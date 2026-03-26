import { spawn } from 'node:child_process';
import process from 'node:process';

const isWindows = process.platform === 'win32';
const npxCommand = isWindows ? 'npx.cmd' : 'npx';

let child = null;
let shuttingDown = false;

function killChildTree(target) {
  if (!target || target.exitCode !== null || target.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    if (isWindows) {
      const killer = spawn('taskkill', ['/PID', String(target.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('exit', () => resolve());
      killer.once('error', () => resolve());
      return;
    }

    try {
      process.kill(-target.pid, 'SIGTERM');
    } catch {
      resolve();
      return;
    }

    setTimeout(resolve, 250);
  });
}

async function shutdown(code = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  await killChildTree(child);
  process.exit(code);
}

child = spawn(
  isWindows
    ? `${npxCommand} tauri dev --config src-tauri/tauri.playwright.conf.json`
    : npxCommand,
  isWindows ? [] : ['tauri', 'dev', '--config', 'src-tauri/tauri.playwright.conf.json'],
  {
    stdio: 'inherit',
    detached: !isWindows,
    shell: isWindows,
  },
);

child.once('error', (error) => {
  console.error('Failed to start Tauri Playwright dev session:', error);
  void shutdown(1);
});

child.once('exit', (code, signal) => {
  if (signal) {
    void shutdown(1);
    return;
  }
  void shutdown(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    void shutdown(0);
  });
}
