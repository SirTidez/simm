//! Windows companion-window docking. No SetParent, owner assignment, game injection or job ownership.
use super::{read_json, write_json, HelperConfig, HelperStatus, ProcessIdentity};
use crate::types::NativeConsoleViewport;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    mem::zeroed,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    ptr::null_mut,
    thread,
    time::{Duration, Instant},
};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use winapi::{
    shared::{
        minwindef::{BOOL, FILETIME, LPARAM},
        windef::{HWND, POINT, RECT},
    },
    um::{
        handleapi::CloseHandle,
        processthreadsapi::{GetExitCodeProcess, GetProcessTimes, OpenProcess, TerminateProcess},
        winbase::QueryFullProcessImageNameW,
        wincon::{AttachConsole, FreeConsole, GetConsoleWindow},
        winnt::{PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE},
        winuser::*,
    },
};

#[derive(Clone, Serialize, Deserialize)]
struct RestorePlan {
    config: HelperConfig,
    game: ProcessIdentity,
    controller: ProcessIdentity,
    console_host: ProcessIdentity,
    console: usize,
    style: isize,
    ex_style: isize,
    rect: [i32; 4],
    visible: bool,
}

pub(super) fn identity(pid: u32) -> Result<ProcessIdentity> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        anyhow::ensure!(
            !handle.is_null(),
            "Could not inspect process {pid}: {}",
            std::io::Error::last_os_error()
        );
        let result = (|| {
            let (mut created, mut exited, mut kernel, mut user): (
                FILETIME,
                FILETIME,
                FILETIME,
                FILETIME,
            ) = (zeroed(), zeroed(), zeroed(), zeroed());
            anyhow::ensure!(
                GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) != 0,
                "Could not inspect process creation time"
            );
            let mut code = 0;
            anyhow::ensure!(
                GetExitCodeProcess(handle, &mut code) != 0 && code == 259,
                "Process has exited"
            );
            let mut buffer = vec![0u16; 32768];
            let mut size = buffer.len() as u32;
            anyhow::ensure!(
                QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size) != 0,
                "Could not inspect process executable"
            );
            Ok(ProcessIdentity {
                pid,
                created: (u64::from(created.dwHighDateTime) << 32)
                    | u64::from(created.dwLowDateTime),
                path: PathBuf::from(String::from_utf16_lossy(&buffer[..size as usize])),
            })
        })();
        CloseHandle(handle);
        result
    }
}

