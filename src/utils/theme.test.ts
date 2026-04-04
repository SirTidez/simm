import { beforeEach, describe, expect, it } from 'vitest';
import type { CustomThemeDefinition } from '../types';
import {
  applyThemeSelection,
  normalizeThemeSelection,
  readCachedThemeBaseSelection,
  THEME_BASE_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from './theme';

const customTheme: CustomThemeDefinition = {
  id: 'sunset',
  name: 'Sunset',
  baseTheme: 'dark',
  filePath: 'C:/SIMM/themes/sunset.json',
  variables: {
    '--app-bg-color': '#1b120f',
  },
};

describe('theme helpers', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-custom-theme');
    document.documentElement.style.cssText = '';
    document.body.style.cssText = '';
  });

  it('canonicalizes built-in themes case-insensitively', () => {
    expect(normalizeThemeSelection(' Dark ')).toBe('dark');
    expect(normalizeThemeSelection('LIGHT')).toBe('light');
    expect(normalizeThemeSelection('MODERN-BLUE')).toBe('modern-blue');
    expect(normalizeThemeSelection('sunset-glow')).toBe('sunset-glow');
    expect(normalizeThemeSelection('custom')).toBe('modern-blue');
  });

  it('caches the resolved built-in base theme for custom themes', () => {
    const resolvedTheme = applyThemeSelection('sunset', [customTheme]);

    expect(resolvedTheme).toBe('sunset');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('sunset');
    expect(window.localStorage.getItem(THEME_BASE_STORAGE_KEY)).toBe('dark');
    expect(readCachedThemeBaseSelection()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-custom-theme')).toBe('sunset');
  });
});
