export function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  if (error && typeof error === 'object') {
    if ('message' in error && typeof error.message === 'string' && error.message.trim()) {
      return error.message;
    }

    if ('error' in error && typeof error.error === 'string' && error.error.trim()) {
      return error.error;
    }
  }

  return fallback;
}

export function isSteamShortcutReloadError(message: string): boolean {
  return message.includes("Steam needs to reload SIMM's shortcut");
}
