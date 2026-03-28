import { invoke } from '@tauri-apps/api/core';
import type {
  DepotDownloaderInfo,
  Settings,
  Environment,
  AppUpdateStatus,
  DownloadProgress,
  AppConfig,
  UpdateCheckResult,
  SecurityScannerStatus,
  SecurityScanReport,
  SecurityScanSummary,
  ConfigDocument,
  ConfigEditOperation,
  ConfigFileSummary,
  ExtractGameVersionResult,
} from '../types';

type SecurityGateResponse = {
  securityScan?: SecurityScanSummary | SecurityScanReport;
  securityScanBlocked?: boolean;
  securityScanConfirmationRequired?: boolean;
  error?: string;
};

export class ApiService {
  // DepotDownloader
  static async detectDepotDownloader(): Promise<DepotDownloaderInfo> {
    return invoke('detect_depot_downloader');
  }

  static async installDepotDownloader(): Promise<DepotDownloaderInfo> {
    return invoke('install_depot_downloader');
  }

  // App Init
  static async getHomeDirectory(): Promise<string> {
    return invoke('get_home_directory');
  }

  static async getAppUpdateStatus(currentVersion: string): Promise<AppUpdateStatus> {
    return invoke('get_app_update_status', { currentVersion });
  }

  // Settings
  static async getSettings(): Promise<Settings> {
    return invoke('get_settings');
  }

  static async saveSettings(settings: Partial<Settings>): Promise<{ success: boolean }> {
    await invoke('save_settings', { updates: settings });
    return { success: true };
  }

  static async backupDatabase(): Promise<{ success: boolean; path: string }> {
    const path = await invoke<string>('backup_database');
    return { success: true, path };
  }

  // Environments
  static async getEnvironments(): Promise<Environment[]> {
    return invoke('get_environments');
  }

  static async getEnvironment(id: string): Promise<Environment> {
    return invoke('get_environment', { id });
  }

  static async createEnvironment(data: {
    appId: string;
    branch: string;
    outputDir: string;
    name?: string;
    description?: string;
  }): Promise<Environment> {
    return invoke('create_environment', {
      appId: data.appId,
      branch: data.branch,
      outputDir: data.outputDir,
      name: data.name,
      description: data.description,
    });
  }

  static async updateEnvironment(
    id: string,
    updates: Partial<Environment>
  ): Promise<Environment> {
    return invoke('update_environment', { id, updates });
  }

  static async deleteEnvironment(id: string, deleteFiles?: boolean): Promise<{ success: boolean }> {
    const result = await invoke<boolean>('delete_environment', { id, deleteFiles });
    return { success: result };
  }

  // Downloads
  static async startDownload(
    environmentId: string,
    _credentials?: {
      username: string;
      password: string;
      steamGuard?: string;
      saveCredentials?: boolean;
    }
  ): Promise<{ success: boolean; downloadId: string }> {
    return invoke('start_download', { environmentId });
  }

  static async cancelDownload(downloadId: string): Promise<{ success: boolean }> {
    const result = await invoke<boolean>('cancel_download', { downloadId });
    return { success: result };
  }

  static async getProgress(downloadId: string): Promise<DownloadProgress> {
    const progress = await invoke<DownloadProgress | null>('get_download_progress', {
      downloadId,
    });
    if (!progress) {
      throw new Error('Download not found');
    }
    return progress;
  }

  // Game configs
  static async getSchedule1Config(): Promise<AppConfig> {
    return invoke('get_schedule1_config');
  }

  static async detectSteamInstallations(): Promise<Array<{
    path: string;
    executablePath: string;
    appId: string;
  }>> {
    return invoke('detect_steam_installations');
  }

  static async createSteamEnvironment(
    steamPath: string,
    name?: string,
    description?: string
  ): Promise<Environment> {
    return invoke('create_steam_environment', {
      steamPath,
      name,
      description,
    });
  }

  static async importLocalEnvironment(
    localPath: string,
    name?: string,
    description?: string
  ): Promise<Environment> {
    return invoke('import_local_environment', {
      localPath,
      name,
      description,
    });
  }

  // Authentication
  static async authenticate(
    username: string,
    password: string,
    steamGuard?: string,
    saveCredentials?: boolean
  ): Promise<{ success: boolean; message?: string; requiresSteamGuard?: boolean }> {
    return invoke('authenticate', {
      username,
      password,
      steamGuard,
      saveCredentials,
    });
  }

  // Credentials
  static async saveCredentials(
    username: string,
    password: string
  ): Promise<{ success: boolean }> {
    await invoke('save_credentials', { username, password });
    return { success: true };
  }

  static async clearCredentials(): Promise<{ success: boolean }> {
    await invoke('clear_credentials');
    return { success: true };
  }

  static async getReleaseApiHealth(): Promise<Record<string, unknown>> {
    return invoke('get_release_api_health');
  }

  // Directory browser
  static async browseDirectory(path: string): Promise<{
    currentPath: string;
    directories: Array<{ name: string; path: string }>;
  }> {
    return invoke('browse_directory', { path });
  }

  // Create directory
  static async createDirectory(path: string): Promise<{ success: boolean; path: string }> {
    return invoke('create_directory', { path });
  }

  // File browser
  static async browseFiles(
    path: string,
    fileExtension?: string
  ): Promise<{
    currentPath: string;
    items: Array<{ name: string; path: string; type: 'directory' | 'file' }>;
  }> {
    return invoke('browse_files', { path, fileExtension });
  }

