import type { ScanResult } from './mlvscan';

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

export type TrackedDownloadKind = 'game' | 'mod' | 'plugin' | 'framework';

export interface TrackedDownload {
  id: string;
  kind: TrackedDownloadKind;
  label: string;
  contextLabel: string;
  status: 'queued' | 'downloading' | 'validating' | 'completed' | 'error' | 'cancelled';
  progress: number;
  downloadedFiles?: number;
  totalFiles?: number;
  message?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number | null;
}

/** Result of `extract_game_version` (Steam entries include reconciled branch/runtime). */
export interface ExtractGameVersionResult {
  version: string | null;
  branch?: string;
  runtime?: 'IL2CPP' | 'Mono';
}

export interface Environment {
  id: string;
  name: string;
  description?: string;
  appId: string;
  branch: string;
  outputDir: string;
  runtime: 'IL2CPP' | 'Mono';
  status: 'not_downloaded' | 'downloading' | 'completed' | 'unavailable' | 'error';
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
  theme: 'light' | 'dark' | 'modern-blue';
  melonLoaderVersion?: string;
  autoInstallMelonLoader?: boolean;
  enableSecurityScanner?: boolean;
  autoInstallSecurityScanner?: boolean;
  blockCriticalScans?: boolean;
  promptOnHighScans?: boolean;
  showSecurityScanBadges?: boolean;
  updateCheckInterval?: number;
  autoCheckUpdates?: boolean;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  nexusModsApiKey?: string;
  nexusModsRateLimits?: NexusRateLimits | null;
  nexusModsGameId?: string;
  thunderstoreGameId?: string;
  autoUpdateMods?: boolean;
  modUpdateCheckInterval?: number;
  modIconCacheLimitMb?: number;
  databaseBackupCount?: number;
}

export interface NexusRateLimits {
  daily: number;
  hourly: number;
  dailyRemaining?: number;
  hourlyRemaining?: number;
  dailyUsed?: number;
  hourlyUsed?: number;
}

export type ConfigFileType = 'MelonPreferences' | 'LoaderConfig' | 'Json' | 'Other';

export interface ConfigEntry {
  key: string;
  value: string;
  comment?: string;
}

export interface ConfigSection {
  name: string;
  entries: ConfigEntry[];
}

export interface ConfigGroup {
  id: string;
  label: string;
  sectionNames: string[];
}

export interface ConfigFileSummary {
  name: string;
  path: string;
  fileType: ConfigFileType;
  format: string;
  relativePath: string;
  groupName: string;
  lastModified?: number;
  sectionCount: number;
  entryCount: number;
  supportsStructuredEdit: boolean;
  supportsRawEdit: boolean;
}

export interface ConfigDocument {
  summary: ConfigFileSummary;
  rawContent: string;
  sections: ConfigSection[];
  parseWarnings: string[];
  groups: ConfigGroup[];
}

export type ConfigEditOperation =
  | { kind: 'setValue'; section: string; key: string; value: string }
  | { kind: 'setComment'; section: string; key: string; comment?: string | null }
  | { kind: 'addSection'; section: string }
  | { kind: 'deleteSection'; section: string }
  | { kind: 'addEntry'; section: string; key: string; value: string; comment?: string | null }
  | { kind: 'deleteEntry'; section: string; key: string };

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
  summary?: string;
  iconUrl?: string;
  iconCachePath?: string;
  downloads?: number;
  likesOrEndorsements?: number;
  updatedAt?: string;
  tags?: string[];
  installedVersion?: string;
  libraryAddedAt?: number;
  installedAt?: number;
  author?: string;
  updateAvailable?: boolean;
  remoteVersion?: string;
  managed: boolean;
  installedIn: string[];
  availableRuntimes: Array<'IL2CPP' | 'Mono'>;
  storageIdsByRuntime: Partial<Record<'IL2CPP' | 'Mono', string>>;
  installedInByRuntime: Partial<Record<'IL2CPP' | 'Mono', string[]>>;
  filesByRuntime: Partial<Record<'IL2CPP' | 'Mono', string[]>>;
  securityScan?: SecurityScanSummary;
}

export interface ModLibraryResult {
  downloaded: ModLibraryEntry[];
}

export type SecurityScanState = 'verified' | 'review' | 'unavailable' | 'disabled' | 'skipped';
export type SecurityFindingSeverity = 'Low' | 'Medium' | 'High' | 'Critical';

export interface SecurityScanSummary {
  state: SecurityScanState;
  verified: boolean;
  highestSeverity?: SecurityFindingSeverity;
  totalFindings: number;
  threatFamilyCount: number;
  scannedAt?: number;
  scannerVersion?: string;
  schemaVersion?: string;
  statusMessage?: string;
}

export interface SecurityScanPolicy {
  enabled: boolean;
  requiresConfirmation: boolean;
  blocked: boolean;
  promptOnHighFindings: boolean;
  blockCriticalFindings: boolean;
  statusMessage?: string;
}

export interface SecurityScanFileReport {
  fileName: string;
  displayPath: string;
  sha256Hash?: string;
  highestSeverity?: SecurityFindingSeverity;
  totalFindings: number;
  threatFamilyCount: number;
  result: ScanResult;
}

export interface SecurityScanReport {
  summary: SecurityScanSummary;
  policy: SecurityScanPolicy;
  files: SecurityScanFileReport[];
}

export interface SecurityScannerStatus {
  enabled: boolean;
  autoInstall: boolean;
  installed: boolean;
  installMethod?: string;
  installedVersion?: string;
  latestVersion?: string;
  schemaVersion?: string;
  executablePath?: string;
  updateAvailable?: boolean;
  lastError?: string;
}

export type { ScanResult, Finding, ThreatFamily, ThreatFamilyEvidence, DeveloperGuidance, Severity, CallChain, DataFlowChain } from './mlvscan';
