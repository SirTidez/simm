const NEXUS_FORCE_FREE_MODE_KEY = 'simm.nexus.forceFreeMode';
const NEXUS_FORCE_FREE_MODE_EVENT = 'nexus-force-free-mode-changed';

export interface NexusOAuthStatusLike {
  connected: boolean;
  account?: {
    name?: string;
    memberId?: number;
    isPremium?: boolean;
    isSupporter?: boolean;
    canDirectDownload?: boolean;
    requiresSiteConfirmation?: boolean;
  };
}

export function isNexusForceFreeModeEnabled(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.localStorage.getItem(NEXUS_FORCE_FREE_MODE_KEY) === 'true';
}

export function setNexusForceFreeModeEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') {
    return;
  }

  if (enabled) {
    window.localStorage.setItem(NEXUS_FORCE_FREE_MODE_KEY, 'true');
  } else {
    window.localStorage.removeItem(NEXUS_FORCE_FREE_MODE_KEY);
  }

  window.dispatchEvent(new CustomEvent(NEXUS_FORCE_FREE_MODE_EVENT, { detail: { enabled } }));
}

export function onNexusForceFreeModeChanged(listener: (enabled: boolean) => void): () => void {
  const handleChange = (event: Event) => {
    const detail = (event as CustomEvent<{ enabled?: boolean }>).detail;
    listener(!!detail?.enabled);
  };

  const handleStorage = (event: StorageEvent) => {
    if (event.key === NEXUS_FORCE_FREE_MODE_KEY) {
      listener(event.newValue === 'true');
    }
  };

  window.addEventListener(NEXUS_FORCE_FREE_MODE_EVENT, handleChange as EventListener);
  window.addEventListener('storage', handleStorage);

  return () => {
    window.removeEventListener(NEXUS_FORCE_FREE_MODE_EVENT, handleChange as EventListener);
    window.removeEventListener('storage', handleStorage);
  };
}

export function canForceFreeMode(status: NexusOAuthStatusLike): boolean {
  return !!(
    status.connected &&
    status.account &&
    (
      status.account.isPremium ||
      status.account.isSupporter ||
      status.account.canDirectDownload
    )
  );
}

export function applyNexusAccessModeOverride<T extends NexusOAuthStatusLike>(status: T): T {
  if (!isNexusForceFreeModeEnabled() || !canForceFreeMode(status) || !status.account) {
    return status;
  }

  return {
    ...status,
    account: {
      ...status.account,
      canDirectDownload: false,
      requiresSiteConfirmation: true,
    },
  };
}
