import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ConfigurationOverlay } from './ConfigurationOverlay';
import type { ConfigDocument, ConfigFileSummary, Environment } from '../types';

const apiMocks = vi.hoisted(() => ({
  getConfigCatalog: vi.fn(),
  getConfigDocument: vi.fn(),
  applyConfigEdits: vi.fn(),
  saveRawConfig: vi.fn(),
  openPath: vi.fn(),
  revealPath: vi.fn(),
}));

vi.mock('../services/api', () => ({
  ApiService: apiMocks,
}));

const environment: Environment = {
  id: 'env-1',
  name: 'Steam Install',
  appId: '3164500',
  branch: 'default',
  outputDir: 'C:/Games/Schedule I',
  runtime: 'Mono',
  status: 'completed',
};

function makeSummary(overrides: Partial<ConfigFileSummary>): ConfigFileSummary {
  return {
    name: 'Loader.cfg',
    path: 'C:/Games/Schedule I/MelonLoader/Loader.cfg',
    fileType: 'LoaderConfig',
    format: 'ini',
    relativePath: 'MelonLoader/Loader.cfg',
    groupName: 'Loader',
    sectionCount: 1,
    entryCount: 1,
    supportsStructuredEdit: true,
    supportsRawEdit: true,
    ...overrides,
  };
}

function makeDocument(overrides: Partial<ConfigDocument>): ConfigDocument {
  return {
    summary: makeSummary({}),
    rawContent: '[General]\nfoo = bar',
    sections: [
      {
        name: 'General',
        entries: [
          { key: 'foo', value: 'bar' },
        ],
      },
    ],
    parseWarnings: [],
    groups: [],
    ...overrides,
  };
}

