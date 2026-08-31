import type {
  ScanResult,
  ThreatDisposition,
} from './mlvscan';

export interface DepotDownloaderInfo {
  installed: boolean;
  path?: string;
  version?: string;
  method?: 'path' | 'winget' | 'homebrew' | 'manual';
  canAutoInstall?: boolean;
  installHelpUrl?: string;
  installHint?: string;
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

/**
 * Credentials supplied only for the DepotDownloader child started by a single
 * download request. They must not be retained in frontend state or settings.
 */
export interface OneTimeDownloadCredentials {
  username: string;
  password: string;
  steamGuard?: string;
  saveCredentials: boolean;
}

export type Runtime = 'IL2CPP' | 'Mono' | 'MONO';

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
  iconUrl?: string;
  iconCachePath?: string;
  message?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number | null;
}

/** Result of `extract_game_version` (Steam entries include reconciled branch/runtime). */
export interface ExtractGameVersionResult {
  version: string | null;
  branch?: string;
  runtime?: Runtime;
}

export interface Environment {
  id: string;
  name: string;
  description?: string;
  appId: string;
  branch: string;
  outputDir: string;
  runtime: Runtime;
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
  steamappsDir?: string;
  steamManifestPath?: string;
  environmentType?: 'Steam' | 'DepotDownloader' | 'steam' | 'depotDownloader' | 'local';
}

export interface GameSaveSlot {
  slotNumber: number;
  organizationName: string | null;
  cashBalance: number | null;
  onlineBalance: number | null;
  netWorth: number | null;
  rank: number | null;
  tier: number | null;
  totalXp: number | null;
  createdAt: string | null;
  lastPlayedAt: string | null;
  lastSaveVersion: string | null;
  path: string;
  exists: boolean;
  sizeBytes: number;
  lastModified: string | null;
  backup: GameSaveBackup | null;
  backups: GameSaveBackup[];
}

export interface GameSaveBackup {
  path: string;
  sizeBytes: number;
  lastModified: string | null;
}

export interface GameSaveAccount {
  steamId: string;
  displayName: string | null;
  path: string;
  backupPath: string;
  slots: GameSaveSlot[];
}

export interface GameSaveBackupStatus {
  available: boolean;
  sourcePath: string;
  accounts: GameSaveAccount[];
  message: string | null;
}

export interface GameSaveBackupResult {
  steamId: string;
  slotNumber: number;
  backup: GameSaveBackup;
  prunedBackupCount: number;
}

export interface GameSaveBackupExportResult {
  steamId: string;
  slotNumber: number;
  path: string;
  sizeBytes: number;
}

export interface GameSaveRestoreResult {
  steamId: string;
  slotNumber: number;
  path: string;
  sizeBytes: number;
}

export interface GameSaveRestorePreview {
  steamId: string;
  slotNumber: number;
  sourceLabel: string;
  sourcePath: string;
  restoreToken: string | null;
  current: GameSaveSlot;
  restored: GameSaveSlot;
}

export interface LinuxMelonLoaderRequirements {
  appId: string;
  protontricksInstalled: boolean;
  protontricksCommand: string;
  canInstallPrerequisites: boolean;
  prerequisiteCommands: string[];
  prerequisiteAppId?: string | null;
  requiredPrerequisites?: string[];
  installedPrerequisites?: string[];
  missingPrerequisites?: string[];
  prerequisitesInstalled?: boolean | null;
  prerequisiteStatus?: 'installed' | 'missing' | 'unknown';
  prerequisiteStatusPath?: string | null;
  prerequisiteStatusError?: string | null;
  launchOptions: string;
  steamLaunchOptions?: string | null;
  steamLaunchOptionsConfigured?: boolean | null;
  steamLaunchOptionsRepairable?: boolean | null;
  needsSteamLaunchOptionsRepair?: boolean | null;
  steamLaunchOptionsPath?: string | null;
  warnings: string[];
}

export interface MelonLoaderStatus {
  installed: boolean;
  version?: string;
  linuxRequirements?: LinuxMelonLoaderRequirements | null;
}

export interface MelonLoaderLaunchOptionsRepairResult {
  success: boolean;
  message?: string;
  linuxPrerequisiteMessage?: string | null;
  linuxRequirements?: LinuxMelonLoaderRequirements | null;
  steamLaunchOptions?: {
    configured: boolean;
    repairable: boolean;
    required: string;
    current?: string | null;
    configPath?: string | null;
  } | null;
  shortcut?: {
    shortcutUrl: string;
    shortcutAppId: number;
    shortcutsFile: string;
    status: string;
    requiresClientReload: boolean;
  } | null;
}

