#!/usr/bin/env node
/**
 * Screenshot every main SIMM screen from a real, running app instance.
 *
 * Works against the original UI (beta before the redesign) and the redesigned
 * UI, so both produce files with the same names for a before/after comparison.
 * It only navigates: it never launches the game, installs, updates, downloads,
 * deletes, or confirms anything.
 *
 * Windows (real WebView2 instance with your own data):
 *   bun install
 *   node scripts/ui-capture/capture.mjs --label after
 *
 * The script starts `bun run tauri:playwright` (the app with a local DevTools
 * port, see src-tauri/tauri.playwright.conf.json), waits for it, captures, and
 * closes it again. Use --no-launch to attach to an instance you started
 * yourself with `bun run tauri:playwright`.
 *
 * Options:
 *   --label <name>          output subfolder, e.g. before / after (required)
 *   --app-dir <path>        checkout to launch (default: current directory)
 *   --out <path>            output root (default: ./ui-captures)
 *   --viewports <list>      default 1600x1000,1280x800
 *   --cdp <url>             DevTools endpoint (default http://127.0.0.1:9222)
 *   --no-launch             attach to an already running instance
 *   --keep-open             leave the app running afterwards
 *   --only <a,b>            capture only these screen names
 *
 * Screenshots show your real environment names, paths and account names.
 * Look through them before sharing.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const LABEL = option('label', null);
if (!LABEL) {
  console.error('Missing --label (for example --label before or --label after).');
  process.exit(2);
}
const APP_DIR = resolve(option('app-dir', process.cwd()));
const OUT = resolve(option('out', 'ui-captures'), LABEL);
const CDP = option('cdp', 'http://127.0.0.1:9222');
const VIEWPORTS = option('viewports', '1600x1000,1280x800').split(',').map((v) => v.split('x').map(Number));
const ONLY = option('only', '').split(',').filter(Boolean);
const isWindows = process.platform === 'win32';

// ---------------------------------------------------------------- launching

let app = null;

async function cdpUp() {
  try {
    const response = await fetch(`${CDP}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

async function launchApp() {
  if (await cdpUp()) {
    console.log(`A DevTools endpoint is already up at ${CDP}; attaching to it.`);
    return;
  }
  console.log(`Starting the app in ${APP_DIR} (first start compiles the Rust side and can take several minutes)...`);
  app = spawn('bun', ['run', 'tauri:playwright'], {
    cwd: APP_DIR,
    stdio: 'inherit',
    shell: isWindows,
    detached: !isWindows,
    windowsHide: true,
  });
  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    if (await cdpUp()) return;
    if (app.exitCode !== null) throw new Error(`The app exited early (code ${app.exitCode}).`);
    await sleep(2000);
  }
  throw new Error('Timed out waiting for the app to open its DevTools port.');
}

async function stopApp() {
  if (!app || flag('keep-open')) return;
  await new Promise((done) => {
    if (isWindows) {
      const killer = spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('exit', done);
      killer.once('error', done);
    } else {
      try { process.kill(-app.pid, 'SIGTERM'); } catch { /* already gone */ }
      done();
    }
  });
}

// ---------------------------------------------------------------- helpers

