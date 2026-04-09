import { ApiService } from './api';
import { applyFeaturedDownloadRemoteVersions } from './modLibrarySummary';
import type { ModLibraryResult } from '../types';

async function loadLatestRelease(
  loader: ((owner: string) => Promise<{ tag_name?: string } | null>) | undefined,
): Promise<{ tag_name?: string } | null> {
  if (typeof loader !== 'function') {
    return null;
  }

  try {
    return await Promise.resolve(loader(''));
  } catch {
    return null;
  }
}

export async function getFeaturedDownloadLatestVersions(): Promise<Map<string, string>> {
  const [s1apiRelease, mlvscanRelease] = await Promise.all([
    loadLatestRelease(ApiService.getS1APILatestRelease),
    loadLatestRelease(ApiService.getMLVScanLatestRelease),
  ]);

  const latestBySourceId = new Map<string, string>();
  if (s1apiRelease?.tag_name) {
    latestBySourceId.set('ifbars/s1api', s1apiRelease.tag_name);
    latestBySourceId.set('ifbars/s1api_forked', s1apiRelease.tag_name);
  }
  if (mlvscanRelease?.tag_name) {
    latestBySourceId.set('ifbars/mlvscan', mlvscanRelease.tag_name);
  }

  return latestBySourceId;
}

export async function normalizeLibraryFeaturedDownloads(
  library: ModLibraryResult | null | undefined,
): Promise<ModLibraryResult | null | undefined> {
  const latestBySourceId = await getFeaturedDownloadLatestVersions();
  return applyFeaturedDownloadRemoteVersions(library, latestBySourceId);
}