export interface LaunchGameResult {
  success: boolean;
  executablePath?: string;
  launchStartedAt?: number;
  launchMethod?: 'steam' | 'steam_restart' | 'direct' | string;
  environmentId?: string;
}

export interface RuntimeSwitchResult {
  environmentId: string;
  environmentName: string;
  previousBranch: string;
  branch: string;
  previousRuntime: Runtime;
  runtime: Runtime;
  disabledItems: number;
  installedItems: number;
  missingItems: string[];
  errors: string[];
}

export interface MelonLoaderLaunchVerification {
  status: 'confirmed' | 'notInstalled' | 'noLog' | 'staleLog' | 'noConfirmation' | string;
  confirmed: boolean;
  logPath: string;
  modifiedAt?: number | null;
  message: string;
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentManifestId?: string;
  remoteManifestId?: string;
  remoteBuildId?: string;
  branch: string;
  runtime: Runtime;
  runtimeSwitch?: RuntimeSwitchResult;
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

export interface AppUpdateChannelPreferences {
  lastCheckedAt?: string | null;
  lastSeenVersionRaw?: string | null;
  lastSeenVersionNormalized?: string | null;
  lastResolvedUrl?: string | null;
  snoozedUntil?: string | null;
  skippedVersionNormalized?: string | null;
}

export interface AppUpdatePreferences extends AppUpdateChannelPreferences {
  channel?: AppUpdateChannel | null;
  /**
   * Channel-scoped updater history and suppression state. The legacy flat
   * fields above remain readable while existing settings rows are migrated.
   */
  byChannel?: Partial<Record<AppUpdateChannel, AppUpdateChannelPreferences>> | null;
}

export type AppUpdateChannel = 'stable' | 'beta';

export type ExperienceMode = 'player' | 'powerUser';

export interface Settings {
  defaultDownloadDir: string;
  depotDownloaderPath?: string;
  steamUsername?: string;
  depotDownloaderRememberedSession?: boolean;
  maxConcurrentDownloads: number;
  platform: 'windows' | 'macos' | 'linux';
  language: string;
  theme: string;
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
  logRetentionDays?: number;
  appUpdate?: AppUpdatePreferences | null;
  experienceMode?: ExperienceMode | null;
  showAdvancedGameTools?: boolean | null;
  windowCloseBehavior?: 'ask' | 'tray' | 'quit' | null;
  setupGuideCompleted?: boolean | null;
}

export interface AppStartupState {
  simmDirectoryCreated: boolean;
  databaseCreated: boolean;
}

export type LinuxReadinessCheckStatus =
  | 'ready'
  | 'warning'
  | 'missing'
  | 'unknown'
  | 'notApplicable';

export interface LinuxReadinessCheck {
  id: string;
  label: string;
  status: LinuxReadinessCheckStatus;
  detail: string;
  command?: string | null;
  path?: string | null;
}

export interface LinuxDesktopSchemeStatus {
  scheme: string;
  handler?: string | null;
  ready: boolean;
  detail: string;
}

export interface LinuxReadinessStatus {
  platform: 'windows' | 'macos' | 'linux';
  available: boolean;
  summary: LinuxReadinessCheckStatus;
  checks: LinuxReadinessCheck[];
  schemeHandlers: LinuxDesktopSchemeStatus[];
}

export interface CustomThemeDefinition {
  id: string;
  name: string;
  baseTheme: 'light' | 'dark' | 'modern-blue';
  filePath: string;
  variables: Record<string, string>;
}

export interface AppUpdateStatus {
  currentVersion: string;
  version: string;
  versionNormalized: string;
  updateAvailable: boolean;
  notes?: string | null;
  pubDate?: string | null;
  channel: AppUpdateChannel;
  manifestUrl: string;
  checkedAt: string;
}

export interface AppUpdateInstallResult {
  installed: boolean;
  version: string;
  channel: AppUpdateChannel;
}

export interface NexusRateLimits {
  daily: number;
  hourly: number;
  dailyRemaining?: number;
  hourlyRemaining?: number;
  dailyUsed?: number;
  hourlyUsed?: number;
}

export interface TelemetryPreferences {
  collectionEnabled: boolean;
  uploadEnabled: boolean;
  errorExcerptsEnabled: boolean;
  retentionDays: number;
  protectLocalMods: boolean;
  updatedAt?: string | null;
}

export interface TelemetryPreferencesUpdate {
  collectionEnabled?: boolean | null;
  uploadEnabled?: boolean | null;
  errorExcerptsEnabled?: boolean | null;
  retentionDays?: number | null;
  protectLocalMods?: boolean | null;
}

export interface TelemetryCapability {
  available: boolean;
}

export type TelemetrySessionEndReason =
  | 'game_exited'
  | 'collection_disabled'
  | 'environment_removed'
  | 'interrupted_process_running'
  | 'interrupted_process_missing';

export type TelemetryModCaptureMode = 'share' | 'local_only' | 'ignore';

export interface TelemetryModPolicyItem {
  modEntry: ModTelemetryModEntry;
  automaticMode: TelemetryModCaptureMode;
  automaticReason?: string | null;
  effectiveMode: TelemetryModCaptureMode;
  globalOverride?: TelemetryModCaptureMode | null;
  environmentOverride?: TelemetryModCaptureMode | null;
}

export interface TelemetryModRuleUpdate {
  modKey: string;
  environmentId?: string | null;
  mode?: TelemetryModCaptureMode | null;
}

export interface LiveTelemetrySession {
  sessionId: string;
  environmentId: string;
  startedAt: string;
  endedAt?: string | null;
  endReason?: TelemetrySessionEndReason | null;
  environment: ModTelemetryEnvironment;
  mods: ModTelemetryModEntry[];
  monitoring: boolean;
}

export interface LiveTelemetryEvent {
  eventId: string;
  sessionId: string;
  environmentId: string;
  occurredAt: string;
  severity: string;
  attribution: 'mod' | 'system' | 'unknown';
  modKey?: string | null;
  modName?: string | null;
  fingerprint: string;
  errorClass: string;
  errorCode?: string | null;
  message?: string | null;
  source: string;
  lineNumber?: number | null;
  origin: 'attach' | 'live';
}

export interface LiveTelemetryStatus {
  environmentId: string;
  running: boolean;
  monitoring: boolean;
  activeSessionId?: string | null;
  eventCount: number;
  lastEventAt?: string | null;
}

export interface LiveTelemetryExport {
  schemaVersion: number;
  exportedAt: string;
  sessions: Array<{
    sessionId: string;
    startedAt: string;
    endedAt?: string | null;
    environment: ModTelemetryEnvironment;
    mods: ModTelemetryModEntry[];
    events: Array<Omit<LiveTelemetryEvent, 'sessionId' | 'environmentId'>>;
  }>;
}

export type TelemetryUploadState = 'pending' | 'sending' | 'accepted' | 'failed';

export interface TelemetryUploadPreview {
  uploadId: string;
  payload: string;
  sessionCount: number;
  eventCount: number;
  exclusions: string[];
}

export interface TelemetryUploadReceipt {
  id: string;
  uploadId: string;
  state: TelemetryUploadState;
  attempts: number;
  lastErrorCode?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModTelemetryCaptureRequest {
  environmentId: string;
  maxLogLines?: number | null;
}

export interface ModTelemetryEnvironment {
  appId: string;
  branch: string;
  runtime: Runtime;
  s1Version?: string | null;
}

export interface ModTelemetryModEntry {
  modKey: string;
  name: string;
  fileName: string;
  version?: string | null;
  source?: 'local' | 'thunderstore' | 'nexusmods' | 'github' | 'unknown' | null;
  author?: string | null;
  managed: boolean;
  disabled: boolean;
}

export interface ModTelemetrySourceError {
  modKey?: string | null;
  modName: string;
  level: string;
  errorClass: string;
  errorCode?: string | null;
  message?: string | null;
  timestamp?: string | null;
  source?: string | null;
  lineNumber?: number | null;
}

export interface ModTelemetrySnapshot {
  schemaVersion: number;
  snapshotId: string;
  createdAt: string;
  environment: ModTelemetryEnvironment;
  mods: ModTelemetryModEntry[];
  errors: ModTelemetrySourceError[];
  uploadReady: boolean;
}

export interface ModTelemetrySnapshotSummary {
  snapshotId: string;
  environmentId: string;
  createdAt: string;
  runtime: Runtime;
  s1Version?: string | null;
  modCount: number;
  errorCount: number;
  uploadReady: boolean;
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
  thumbnail_url?: string;
  version: string;
  author: string;
  uploader?: string;
  uploader_member_id?: number;
  original_author?: string;
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

export interface NexusDependencyCandidate {
  modId: string;
  modName: string;
  modFileId: string;
  modFileName: string;
  versionId: string;
  versionGameScopedId: string;
  version: string;
}

export interface NexusDependencyRequirement {
  id: string;
  candidates: NexusDependencyCandidate[];
}

export interface NexusModFileDependencies {
  sourceVersionId: string;
  requirements: NexusDependencyRequirement[];
}

export interface ModLibraryEntry {
  storageId: string;
  displayName: string;
  files: string[];
  attachedUserLibs: string[];
  attachedUserData?: string[];
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
  availableRuntimes: Runtime[];
  storageIdsByRuntime: Partial<Record<Runtime, string>>;
  installedInByRuntime: Partial<Record<Runtime, string[]>>;
  filesByRuntime: Partial<Record<Runtime, string[]>>;
  securityScan?: SecurityScanSummary;
}

export interface ModLibraryResult {
  downloaded: ModLibraryEntry[];
}

export interface ModProfileManifest {
  schemaVersion: number;
  kind: 'simm.profile' | string;
  profileId?: string | null;
  isDefault?: boolean | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  profile: ModProfileInfo;
  items: ModProfileItem[];
}

export interface ModProfileInfo {
  name: string;
  game: string;
  environmentId?: string | null;
  runtime: Runtime;
  branch: string;
  gameVersion?: string | null;
  exportedAt: string;
}

export type ModProfileItemType = 'mod' | 'plugin' | 'userlib';

export interface ModProfileItem {
  itemType: ModProfileItemType;
  name: string;
  fileName?: string | null;
  required: boolean;
  enabled?: boolean;
  source?: 'local' | 'thunderstore' | 'nexusmods' | 'github' | 'unknown' | null;
  sourceId?: string | null;
  sourceVersion?: string | null;
  sourceUrl?: string | null;
  runtime?: Runtime | null;
  storageId?: string | null;
  nexusFileId?: string | null;
  manualReason?: string | null;
}

export type ModProfileImportStatus =
  | 'alreadyInstalled'
  | 'readyToInstall'
  | 'needsDownload'
  | 'manualRequired'
  | 'runtimeMismatch'
  | 'unsupported';

export interface ModProfileImportPlanItem {
  item: ModProfileItem;
  status: ModProfileImportStatus;
  resolvedStorageId?: string | null;
  message: string;
}

export interface ModProfileImportSummary {
  total: number;
  alreadyInstalled: number;
  readyToInstall: number;
  needsDownload: number;
  manualRequired: number;
  runtimeMismatches: number;
  unsupported: number;
}

export interface ModProfileImportPlan {
  profile: ModProfileInfo;
  targetEnvironmentId?: string | null;
  items: ModProfileImportPlanItem[];
  summary: ModProfileImportSummary;
}

export interface ModProfileApplyRequest {
  manifest: ModProfileManifest;
  targetEnvironmentId: string;
}

export interface ModProfileApplyResult {
  plan: ModProfileImportPlan;
  installed: number;
  skipped: number;
  unresolved: number;
  messages: string[];
}

export interface StoredModProfile {
  id: string;
  name: string;
  runtime: Runtime;
  isDefault: boolean;
  activeEnvironmentIds?: string[];
  manifest: ModProfileManifest;
  createdAt: string;
  updatedAt: string;
}

export interface ModProfileCaptureRequest {
  environmentId: string;
  name?: string | null;
  profileId?: string | null;
  includeDisabled?: boolean;
}

export interface ModProfileSaveRequest {
  profileId?: string | null;
  name: string;
  runtime: Runtime;
  manifest: ModProfileManifest;
}

export interface ModProfileExportRequest {
  profileId: string;
  includeDisabled: boolean;
}

export interface LocalModSourceVersionOption {
  key: string;
  version: string;
  runtime?: string;
  updatedAt?: string;
  isLatest: boolean;
  label?: string;
}

export interface LocalModSourcePreview {
  source: 'local' | 'thunderstore' | 'nexusmods' | 'github' | 'unknown';
  sourceId: string;
  sourceUrl: string;
  displayName: string;
  author?: string;
  summary?: string;
  iconUrl?: string;
  downloads?: number;
  likesOrEndorsements?: number;
  updatedAt?: string;
  versions: LocalModSourceVersionOption[];
}

export interface LocalModOwnershipCandidate {
  id: string;
  bucket: string;
  relativePath: string;
  fileName: string;
}

export type SecurityScanState = 'verified' | 'review' | 'unavailable' | 'disabled' | 'skipped';
export type SecurityFindingSeverity = 'Low' | 'Medium' | 'High' | 'Critical';

export interface SecurityScanSummary {
  state: SecurityScanState;
  verified: boolean;
  disposition?: ThreatDisposition | null;
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

export type {
  ScanResult,
  Finding,
  ThreatDisposition,
  ThreatDispositionClassification,
  ThreatFamily,
  ThreatFamilyEvidence,
  DeveloperGuidance,
  Severity,
  CallChain,
  DataFlowChain,
} from './mlvscan';