  // Update checks
  static async checkUpdate(environmentId: string, manual = false): Promise<UpdateCheckResult> {
    return invoke('check_update', { environmentId, manual });
  }

  static async checkAllUpdates(manual = false): Promise<
    Array<{ environmentId: string } & UpdateCheckResult>
  > {
    return invoke('check_all_updates', { manual });
  }

  static async getUpdateStatus(environmentId: string): Promise<{
    updateAvailable: boolean;
    lastUpdateCheck?: string;
    remoteManifestId?: string;
    remoteBuildId?: string;
    currentManifestId?: string;
  }> {
    return invoke('get_update_status', { environmentId });
  }

  // File system operations
  static async openFolder(environmentId: string): Promise<{ success: boolean }> {
    await invoke('open_folder', { environmentId });
    return { success: true };
  }

  static async launchGame(
    environmentId: string,
    launchMethod?: 'steam' | 'direct'
  ): Promise<{
    success: boolean;
    executablePath?: string;
  }> {
    console.log(`[Launch] ApiService: Calling launch_game with environmentId: ${environmentId}, launchMethod: ${launchMethod}`);
    return invoke('launch_game', {
      environmentId,
      launchMethod,
    });
  }

  // Mods operations
  static async getMods(environmentId: string, refresh: boolean = false): Promise<{
    mods: Array<{
      name: string;
      fileName: string;
      path: string;
      version?: string;
      source?: string;
      sourceUrl?: string;
      disabled?: boolean;
      modStorageId?: string;
      managed?: boolean;
      summary?: string;
      iconUrl?: string;
      iconCachePath?: string;
      downloads?: number;
      likesOrEndorsements?: number;
      updatedAt?: string;
      tags?: string[];
      installedAt?: number;
      securityScan?: SecurityScanSummary;
    }>;
    modsDirectory: string;
    count: number;
  }> {
    return invoke('get_mods', { environmentId, refresh });
  }

  static async getModLibrary(): Promise<import('../types').ModLibraryResult> {
    return invoke('get_mod_library');
  }

  static async installDownloadedMod(
    storageId: string,
    environmentIds: string[]
  ): Promise<{ results: Array<{ environmentId: string; installedFiles: string[] }> }> {
    return invoke('install_downloaded_mod', { storageId, environmentIds });
  }

  static async uninstallDownloadedMod(
    storageId: string,
    environmentIds: string[]
  ): Promise<{ results: Array<{ environmentId: string; removedFiles: string[] }> }> {
    return invoke('uninstall_downloaded_mod', { storageId, environmentIds });
  }

  static async deleteDownloadedMod(
    storageId: string
  ): Promise<{ deleted: boolean; removedFrom: string[] }> {
    return invoke('delete_downloaded_mod', { storageId });
  }

  static async storeModArchive(
    filePath: string,
    originalFileName: string,
    runtime?: 'IL2CPP' | 'Mono',
    metadata?: {
      source?: 'thunderstore' | 'nexusmods' | 'github' | 'local' | 'unknown';
      sourceUrl?: string;
      modName?: string;
      author?: string;
      sourceId?: string;
      sourceVersion?: string;
      summary?: string;
      iconUrl?: string;
      downloads?: number;
      likesOrEndorsements?: number;
      updatedAt?: string;
      tags?: string[];
    },
    target?: 'mods' | 'plugins',
    cleanup?: boolean,
    securityOverride?: boolean,
  ): Promise<{ success: boolean; storageId?: string; alreadyStored?: boolean } & SecurityGateResponse> {
    return invoke('store_mod_archive', {
      filePath,
      originalFileName,
      runtime,
      metadata: metadata ? {
        source: metadata.source || 'unknown',
        sourceUrl: metadata.sourceUrl,
        modName: metadata.modName,
        author: metadata.author,
        sourceId: metadata.sourceId,
        sourceVersion: metadata.sourceVersion,
        summary: metadata.summary,
        iconUrl: metadata.iconUrl,
        downloads: metadata.downloads,
        likesOrEndorsements: metadata.likesOrEndorsements,
        updatedAt: metadata.updatedAt,
        tags: metadata.tags,
      } : null,
      target,
      cleanup,
      securityOverride,
    });
  }

  static async getModsCount(environmentId: string): Promise<{ count: number }> {
    return invoke('get_mods_count', { environmentId });
  }

  static async deleteMod(
    environmentId: string,
    modFileName: string
  ): Promise<{ success: boolean }> {
    await invoke('delete_mod', { environmentId, modFileName });
    return { success: true };
  }

  static async disableMod(
    environmentId: string,
    modFileName: string
  ): Promise<{ success: boolean }> {
    await invoke('disable_mod', { environmentId, modFileName });
    return { success: true };
  }

  static async enableMod(
    environmentId: string,
    modFileName: string
  ): Promise<{ success: boolean }> {
    await invoke('enable_mod', { environmentId, modFileName });
    return { success: true };
  }

  static async openModsFolder(environmentId: string): Promise<{ success: boolean }> {
    await invoke('open_mods_folder', { environmentId });
    return { success: true };
  }

