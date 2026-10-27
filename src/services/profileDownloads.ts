import { ApiService } from './api';
import { inferNexusFileRuntime } from './collectionProfile';
import type { ModProfileItem } from '../types';

interface ThunderstorePackage {
  uuid4: string;
  owner: string;
  name: string;
  versions: Array<{ uuid4: string; version_number: string }>;
}

/** Resolve pinned identities through SIMM's providers, never exported URLs. */
export async function downloadProfileItem(
  item: ModProfileItem,
  runtime: 'IL2CPP' | 'Mono',
  confirmSecurity: (name: string) => Promise<boolean>,
): Promise<'downloaded' | 'manual'> {
  let download: (override?: boolean) => ReturnType<typeof ApiService.downloadThunderstoreToLibrary>;
  if (item.source === 'thunderstore') {
    if (!item.sourceId || !item.sourceVersion) throw new Error('This mod has no exact Thunderstore identity and version.');
    const identity = item.sourceId;
    const parts = identity.split('/');
    if (parts.length !== 2) throw new Error('Invalid Thunderstore package identity.');
    const result = await ApiService.searchThunderstore('schedule-i', parts[1], runtime);
    const pkg = (result.packages as ThunderstorePackage[]).find((p) => `${p.owner}/${p.name}`.toLowerCase() === identity.toLowerCase());
    const version = pkg?.versions?.find((v) => v.version_number === item.sourceVersion);
    if (!pkg || !version) throw new Error(`Exact ${identity} ${item.sourceVersion} is unavailable for ${runtime}.`);
    download = (override) => ApiService.downloadThunderstoreToLibrary(pkg.uuid4, runtime, override, version.uuid4);
  } else if (item.source === 'nexusmods') {
    const modId = Number(item.sourceId);
    const fileId = Number(item.nexusFileId);
    if (!Number.isSafeInteger(modId) || modId <= 0 || !Number.isSafeInteger(fileId) || fileId <= 0) throw new Error('This mod has no exact Nexus mod and file IDs.');
    const files = await ApiService.getNexusModsModFiles('schedule1', modId);
    const file = files?.find((f) => f.file_id === fileId);
    if (!file) throw new Error(`Nexus file ${fileId} is no longer available. Add its original archive to the library manually.`);
    const fileRuntime = inferNexusFileRuntime(file.file_name, file.name);
    if (fileRuntime && fileRuntime !== runtime) throw new Error(`Nexus file ${fileId} targets ${fileRuntime}, but this profile uses ${runtime}.`);
    const access = await ApiService.getNexusOAuthStatus();
    if (!access.connected) throw new Error('Sign in to Nexus Mods from Accounts first.');
    if (!access.account?.isPremium && !access.account?.canDirectDownload) {
      await ApiService.beginNexusManualDownloadSession({ kind: 'library', modId, fileId, gameId: 'schedule1', runtime });
      return 'manual';
    }
    download = (override) => ApiService.downloadNexusModToLibrary(modId, fileId, runtime, override);
  } else {
    throw new Error(item.manualReason || 'Add the original archive or local DLL to the library manually.');
  }
  let result = await download();
  if (!result.success && result.securityScanConfirmationRequired && !result.securityScanBlocked) {
    if (!await confirmSecurity(item.name)) throw new Error('Download paused for security review.');
    result = await download(true);
  }
  if (!result.success) throw new Error(result.securityScanBlocked ? 'The security policy blocked this file.' : 'The exact-version download did not complete.');
  return 'downloaded';
}