fn same_path(first: &Path, second: &Path) -> bool {
    first
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .eq_ignore_ascii_case(second.to_string_lossy().trim_start_matches(r"\\?\"))
}
pub(super) fn alive(expected: &ProcessIdentity) -> bool {
    identity(expected.pid)
        .map(|actual| actual.created == expected.created && same_path(&actual.path, &expected.path))
        .unwrap_or(false)
}
unsafe fn window_process(window: HWND) -> u32 {
    let mut pid = 0;
    GetWindowThreadProcessId(window, &mut pid);
    pid
}
fn host_valid(config: &HelperConfig) -> bool {
    unsafe {
        IsWindow(config.host as HWND) != 0
            && window_process(config.host as HWND) == config.parent.pid
            && alive(&config.parent)
    }
}
fn console_valid(plan: &RestorePlan) -> bool {
    unsafe {
        IsWindow(plan.console as HWND) != 0
            && window_process(plan.console as HWND) == plan.console_host.pid
            && alive(&plan.console_host)
            && alive(&plan.game)
    }
}

pub(super) fn spawn_helper(mode: &str, directory: &Path) -> Result<std::process::Child> {
    let child = Command::new(std::env::current_exe()?)
        .arg(mode)
        .arg(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000)
        .spawn()
        .context("Could not start native console recovery process")?;
    Ok(child)
}

fn status(
    directory: &Path,
    state: &str,
    game: Option<&ProcessIdentity>,
    message: Option<String>,
) -> Result<()> {
    write_json(
        &directory.join("status.json"),
        &HelperStatus {
            status: state.into(),
            process: game.cloned(),
            diagnostic: message,
        },
    )
}
fn stopped(directory: &Path, config: &HelperConfig) -> bool {
    directory.join("stop").exists() || !host_valid(config)
}

fn discover(config: &HelperConfig, directory: &Path) -> Result<Option<ProcessIdentity>> {
    let deadline = Instant::now() + Duration::from_secs(180);
    let mut system = System::new();
    while Instant::now() < deadline && !stopped(directory, config) {
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
        );
        let matching: Vec<_> = system
            .processes()
            .values()
            .filter(|process| {
                process
                    .exe()
                    .is_some_and(|path| same_path(path, &config.expected_path))
            })
            .collect();
        anyhow::ensure!(
            matching.len() <= 1,
            "Multiple matching game processes found; refusing an ambiguous console attachment."
        );
        if let Some(process) = matching.first() {
            return identity(process.pid().as_u32()).map(Some);
        }
        thread::sleep(Duration::from_millis(500));
    }
    Ok(None)
}

unsafe fn clear_selection(window: HWND) {
    PostMessageW(window, WM_KEYDOWN, 0x1b, 0);
    PostMessageW(window, WM_KEYUP, 0x1b, 0);
}

fn restore(plan: &RestorePlan, directory: &Path) -> Result<()> {
    if console_valid(plan) {
        unsafe {
            let window = plan.console as HWND;
            clear_selection(window);
            SetWindowLongPtrW(window, GWL_STYLE, plan.style);
            SetWindowLongPtrW(window, GWL_EXSTYLE, plan.ex_style);
            anyhow::ensure!(
                SetWindowPos(
                    window,
                    null_mut(),
                    plan.rect[0],
                    plan.rect[1],
                    plan.rect[2],
                    plan.rect[3],
                    SWP_NOACTIVATE | SWP_NOZORDER | SWP_FRAMECHANGED | SWP_ASYNCWINDOWPOS
                ) != 0,
                "Could not restore native console bounds"
            );
            ShowWindowAsync(
                window,
                if directory.join("popout").exists() {
                    SW_SHOWNORMAL
                } else if plan.visible {
                    SW_SHOWNA
                } else {
                    SW_HIDE
                },
            );
        }
    }
    std::fs::write(directory.join("restored"), b"restored")?;
    Ok(())
}

fn pane_bounds(
    viewport: &NativeConsoleViewport,
    scale: f64,
    width: i32,
    height: i32,
) -> (i32, i32, i32, i32) {
    let x = (viewport.x * scale)
        .round()
        .clamp(0.0, f64::from((width - 1).max(0))) as i32;
    let y = (viewport.y * scale)
        .round()
        .clamp(0.0, f64::from((height - 1).max(0))) as i32;
    (
        x,
        y,
        ((viewport.width * scale).round() as i32).clamp(1, (width - x).max(1)),
        ((viewport.height * scale).round() as i32).clamp(1, (height - y).max(1)),
    )
}

fn controller(config: &HelperConfig, directory: &Path) -> Result<()> {
    status(directory, "waitingForGame", None, None)?;
    let Some(game) = discover(config, directory)? else {
        status(directory, "unavailable", None, Some("No matching game process was found yet. Retry observes the game without launching it again.".into()))?;
        std::fs::write(directory.join("restored"), b"no attachment")?;
        return Ok(());
    };
    status(directory, "waitingForConsole", Some(&game), None)?;
    let deadline = Instant::now() + Duration::from_secs(120);
    let console = loop {
        if stopped(directory, config) || !alive(&game) {
            status(directory, "exited", Some(&game), None)?;
            std::fs::write(directory.join("restored"), b"no attachment")?;
            return Ok(());
        }
        unsafe {
            FreeConsole();
            if AttachConsole(game.pid) != 0 {
                let window = GetConsoleWindow();
                if !window.is_null() && IsWindow(window) != 0 {
                    break window;
                }
                FreeConsole();
            }
        }
        if Instant::now() >= deadline {
            status(directory, "unavailable", Some(&game), Some("The game is running, but no attachable Windows console is available. MelonLoader's hide-console option or a terminal host can prevent native docking. Retry does not relaunch the game.".into()))?;
            std::fs::write(directory.join("restored"), b"no attachment")?;
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    };
    let plan = unsafe {
        anyhow::ensure!(
            GetParent(console).is_null() && GetWindow(console, GW_OWNER).is_null(),
            "Console already has a parent/owner; refusing to dock it."
        );
        let mut rect: RECT = zeroed();
        anyhow::ensure!(
            GetWindowRect(console, &mut rect) != 0,
            "Could not inspect console bounds"
        );
        RestorePlan {
            config: config.clone(),
            game: game.clone(),
            controller: identity(std::process::id())?,
            console_host: identity(window_process(console))?,
            console: console as usize,
            style: GetWindowLongPtrW(console, GWL_STYLE),
            ex_style: GetWindowLongPtrW(console, GWL_EXSTYLE),
            rect: [
                rect.left,
                rect.top,
                rect.right - rect.left,
                rect.bottom - rect.top,
            ],
            visible: IsWindowVisible(console) != 0,
        }
    };
    write_json(&directory.join("plan.json"), &plan)?;
    spawn_helper("--native-console-guard", directory)?;
    let ready_deadline = Instant::now() + Duration::from_secs(8);
    while !directory.join("guard.ready").exists() {
        anyhow::ensure!(
            Instant::now() < ready_deadline && !stopped(directory, config),
            "Console recovery handshake failed; console was not modified."
        );
        thread::sleep(Duration::from_millis(25));
    }
    // Restoration runs even when style/geometry publication fails. The guard also survives this process.
    let result = (|| -> Result<()> {
        unsafe {
            anyhow::ensure!(
                !stopped(directory, config),
                "Console host closed before docking"
            );
            let style = (plan.style as u32
                & !(WS_CHILD
                    | WS_CAPTION
                    | WS_THICKFRAME
                    | WS_SYSMENU
                    | WS_MINIMIZEBOX
                    | WS_MAXIMIZEBOX)) as isize;
            // Redocking can start from an actively selected standalone console.
            // Release its writer before hiding it, including an initially hidden pane.
            clear_selection(console);
            ShowWindowAsync(console, SW_HIDE);
            SetWindowLongPtrW(console, GWL_STYLE, style);
            let ex_style = (plan.ex_style as u32 & !WS_EX_APPWINDOW | WS_EX_TOOLWINDOW) as isize;
            SetWindowLongPtrW(console, GWL_EXSTYLE, ex_style);
            // ShowWindowAsync changes WS_VISIBLE independently of frame styling.
            let frame_bits = WS_CHILD
                | WS_CAPTION
                | WS_THICKFRAME
                | WS_SYSMENU
                | WS_MINIMIZEBOX
                | WS_MAXIMIZEBOX;
            let actual_style = GetWindowLongPtrW(console, GWL_STYLE) as u32;
            let actual_ex_style = GetWindowLongPtrW(console, GWL_EXSTYLE) as u32;
            anyhow::ensure!(actual_style & frame_bits == 0 && actual_ex_style & (WS_EX_APPWINDOW | WS_EX_TOOLWINDOW) == WS_EX_TOOLWINDOW,
                "Windows did not accept the console frame styles (style={actual_style:x}, extended={actual_ex_style:x})");
        }
        let host = config.host as HWND;
        let mut hidden = true;
        let mut last_bounds = None;
        let mut last_publish = Instant::now() - Duration::from_secs(1);
        while !stopped(directory, config) && console_valid(&plan) {
            // The guard signals stop before recovery. Never redock after recovery.
            unsafe {
                let viewport: NativeConsoleViewport =
                    read_json(&directory.join("viewport.json")).unwrap_or_default();
                let is_hidden = !viewport.visible
                    || viewport.width < 1.0
                    || viewport.height < 1.0
                    || IsIconic(host) != 0
                    || IsWindowVisible(host) == 0;
                if is_hidden != hidden {
                    if is_hidden {
                        clear_selection(console);
                    }
                    ShowWindowAsync(console, if is_hidden { SW_HIDE } else { SW_SHOWNA });
                    hidden = is_hidden;
                }
                if !hidden {
                    let mut rect: RECT = zeroed();
                    let mut origin: POINT = zeroed();
                    anyhow::ensure!(
                        GetClientRect(host, &mut rect) != 0
                            && ClientToScreen(host, &mut origin) != 0,
                        "Could not locate console pane"
                    );
                    let scale = f64::from(GetDpiForWindow(host).max(96)) / 96.0;
                    let (x, y, width, height) =
                        pane_bounds(&viewport, scale, rect.right, rect.bottom);
                    let bounds = (origin.x + x, origin.y + y, width, height);
                    if last_bounds != Some(bounds) {
                        anyhow::ensure!(
                            SetWindowPos(
                                console,
                                null_mut(),
                                bounds.0,
                                bounds.1,
                                bounds.2,
                                bounds.3,
                                SWP_NOACTIVATE
                                    | SWP_NOZORDER
                                    | SWP_FRAMECHANGED
                                    | SWP_ASYNCWINDOWPOS
                            ) != 0,
                            "Could not position native console"
                        );
                        ShowWindowAsync(console, SW_SHOWNA);
                        last_bounds = Some(bounds);
                    }
                    if GetForegroundWindow() == console && GetWindow(console, GW_HWNDNEXT) != host {
                        SetWindowPos(
                            host,
                            console,
                            0,
                            0,
                            0,
                            0,
                            SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_ASYNCWINDOWPOS,
                        );
                    }
                    let previous = GetWindow(host, GW_HWNDPREV);
                    if previous != console {
                        SetWindowPos(
                            console,
                            previous,
                            0,
                            0,
                            0,
                            0,
                            SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_ASYNCWINDOWPOS,
                        );
                    }
                    anyhow::ensure!(
                        GetParent(console).is_null() && GetWindow(console, GW_OWNER).is_null(),
                        "Console acquired an unexpected parent/owner"
                    );
                }
            }
            if last_publish.elapsed() >= Duration::from_millis(500) {
                status(directory, "docked", Some(&game), None)?;
                last_publish = Instant::now();
            }
            thread::sleep(Duration::from_millis(50));
        }
        status(
            directory,
            if alive(&game) { "detached" } else { "exited" },
            Some(&game),
            None,
        )?;
        Ok(())
    })();
    let restored = restore(&plan, directory);
    unsafe {
        FreeConsole();
    }
    result.and(restored)
}

fn guard(directory: &Path) -> Result<()> {
    let plan: RestorePlan = read_json(&directory.join("plan.json"))?;
    anyhow::ensure!(
        alive(&plan.controller)
            && same_path(&plan.controller.path, &std::env::current_exe()?)
            && host_valid(&plan.config)
            && console_valid(&plan),
        "Invalid recovery identity"
    );
    std::fs::write(directory.join("guard.ready"), b"")?;
    loop {
        if directory.join("restored").exists() {
            return Ok(());
        }
        if !alive(&plan.controller) || !host_valid(&plan.config) || !alive(&plan.game) {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = write_json(
        &directory.join("guard-recovery.json"),
        &serde_json::json!({
            "controllerAlive": alive(&plan.controller), "hostAlive": host_valid(&plan.config), "gameAlive": alive(&plan.game)
        }),
    );
    let _ = std::fs::write(directory.join("stop"), b"");
    // Give normal controller cleanup time, then stop only our verified helper before restoring.
    for _ in 0..10 {
        if !alive(&plan.controller) {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    if alive(&plan.controller) {
        unsafe {
            let handle = OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
                0,
                plan.controller.pid,
            );
            if !handle.is_null() {
                if alive(&plan.controller) {
                    TerminateProcess(handle, 1);
                }
                CloseHandle(handle);
            }
        }
    }
    restore(&plan, directory)
}

pub(super) fn run(mode: &str, directory: &Path) -> Result<()> {
    let result = if mode == "--native-console-guard" {
        guard(directory)
    } else {
        read_json::<HelperConfig>(&directory.join("config.json")).and_then(|config| {
            anyhow::ensure!(
                same_path(&config.parent.path, &std::env::current_exe()?) && host_valid(&config),
                "Invalid SIMM console host"
            );
            controller(&config, directory)
        })
    };
    if let Err(error) = &result {
        let existing = read_json::<HelperStatus>(&directory.join("status.json")).ok();
        let _ = status(
            directory,
            "unavailable",
            existing.as_ref().and_then(|status| status.process.as_ref()),
            Some(format!("Native console docking stopped: {error:#}")),
        );
        // A failed guard cannot claim restoration. The controller restores on its own failure.
        if mode != "--native-console-guard" && !directory.join("plan.json").exists() {
            let _ = std::fs::write(directory.join("restored"), b"no attachment");
        }
    }
    result
}

pub(super) fn close_game(game: &ProcessIdentity, directory: &Path) -> Result<()> {
    use std::os::windows::io::{FromRawHandle, OwnedHandle};
    // Retain a process-object reference while validating and posting, preventing PID reuse.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, game.pid) };
    anyhow::ensure!(
        !handle.is_null(),
        "The attached game process is unavailable."
    );
    let _process = unsafe { OwnedHandle::from_raw_handle(handle) };
    anyhow::ensure!(
        alive(game),
        "The attached game process has exited or changed. No close request was sent."
    );
    if let Ok(plan) = read_json::<RestorePlan>(&directory.join("plan.json")) {
        if console_valid(&plan) {
            unsafe {
                clear_selection(plan.console as HWND);
            }
        }
    }
    struct CloseRequest {
        pid: u32,
        windows: Vec<usize>,
    }
    unsafe extern "system" fn find(window: HWND, parameter: LPARAM) -> BOOL {
        let request = &mut *(parameter as *mut CloseRequest);
        if window_process(window) == request.pid {
            let mut class = [0u16; 128];
            let length = GetClassNameW(window, class.as_mut_ptr(), class.len() as i32);
            if String::from_utf16_lossy(&class[..length.max(0) as usize]) == "UnityWndClass" {
                request.windows.push(window as usize);
            }
        }
        1
    }
    let mut request = CloseRequest {
        pid: game.pid,
        windows: Vec::new(),
    };
    unsafe {
        EnumWindows(Some(find), &mut request as *mut _ as LPARAM);
    }
    anyhow::ensure!(
        request.windows.len() == 1,
        "Could not identify one game window. Close Schedule I from its own menu."
    );
    anyhow::ensure!(
        alive(game),
        "The attached game process changed. No close request was sent."
    );
    unsafe {
        let window = request.windows[0] as HWND;
        anyhow::ensure!(
            window_process(window) == game.pid && PostMessageW(window, WM_CLOSE, 0, 0) != 0,
            "Windows could not deliver the game close request: {}",
            std::io::Error::last_os_error()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pane_uses_workspace_offsets_and_monitor_scale_without_covering_shell() {
        let viewport = NativeConsoleViewport {
            x: 224.0,
            y: 120.0,
            width: 680.0,
            height: 600.0,
            visible: true,
            revision: 1,
        };
        assert_eq!(
            pane_bounds(&viewport, 1.5, 1920, 1200),
            (336, 180, 1020, 900)
        );
        assert_eq!(
            pane_bounds(&viewport, 2.0, 1600, 1000),
            (448, 240, 1152, 760)
        );
    }
    #[test]
    fn process_identity_rejects_reused_pid_and_wrong_path() {
        let original = identity(std::process::id()).unwrap();
        assert!(alive(&original));
        let mut changed = original.clone();
        changed.created += 1;
        assert!(!alive(&changed));
        changed = original;
        changed.path = PathBuf::from("C:\\unrelated.exe");
        assert!(!alive(&changed));
        assert!(same_path(
            Path::new(r"\\?\C:\Game\Schedule I.exe"),
            Path::new(r"c:\game\schedule i.exe")
        ));
    }
}