  static async uploadMod(
    environmentId: string,
    filePath: string,
    originalFileName: string,
    runtime: string,
    metadata?: {
      source?: 'thunderstore' | 'nexusmods' | 'github' | 'local' | 'unknown';
      sourceUrl?: string;
      modName?: string;
      author?: string;
      sourceId?: string;
      sourceVersion?: string;
      detectedRuntime?: 'IL2CPP' | 'Mono';
      summary?: string;
      iconUrl?: string;
      downloads?: number;
      likesOrEndorsements?: number;
      updatedAt?: string;
      tags?: string[];
    },
    securityOverride?: boolean,
  ): Promise<{
    success: boolean;
    message?: string;
    installedFiles?: string[];
    storageId?: string;
    source?: string;
    error?: string;
    requiresManualDownload?: boolean;
    modUrl?: string;
    runtimeMismatch?: {
      detected: 'IL2CPP' | 'Mono' | 'unknown';
      environment: 'IL2CPP' | 'Mono';
      warning: string;
      requiresConfirmation: boolean;
    };
  } & SecurityGateResponse> {
    return invoke('upload_mod', {
      environmentId,
      filePath,
      originalFileName,
      runtime,
      branch: '', // Not used for local uploads
      metadata: metadata ? {
        source: metadata.source || 'unknown',
        sourceUrl: metadata.sourceUrl,
        modName: metadata.modName,
        author: metadata.author,
        sourceId: metadata.sourceId,
        sourceVersion: metadata.sourceVersion,
        detectedRuntime: metadata.detectedRuntime,
        summary: metadata.summary,
        iconUrl: metadata.iconUrl,
        downloads: metadata.downloads,
        likesOrEndorsements: metadata.likesOrEndorsements,
        updatedAt: metadata.updatedAt,
        tags: metadata.tags,
      } : null,
      securityOverride,
    });
  }

  // Plugins operations
  static async getPlugins(environmentId: string): Promise<{
    plugins: Array<{
      name: string;
      fileName: string;
      path: string;
      version?: string;
      source?: string;
      relatedMod?: string;
      disabled?: boolean;
    }>;
    pluginsDirectory: string;
    count: number;
  }> {
    return invoke('get_plugins', { environmentId });
  }

  static async getPluginsCount(environmentId: string): Promise<{ count: number }> {
    return invoke('get_plugins_count', { environmentId });
  }

  static async deletePlugin(
    environmentId: string,
    pluginFileName: string
  ): Promise<{ success: boolean }> {
    await invoke('delete_plugin', { environmentId, pluginFileName });
    return { success: true };
  }

  static async disablePlugin(
    environmentId: string,
    pluginFileName: string
  ): Promise<{ success: boolean }> {
    await invoke('disable_plugin', { environmentId, pluginFileName });
    return { success: true };
  }

  static async enablePlugin(
    environmentId: string,
    pluginFileName: string
  ): Promise<{ success: boolean }> {
    await invoke('enable_plugin', { environmentId, pluginFileName });
    return { success: true };
  }

  static async openPluginsFolder(environmentId: string): Promise<{ success: boolean }> {
    await invoke('open_plugins_folder', { environmentId });
    return { success: true };
  }

  static async uploadPlugin(
    environmentId: string,
    filePath: string,
    originalFileName: string,
    runtime: string
  ): Promise<{
    success: boolean;
    message?: string;
    installedFiles?: string[];
    source?: string;
    error?: string;
    requiresManualDownload?: boolean;
    modUrl?: string;
    runtimeMismatch?: {
      detected: 'IL2CPP' | 'Mono' | 'unknown';
      environment: 'IL2CPP' | 'Mono';
      warning: string;
      requiresConfirmation: boolean;
    };
  }> {
    return invoke('upload_plugin', {
      environmentId,
      filePath,
      originalFileName,
      runtime,
      metadata: {
        source: 'local',
      },
    });
  }

  // UserLibs operations
  static async getUserLibs(environmentId: string): Promise<{
    userLibs: Array<{
      name: string;
      fileName: string;
      path: string;
      size?: number;
      isDirectory: boolean;
      disabled?: boolean;
    }>;
    userLibsDirectory: string;
    count: number;
  }> {
    return invoke('get_userlibs', { environmentId });
  }

  static async getUserLibsCount(environmentId: string): Promise<{ count: number }> {
    return invoke('get_userlibs_count', { environmentId });
  }

  static async openUserLibsFolder(environmentId: string): Promise<{ success: boolean }> {
    await invoke('open_user_libs_folder', { environmentId });
    return { success: true };
  }

  static async disableUserLib(
    environmentId: string,
    userLibPath: string
  ): Promise<{ success: boolean }> {
    await invoke('disable_user_lib', { environmentId, userLibPath });
    return { success: true };
  }

  static async enableUserLib(
    environmentId: string,
    userLibPath: string
  ): Promise<{ success: boolean }> {
    await invoke('enable_user_lib', { environmentId, userLibPath });
    return { success: true };
  }

  // MelonLoader methods
  static async getMelonLoaderStatus(environmentId: string): Promise<{
    installed: boolean;
    version?: string;
  }> {
    return invoke('get_melon_loader_status', { environmentId });
  }

