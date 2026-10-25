import type { LaunchMethod } from '../stores/gameLaunchStore';

export const PREFERRED_LAUNCH_METHOD_STORAGE_KEY = 'simm-preferred-launch-method';

/**
 * Reads the launch method the user chose for an environment in its menu
 * ("Use Steam Launch" / "Use Local Launch"). Every Launch button in the shell
 * must honour it, not only the one on the environment overview.
 */
export function readPreferredLaunchMethod(
  environmentId: string,
  platform: string | undefined,
): LaunchMethod {
  if ((platform ?? 'windows') === 'linux') {
    return 'steam';
  }

  try {
    const saved = localStorage.getItem(PREFERRED_LAUNCH_METHOD_STORAGE_KEY);
    if (!saved) {
      return 'steam';
    }
    const parsed = JSON.parse(saved) as Record<string, unknown>;
    return parsed[environmentId] === 'direct' ? 'direct' : 'steam';
  } catch {
    return 'steam';
  }
}
