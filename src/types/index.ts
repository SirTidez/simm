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
  environmentType?: 'Steam' | 'DepotDownloader' | 'steam' | 'depotDownloader' | 'local';
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
  theme: 'light' | 'dark' | 'modern-blue' | 'custom';
  customTheme?: CustomTheme;
  melonLoaderVersion?: string;
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

export interface CustomTheme {
  appBgColor: string;
  appTextColor: string;
  headerBgColor: string;
  borderColor: string;
  cardBgColor: string;
  cardBorderColor: string;
  textSecondary: string;
  inputBgColor: string;
  inputBorderColor: string;
  inputTextColor: string;
  btnSecondaryBg: string;
  btnSecondaryHover: string;
  btnSecondaryText: string;
  btnSecondaryBorder: string;
  infoBoxBg: string;
  infoBoxBorder: string;
  warningBoxBg: string;
  warningBoxBorder: string;
  infoPanelBg: string;
  infoPanelBorder: string;
  modalOverlay: string;
  bgGradient: string;
  bgPattern: string;
  badgeGray: string;
  badgeBlue: string;
  badgeOrangeRed: string;
  badgeYellow: string;
  badgeGreen: string;
  badgeRed: string;
  badgeOrange: string;
  badgeCyan: string;
  updateVersionColor: string;
  updateVersionBg: string;
  primaryBtnColor: string;
  primaryBtnHover: string;
}

export interface NexusMod {
  mod_id: number;
  name: string;
  summary: string;
  description: string;
  picture_url?: string;
  version: string;
  author: string;
  uploaded_time: string;
  updated_time: string;
  category_id: number;
  contains_adult_content: boolean;
  status: string;
  endorsement_count: number;
  unique_downloads: number;
  mod_downloads: number;
}

export interface NexusModFile {
  file_id: number;
  name: string;
  version: string;
  category_id: number;
  category_name: string;
  is_primary: boolean;
  size: number;
  file_name: string;
  uploaded_timestamp: number;
  mod_version: string;
}

export interface ModLibraryEntry {
  storageId: string;
  displayName: string;
  files: string[];
  source?: 'local' | 'thunderstore' | 'nexusmods' | 'github' | 'unknown';
  sourceId?: string;
  sourceVersion?: string;
  sourceUrl?: string;
  installedVersion?: string;
  author?: string;
  updateAvailable?: boolean;
  remoteVersion?: string;
  managed: boolean;
  installedIn: string[];
  availableRuntimes: Array<'IL2CPP' | 'Mono'>;
  storageIdsByRuntime: Partial<Record<'IL2CPP' | 'Mono', string>>;
  installedInByRuntime: Partial<Record<'IL2CPP' | 'Mono', string[]>>;
  filesByRuntime: Partial<Record<'IL2CPP' | 'Mono', string[]>>;
}

export interface ModLibraryResult {
  downloaded: ModLibraryEntry[];
}