async function settle(page, ms = 700) {
  await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(ms);
  // Real data can take a while (save inspection, library scans): wait until no
  // loading placeholder is left on screen, in either UI generation.
  await page.locator([
    '.workspace-panel-fallback',
    '[aria-label^="Loading"]',
    '[aria-label^="Inspecting"]',
    '[role="status"]:has-text("Inspecting")',
    '[aria-busy="true"]',
    '[data-slot="skeleton"]',
    '[class*="skeleton"]',
  ].join(', ')).first().waitFor({ state: 'detached', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(200);
}

async function click(locator, timeout = 8000) {
  const target = locator.first();
  await target.waitFor({ state: 'visible', timeout });
  await target.scrollIntoViewIfNeeded().catch(() => {});
  await target.click({ timeout });
}

async function escape(page, times = 2) {
  for (let i = 0; i < times; i += 1) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(150);
  }
}

const sidebar = (page) => page.getByRole('complementary', { name: 'Primary navigation' });

// Navigation for each UI generation. Every function only moves around the app.
const UI = {
  new: {
    detect: (page) => page.locator('.shell-env').first(),
    home: async (page) => { await click(sidebar(page).getByRole('button', { name: /^Home$/ })); },
    nav: async (page, label) => { await click(sidebar(page).getByRole('button', { name: new RegExp(`^${label}( \\d+)?$`) })); },
    environment: async (page) => {
      const items = sidebar(page).locator('.shell-env');
      const count = await items.count();
      let target = items.first();
      for (let i = 0; i < count; i += 1) {
        const text = await items.nth(i).innerText();
        if (!/Not installed|Downloading|Folder missing/.test(text)) { target = items.nth(i); break; }
      }
      await click(target);
    },
    envTab: async (page, label) => {
      await UI.new.environment(page);
      await settle(page, 400);
      await click(page.locator('.env-header__tabs').getByRole('button', { name: new RegExp(`^${label}`) }));
    },
    libraryTab: async (page, label) => {
      await UI.new.nav(page, 'Mod Library');
      await settle(page, 400);
      // The library remembers an open detail page; step back to the tabs first.
      const back = page.getByRole('button', { name: /^Back to/ });
      if (!(await page.locator('.lib-tabs').first().isVisible().catch(() => false)) && await back.count()) {
        await click(back);
        await settle(page, 400);
      }
      if (label) await click(page.locator('.lib-tabs').getByRole('button', { name: new RegExp(`^${label}`) }));
    },
    discoverRow: (page) => page.locator('.lib-row--discover'),
    downloads: async (page) => { await click(page.locator('.statusbar-downloads__button')); },
    addEnvironment: async (page) => { await click(sidebar(page).getByRole('button', { name: 'Add Environment', exact: true })); },
    settingsSections: async (page) => page.locator('.settings-nav button, .settings-nav a'),
  },
  old: {
    detect: (page) => page.locator('.app-shell-sidebar__environment-item').first(),
    home: async (page) => { await click(page.locator('.app-shell-sidebar__tool-list').getByRole('button', { name: /^Home$/ })); },
    nav: async (page, label) => {
      const banner = page.getByRole('banner').getByRole('button', { name: label, exact: true });
      if (await banner.count()) { await click(banner); return; }
      await click(page.locator('.app-shell-sidebar__tool-list').getByRole('button', { name: new RegExp(`^${label}( \\d+)?$`) }));
    },
    environment: async (page) => {
      const items = sidebar(page).locator('.app-shell-sidebar__environment-item');
      const count = await items.count();
      let target = items.first();
      for (let i = 0; i < count; i += 1) {
        const text = await items.nth(i).innerText();
        if (/Ready|Update/.test(text)) { target = items.nth(i); break; }
      }
      const name = (await target.locator('.app-shell-sidebar__environment-name').innerText().catch(() => '')).trim();
      await click(target);
      return name;
    },
    envTab: async (page, label) => {
      // From Home, choosing an environment opens the Environments page with its card.
      await UI.old.home(page);
      await settle(page, 300);
      const name = await UI.old.environment(page);
      await settle(page, 400);
      if (label === 'Overview') return;
      const tool = { Mods: 'Installed Mods', Config: 'Config Files', Logs: 'Logs' }[label];
      if (tool) {
        await click(page.locator('.app-shell-sidebar__tool-list').getByRole('button', { name: new RegExp(`^${tool}`) }));
        return;
      }
      // Plugins and UserLibs only open from the environment's card.
      await click(page.getByRole('button', { name: `Open actions for ${name}`, exact: true }).getByRole('button', { name: label, exact: true }));
    },
    libraryTab: async (page, label) => {
      await UI.old.nav(page, 'Mod Library');
      await settle(page, 400);
      const back = page.getByRole('button', { name: /^Back to/ });
      if (!(await page.locator('.workspace-collection__primary-tabs').first().isVisible().catch(() => false)) && await back.count()) {
        await click(back);
        await settle(page, 400);
      }
      if (label) await click(page.locator('.workspace-collection__primary-tabs').getByRole('button', { name: new RegExp(`^${label}`) }));
    },
    discoverRow: (page) => page.locator('.workspace-collection__row--discover'),
    downloads: async (page) => { await click(page.locator('.app-shell-sidebar__download-item')); },
    addEnvironment: async (page) => { await click(page.getByRole('banner').getByRole('button', { name: 'Add Environment', exact: true })); },
    settingsSections: async () => null,
  },
};

// ---------------------------------------------------------------- screens
// Same names for both UIs so the files pair up. Each run() only navigates.
const SCREENS = [
  { name: 'home', run: async (page, ui) => { await ui.home(page); } },
  { name: 'environment-overview', run: async (page, ui) => { await ui.envTab(page, 'Overview'); } },
  { name: 'environment-mods', run: async (page, ui) => { await ui.envTab(page, 'Mods'); } },
  { name: 'environment-plugins', run: async (page, ui) => { await ui.envTab(page, 'Plugins'); } },
  { name: 'environment-userlibs', run: async (page, ui) => { await ui.envTab(page, 'UserLibs'); } },
  { name: 'environment-config', run: async (page, ui) => { await ui.envTab(page, 'Config'); } },
  { name: 'environment-logs', run: async (page, ui) => { await ui.envTab(page, 'Logs'); } },
  { name: 'library-discover', run: async (page, ui) => { await ui.libraryTab(page, 'Discover'); } },
  { name: 'library-discover-detail', run: async (page, ui) => {
    await ui.libraryTab(page, 'Discover');
    await settle(page, 1500);
    await click(ui.discoverRow(page), 15000);
  } },
  { name: 'library-library', run: async (page, ui) => { await ui.libraryTab(page, 'Library'); } },
  { name: 'library-updates', run: async (page, ui) => { await ui.libraryTab(page, 'Updates'); } },
  { name: 'profiles', run: async (page, ui) => { await ui.nav(page, 'Profiles'); } },
  { name: 'saves', run: async (page, ui) => { await ui.nav(page, ui === UI.new ? 'Saves' : 'Save Management'); } },
  { name: 'accounts', run: async (page, ui) => { await ui.nav(page, 'Accounts'); } },
  { name: 'help', run: async (page, ui) => { await ui.nav(page, 'Help'); } },
  { name: 'telemetry', optional: true, run: async (page, ui) => { await ui.nav(page, 'Telemetry'); } },
  { name: 'settings', run: async (page, ui) => { await ui.nav(page, 'Settings'); } },
  { name: 'settings-more', run: async (page, ui) => {
    await ui.nav(page, 'Settings');
    await settle(page, 500);
    const box = page.locator('main').first();
    await box.hover().catch(() => {});
    await page.mouse.wheel(0, 900);
  } },
  { name: 'add-environment', run: async (page, ui) => { await ui.addEnvironment(page); } },
  { name: 'downloads', run: async (page, ui) => { await ui.home(page); await settle(page, 300); await ui.downloads(page); } },
];

// ---------------------------------------------------------------- main

async function findAppPage(browser) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const page = browser.contexts().flatMap((context) => context.pages())
      .find((candidate) => /localhost:\d+|127\.0\.0\.1:\d+|tauri\.localhost/.test(candidate.url()));
    if (page) return page;
    await sleep(1000);
  }
  throw new Error('The SIMM window did not appear over DevTools.');
}

