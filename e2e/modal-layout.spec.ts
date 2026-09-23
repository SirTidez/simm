import { expect, test } from '@playwright/test';

import { connectToTauriApp } from './tauriApp';

interface DialogAuditSpec {
  name: string;
  classes: string;
  contentHeight: number;
  style?: Record<string, string>;
  centered?: boolean;
}

const dialogAuditSpecs: DialogAuditSpec[] = [
  { name: 'message', classes: 'app-dialog app-dialog--message', contentHeight: 220, centered: true },
  { name: 'confirmation', classes: 'app-dialog app-dialog--confirm', contentHeight: 260, centered: true },
  { name: 'authentication', classes: 'auth-modal', contentHeight: 900 },
  { name: 'directory picker', classes: 'wizard-directory-dialog', contentHeight: 900 },
  { name: 'MelonLoader selector', classes: 'melonloader-dialog', contentHeight: 800 },
  { name: 'install targets', classes: 'workspace-install-dialog', contentHeight: 900, centered: true },
  { name: 'profile export', classes: 'app-dialog profile-export-dialog', contentHeight: 900, centered: true },
  { name: 'save restore preview', classes: 'app-dialog save-restore-preview', contentHeight: 900 },
  {
    name: 'security report',
    classes: 'security-report-view__dialog',
    contentHeight: 900,
    style: { maxWidth: '1240px', width: 'min(1240px, calc(100vw - 2rem))' },
  },
  { name: 'collection conflict', classes: 'collection-conflict-dialog', contentHeight: 720 },
  {
    name: 'collection runtime',
    classes: 'app-dialog app-dialog--message',
    contentHeight: 240,
    style: { maxWidth: '420px' },
    centered: true,
  },
  { name: 'telemetry export', classes: 'app-dialog telemetry-export-viewer', contentHeight: 900 },
  { name: 'telemetry policy', classes: 'app-dialog telemetry-mod-policy-dialog', contentHeight: 900 },
];

const desktopViewports = [
  { width: 1024, height: 600 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 3840, height: 2160 },
];

test('keeps every shared dialog family inside common desktop viewports', async () => {
  const { browser, page } = await connectToTauriApp();

  try {
    for (const viewport of desktopViewports) {
      await page.setViewportSize(viewport);

      for (const spec of dialogAuditSpecs) {
        const geometry = await page.evaluate(({ dialogSpec }) => {
          const dialog = document.createElement('section');
          dialog.className = `modal-content simm-dialog-content ${dialogSpec.classes}`;
          Object.assign(dialog.style, dialogSpec.style ?? {});
          dialog.innerHTML = `
            <header class="modal-header"><h2>Dialog layout audit</h2><button>Close</button></header>
            <div class="app-dialog__body" style="height: ${dialogSpec.contentHeight}px">
              <p>Representative content</p>
            </div>
            <footer class="app-dialog__footer"><button>Cancel</button><button>Continue</button></footer>
          `;
          document.body.appendChild(dialog);

          const bounds = dialog.getBoundingClientRect();
          const result = {
            left: bounds.left,
            top: bounds.top,
            right: bounds.right,
            bottom: bounds.bottom,
            centerX: bounds.left + bounds.width / 2,
            centerY: bounds.top + bounds.height / 2,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
          };
          dialog.remove();
          return result;
        }, { dialogSpec: spec });

        expect.soft(geometry.left, `${spec.name} left edge at ${viewport.width}x${viewport.height}`).toBeGreaterThanOrEqual(-0.5);
        expect.soft(geometry.top, `${spec.name} top edge at ${viewport.width}x${viewport.height}`).toBeGreaterThanOrEqual(-0.5);
        expect.soft(geometry.right, `${spec.name} right edge at ${viewport.width}x${viewport.height}`).toBeLessThanOrEqual(geometry.viewportWidth + 0.5);
        expect.soft(geometry.bottom, `${spec.name} bottom edge at ${viewport.width}x${viewport.height}`).toBeLessThanOrEqual(geometry.viewportHeight + 0.5);

        if (spec.centered) {
          expect.soft(
            Math.abs(geometry.centerX - geometry.viewportWidth / 2),
            `${spec.name} horizontal center at ${viewport.width}x${viewport.height}`,
          ).toBeLessThanOrEqual(0.5);
          expect.soft(
            Math.abs(geometry.centerY - geometry.viewportHeight / 2),
            `${spec.name} vertical center at ${viewport.width}x${viewport.height}`,
          ).toBeLessThanOrEqual(0.5);
        }
      }
    }
  } finally {
    await browser.close();
  }
});
