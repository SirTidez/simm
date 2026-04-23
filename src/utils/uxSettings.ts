import type { ExperienceMode, Settings } from '../types';

export const DEFAULT_FRESH_EXPERIENCE_MODE: ExperienceMode = 'player';
export const LEGACY_EXPERIENCE_MODE: ExperienceMode = 'powerUser';

export function resolveExperienceMode(settings: Settings | null | undefined): ExperienceMode {
  return settings?.experienceMode ?? LEGACY_EXPERIENCE_MODE;
}

export function resolveShowAdvancedGameTools(settings: Settings | null | undefined): boolean {
  return settings?.showAdvancedGameTools ?? true;
}

export function settingsNeedUpgradeSetupPrompt(settings: Settings | null | undefined): boolean {
  return Boolean(settings) && settings?.setupGuideCompleted == null;
}

export function buildSetupGuideSettings(mode: ExperienceMode) {
  const powerUser = mode === 'powerUser';
  return {
    experienceMode: mode,
    showAdvancedGameTools: powerUser,
    setupGuideCompleted: true,
  };
}
