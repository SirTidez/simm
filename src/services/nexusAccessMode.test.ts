import { afterEach, describe, expect, it } from 'vitest';
import {
  applyNexusAccessModeOverride,
  canForceFreeMode,
  isNexusForceFreeModeEnabled,
  setNexusForceFreeModeEnabled,
} from './nexusAccessMode';

describe('nexusAccessMode', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it('disables direct downloads when force-free mode is enabled for a premium account', () => {
    setNexusForceFreeModeEnabled(true);

    const status = applyNexusAccessModeOverride({
      connected: true,
      account: {
        isPremium: true,
        canDirectDownload: true,
        requiresSiteConfirmation: false,
      },
    });

    expect(isNexusForceFreeModeEnabled()).toBe(true);
    expect(canForceFreeMode(status)).toBe(true);
    expect(status.account?.canDirectDownload).toBe(false);
    expect(status.account?.requiresSiteConfirmation).toBe(true);
    expect(status.account?.isPremium).toBe(true);
  });

  it('does not change a genuinely free account', () => {
    setNexusForceFreeModeEnabled(true);

    const status = applyNexusAccessModeOverride({
      connected: true,
      account: {
        isPremium: false,
        isSupporter: false,
        canDirectDownload: false,
        requiresSiteConfirmation: true,
      },
    });

    expect(canForceFreeMode(status)).toBe(false);
    expect(status.account?.canDirectDownload).toBe(false);
    expect(status.account?.requiresSiteConfirmation).toBe(true);
  });
});