  static async getMelonLoaderReleases(_environmentId: string): Promise<Array<{
    tag_name: string;
    name: string;
    published_at: string;
    prerelease: boolean;
    isNightly?: boolean;
    download_url: string | null;
    body?: string;
  }>> {
    const releases = await invoke<Array<any>>('get_all_melon_loader_releases');
    return releases.map(r => ({
      tag_name: r.tag_name,
      name: r.name,
      published_at: r.published_at,
      prerelease: r.prerelease,
      isNightly: false,
      download_url: r.assets?.[0]?.browser_download_url || null,
      body: r.body,
    }));
  }

  static async getAvailableMelonLoaderVersions(): Promise<Array<{
    tag: string;
    name: string;
  }>> {
    return invoke('get_available_melonloader_versions');
  }

  static async installMelonLoader(
    environmentId: string,
    versionTag: string
  ): Promise<{
    success: boolean;
    error?: string;
    message?: string;
    version?: string;
    installedFiles?: string[];
  }> {
    try {
      const result = await invoke<{
        success: boolean;
        error?: string;
        message?: string;
        version?: string;
        installedFiles?: string[];
      }>('install_melon_loader', { environmentId, versionTag: versionTag });
      console.log('installMelonLoader result:', result);
      return result;
    } catch (err: any) {
      // Handle Tauri command errors - they throw exceptions
      console.error('installMelonLoader error:', err);
      console.error('Error type:', typeof err);
      console.error('Error details:', JSON.stringify(err, null, 2));

      let errorMessage = 'Unknown error';
      if (typeof err === 'string') {
        errorMessage = err;
      } else if (err instanceof Error) {
        errorMessage = err.message;
      } else if (err && typeof err === 'object') {
        // Tauri errors might be in different formats
        if ('message' in err) {
          errorMessage = String(err.message);
        } else if ('error' in err) {
          errorMessage = String(err.error);
        } else if ('data' in err) {
          // Tauri 2.0 error format
          errorMessage = String(err.data || err);
        } else {
          errorMessage = JSON.stringify(err);
        }
      }

      return {
        success: false,
        error: errorMessage
      };
    }
  }

  static async extractGameVersion(environmentId: string): Promise<ExtractGameVersionResult> {
    return invoke('extract_game_version', { environmentId });
  }

  static async extractGameVersionFromPath(gameDir: string): Promise<string | null> {
    return invoke('extract_game_version_from_path', { gameDir });
  }

  static async beginNexusOAuthLogin(preferLocalhost: boolean = false): Promise<{
    authorizeUrl: string;
    state: string;
    redirectUri: string;
  }> {
    return invoke('begin_nexus_oauth_login', { preferLocalhost });
  }

  static async completeNexusOAuthCallback(callbackUrl?: string): Promise<{
    success: boolean;
    status: {
      connected: boolean;
      expiresAt?: number;
      account?: {
        name?: string;
        memberId?: number;
        isPremium?: boolean;
        isSupporter?: boolean;
        canDirectDownload?: boolean;
        requiresSiteConfirmation?: boolean;
      };
    };
  }> {
    return invoke('complete_nexus_oauth_callback', { callbackUrl: callbackUrl ?? null });
  }

  static async getNexusOAuthStatus(): Promise<{
    connected: boolean;
    expiresAt?: number;
    account?: {
      name?: string;
      memberId?: number;
      isPremium?: boolean;
      isSupporter?: boolean;
      canDirectDownload?: boolean;
      requiresSiteConfirmation?: boolean;
    };
  }> {
    return invoke('get_nexus_oauth_status');
  }

  static async logoutNexusOAuth(): Promise<{ success: boolean }> {
    return invoke('logout_nexus_oauth');
  }

  static async beginNexusManualDownloadSession(params: {
    kind: 'library' | 'install';
    modId: number;
    fileId: number;
    gameId?: string;
    environmentId?: string;
    runtime?: 'IL2CPP' | 'Mono';
  }): Promise<{
    success: boolean;
    kind: 'library' | 'install';
    filesPageUrl: string;
    modId: number;
    fileId: number;
    gameId: string;
  }> {
    return invoke('begin_nexus_manual_download_session', {
      kind: params.kind,
      modId: params.modId,
      fileId: params.fileId,
      gameId: params.gameId ?? null,
      environmentId: params.environmentId ?? null,
      runtime: params.runtime ?? null,
    });
  }

  static async completeNexusManualDownloadSession(
    nxmUrl: string,
    runtimeOverride?: 'IL2CPP' | 'Mono' | 'Both'
  ): Promise<{
    success: boolean;
    error?: string;
    kind?: 'library' | 'install';
    environmentId?: string;
    storageId?: string;
    modId?: number;
    fileId?: number;
    requestedKind?: 'library' | 'install';
    usedFallback?: boolean;
    runtimeSelectionRequired?: boolean;
    modName?: string;
    fileName?: string;
    version?: string;
  }> {
    return invoke('complete_nexus_manual_download_session', {
      nxmUrl,
      runtimeOverride: runtimeOverride ?? null,
    });
  }

  static async cancelNexusManualDownloadSession(): Promise<{ success: boolean }> {
    return invoke('cancel_nexus_manual_download_session');
  }

  static async searchNexusMods(
    gameId: string,
    query: string
  ): Promise<{ mods: any[] }> {
    const mods = await invoke<any[]>('search_nexus_mods_mods', {
      gameId,
      query,
    });

    return { mods: this.transformNexusMods(mods) };
  }

