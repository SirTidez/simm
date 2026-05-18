import type { Environment } from '../types';

export function isSteamEnvironment(env: Pick<Environment, 'environmentType' | 'id'>): boolean {
  return env.environmentType === 'Steam' || env.environmentType === 'steam' || env.id.startsWith('steam-');
}

export function sortEnvironmentsForDisplay(environments: Environment[]): Environment[] {
  return [...environments].sort((left, right) => {
    const leftIsSteam = isSteamEnvironment(left);
    const rightIsSteam = isSteamEnvironment(right);
    if (leftIsSteam && !rightIsSteam) return -1;
    if (!leftIsSteam && rightIsSteam) return 1;
    return 0;
  });
}
