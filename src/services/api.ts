import { invoke } from '@tauri-apps/api/core';
import type {
  DepotDownloaderInfo,
  Settings,
  Environment,
  DownloadProgress,
  AppConfig,
  UpdateCheckResult,
  ConfigFile,
  ConfigSection,
  ConfigUpdate,
} from '../types';

export class ApiService {
  // DepotDownloader
  static async detectDepotDownloader(): Promise<DepotDownloaderInfo> {
    return invoke('detect_depot_downloader');
  }

  // Settings
  static async getSettings(): Promise<Settings> {
    return invoke('get_settings');
  }

  static async saveSettings(settings: Partial<Settings>): Promise<{ success: boolean }> {
    await invoke('save_settings', { updates: settings });
    return { success: true };
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

  static async deleteEnvironment(id: string): Promise<{ success: boolean }> {
    const result = await invoke<boolean>('delete_environment', { id });
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

  // GitHub Token (encrypted storage)
  static async setGitHubToken(token: string): Promise<{ success: boolean }> {
    await invoke('set_github_token', { token });
    return { success: true };
  }

  static async hasGitHubToken(): Promise<boolean> {
    return invoke('has_github_token');
  }

  static async clearGitHubToken(): Promise<{ success: boolean }> {
    await invoke('clear_github_token');
    return { success: true };
  }

  static async removeGitHubToken(): Promise<{ success: boolean }> {
    return this.clearGitHubToken();
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
  static async getMods(environmentId: string): Promise<{
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
    }>;
    modsDirectory: string;
    count: number;
  }> {
    return invoke('get_mods', { environmentId });
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
    },
    target?: 'mods' | 'plugins',
    cleanup?: boolean
  ): Promise<{ success: boolean; storageId?: string; alreadyStored?: boolean }> {
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
      } : null,
      target,
      cleanup,
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
    }
  ): Promise<{
    success: boolean;
    message?: string;
    installedFiles?: string[];
    source?: string;
    error?: string;
    runtimeMismatch?: {
      detected: 'IL2CPP' | 'Mono' | 'unknown';
      environment: 'IL2CPP' | 'Mono';
      warning: string;
      requiresConfirmation: boolean;
    };
  }> {
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
      } : null,
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
    userLibFileName: string
  ): Promise<{ success: boolean }> {
    await invoke('disable_user_lib', { environmentId, userLibFileName });
    return { success: true };
  }

  static async enableUserLib(
    environmentId: string,
    userLibFileName: string
  ): Promise<{ success: boolean }> {
    await invoke('enable_user_lib', { environmentId, userLibFileName });
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

  static async extractGameVersion(environmentId: string): Promise<string | null> {
    return invoke('extract_game_version', { environmentId });
  }

  static async extractGameVersionFromPath(gameDir: string): Promise<string | null> {
    return invoke('extract_game_version_from_path', { gameDir });
  }

  static async saveNexusModsApiKey(apiKey: string): Promise<{
    success: boolean;
    message?: string;
  }> {
    // Save API key via encrypted storage
    await invoke('save_nexus_mods_api_key', { apiKey });
    return { success: true };
  }

  static async validateNexusModsApiKey(apiKey: string): Promise<{
    success: boolean;
    rateLimits?: { daily: number; hourly: number };
    user?: { name: string; isPremium: boolean; isSupporter: boolean };
    error?: string;
  }> {
    return invoke('validate_nexus_mods_api_key', { apiKey });
  }

  static async getNexusModsApiKey(): Promise<string | null> {
    return invoke('get_nexus_mods_api_key');
  }

  static async hasNexusModsApiKey(): Promise<boolean> {
    return invoke('has_nexus_mods_api_key');
  }

  static async removeNexusModsApiKey(): Promise<void> {
    return invoke('clear_nexus_mods_api_key');
  }

  static async getNexusModsRateLimits(): Promise<{
    daily: number;
    hourly: number;
  }> {
    return invoke('get_nexus_mods_rate_limits');
  }

  static async searchNexusMods(
    gameId: string,
    query: string
  ): Promise<{ mods: any[] }> {
    const mods = await invoke<any[]>('search_nexus_mods_mods', {
      gameId,
      query,
    });

    // Transform GraphQL field names to match frontend expectations
    const transformedMods = mods.map((mod: any) => ({
      mod_id: mod.modId,
      name: mod.name,
      summary: mod.summary,
      picture_url: mod.pictureUrl,
      thumbnail_url: mod.thumbnailUrl,
      endorsement_count: mod.endorsements,
      mod_downloads: mod.downloads,
      version: mod.version,
      author: mod.author || mod.uploader?.name,
      updated_at: mod.updatedAt,
      created_at: mod.createdAt,
    }));

    return { mods: transformedMods };
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
    gameId?: string
  ): Promise<{
    success: boolean;
    message?: string;
    installedFiles?: string[];
    source?: string;
    error?: string;
    runtimeMismatch?: {
      detected: 'IL2CPP' | 'Mono' | 'unknown';
      environment: 'IL2CPP' | 'Mono';
      warning: string;
      requiresConfirmation: boolean;
    };
  }> {
    return invoke('install_nexus_mods_mod', {
      environmentId,
      game_id_param: gameId ?? null,
      modId,
      fileId,
    });
  }

  static async checkModUpdates(environmentId: string): Promise<Array<{
    modFileName: string;
    updateAvailable: boolean;
    currentVersion?: string;
    latestVersion?: string;
    source?: 'thunderstore' | 'nexusmods';
    packageInfo?: any;
  }>> {
    return invoke('check_mod_updates', { environmentId });
  }

  static async updateMod(
    environmentId: string,
    modFileName: string
  ): Promise<{ success: boolean; message?: string; error?: string }> {
    return invoke('update_mod', { environmentId, modFileName });
  }

  static async getAvailableModUpdates(environmentId: string): Promise<{
    count: number;
    updates: Array<{
      modFileName: string;
      updateAvailable: boolean;
      currentVersion?: string;
      latestVersion?: string;
      source?: 'thunderstore' | 'nexusmods';
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
    packageUuid: string
  ): Promise<{
    success: boolean;
    message?: string;
    installedFiles?: string[];
    source?: string;
    error?: string;
    alreadyInstalled?: boolean;
    runtimeMismatch?: {
      detected: 'IL2CPP' | 'Mono' | 'unknown';
      environment: 'IL2CPP' | 'Mono';
      warning: string;
      requiresConfirmation: boolean;
    };
  }> {
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
        sourceId: packageUuid,
        sourceVersion: versionNumber,
        sourceUrl: packageUrl,
        modName: modName,
        author: owner,
      },
    });
  }

  static async downloadThunderstoreToLibrary(
    packageUuid: string,
    runtime?: 'IL2CPP' | 'Mono'
  ): Promise<{ success: boolean; storageId?: string; alreadyStored?: boolean }> {
    const gameId = 'schedule-i';
    const packageInfo = await invoke<any>('get_thunderstore_package', {
      packageUuid,
      gameId
    });

    if (!packageInfo) {
      throw new Error('Package not found');
    }

    const latestVersion = packageInfo.versions?.[0];
    const packageUrl = packageInfo.package_url || '';
    const modName = packageInfo.name || '';
    const owner = packageInfo.owner || '';
    const versionNumber = latestVersion?.version_number || '';
    const sourceId = owner && modName ? `${owner}/${modName}` : packageUuid;

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
      gameId
    });

    return this.storeModArchive(
      zipPath,
      `${packageUuid}.zip`,
      runtime,
      {
        source: 'thunderstore',
        sourceId,
        sourceVersion: versionNumber,
        sourceUrl: packageUrl,
        modName,
        author: owner,
      },
      undefined,
      true
    );
  }

  static async downloadNexusModToLibrary(
    modId: number,
    fileId: number,
    runtime?: 'IL2CPP' | 'Mono'
  ): Promise<{ success: boolean; storageId?: string; alreadyStored?: boolean }> {
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
      },
      undefined,
      true
    );
  }

  static async downloadS1APIToLibrary(versionTag: string): Promise<{ success: boolean; storageId?: string; alreadyStored?: boolean }> {
    return invoke('download_s1api_to_library', { versionTag });
  }

  static async downloadMLVScanToLibrary(versionTag: string): Promise<{ success: boolean; storageId?: string; alreadyStored?: boolean }> {
    return invoke('download_mlvscan_to_library', { versionTag });
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
    searchQuery: string | null,
    filterModTag: string | null,
    outputPath: string
  ): Promise<void> {
    return invoke('export_logs', {
      logPath,
      filterLevel,
      searchQuery,
      filterModTag,
      outputPath,
    });
  }

  // Config
  static async getConfigFiles(environmentId: string): Promise<ConfigFile[]> {
    return invoke('get_config_files', { environmentId });
  }

  static async getGroupedConfig(environmentId: string): Promise<Record<string, ConfigSection[]>> {
    return invoke('get_grouped_config', { environmentId });
  }

  static async updateConfig(filePath: string, updates: ConfigUpdate[]): Promise<void> {
    return invoke('update_config', { filePath, updates });
  }
}