  private static transformNexusMods(mods: any[]): any[] {
    return mods.map((mod: any) => ({
      mod_id: mod.modId ?? mod.mod_id,
      name: mod.name,
      summary: mod.summary,
      picture_url: mod.pictureUrl ?? mod.picture_url,
      thumbnail_url: mod.thumbnailUrl ?? mod.thumbnail_url,
      endorsement_count: mod.endorsements ?? mod.endorsement_count,
      mod_downloads: mod.downloads ?? mod.mod_downloads,
      unique_downloads:
        mod.downloads ?? mod.unique_downloads ?? mod.mod_downloads,
      version: mod.version,
      author: mod.author || mod.uploader?.name,
      updated_at: mod.updatedAt ?? mod.updated_at ?? mod.updated_time,
      created_at: mod.createdAt ?? mod.created_at ?? mod.uploaded_time,
      updated_time: mod.updatedAt ?? mod.updated_at ?? mod.updated_time,
      uploaded_time: mod.createdAt ?? mod.created_at ?? mod.uploaded_time,
    }));
  }

  static async getNexusModsLatestUpdated(gameId: string): Promise<{ mods: any[] }> {
    const mods = await invoke<any[]>('get_nexus_mods_latest_updated', { gameId });
    return { mods: this.transformNexusMods(mods) };
  }

  static async getNexusModsTrending(gameId: string): Promise<{ mods: any[] }> {
    const mods = await invoke<any[]>('get_nexus_mods_trending', { gameId });
    return { mods: this.transformNexusMods(mods) };
  }

  static async getNexusModsLatestAdded(gameId: string): Promise<{ mods: any[] }> {
    const mods = await invoke<any[]>('get_nexus_mods_latest_added', { gameId });
    return { mods: this.transformNexusMods(mods) };
  }

  static async getNexusModsMod(gameId: string, modId: number): Promise<any> {
    return invoke('get_nexus_mods_mod', { gameId, modId });
  }

  static async getNexusModsModFiles(gameId: string, modId: number): Promise<any[]> {
    return invoke('get_nexus_mods_mod_files', { gameId, modId });
  }

  static async installNexusModsMod(
    environmentId: string,
    modId: number,
    fileId: number,
    gameId?: string,
    securityOverride?: boolean,
  ): Promise<{
    success: boolean;
    message?: string;
    installedFiles?: string[];
    storageId?: string;
    source?: string;
    error?: string;
    requiresManualDownload?: boolean;
    modUrl?: string;
    runtimeMismatch?: {
      detected: 'IL2CPP' | 'Mono' | 'unknown';
      environment: 'IL2CPP' | 'Mono';
      warning: string;
      requiresConfirmation: boolean;
    };
  } & SecurityGateResponse> {
    return invoke('install_nexus_mods_mod', {
      environmentId,
      game_id_param: gameId ?? null,
      modId,
      fileId,
      securityOverride,
    });
  }

  static async checkModUpdates(environmentId: string): Promise<Array<{
    modFileName: string;
    updateAvailable: boolean;
    currentVersion?: string;
    latestVersion?: string;
    source?: 'thunderstore' | 'nexusmods' | 'github';
    packageInfo?: any;
  }>> {
    return invoke('check_mod_updates', { environmentId });
  }

  static async updateMod(
    environmentId: string,
    modFileName: string
  ): Promise<{
    success: boolean;
    message?: string;
    error?: string;
    errorCode?: string;
    requiresManualDownload?: boolean;
    recoveryUrl?: string;
    alreadyUpToDate?: boolean;
  }> {
    return invoke('update_mod', { environmentId, modFileName });
  }

  static async getAvailableModUpdates(environmentId: string): Promise<{
    count: number;
      updates: Array<{
        modFileName: string;
        updateAvailable: boolean;
        currentVersion?: string;
        latestVersion?: string;
        source?: 'thunderstore' | 'nexusmods' | 'github';
      }>;
  }> {
    const updates = await this.checkModUpdates(environmentId);
    const available = updates.filter(u => u.updateAvailable);
    return {
      count: available.length,
      updates: available.map(u => ({
        modFileName: u.modFileName,
        updateAvailable: u.updateAvailable,
        currentVersion: u.currentVersion,
        latestVersion: u.latestVersion,
        source: u.source,
      })),
    };
  }

  static async getModUpdatesSummary(environmentId: string): Promise<{
    count: number;
    updates: Array<{
      modFileName: string;
      modName: string;
      currentVersion: string;
      latestVersion: string;
      source: string;
    }>;
  }> {
    return invoke('get_mod_updates_summary', { environmentId });
  }

  static async getAllModUpdatesSummary(): Promise<Array<{
    environmentId: string;
    environmentName: string;
    count: number;
    updates: Array<{
      modFileName: string;
      modName: string;
      currentVersion: string;
      latestVersion: string;
      source: string;
    }>;
  }>> {
    return invoke('get_all_mod_updates_summary', {});
  }

  static async getS1APIStatus(environmentId: string): Promise<{
    installed: boolean;
    enabled: boolean;
    version?: string;
    monoFile?: string;
    il2cppFile?: string;
    pluginFile?: string;
  }> {
    return invoke('get_s1api_installation_status', { environmentId });
  }