describe('ConfigurationOverlay', () => {
  beforeEach(() => {
    apiMocks.getConfigCatalog.mockReset();
    apiMocks.getConfigDocument.mockReset();
    apiMocks.applyConfigEdits.mockReset();
    apiMocks.saveRawConfig.mockReset();
    apiMocks.openPath.mockReset();
    apiMocks.revealPath.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders discovered config files and falls back to raw mode for parse-limited files', async () => {
    apiMocks.getConfigCatalog.mockResolvedValue([
      makeSummary({ name: 'Loader.cfg', path: 'C:/Games/Schedule I/MelonLoader/Loader.cfg', fileType: 'LoaderConfig' }),
      makeSummary({
        name: 'Custom.cfg',
        path: 'C:/Games/Schedule I/UserData/Custom.cfg',
        fileType: 'Other',
        relativePath: 'UserData/Custom.cfg',
        groupName: 'UserData Root',
        supportsStructuredEdit: false,
      }),
      makeSummary({
        name: 'ModSettings.json',
        path: 'C:/Games/Schedule I/UserData/CoolMod/ModSettings.json',
        fileType: 'Json',
        format: 'json',
        relativePath: 'UserData/CoolMod/ModSettings.json',
        groupName: 'CoolMod',
        sectionCount: 0,
        entryCount: 0,
        supportsStructuredEdit: false,
      }),
    ]);

    apiMocks.getConfigDocument.mockImplementation(async (_environmentId: string, filePath: string) => {
      if (filePath.endsWith('Custom.cfg')) {
        return makeDocument({
          summary: makeSummary({
            name: 'Custom.cfg',
            path: filePath,
            fileType: 'Other',
            relativePath: 'UserData/Custom.cfg',
            groupName: 'UserData Root',
            supportsStructuredEdit: false,
          }),
          rawContent: '[General]\nunsupported line',
          sections: [],
          parseWarnings: ['Line 2 is not supported by the structured parser: unsupported line'],
        });
      }

      if (filePath.endsWith('ModSettings.json')) {
        return makeDocument({
          summary: makeSummary({
            name: 'ModSettings.json',
            path: filePath,
            fileType: 'Json',
            format: 'json',
            relativePath: 'UserData/CoolMod/ModSettings.json',
            groupName: 'CoolMod',
            supportsStructuredEdit: false,
            sectionCount: 0,
            entryCount: 0,
          }),
          rawContent: '{\n  "enabled": true\n}',
          sections: [],
          parseWarnings: ['Structured editing is not currently available for JSON configuration files.'],
        });
      }

      return makeDocument({
        summary: makeSummary({
          name: 'Loader.cfg',
          path: filePath,
          fileType: 'LoaderConfig',
          relativePath: 'MelonLoader/Loader.cfg',
          groupName: 'Loader',
        }),
      });
    });

    render(
      <ConfigurationOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        environment={environment}
      />
    );

    expect(await screen.findByRole('button', { name: /Loader\.cfg/i })).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Custom\.cfg/i })).toBeTruthy();
    expect(await screen.findByText('CoolMod')).toBeTruthy();
    expect(await screen.findByRole('button', { name: /ModSettings\.json/i })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Custom\.cfg/i }));

    expect(await screen.findByText('Structured editing is unavailable for part of this file.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Structured' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Raw' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Loader\.cfg/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'General' })).toBeTruthy();
    });
  });

  it('prefers MelonPreferences as the initial file when it is available', async () => {
    apiMocks.getConfigCatalog.mockResolvedValue([
      makeSummary({
        name: 'Loader.cfg',
        path: 'C:/Games/Schedule I/MelonLoader/Loader.cfg',
        fileType: 'LoaderConfig',
        relativePath: 'MelonLoader/Loader.cfg',
        groupName: 'Loader',
      }),
      makeSummary({
        name: 'MelonPreferences.cfg',
        path: 'C:/Games/Schedule I/UserData/MelonPreferences.cfg',
        fileType: 'MelonPreferences',
        relativePath: 'UserData/MelonPreferences.cfg',
        groupName: 'MelonPreferences',
      }),
    ]);
    apiMocks.getConfigDocument.mockImplementation(async (_environmentId: string, filePath: string) =>
      makeDocument({
        summary: makeSummary({
          name: filePath.endsWith('MelonPreferences.cfg') ? 'MelonPreferences.cfg' : 'Loader.cfg',
          path: filePath,
          fileType: filePath.endsWith('MelonPreferences.cfg') ? 'MelonPreferences' : 'LoaderConfig',
          relativePath: filePath.endsWith('MelonPreferences.cfg')
            ? 'UserData/MelonPreferences.cfg'
            : 'MelonLoader/Loader.cfg',
          groupName: filePath.endsWith('MelonPreferences.cfg') ? 'MelonPreferences' : 'Loader',
        }),
      })
    );

    render(
      <ConfigurationOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        environment={environment}
      />
    );

    expect(await screen.findByText('MelonPreferences.cfg')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'MelonPreferences.cfg' })).toBeTruthy();
    });
  });

  it('matches config explorer searches against loaded file contents', async () => {
    apiMocks.getConfigCatalog.mockResolvedValue([
      makeSummary({ name: 'Loader.cfg', path: 'C:/Games/Schedule I/MelonLoader/Loader.cfg' }),
      makeSummary({
        name: 'Gameplay.cfg',
        path: 'C:/Games/Schedule I/UserData/SomeMod/Gameplay.cfg',
        fileType: 'Other',
        relativePath: 'UserData/SomeMod/Gameplay.cfg',
        groupName: 'SomeMod',
      }),
    ]);

    apiMocks.getConfigDocument.mockImplementation(async (_environmentId: string, filePath: string) => {
      if (filePath.endsWith('Gameplay.cfg')) {
        return makeDocument({
          summary: makeSummary({
            name: 'Gameplay.cfg',
            path: filePath,
            fileType: 'Other',
            relativePath: 'UserData/SomeMod/Gameplay.cfg',
            groupName: 'SomeMod',
          }),
          rawContent: '[Economy]\nDealerCutMultiplier = 1.25',
          sections: [
            {
              name: 'Economy',
              entries: [
                { key: 'DealerCutMultiplier', value: '1.25', comment: 'Adjusts dealer payouts' },
              ],
            },
          ],
        });
      }

      return makeDocument({
        summary: makeSummary({ name: 'Loader.cfg', path: filePath }),
        rawContent: '[General]\nfoo = bar',
      });
    });

    render(
      <ConfigurationOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        environment={environment}
      />
    );

    expect(await screen.findByRole('button', { name: /Loader\.cfg/i })).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('Search config files'), {
      target: { value: 'DealerCutMultiplier' },
    });

    expect(await screen.findByRole('button', { name: /Gameplay\.cfg/i })).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Economy/i })).toBeTruthy();
    expect(await screen.findByRole('button', { name: /DealerCutMultiplier/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Loader\.cfg/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Economy/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Gameplay.cfg' })).toBeTruthy();
      expect(screen.getByRole('heading', { name: 'Economy' })).toBeTruthy();
    });
  });

  it('saves structured edits through applyConfigEdits', async () => {
    apiMocks.getConfigCatalog.mockResolvedValue([
      makeSummary({ name: 'Loader.cfg', path: 'C:/Games/Schedule I/MelonLoader/Loader.cfg' }),
    ]);
    apiMocks.getConfigDocument.mockResolvedValue(
      makeDocument({
        summary: makeSummary({ name: 'Loader.cfg', path: 'C:/Games/Schedule I/MelonLoader/Loader.cfg' }),
      })
    );
    apiMocks.applyConfigEdits.mockResolvedValue(undefined);

    render(
      <ConfigurationOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        environment={environment}
      />
    );

    expect(await screen.findByRole('button', { name: /Loader\.cfg/i })).toBeTruthy();

    const valueInput = await screen.findByRole('textbox', { name: 'Value for foo' });
    fireEvent.change(valueInput, { target: { value: 'baz' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(apiMocks.applyConfigEdits).toHaveBeenCalledWith(
        'env-1',
        'C:/Games/Schedule I/MelonLoader/Loader.cfg',
        [{ kind: 'setValue', section: 'General', key: 'foo', value: 'baz' }]
      );
    });
  });

  it('does not block wheel scrolling on the raw editor wrapper', async () => {
    apiMocks.getConfigCatalog.mockResolvedValue([
      makeSummary({ name: 'Loader.cfg', path: 'C:/Games/Schedule I/MelonLoader/Loader.cfg' }),
    ]);
    apiMocks.getConfigDocument.mockResolvedValue(
      makeDocument({
        summary: makeSummary({ name: 'Loader.cfg', path: 'C:/Games/Schedule I/MelonLoader/Loader.cfg' }),
        rawContent: Array.from({ length: 80 }, (_, index) => `key_${index} = value_${index}`).join('\n'),
      })
    );

    const { container } = render(
      <ConfigurationOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        environment={environment}
      />
    );

    expect(await screen.findByRole('button', { name: /Loader\.cfg/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));

    const rawEditor = await waitFor(() => {
      const element = container.querySelector('.config-raw__editor');
      expect(element).toBeTruthy();
      return element as HTMLElement;
    });

    expect(fireEvent.wheel(rawEditor, { deltaY: 120 })).toBe(true);
  });
});
