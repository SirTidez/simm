import type { Environment } from '../../types';
import { isSteamEnvironment } from '../../utils/environmentOrdering';

export type EnvironmentTone = 'ok' | 'warn' | 'danger' | 'info' | 'muted';

export interface EnvironmentStatusSummary {
  tone: EnvironmentTone;
  label: string;
}

export function runtimeLabel(runtime: Environment['runtime']): 'IL2CPP' | 'Mono' {
  return runtime === 'IL2CPP' ? 'IL2CPP' : 'Mono';
}

export function runtimeTagClass(runtime: Environment['runtime']): string {
  return runtime === 'IL2CPP' ? 'ui-tag ui-tag--il2cpp' : 'ui-tag ui-tag--mono';
}

export function environmentSourceLabel(environment: Environment): string {
  return isSteamEnvironment(environment) ? 'Steam' : environment.branch;
}

export function environmentGameVersion(environment: Environment): string | null {
  return environment.currentGameVersion ?? null;
}

/**
 * The single status an environment shows wherever it appears (sidebar, home,
 * workspace header). Ordered by what the player has to deal with first.
 */
export function summarizeEnvironmentStatus(
  environment: Environment,
  modUpdateCount = 0,
): EnvironmentStatusSummary {
  switch (environment.status) {
    case 'downloading':
      return { tone: 'info', label: 'Downloading' };
    case 'not_downloaded':
      return { tone: 'muted', label: 'Not installed' };
    case 'unavailable':
      return { tone: 'danger', label: 'Folder missing' };
    case 'error':
      return { tone: 'danger', label: 'Needs attention' };
    default:
      break;
  }

  const modLabel = modUpdateCount === 1 ? '1 mod update' : `${modUpdateCount} mod updates`;

  if (environment.updateAvailable) {
    return { tone: 'warn', label: modUpdateCount > 0 ? `Game update · ${modLabel}` : 'Game update' };
  }

  if (modUpdateCount > 0) {
    return { tone: 'warn', label: modLabel };
  }

  return { tone: 'ok', label: 'Ready' };
}