async function main() {
  if (!flag('no-launch')) await launchApp();
  const browser = await chromium.connectOverCDP(CDP);
  let failures = 0;
  try {
    const page = await findAppPage(browser);
    await page.bringToFront().catch(() => {});
    await sidebar(page).waitFor({ state: 'visible', timeout: 120000 });
    await settle(page, 3000);
    const generation = (await UI.new.detect(page).count()) > 0 ? 'new' : 'old';
    const ui = UI[generation];
    console.log(`Detected the ${generation === 'new' ? 'redesigned' : 'original'} UI.`);

    for (const [width, height] of VIEWPORTS) {
      await page.setViewportSize({ width, height });
      const dir = join(OUT, `${width}x${height}`);
      mkdirSync(dir, { recursive: true });
      let index = 0;
      for (const screen of SCREENS) {
        index += 1;
        if (ONLY.length && !ONLY.includes(screen.name)) continue;
        const file = join(dir, `${String(index).padStart(2, '0')}-${screen.name}.png`);
        try {
          await escape(page);
          await screen.run(page, ui);
          await settle(page);
          await page.screenshot({ path: file });
          console.log(`  ok   ${width}x${height} ${screen.name}`);
        } catch (error) {
          if (!screen.optional) failures += 1;
          console.log(`  ${screen.optional ? 'skip' : 'FAIL'} ${width}x${height} ${screen.name}: ${error.message.split('\n')[0]}`);
        } finally {
          await escape(page);
        }
      }
    }
    await ui.home(page).catch(() => {});
  } finally {
    await browser.close().catch(() => {});
    await stopApp();
  }
  console.log(`\nScreenshots in ${OUT}${failures ? ` (${failures} screen(s) failed)` : ''}.`);
  process.exit(failures ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await stopApp();
  process.exit(1);
});
