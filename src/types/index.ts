export interface DepotDownloaderInfo {
  installed: boolean;
  path?: string;
  version?: string;
  method?: 'path' | 'winget' | 'homebrew' | 'manual';
}

export interface DownloadProgress {
  downloadId: string;
  status: 'queued' | 'downloading' | 'validating' | 'completed' | 'error' | 'cancelled';
  progress: number;
  downloadedFiles?: number;
  totalFiles?: number;
  speed?: string;
  eta?: string;
  message?: string;
  error?: string;
}

export interface Environment {
  id: string;
  name: string;
  description?: string;
  appId: string;
  branch: string;
  outputDir: string;
  runtime: 'IL2CPP' | 'Mono';
  status: 'not_downloaded' | 'downloading' | 'completed' | 'error';
  lastUpdated?: string;
  size?: number;
  lastManifestId?: string;
  lastUpdateCheck?: string | number; // Can be ISO string or timestamp (seconds)
  updateAvailable?: boolean;
  remoteManifestId?: string;
  remoteBuildId?: string;
  currentGameVersion?: string;
  updateGameVersion?: string;
  melonLoaderVersion?: string;
  environmentType?: 'Steam' | 'DepotDownloader';
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentManifestId?: string;
  remoteManifestId?: string;
  remoteBuildId?: string;
  branch: string;
  appId: string;
  checkedAt: string;
  error?: string;
  currentGameVersion?: string;
  updateGameVersion?: string;
}

export interface AppConfig {
  appId: string;
  name: string;
  branches: BranchConfig[];
}

export interface BranchConfig {
  name: string;
  displayName: string;
  runtime: 'IL2CPP' | 'Mono';
  requiresAuth: boolean;
}

export interface Settings {
  defaultDownloadDir: string;
  depotDownloaderPath?: string;
  steamUsername?: string;
  maxConcurrentDownloads: number;
  platform: 'windows' | 'macos' | 'linux';
  language: string;
  theme: 'light' | 'dark';
  melonLoaderZipPath?: string;
  autoInstallMelonLoader?: boolean;
  updateCheckInterval?: number;
  autoCheckUpdates?: boolean;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  nexusModsApiKey?: string;
  nexusModsGameId?: string;
  thunderstoreGameId?: string;
  autoUpdateMods?: boolean;
  modUpdateCheckInterval?: number;
  // Note: githubToken is NOT stored here - it's stored encrypted separately
}

