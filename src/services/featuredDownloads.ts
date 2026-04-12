import { ApiService } from './api';
import { applyFeaturedDownloadRemoteVersions } from './modLibrarySummary';
import { logger } from './logger';
import type { ModLibraryResult } from '../types';

async function loadLatestRelease(
  source: string,
  loader: ((owner: string) => Promise<{ tag_name?: string } | null>) | undefined,
): Promise<{ tag_name?: string } | null> {
  if (typeof loader !== 'function') {
    logger.warn('Featured download release loader is unavailable', { source });
    return null;
  }

  try {
    const release = await Promise.resolve(loader(''));
    if (!release?.tag_name) {
      logger.warn('Featured download release lookup returned no version tag', {
        source,
      });
      return null;
    }

    logger.debug('Resolved featured download release metadata', {
      source,
      tagName: release.tag_name,
    });
    return release;
  } catch (error) {
    logger.warn('Failed to resolve featured download release metadata', {
      source,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function getFeaturedDownloadLatestVersions(): Promise<Map<string, string>> {
  const [s1apiRelease, mlvscanRelease] = await Promise.all([
    loadLatestRelease('s1api', ApiService.getS1APILatestRelease),
    loadLatestRelease('mlvscan', ApiService.getMLVScanLatestRelease),
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
