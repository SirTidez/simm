import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const isWindows = process.platform === 'win32';
const defaultWindowsBun = join(process.env.USERPROFILE || '', '.bun', 'bin', 'bun.exe');
const bunCommand = isWindows && existsSync(defaultWindowsBun) ? defaultWindowsBun : 'bun';

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
  bunCommand,
  ['run', 'tauri', 'dev', '--config', 'src-tauri/tauri.playwright.conf.json'],
  {
    stdio: 'inherit',
    detached: !isWindows,
    shell: isWindows,
    windowsHide: true,
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

const signals = isWindows ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];

for (const signal of signals) {
  process.on(signal, () => {
    void shutdown(0);
  });
}
