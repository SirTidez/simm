import { ApiService } from './api';
import {
  applyFeaturedDownloadRemoteVersions,
  compareVersionTokensDescForSource,
  normalizeThunderstoreName,
  parseThunderstoreSourceId,
} from './modLibrarySummary';
import { logger } from './logger';
import type { ModLibraryResult } from '../types';

type ThunderstorePackageVersion = {
  version_number?: string;
  date_updated?: string;
  date_created?: string;
  dateUpdated?: string;
  dateCreated?: string;
};

type ThunderstorePackage = {
  owner?: string;
  name?: string;
  full_name?: string;
  versions?: ThunderstorePackageVersion[];
};

const FEATURED_THUNDERSTORE_SOURCE_IDS = [
  'hdlmrell/MeshVault',
  'ifBars/S1MAPI',
] as const;

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

function findThunderstorePackageForSourceId(
  packages: ThunderstorePackage[],
  sourceId: string,
): ThunderstorePackage | null {
  const parsed = parseThunderstoreSourceId(sourceId);
  if (!parsed.owner || !parsed.name) {
    return null;
  }

  const targetOwner = parsed.owner.toLowerCase();
  const targetName = normalizeThunderstoreName(parsed.name).toLowerCase();

  const exact = packages.find((pkg) => {
    const pkgOwner = (pkg.owner || '').toLowerCase();
    const pkgName = normalizeThunderstoreName(
      pkg.name || pkg.full_name || '',
    ).toLowerCase();
    return pkgOwner === targetOwner && pkgName === targetName;
  });
  if (exact) {
    return exact;
  }

  const rawNameMatch = packages.find((pkg) => {
    const pkgOwner = (pkg.owner || '').toLowerCase();
    const pkgName = (pkg.name || '').toLowerCase();
    return pkgOwner === targetOwner && pkgName === parsed.name.toLowerCase();
  });
  if (rawNameMatch) {
    return rawNameMatch;
  }

  const normalizedContainsMatch = packages.find((pkg) => {
    const pkgOwner = (pkg.owner || '').toLowerCase();
    const pkgName = normalizeThunderstoreName(
      pkg.name || pkg.full_name || '',
    ).toLowerCase();
    return (
      pkgOwner === targetOwner &&
      (pkgName.includes(targetName) || targetName.includes(pkgName))
    );
  });
  if (normalizedContainsMatch) {
    return normalizedContainsMatch;
  }

  const soleOwnerMatch = packages.filter(
    (pkg) => (pkg.owner || '').toLowerCase() === targetOwner,
  );
  return soleOwnerMatch.length === 1 ? soleOwnerMatch[0] : null;
}

function getVersionUpdatedAt(version: ThunderstorePackageVersion): string {
  return (
    version.date_updated ||
    version.date_created ||
    version.dateUpdated ||
    version.dateCreated ||
    ''
  );
}

async function loadLatestThunderstoreVersion(sourceId: string): Promise<string | null> {
  const parsed = parseThunderstoreSourceId(sourceId);
  if (!parsed.name) {
    return null;
  }

  const query = normalizeThunderstoreName(parsed.name) || parsed.name;

  try {
    const searchResults = await Promise.allSettled([
      ApiService.searchThunderstore('schedule-i', query, 'IL2CPP'),
      ApiService.searchThunderstore('schedule-i', query, 'Mono'),
    ]);

    const packages = searchResults.flatMap((result) => {
      if (result.status !== 'fulfilled') {
        return [];
      }
      return (result.value?.packages || []) as ThunderstorePackage[];
    });

    if (packages.length === 0) {
      return null;
    }

    const matchedPackages = searchResults.flatMap((result) => {
      if (result.status !== 'fulfilled') {
        return [];
      }
      const match = findThunderstorePackageForSourceId(
        (result.value?.packages || []) as ThunderstorePackage[],
        sourceId,
      );
      return match ? [match] : [];
    });

    const versions = matchedPackages.flatMap((pkg) => pkg.versions || []);
    if (versions.length === 0) {
      logger.warn('Featured Thunderstore package lookup returned no matching versions', {
        sourceId,
        query,
      });
      return null;
    }

    const latestVersion = [...versions].sort((left, right) => {
      const versionDelta = compareVersionTokensDescForSource(
        sourceId,
        left.version_number,
        right.version_number,
      );
      if (versionDelta !== 0) {
        return versionDelta;
      }

      return getVersionUpdatedAt(right).localeCompare(getVersionUpdatedAt(left));
    })[0]?.version_number;

    return latestVersion || null;
  } catch (error) {
    logger.warn('Failed to resolve featured Thunderstore package metadata', {
      sourceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function getFeaturedDownloadLatestVersions(): Promise<Map<string, string>> {
  const [s1apiRelease, mlvscanRelease, meshVaultVersion, s1mapiVersion] = await Promise.all([
    loadLatestRelease('s1api', ApiService.getS1APILatestRelease),
    loadLatestRelease('mlvscan', ApiService.getMLVScanLatestRelease),
    loadLatestThunderstoreVersion(FEATURED_THUNDERSTORE_SOURCE_IDS[0]),
    loadLatestThunderstoreVersion(FEATURED_THUNDERSTORE_SOURCE_IDS[1]),
  ]);

  const latestBySourceId = new Map<string, string>();
  if (s1apiRelease?.tag_name) {
    latestBySourceId.set('ifbars/s1api', s1apiRelease.tag_name);
    latestBySourceId.set('ifbars/s1api_forked', s1apiRelease.tag_name);
  }
  if (mlvscanRelease?.tag_name) {
    latestBySourceId.set('ifbars/mlvscan', mlvscanRelease.tag_name);
  }
  if (meshVaultVersion) {
    latestBySourceId.set('hdlmrell/meshvault', meshVaultVersion);
  }
  if (s1mapiVersion) {
    latestBySourceId.set('ifbars/s1mapi', s1mapiVersion);
  }

  return latestBySourceId;
}

export async function normalizeLibraryFeaturedDownloads(
  library: ModLibraryResult | null | undefined,
): Promise<ModLibraryResult | null | undefined> {
  const latestBySourceId = await getFeaturedDownloadLatestVersions();
  return applyFeaturedDownloadRemoteVersions(library, latestBySourceId);
}