  static async getS1APILatestRelease(_environmentId: string): Promise<{
    tag_name: string;
    name: string;
    published_at: string;
    prerelease: boolean;
    download_url: string | null;
    body?: string;
  }> {
    const release = await invoke<any>('get_latest_s1api_release');
    if (!release) {
      throw new Error('No S1API release found');
    }
    return {
      tag_name: release.tag_name,
      name: release.name,
      published_at: release.published_at,
      prerelease: release.prerelease,
      download_url: release.assets?.[0]?.browser_download_url || null,
      body: release.body,
    };
  }

  static async getS1APIReleases(_environmentId: string): Promise<Array<{
    tag_name: string;
    name: string;
    published_at: string;
    prerelease: boolean;
    download_url: string | null;
    body?: string;
  }>> {
    const releases = await invoke<Array<any>>('get_all_s1api_releases');
    return releases.map(r => ({
      tag_name: r.tag_name,
      name: r.name,
      published_at: r.published_at,
      prerelease: r.prerelease,
      download_url: r.assets?.[0]?.browser_download_url || null,
      body: r.body,
    }));
  }

  static async installS1API(
    environmentId: string,
    versionTag: string
  ): Promise<{
    success: boolean;
    message?: string;
    version?: string;
    installedFiles?: string[];
    error?: string;
  }> {
    try {
      const result = await invoke<{
        success: boolean;
        message?: string;
        version?: string;
        installedFiles?: string[];
        error?: string;
      }>('install_s1api', { environmentId, versionTag });
      console.log('installS1API result:', result);
      return result;
    } catch (err: any) {
      console.error('installS1API error:', err);
      // Extract error message from various Tauri error formats
      let errorMessage = 'Unknown error';
      if (typeof err === 'string') {
        errorMessage = err;
      } else if (err?.message) {
        errorMessage = err.message;
      } else if (err?.toString) {
        errorMessage = err.toString();
      }
      return {
        success: false,
        error: errorMessage
      };
    }
  }

  static async uninstallS1API(environmentId: string): Promise<{
    success: boolean;
    message?: string;
    error?: string;
  }> {
    return invoke('uninstall_s1api', { environmentId });
  }

  // MLVScan
  static async getMLVScanStatus(environmentId: string): Promise<{
    installed: boolean;
    enabled: boolean;
    version?: string;
    pluginFile?: string;
  }> {
    return invoke('get_mlvscan_installation_status', { environmentId });
  }

  static async getMLVScanLatestRelease(_environmentId: string): Promise<{
    tag_name: string;
    name: string;
    published_at: string;
    prerelease: boolean;
    download_url: string | null;
    body?: string;
  }> {
    const release = await invoke<any>('get_latest_mlvscan_release');
    if (!release) {
      throw new Error('No MLVScan release found');
    }
    return {
      tag_name: release.tag_name,
      name: release.name,
      published_at: release.published_at,
      prerelease: release.prerelease,
      download_url: release.assets?.[0]?.browser_download_url || null,
      body: release.body,
    };
  }

  static async getMLVScanReleases(_environmentId: string): Promise<Array<{
    tag_name: string;
    name: string;
    published_at: string;
    prerelease: boolean;
    download_url: string | null;
    body?: string;
  }>> {
    const releases = await invoke<Array<any>>('get_all_mlvscan_releases');
    return releases.map(r => ({
      tag_name: r.tag_name,
      name: r.name,
      published_at: r.published_at,
      prerelease: r.prerelease,
      download_url: r.assets?.[0]?.browser_download_url || null,
      body: r.body,
    }));
  }

  static async installMLVScan(
    environmentId: string,
    versionTag: string
  ): Promise<{
    success: boolean;
    message?: string;
    version?: string;
    error?: string;
  }> {
    try {
      const result = await invoke<{
        success: boolean;
        message?: string;
        version?: string;
        error?: string;
      }>('install_mlvscan', { environmentId, versionTag });
      console.log('installMLVScan result:', result);
      return result;
    } catch (err: any) {
      console.error('installMLVScan error:', err);
      // Extract error message from various Tauri error formats
      let errorMessage = 'Unknown error';
      if (typeof err === 'string') {
        errorMessage = err;
      } else if (err?.message) {
        errorMessage = err.message;
      } else if (err?.toString) {
        errorMessage = err.toString();
      }
      return {
        success: false,
        error: errorMessage
      };
    }
  }

  static async uninstallMLVScan(environmentId: string): Promise<{
    success: boolean;
    message?: string;
    error?: string;
  }> {
    return invoke('uninstall_mlvscan', { environmentId });
  }

  static async searchThunderstore(
    gameId: string,
    query: string,
    runtime: 'IL2CPP' | 'Mono'
  ): Promise<{
    packages: Array<any>;
  }> {
    const packages = await invoke<Array<any>>('search_thunderstore_packages', {
      gameId,
      runtime,
      query,
    });
    return { packages };
  }

