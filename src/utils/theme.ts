import type { Settings } from '../types';

interface SharedThemeTokens {
  appTextColorSecondary: string;
  textTertiary: string;
  workspaceStroke: string;
  workspaceStrokeSoft: string;
  workspaceTitleColor: string;
  workspaceCopyColor: string;
  workspaceEyebrowColor: string;
  workspaceSurfaceCard: string;
  workspaceSurfaceCardStrong: string;
  workspaceSurfaceMuted: string;
  workspaceSurfaceMutedSoft: string;
  workspacePathSurface: string;
  workspaceIconSurface: string;
}

export type BuiltInTheme = 'light' | 'dark' | 'modern-blue';

export const THEME_STORAGE_KEY = 'simm-theme';

export const normalizeThemeSelection = (theme: Settings['theme'] | string | undefined): BuiltInTheme => {
  return theme === 'light' || theme === 'dark' || theme === 'modern-blue'
    ? theme
    : 'modern-blue';
};

const applySharedThemeTokens = (root: HTMLElement, tokens: SharedThemeTokens) => {
  root.style.setProperty('--app-text-color-secondary', tokens.appTextColorSecondary);
  root.style.setProperty('--text-tertiary', tokens.textTertiary);
  root.style.setProperty('--theme-workspace-stroke', tokens.workspaceStroke);
  root.style.setProperty('--theme-workspace-stroke-soft', tokens.workspaceStrokeSoft);
  root.style.setProperty('--theme-workspace-title-color', tokens.workspaceTitleColor);
  root.style.setProperty('--theme-workspace-copy-color', tokens.workspaceCopyColor);
  root.style.setProperty('--theme-workspace-eyebrow-color', tokens.workspaceEyebrowColor);
  root.style.setProperty('--theme-workspace-surface-card', tokens.workspaceSurfaceCard);
  root.style.setProperty('--theme-workspace-surface-card-strong', tokens.workspaceSurfaceCardStrong);
  root.style.setProperty('--theme-workspace-surface-muted', tokens.workspaceSurfaceMuted);
  root.style.setProperty('--theme-workspace-surface-muted-soft', tokens.workspaceSurfaceMutedSoft);
  root.style.setProperty('--theme-workspace-path-surface', tokens.workspacePathSurface);
  root.style.setProperty('--theme-workspace-icon-surface', tokens.workspaceIconSurface);
};

export const persistThemeSelection = (theme: BuiltInTheme) => {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore storage failures during theme persistence.
  }
};

export const readCachedThemeSelection = (): BuiltInTheme => {
  try {
    const cachedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    return normalizeThemeSelection(cachedTheme ?? undefined);
  } catch {
    return 'modern-blue';
  }
};

export const applyBuiltInTheme = (theme: BuiltInTheme) => {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);

  if (theme === 'light') {
    root.style.setProperty('color-scheme', 'light');
    root.style.setProperty('--app-bg-color', '#e8eef6');
    root.style.setProperty('--app-text-color', '#1f2835');
    root.style.setProperty('--header-bg-color', '#f7f9fc');
    root.style.setProperty('--border-color', '#cfd8e4');
    root.style.setProperty('--card-bg-color', '#ffffff');
    root.style.setProperty('--card-border-color', '#d9e2ee');
    root.style.setProperty('--text-secondary', '#607086');
    root.style.setProperty('--text-tertiary', '#7d8998');
    root.style.setProperty('--input-bg-color', '#ffffff');
    root.style.setProperty('--input-border-color', '#c3d0de');
    root.style.setProperty('--input-text-color', '#1f2835');
    root.style.setProperty('--btn-secondary-bg', '#edf2f8');
    root.style.setProperty('--btn-secondary-hover', '#e2e9f2');
    root.style.setProperty('--btn-secondary-text', '#1f2835');
    root.style.setProperty('--btn-secondary-border', '#c9d4e1');
    root.style.setProperty('--primary-btn-color', '#3f74c9');
    root.style.setProperty('--primary-btn-hover', '#3567b9');
    root.style.setProperty('--info-box-bg', 'rgba(232, 242, 255, 0.92)');
    root.style.setProperty('--info-box-border', 'rgba(159, 188, 232, 0.72)');
    root.style.setProperty('--warning-box-bg', 'rgba(255, 244, 220, 0.96)');
    root.style.setProperty('--warning-box-border', 'rgba(227, 194, 125, 0.82)');
    root.style.setProperty('--info-panel-bg', 'rgba(245, 248, 252, 0.96)');
    root.style.setProperty('--info-panel-border', '#d6e0ec');
    root.style.setProperty('--modal-overlay', 'rgba(30, 41, 57, 0.4)');
    root.style.setProperty('--bg-gradient', 'linear-gradient(180deg, #f8fafd 0%, #eef3f9 54%, #e7edf5 100%)');
    root.style.setProperty('--bg-pattern', 'radial-gradient(circle at 18% -8%, rgba(82, 137, 214, 0.11), transparent 36%), radial-gradient(circle at 85% 110%, rgba(123, 166, 227, 0.1), transparent 42%)');
    root.style.setProperty('--badge-gray', '#778398');
    root.style.setProperty('--badge-blue', '#4b7fd0');
    root.style.setProperty('--badge-orange-red', '#c56c43');
    root.style.setProperty('--badge-yellow', '#d5a63c');
    root.style.setProperty('--badge-green', '#3f9c69');
    root.style.setProperty('--badge-red', '#c45b5b');
    root.style.setProperty('--badge-orange', '#d28a36');
    root.style.setProperty('--badge-cyan', '#3b98b3');
    root.style.setProperty('--update-version-color', '#b96f17');
    root.style.setProperty('--update-version-bg', 'rgba(233, 163, 74, 0.16)');
    applySharedThemeTokens(root, {
      appTextColorSecondary: '#607086',
      textTertiary: '#7d8998',
      workspaceStroke: '#d9e2ee',
      workspaceStrokeSoft: '#cfd8e4',
      workspaceTitleColor: '#1f2835',
      workspaceCopyColor: '#607086',
      workspaceEyebrowColor: '#7d8998',
      workspaceSurfaceCard: '#ffffff',
      workspaceSurfaceCardStrong: '#f7f9fc',
      workspaceSurfaceMuted: '#ffffff',
      workspaceSurfaceMutedSoft: '#ffffff',
      workspacePathSurface: '#ffffff',
      workspaceIconSurface: '#3f74c9',
    });
  } else if (theme === 'modern-blue') {
    root.style.setProperty('color-scheme', 'dark');
    root.style.setProperty('--app-bg-color', '#0f141d');
    root.style.setProperty('--app-text-color', '#edf4ff');
    root.style.setProperty('--header-bg-color', '#151d2a');
    root.style.setProperty('--border-color', '#243246');
    root.style.setProperty('--card-bg-color', '#1a2433');
    root.style.setProperty('--card-border-color', '#2b3950');
    root.style.setProperty('--text-secondary', '#9aabc6');
    root.style.setProperty('--text-tertiary', '#75859d');
    root.style.setProperty('--input-bg-color', '#101824');
    root.style.setProperty('--input-border-color', '#2b3a50');
    root.style.setProperty('--input-text-color', '#edf4ff');
    root.style.setProperty('--btn-secondary-bg', '#1a2434');
    root.style.setProperty('--btn-secondary-hover', '#27354c');
    root.style.setProperty('--btn-secondary-text', '#edf4ff');
    root.style.setProperty('--btn-secondary-border', '#2b3950');
    root.style.setProperty('--info-box-bg', 'rgba(32, 53, 85, 0.62)');
    root.style.setProperty('--info-box-border', 'rgba(63, 103, 165, 0.48)');
    root.style.setProperty('--warning-box-bg', 'rgba(88, 63, 26, 0.58)');
    root.style.setProperty('--warning-box-border', 'rgba(168, 127, 54, 0.5)');
    root.style.setProperty('--info-panel-bg', 'rgba(20, 31, 46, 0.78)');
    root.style.setProperty('--info-panel-border', '#2b3950');
    root.style.setProperty('--modal-overlay', 'rgba(10, 15, 24, 0.78)');
    root.style.setProperty('--bg-gradient', 'linear-gradient(180deg, #0a0f17 0%, #111826 52%, #0f141d 100%)');
    root.style.setProperty('--bg-pattern', 'radial-gradient(circle at 18% -10%, rgba(99, 162, 255, 0.22), transparent 38%), radial-gradient(circle at 88% 110%, rgba(57, 106, 181, 0.2), transparent 40%)');
    root.style.setProperty('--badge-gray', '#6c7f99');
    root.style.setProperty('--badge-blue', '#4e8ad9');
    root.style.setProperty('--badge-orange-red', '#c86b4a');
    root.style.setProperty('--badge-yellow', '#c7a340');
    root.style.setProperty('--badge-green', '#3da571');
    root.style.setProperty('--badge-red', '#cc6767');
    root.style.setProperty('--badge-orange', '#d28740');
    root.style.setProperty('--badge-cyan', '#3f9dc0');
    root.style.setProperty('--update-version-color', '#f1a647');
    root.style.setProperty('--update-version-bg', 'rgba(241, 166, 71, 0.14)');
    root.style.setProperty('--primary-btn-color', '#4e8ad9');
    root.style.setProperty('--primary-btn-hover', '#5c98e6');
    applySharedThemeTokens(root, {
      appTextColorSecondary: '#9aabc6',
      textTertiary: '#75859d',
      workspaceStroke: '#2b3950',
      workspaceStrokeSoft: '#243246',
      workspaceTitleColor: '#edf4ff',
      workspaceCopyColor: '#9aabc6',
      workspaceEyebrowColor: '#75859d',
      workspaceSurfaceCard: '#1a2433',
      workspaceSurfaceCardStrong: '#151d2a',
      workspaceSurfaceMuted: '#101824',
      workspaceSurfaceMutedSoft: '#101824',
      workspacePathSurface: '#101824',
      workspaceIconSurface: '#4e8ad9',
    });
  } else {
    root.style.setProperty('color-scheme', 'dark');
    root.style.setProperty('--app-bg-color', '#11161d');
    root.style.setProperty('--app-text-color', '#e9eef6');
    root.style.setProperty('--header-bg-color', '#1a222d');
    root.style.setProperty('--border-color', '#2b3644');
    root.style.setProperty('--card-bg-color', '#1d2631');
    root.style.setProperty('--card-border-color', '#344253');
    root.style.setProperty('--text-secondary', '#a4afbf');
    root.style.setProperty('--text-tertiary', '#7f8d9e');
    root.style.setProperty('--input-bg-color', '#151d27');
    root.style.setProperty('--input-border-color', '#334154');
    root.style.setProperty('--input-text-color', '#eef3fb');
    root.style.setProperty('--btn-secondary-bg', '#202a37');
    root.style.setProperty('--btn-secondary-hover', '#2b394a');
    root.style.setProperty('--btn-secondary-text', '#e9eef6');
    root.style.setProperty('--btn-secondary-border', '#344253');
    root.style.setProperty('--primary-btn-color', '#537fd4');
    root.style.setProperty('--primary-btn-hover', '#6493e5');
    root.style.setProperty('--badge-gray', '#6d7787');
    root.style.setProperty('--badge-blue', '#5b83d2');
    root.style.setProperty('--badge-orange-red', '#c6704f');
    root.style.setProperty('--badge-yellow', '#c3a048');
    root.style.setProperty('--badge-green', '#46966a');
    root.style.setProperty('--badge-red', '#c36d6d');
    root.style.setProperty('--badge-orange', '#cb8444');
    root.style.setProperty('--badge-cyan', '#4495ab');
    root.style.setProperty('--update-version-color', '#e1a44d');
    root.style.setProperty('--update-version-bg', 'rgba(225, 164, 77, 0.16)');
    root.style.setProperty('--info-box-bg', 'rgba(38, 59, 91, 0.62)');
    root.style.setProperty('--info-box-border', 'rgba(70, 102, 149, 0.5)');
    root.style.setProperty('--warning-box-bg', 'rgba(92, 63, 29, 0.6)');
    root.style.setProperty('--warning-box-border', 'rgba(145, 108, 56, 0.52)');
    root.style.setProperty('--info-panel-bg', 'rgba(24, 32, 42, 0.82)');
    root.style.setProperty('--info-panel-border', '#344253');
    root.style.setProperty('--modal-overlay', 'rgba(6, 9, 14, 0.74)');
    root.style.setProperty('--bg-gradient', 'linear-gradient(180deg, #0d1117 0%, #141a22 54%, #11161d 100%)');
    root.style.setProperty('--bg-pattern', 'radial-gradient(circle at 16% -10%, rgba(83, 127, 197, 0.13), transparent 34%), radial-gradient(circle at 88% 108%, rgba(63, 88, 128, 0.11), transparent 42%)');
    applySharedThemeTokens(root, {
      appTextColorSecondary: '#a4afbf',
      textTertiary: '#7f8d9e',
      workspaceStroke: '#344253',
      workspaceStrokeSoft: '#2b3644',
      workspaceTitleColor: '#e9eef6',
      workspaceCopyColor: '#a4afbf',
      workspaceEyebrowColor: '#7f8d9e',
      workspaceSurfaceCard: '#1d2631',
      workspaceSurfaceCardStrong: '#1a222d',
      workspaceSurfaceMuted: '#151d27',
      workspaceSurfaceMutedSoft: '#151d27',
      workspacePathSurface: '#151d27',
      workspaceIconSurface: '#537fd4',
    });
  }

  document.body.style.backgroundColor = theme === 'light' ? '#e8eef6' : theme === 'modern-blue' ? '#0f141d' : '#11161d';
  document.body.style.color = theme === 'light' ? '#1f2835' : theme === 'modern-blue' ? '#edf4ff' : '#e9eef6';
};