  static async installThunderstoreMod(
    environmentId: string,
    packageUuid: string,
    securityOverride?: boolean,
  ): Promise<{
    success: boolean;
    message?: string;
    installedFiles?: string[];
    storageId?: string;
    source?: string;
    error?: string;
    alreadyInstalled?: boolean;
    requiresManualDownload?: boolean;
    modUrl?: string;
    runtimeMismatch?: {
      detected: 'IL2CPP' | 'Mono' | 'unknown';
      environment: 'IL2CPP' | 'Mono';
      warning: string;
      requiresConfirmation: boolean;
    };
  } & SecurityGateResponse> {
    // Use hardcoded game ID for Schedule I
    const gameId = 'schedule-i';

    // Fetch package info first to get metadata
    const packageInfo = await invoke<any>('get_thunderstore_package', {
      packageUuid,
      gameId
    });

    if (!packageInfo) {
      throw new Error('Package not found');
    }

    // Extract package metadata
    const latestVersion = packageInfo.versions?.[0];
    const packageUrl = packageInfo.package_url || '';
    const modName = packageInfo.name || '';
    const owner = packageInfo.owner || '';
    const versionNumber = latestVersion?.version_number || '';
    const description = latestVersion?.description || packageInfo.latest?.description || '';
    const iconUrl = latestVersion?.icon || packageInfo.latest?.icon || packageInfo.icon || packageInfo.icon_url || '';
    const downloads = Array.isArray(packageInfo.versions)
      ? packageInfo.versions.reduce((sum: number, version: any) => sum + (version?.downloads || 0), 0)
      : 0;
    const likesOrEndorsements = Number(packageInfo.rating_score || 0);
    const updatedAt = packageInfo.date_updated || latestVersion?.date_updated || '';
    const tags = Array.isArray(packageInfo.categories) ? packageInfo.categories : [];

    const env = await this.getEnvironment(environmentId);
    const runtime = env.runtime === 'IL2CPP' ? 'IL2CPP' : 'Mono';

    // Check if mod is already installed before downloading
    // Thunderstore mods use "owner/name" format for sourceId (matches manifest.json format)
    const sourceId = owner && modName ? `${owner}/${modName}` : packageUuid;
    const storageCheck = await invoke<any>('find_existing_mod_storage', {
      sourceId,
      sourceVersion: versionNumber,
      runtime,
    });
    if (storageCheck?.found && storageCheck.storageId) {
      await this.installDownloadedMod(storageCheck.storageId, [environmentId]);
      return {
        success: true,
        message: 'Installed from library',
      };
    }
    const checkResult = await invoke<any>('check_mod_installed', {
      environmentId,
      sourceId: sourceId,
      sourceVersion: versionNumber
    });

    if (checkResult.installed) {
      console.log(`Mod ${modName} version ${versionNumber} is already installed, skipping download`);
      return {
        success: true,
        message: 'Mod already installed',
        alreadyInstalled: true
      };
    }

    // Download package
    const zipPath = await invoke<string>('download_thunderstore_package', {
      packageUuid,
      gameId
    });


    // Install using upload_mod with full metadata
    return invoke('upload_mod', {
      environmentId,
      filePath: zipPath,
      originalFileName: `${packageUuid}.zip`,
      runtime,
      branch: env.branch,
      metadata: {
        source: 'thunderstore',
        sourceId,
        sourceVersion: versionNumber,
        sourceUrl: packageUrl,
        modName: modName,
        author: owner,
        summary: description,
        iconUrl,
        downloads,
        likesOrEndorsements,
        updatedAt,
        tags,
      },
      securityOverride,
    });
  }

  static async downloadThunderstoreToLibrary(
    packageUuid: string,
    runtime?: 'IL2CPP' | 'Mono',
    securityOverride?: boolean,
    versionUuid?: string,
  ): Promise<{ success: boolean; storageId?: string; alreadyStored?: boolean } & SecurityGateResponse> {
    const gameId = 'schedule-i';
    const packageInfo = await invoke<any>('get_thunderstore_package', {
      packageUuid,
      gameId
    });

    if (!packageInfo) {
      throw new Error('Package not found');
    }

    const selectedVersion = Array.isArray(packageInfo.versions)
      ? packageInfo.versions.find((version: any) => version?.uuid4 === versionUuid) || packageInfo.versions[0]
      : undefined;
    const packageUrl = packageInfo.package_url || '';
    const modName = packageInfo.name || '';
    const owner = packageInfo.owner || '';
    const versionNumber = selectedVersion?.version_number || '';
    const sourceId = owner && modName ? `${owner}/${modName}` : packageUuid;
    const description = selectedVersion?.description || packageInfo.latest?.description || '';
    const iconUrl = selectedVersion?.icon || packageInfo.latest?.icon || packageInfo.icon || packageInfo.icon_url || '';
    const downloads = Array.isArray(packageInfo.versions)
      ? packageInfo.versions.reduce((sum: number, version: any) => sum + (version?.downloads || 0), 0)
      : 0;
    const likesOrEndorsements = Number(packageInfo.rating_score || 0);
    const updatedAt = selectedVersion?.date_updated || packageInfo.date_updated || '';
    const tags = Array.isArray(packageInfo.categories) ? packageInfo.categories : [];

    const storageCheck = await invoke<any>('find_existing_mod_storage', {
      sourceId,
      sourceVersion: versionNumber,
      runtime,
    });
    if (storageCheck?.found && storageCheck.storageId) {
      return { success: true, storageId: storageCheck.storageId, alreadyStored: true };
    }

    const zipPath = await invoke<string>('download_thunderstore_package', {
      packageUuid,
      gameId,
      versionUuid: versionUuid ?? null,
    });

    return this.storeModArchive(
      zipPath,
      `${packageUuid}-${versionNumber || 'latest'}.zip`,
      runtime,
      {
        source: 'thunderstore',
        sourceId,
        sourceVersion: versionNumber,
        sourceUrl: packageUrl,
        modName,
        author: owner,
        summary: description,
        iconUrl,
        downloads,
        likesOrEndorsements,
        updatedAt,
        tags,
      },
      undefined,
      true,
      securityOverride,
    );
  }

  static async downloadNexusModToLibrary(
    modId: number,
    fileId: number,
    runtime?: 'IL2CPP' | 'Mono',
    securityOverride?: boolean,
  ): Promise<{ success: boolean; storageId?: string; alreadyStored?: boolean } & SecurityGateResponse> {
    const gameId = 'schedule1';
    const modInfo = await invoke<any>('get_nexus_mods_mod', { gameId, modId });
    const files = await invoke<any[]>('get_nexus_mods_mod_files', { gameId, modId });
    const fileInfo = files.find(f => f.file_id === fileId || f.file_id === Number(fileId));

    if (!fileInfo) {
      throw new Error(`File ${fileId} not found for mod ${modId}`);
    }

    const version = fileInfo.version || fileInfo.mod_version || '1.0.0';
    const sourceUrl = `https://www.nexusmods.com/${gameId}/mods/${modId}`;
    const zipPath = await invoke<string>('download_nexus_mods_mod_file', {
      gameId,
      modId,
      fileId,
    });

    return this.storeModArchive(
      zipPath,
      fileInfo.file_name || `nexusmods-${modId}-${fileId}.zip`,
      runtime,
      {
        source: 'nexusmods',
        sourceId: modId.toString(),
        sourceVersion: version,
        sourceUrl,
        modName: modInfo?.name || 'Unknown Mod',
        author: modInfo?.author || 'Unknown',
        summary: modInfo?.summary || '',
        iconUrl: modInfo?.picture_url || modInfo?.pictureUrl || '',
        downloads: Number(modInfo?.mod_downloads || modInfo?.downloads || 0),
        likesOrEndorsements: Number(modInfo?.endorsement_count || modInfo?.endorsements || 0),
        updatedAt: modInfo?.updated_at || modInfo?.updatedAt || '',
        tags: Array.isArray(modInfo?.tags) ? modInfo.tags : (Array.isArray(modInfo?.tag_list) ? modInfo.tag_list : []),
      },
      undefined,
      true,
      securityOverride,
    );
  }

  static async downloadS1APIToLibrary(
    versionTag: string,
    securityOverride?: boolean,
  ): Promise<{ success: boolean; storageId?: string; alreadyStored?: boolean } & SecurityGateResponse> {
    return invoke('download_s1api_to_library', { versionTag, securityOverride });
  }

  static async downloadMLVScanToLibrary(
    versionTag: string,
    securityOverride?: boolean,
  ): Promise<{ success: boolean; storageId?: string; alreadyStored?: boolean } & SecurityGateResponse> {
    return invoke('download_mlvscan_to_library', { versionTag, securityOverride });
  }

  static async getSecurityScannerStatus(): Promise<SecurityScannerStatus> {
    return invoke('get_security_scanner_status');
  }

  static async installSecurityScanner(): Promise<SecurityScannerStatus> {
    return invoke('install_security_scanner');
  }

  static async getModSecurityScanReport(storageId: string): Promise<SecurityScanReport | null> {
    return invoke('get_mod_security_scan_report', { storageId });
  }

  // Logs
  static async getLogFiles(environmentId: string): Promise<Array<{
    name: string;
    path: string;
    size: number;
    modified: string | null;
    isLatest: boolean;
  }>> {
    return invoke('get_log_files', { environmentId });
  }

  static async readLogFile(logPath: string, maxLines?: number): Promise<Array<{
    lineNumber: number;
    content: string;
    level: string | null;
    timestamp: string | null;
    modTag: string | null;
    category: 'melonloader' | 'mod' | 'general';
  }>> {
    return invoke('read_log_file', { logPath, maxLines });
  }

  static async watchLogFile(logPath: string): Promise<void> {
    return invoke('watch_log_file', { logPath });
  }

  static async stopWatchingLog(): Promise<void> {
    return invoke('stop_watching_log');
  }

  static async exportLogs(
    logPath: string,
    filterLevel: string | null,
    filterCategory: string | null,
    searchQuery: string | null,
    filterModTag: string | null,
    timePeriod: string | null,
    customTimeStart: string | null,
    customTimeEnd: string | null,
    outputPath: string
  ): Promise<void> {
    return invoke('export_logs', {
      logPath,
      filterLevel,
      filterCategory,
      searchQuery,
      filterModTag,
      timePeriod,
      customTimeStart,
      customTimeEnd,
      outputPath,
    });
  }

  // Config
  static async getConfigCatalog(environmentId: string): Promise<ConfigFileSummary[]> {
    return invoke('get_config_catalog', { environmentId });
  }

  static async getConfigDocument(environmentId: string, filePath: string): Promise<ConfigDocument> {
    return invoke('get_config_document', { environmentId, filePath });
  }

  static async applyConfigEdits(environmentId: string, filePath: string, operations: ConfigEditOperation[]): Promise<void> {
    return invoke('apply_config_edits', { environmentId, filePath, operations });
  }

  static async saveRawConfig(environmentId: string, filePath: string, content: string): Promise<void> {
    return invoke('save_raw_config', { environmentId, filePath, content });
  }

  static async openPath(path: string): Promise<void> {
    return invoke('open_path', { path });
  }

  static async revealPath(path: string): Promise<void> {
    return invoke('reveal_path', { path });
  }
}
