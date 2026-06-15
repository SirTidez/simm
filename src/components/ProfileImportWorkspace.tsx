import { useMemo, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { Textarea } from '@/components/ui/textarea';
import { useEnvironmentStore } from '../stores/environmentStore';
import { ApiService } from '../services/api';
import type { ModProfileImportPlan, ModProfileManifest } from '../types';
import { Icon } from './Icon';
import { SimmButton } from './primitives';
import { WorkspacePageHeader } from './WorkspacePageHeader';

interface ProfileImportWorkspaceProps {
  onClose?: () => void;
}

const statusLabels: Record<string, string> = {
  alreadyInstalled: 'Installed',
  readyToInstall: 'Ready',
  needsDownload: 'Download needed',
  manualRequired: 'Manual',
  runtimeMismatch: 'Runtime mismatch',
  unsupported: 'Unsupported',
};

type ProfileResolutionNotice = {
  kind: 'matched' | 'noMatchFound' | 'manual' | 'nexusManual';
  message: string;
  nexus?: NexusMatch;
  modUrl?: string;
};

type ProfileResolutionMode = 'preview' | 'download';

type ThunderstoreMatch = {
  package: any;
  packageUuid: string;
  sourceId: string;
  versionNumber: string | null;
  versionUuid: string | undefined;
};

type NexusMatch = {
  modId: number;
  fileId: number;
};

const FEATURED_THUNDERSTORE_SOURCE_IDS: Record<string, string> = {
  meshvault: 'hdlmrell/MeshVault',
  s1mapi: 'ifBars/S1MAPI',
};

function parseManifest(value: string): ModProfileManifest {
  const parsed = JSON.parse(value) as ModProfileManifest;
  if (!parsed || parsed.kind !== 'simm.profile' || parsed.schemaVersion !== 1) {
    throw new Error('Paste a SIMM profile export with schemaVersion 1.');
  }
  if (!parsed.profile || !Array.isArray(parsed.items)) {
    throw new Error('Profile export is missing profile details or items.');
  }
  return parsed;
}

function profileItemKey(item: ModProfileManifest['items'][number], index: number): string {
  return [
    item.itemType,
    item.name,
    item.fileName ?? '',
    item.source ?? '',
    item.sourceId ?? '',
    item.sourceVersion ?? '',
    index,
  ].join('|');
}

function normalizeMatchToken(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .replace(/\.disabled$/i, '')
    .replace(/\.(dll|zip|rar|7z)$/i, '')
    .replace(/\b(il2cpp|mono|melonloader|bepinex)\b/gi, ' ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

function normalizeVersion(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/^v/i, '').toLowerCase();
}

function profileRuntime(runtime: string | null | undefined): 'IL2CPP' | 'Mono' | undefined {
  const normalized = (runtime ?? '').toLowerCase();
  if (normalized.includes('il2cpp')) return 'IL2CPP';
  if (normalized.includes('mono')) return 'Mono';
  return undefined;
}

function sourceIdParts(sourceId: string | null | undefined): { owner?: string; name?: string } {
  const [owner, name] = (sourceId ?? '').split('/').map((part) => part.trim()).filter(Boolean);
  return { owner, name };
}

function itemSearchToken(item: ModProfileManifest['items'][number]): string {
  return normalizeMatchToken([item.name, item.fileName ?? ''].join(' '));
}

function featuredThunderstoreSourceId(item: ModProfileManifest['items'][number]): string | null {
  const token = itemSearchToken(item);
  if (token.includes('steamnetworklib')) {
    return profileRuntime(item.runtime) === 'IL2CPP'
      ? 'ifBars/SteamNetworkLib_Il2Cpp'
      : 'ifBars/SteamNetworkLib_Mono';
  }
  for (const [needle, sourceId] of Object.entries(FEATURED_THUNDERSTORE_SOURCE_IDS)) {
    if (token.includes(needle)) return sourceId;
  }
  return null;
}

function featuredGithubSourceId(item: ModProfileManifest['items'][number]): 'ifBars/S1API' | 'ifBars/MLVScan' | null {
  const token = itemSearchToken(item);
  if (token.includes('s1api') || token.includes('s1apiloader')) return 'ifBars/S1API';
  if (token.includes('mlvscan')) return 'ifBars/MLVScan';
  return null;
}

function thunderstorePackageUuid(pkg: any): string | null {
  return pkg?.uuid4 ?? pkg?.uuid ?? pkg?.package_uuid ?? pkg?.packageUuid ?? pkg?.id ?? null;
}

function thunderstoreSourceId(pkg: any): string {
  const owner = pkg?.owner ?? pkg?.namespace ?? '';
  const name = pkg?.name ?? '';
  return owner && name ? `${owner}/${name}` : thunderstorePackageUuid(pkg) ?? '';
}

function thunderstoreVersions(pkg: any): any[] {
  return Array.isArray(pkg?.versions) ? pkg.versions : [];
}

function thunderstoreVersionNumber(version: any): string | null {
  return version?.version_number ?? version?.versionNumber ?? version?.version ?? null;
}

function thunderstoreVersionUuid(version: any): string | undefined {
  return version?.uuid4 ?? version?.uuid ?? undefined;
}

function selectThunderstoreVersion(pkg: any, requestedVersion: string | null | undefined): any | null {
  const versions = thunderstoreVersions(pkg);
  if (versions.length === 0) return null;
  if (requestedVersion) {
    const requested = normalizeVersion(requestedVersion);
    const exact = versions.find((version) => normalizeVersion(thunderstoreVersionNumber(version)) === requested);
    if (exact) return exact;
  }
  return versions[0];
}

function isThunderstorePackageMatch(pkg: any, item: ModProfileManifest['items'][number]): boolean {
  const { owner, name } = sourceIdParts(item.sourceId);
  const packageOwner = (pkg?.owner ?? '').toString();
  const packageName = (pkg?.name ?? '').toString();
  if (owner && name && packageOwner.toLowerCase() === owner.toLowerCase() && packageName.toLowerCase() === name.toLowerCase()) {
    return true;
  }

  const wanted = [
    item.name,
    item.fileName ?? undefined,
    name,
  ].map(normalizeMatchToken).filter(Boolean);
  const candidate = normalizeMatchToken(packageName);
  return wanted.some((token) => token === candidate || token.includes(candidate) || candidate.includes(token));
}

function bestThunderstoreMatch(
  packages: any[],
  item: ModProfileManifest['items'][number],
): ThunderstoreMatch | null {
  const pkg = packages.find((candidate) => isThunderstorePackageMatch(candidate, item));
  if (!pkg) return null;
  const packageUuid = thunderstorePackageUuid(pkg);
  if (!packageUuid) return null;
  const selectedVersion = selectThunderstoreVersion(pkg, item.sourceVersion);
  const versionNumber = thunderstoreVersionNumber(selectedVersion);
  return {
    package: pkg,
    packageUuid,
    sourceId: thunderstoreSourceId(pkg),
    versionNumber,
    versionUuid: thunderstoreVersionUuid(selectedVersion),
  };
}

function profileSearchQueries(item: ModProfileManifest['items'][number]): string[] {
  const { name } = sourceIdParts(item.sourceId);
  const featuredSourceId = featuredThunderstoreSourceId(item);
  const featuredName = sourceIdParts(featuredSourceId).name;
  return Array.from(new Set([
    featuredName,
    name,
    item.name,
    item.fileName ?? undefined,
    normalizeMatchToken(item.name),
  ].filter((value): value is string => Boolean(value && value.trim()))));
}

async function findThunderstoreMatch(item: ModProfileManifest['items'][number]): Promise<ThunderstoreMatch | null> {
  const runtime = profileRuntime(item.runtime);
  const featuredSourceId = featuredThunderstoreSourceId(item);
  const searchItem = featuredSourceId && !item.sourceId
    ? { ...item, sourceId: featuredSourceId }
    : item;
  for (const query of profileSearchQueries(item)) {
    const result = await ApiService.searchThunderstore('schedule-i', query, runtime ?? 'unknown');
    const match = bestThunderstoreMatch(result.packages ?? [], searchItem);
    if (match) return match;
  }
  return null;
}

function numericId(value: string | number | null | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nexusFileVersion(file: any): string | null {
  return file?.version ?? file?.mod_version ?? null;
}

function nexusFileId(file: any): number | null {
  return numericId(file?.file_id ?? file?.fileId);
}

function fileRuntimeMatches(file: any, item: ModProfileManifest['items'][number]): boolean {
  const runtime = profileRuntime(item.runtime);
  if (!runtime) return true;
  const haystack = [
    file?.name,
    file?.file_name,
    file?.category_name,
  ].filter(Boolean).join(' ');
  const fileRuntime = profileRuntime(haystack);
  return !fileRuntime || fileRuntime === runtime;
}

function selectNexusFile(files: any[], item: ModProfileManifest['items'][number]): any | null {
  const requested = normalizeVersion(item.sourceVersion);
  if (requested) {
    const exact = files.find((file) =>
      fileRuntimeMatches(file, item) && normalizeVersion(nexusFileVersion(file)) === requested
    );
    if (exact) return exact;
  }
  return files.find((file) => fileRuntimeMatches(file, item)) ?? files[0] ?? null;
}

function isNexusModMatch(mod: any, item: ModProfileManifest['items'][number]): boolean {
  const wanted = [item.name, item.fileName ?? undefined].map(normalizeMatchToken).filter(Boolean);
  const candidate = normalizeMatchToken(mod?.name);
  return wanted.some((token) => token === candidate || token.includes(candidate) || candidate.includes(token));
}

async function findNexusMatch(item: ModProfileManifest['items'][number]): Promise<NexusMatch | null> {
  const directModId = numericId(item.sourceId);
  const directFileId = numericId(item.nexusFileId);
  if (directModId && directFileId) {
    return { modId: directModId, fileId: directFileId };
  }

  for (const query of profileSearchQueries(item)) {
    const result = await ApiService.searchNexusMods('schedule1', query);
    const mod = (result.mods ?? []).find((candidate) => isNexusModMatch(candidate, item));
    const modId = numericId(mod?.mod_id);
    if (!modId) continue;
    const files = await ApiService.getNexusModsModFiles('schedule1', modId);
    const file = selectNexusFile(files, item);
    const fileId = nexusFileId(file);
    if (fileId) return { modId, fileId };
  }

  return null;
}

export function ProfileImportWorkspace({ onClose }: ProfileImportWorkspaceProps) {
  const { environments } = useEnvironmentStore();
  const completedEnvironments = useMemo(
    () => environments.filter((environment) => environment.status === 'completed'),
    [environments],
  );
  const [profileText, setProfileText] = useState('');
  const [profileSource, setProfileSource] = useState<string | null>(null);
  const [targetEnvironmentId, setTargetEnvironmentId] = useState(completedEnvironments[0]?.id ?? '');
  const [plan, setPlan] = useState<ModProfileImportPlan | null>(null);
  const [resolutionNotices, setResolutionNotices] = useState<Record<string, ProfileResolutionNotice>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingNexusImportKey, setPendingNexusImportKey] = useState<string | null>(null);
  const [applyMessage, setApplyMessage] = useState<string | null>(null);

  const selectedTarget = completedEnvironments.find((environment) => environment.id === targetEnvironmentId) ?? null;

  const loadManifest = async (): Promise<ModProfileManifest> => {
    if (profileSource) {
      return ApiService.readModProfileFile(profileSource);
    }
    return parseManifest(profileText);
  };

  const handleChooseProfileFile = async () => {
    setBusy(true);
    setError(null);
    setApplyMessage(null);
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'SIMM Profile', extensions: ['json'] }],
      });
      if (!selected || Array.isArray(selected)) return;

      const manifest = await ApiService.readModProfileFile(selected);
      setProfileSource(selected);
      setProfileText(JSON.stringify(manifest, null, 2));
      const nextPlan = await ApiService.previewModProfileImport(manifest, targetEnvironmentId || null);
      setPlan(nextPlan);
      await resolveProfileDownloads(manifest, nextPlan, 'preview');
    } catch (err) {
      setPlan(null);
      setResolutionNotices({});
      setError(err instanceof Error ? err.message : 'Failed to load profile file.');
    } finally {
      setBusy(false);
    }
  };

  const handlePreview = async () => {
    setBusy(true);
    setError(null);
    setApplyMessage(null);
    try {
      const manifest = await loadManifest();
      const nextPlan = await ApiService.previewModProfileImport(manifest, targetEnvironmentId || null);
      setPlan(nextPlan);
      await resolveProfileDownloads(manifest, nextPlan, 'preview');
    } catch (err) {
      setPlan(null);
      setResolutionNotices({});
      setError(err instanceof Error ? err.message : 'Failed to preview profile import.');
    } finally {
      setBusy(false);
    }
  };

  const resolveProfileDownloads = async (
    manifest: ModProfileManifest,
    currentPlan: ModProfileImportPlan,
    mode: ProfileResolutionMode,
  ): Promise<ModProfileManifest> => {
    const nexusStatus = await ApiService.getNexusOAuthStatus().catch(() => null);
    const canDirectDownloadNexus = Boolean(
      nexusStatus?.account?.canDirectDownload || nexusStatus?.account?.isPremium,
    );
    const notices: Record<string, ProfileResolutionNotice> = {};
    const nextItems = [...manifest.items];

    for (const [index, planItem] of currentPlan.items.entries()) {
      const item = nextItems[index];
      if (!item) continue;
      if (!['needsDownload', 'manualRequired'].includes(planItem.status)) continue;

      const key = profileItemKey(item, index);
      const runtime = profileRuntime(item.runtime);
      const featuredGithubSource = featuredGithubSourceId(item);
      const exactNexusMatch = item.source === 'nexusmods' ? await findNexusMatch(item) : null;
      const applyThunderstoreMatch = async (thunderstoreMatch: ThunderstoreMatch): Promise<void> => {
        if (mode === 'download') {
          const result = await ApiService.downloadThunderstoreToLibrary(
            thunderstoreMatch.packageUuid,
            runtime,
            undefined,
            thunderstoreMatch.versionUuid,
          );
          if (result.securityScanBlocked || result.securityScanConfirmationRequired) {
            notices[key] = { kind: 'manual', message: `${item.name} needs security review before SIMM can import it.` };
            return;
          }
          if (result.storageId) {
            nextItems[index] = {
              ...item,
              source: 'thunderstore',
              sourceId: thunderstoreMatch.sourceId,
              sourceVersion: thunderstoreMatch.versionNumber ?? item.sourceVersion,
              sourceUrl: thunderstoreMatch.package?.package_url ?? item.sourceUrl,
              runtime: runtime ?? item.runtime,
              storageId: result.storageId,
              manualReason: null,
            };
          }
        }
        notices[key] = {
          kind: 'matched',
          message: `${item.name} matched ${thunderstoreMatch.sourceId} on Thunderstore.`,
        };
      };

      if (exactNexusMatch) {
        if (!canDirectDownloadNexus) {
          const thunderstoreMatch = await findThunderstoreMatch(item);
          const thunderstoreVersionMatch = !item.sourceVersion
            || normalizeVersion(thunderstoreMatch?.versionNumber) === normalizeVersion(item.sourceVersion);
          if (thunderstoreMatch && thunderstoreVersionMatch) {
            await applyThunderstoreMatch(thunderstoreMatch);
            continue;
          }

          notices[key] = {
            kind: 'nexusManual',
            message: `${item.name} has a Nexus Mods file match, but this account must confirm the download manually.`,
            nexus: exactNexusMatch,
            modUrl: `https://www.nexusmods.com/schedule1/mods/${exactNexusMatch.modId}?tab=files`,
          };
          continue;
        }

        if (mode === 'download') {
          const result = await ApiService.downloadNexusModToLibrary(exactNexusMatch.modId, exactNexusMatch.fileId, runtime);
          if (result.requiresManualDownload) {
            notices[key] = {
              kind: 'nexusManual',
              message: `${item.name} has a Nexus Mods file match, but this account must confirm the download manually.`,
              nexus: exactNexusMatch,
              modUrl: result.modUrl ?? `https://www.nexusmods.com/schedule1/mods/${exactNexusMatch.modId}?tab=files`,
            };
            continue;
          }
          if (result.securityScanBlocked || result.securityScanConfirmationRequired) {
            notices[key] = { kind: 'manual', message: `${item.name} needs security review before SIMM can import it.` };
            continue;
          }
          if (result.storageId) {
            nextItems[index] = {
              ...item,
              source: 'nexusmods',
              sourceId: String(exactNexusMatch.modId),
              nexusFileId: String(exactNexusMatch.fileId),
              runtime: runtime ?? item.runtime,
              storageId: result.storageId,
              manualReason: null,
            };
          }
        }
        notices[key] = { kind: 'matched', message: `${item.name} matched the listed Nexus Mods file.` };
        continue;
      }

      if (featuredGithubSource === 'ifBars/S1API' && item.sourceVersion) {
        if (mode === 'download') {
          const result = await ApiService.downloadS1APIToLibrary(item.sourceVersion);
          if (result.securityScanBlocked || result.securityScanConfirmationRequired) {
            notices[key] = { kind: 'manual', message: `${item.name} needs security review before SIMM can import it.` };
            continue;
          }
          if (result.storageId) {
            nextItems[index] = {
              ...item,
              source: 'github',
              sourceId: 'ifBars/S1API',
              sourceUrl: 'https://github.com/ifBars/S1API',
              runtime: runtime ?? item.runtime,
              storageId: result.storageId,
              manualReason: null,
            };
          }
        }
        notices[key] = { kind: 'matched', message: `${item.name} can be downloaded from GitHub.` };
        continue;
      }

      if (featuredGithubSource === 'ifBars/MLVScan' && item.sourceVersion) {
        if (mode === 'download') {
          const result = await ApiService.downloadMLVScanToLibrary(item.sourceVersion);
          if (result.securityScanBlocked || result.securityScanConfirmationRequired) {
            notices[key] = { kind: 'manual', message: `${item.name} needs security review before SIMM can import it.` };
            continue;
          }
          if (result.storageId) {
            nextItems[index] = {
              ...item,
              source: 'github',
              sourceId: 'ifBars/MLVScan',
              sourceUrl: 'https://github.com/ifBars/MLVScan',
              runtime: runtime ?? item.runtime,
              storageId: result.storageId,
              manualReason: null,
            };
          }
        }
        notices[key] = { kind: 'matched', message: `${item.name} can be downloaded from GitHub.` };
        continue;
      }

      const thunderstoreMatch = await findThunderstoreMatch(item);

      if (thunderstoreMatch) {
        await applyThunderstoreMatch(thunderstoreMatch);
        continue;
      }

      if (item.source !== 'nexusmods') {
        const match = await findNexusMatch(item);
        if (match) {
          if (!canDirectDownloadNexus) {
            notices[key] = {
              kind: 'nexusManual',
              message: `${item.name} matched Nexus Mods, but this account must confirm the download manually.`,
              nexus: match,
              modUrl: `https://www.nexusmods.com/schedule1/mods/${match.modId}?tab=files`,
            };
            continue;
          }
          if (mode === 'download') {
            const result = await ApiService.downloadNexusModToLibrary(match.modId, match.fileId, runtime);
            if (result.requiresManualDownload) {
              notices[key] = {
                kind: 'nexusManual',
                message: `${item.name} matched Nexus Mods, but this account must confirm the download manually.`,
                nexus: match,
                modUrl: result.modUrl ?? `https://www.nexusmods.com/schedule1/mods/${match.modId}?tab=files`,
              };
              continue;
            }
            if (result.securityScanBlocked || result.securityScanConfirmationRequired) {
              notices[key] = { kind: 'manual', message: `${item.name} needs security review before SIMM can import it.` };
              continue;
            }
            if (result.storageId) {
              nextItems[index] = {
                ...item,
                source: 'nexusmods',
                sourceId: String(match.modId),
                nexusFileId: String(match.fileId),
                runtime: runtime ?? item.runtime,
                storageId: result.storageId,
                manualReason: null,
              };
            }
          }
          notices[key] = { kind: 'matched', message: `${item.name} matched Nexus Mods.` };
          continue;
        }
      }

      notices[key] = {
        kind: 'noMatchFound',
        message: `No matching downloadable source found for ${item.name}.`,
      };
    }

    setResolutionNotices(notices);
    return { ...manifest, items: nextItems };
  };

  const handleStartNexusManualImport = async (
    item: ModProfileImportPlan['items'][number],
    index: number,
    notice: ProfileResolutionNotice,
  ) => {
    if (!targetEnvironmentId) {
      setError('Choose a target environment before starting a Nexus manual import.');
      return;
    }
    if (!notice.nexus) return;

    const key = profileItemKey(item.item, index);
    setPendingNexusImportKey(key);
    setError(null);
    setApplyMessage(null);
    try {
      const result = await ApiService.beginNexusManualDownloadSession({
        kind: 'install',
        modId: notice.nexus.modId,
        fileId: notice.nexus.fileId,
        gameId: 'schedule1',
        environmentId: targetEnvironmentId,
        runtime: profileRuntime(item.item.runtime),
      });
      window.open(result.filesPageUrl || notice.modUrl, '_blank', 'noopener,noreferrer');
      setApplyMessage(`Started Nexus manual import for ${item.item.name}. Use the Nexus download prompt to continue.`);
    } catch (err) {
      setPendingNexusImportKey(null);
      setError(err instanceof Error ? err.message : 'Failed to start Nexus manual import.');
    }
  };

  const handleApply = async () => {
    if (!targetEnvironmentId) {
      setError('Choose a target environment before applying the profile.');
      return;
    }
    setBusy(true);
    setError(null);
    setApplyMessage(null);
    try {
      const manifest = await loadManifest();
      const initialPlan = await ApiService.previewModProfileImport(manifest, targetEnvironmentId || null);
      setPlan(initialPlan);
      const resolvedManifest = await resolveProfileDownloads(manifest, initialPlan, 'download');
      const result = await ApiService.applyModProfileImport({
        manifest: resolvedManifest,
        targetEnvironmentId,
      });
      setPlan(result.plan);
      setApplyMessage(`Installed ${result.installed}; ${result.unresolved} unresolved.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply profile import.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="profile-workspace workspace-collection-shell">
      <WorkspacePageHeader
        eyebrow="Profiles"
        title="Import Profile"
        description="Preview a shared SIMM profile before changing an environment."
      />

      <div className="profile-workspace__layout">
        <section className="profile-workspace__panel">
          <div className="profile-workspace__toolbar">
            <label className="profile-workspace__field">
              <span>Target environment</span>
              <select
                value={targetEnvironmentId}
                onChange={(event) => setTargetEnvironmentId(event.target.value)}
              >
                <option value="">Preview without target</option>
                {completedEnvironments.map((environment) => (
                  <option key={environment.id} value={environment.id}>
                    {environment.name} ({environment.runtime})
                  </option>
                ))}
              </select>
            </label>
            {selectedTarget && (
              <div className="profile-workspace__target-summary">
                <strong>{selectedTarget.name}</strong>
                <span>{selectedTarget.runtime} on {selectedTarget.branch}</span>
              </div>
            )}
          </div>

          <div className="profile-workspace__file-row">
            <SimmButton type="button" variant="secondary" className="btn btn-secondary" onClick={handleChooseProfileFile} disabled={busy}>
              <Icon name="folderOpen" />
              Choose Profile JSON
            </SimmButton>
            {profileSource && <span title={profileSource}>{profileSource}</span>}
          </div>

          <Textarea
            className="profile-workspace__input"
            value={profileText}
            onChange={(event) => {
              setProfileSource(null);
              setProfileText(event.target.value);
            }}
            placeholder="Paste a SIMM profile JSON export..."
          />

          {error && <div className="profile-workspace__notice profile-workspace__notice--error">{error}</div>}
          {applyMessage && <div className="profile-workspace__notice profile-workspace__notice--success">{applyMessage}</div>}

          <div className="profile-workspace__actions">
            <SimmButton type="button" variant="secondary" className="btn btn-secondary" onClick={onClose} disabled={!onClose}>
              Close
            </SimmButton>
            <SimmButton type="button" variant="secondary" className="btn btn-secondary" onClick={handlePreview} disabled={busy || (!profileText.trim() && !profileSource)}>
              <Icon name={busy ? 'spinner' : 'search'} />
              Preview
            </SimmButton>
            <SimmButton type="button" className="btn btn-primary" onClick={handleApply} disabled={busy || (!profileText.trim() && !profileSource) || !targetEnvironmentId || !plan}>
              <Icon name={busy ? 'spinner' : 'download'} />
              Download & Apply
            </SimmButton>
          </div>
        </section>

        <aside className="profile-workspace__panel profile-workspace__plan">
          {plan ? (
            <>
              <div className="profile-workspace__plan-header">
                <div>
                  <span className="workspace-eyebrow">Profile</span>
                  <h2>{plan.profile.name}</h2>
                  <p>{plan.profile.runtime} on {plan.profile.branch}</p>
                </div>
              </div>
              <div className="profile-workspace__summary-grid">
                <div className="workspace-pill profile-workspace__summary-pill"><span>Total</span><strong>{plan.summary.total}</strong></div>
                <div className="workspace-pill workspace-pill--success profile-workspace__summary-pill"><span>Ready</span><strong>{plan.summary.readyToInstall}</strong></div>
                <div className="workspace-pill workspace-pill--source profile-workspace__summary-pill"><span>Installed</span><strong>{plan.summary.alreadyInstalled}</strong></div>
                <div className="workspace-pill workspace-pill--warning profile-workspace__summary-pill"><span>Manual</span><strong>{plan.summary.manualRequired + plan.summary.needsDownload + plan.summary.runtimeMismatches}</strong></div>
              </div>
              <div className="profile-workspace__items">
                {plan.items.map((item, index) => {
                  const notice = resolutionNotices[profileItemKey(item.item, index)];
                  const itemStatusClass = notice?.kind === 'noMatchFound'
                    ? 'noMatchFound'
                    : notice?.kind === 'nexusManual'
                      ? 'nexusManual'
                    : item.status;
                  const itemKey = profileItemKey(item.item, index);
                  const nexusManualBusy = Boolean(pendingNexusImportKey && pendingNexusImportKey !== itemKey);
                  return (
                    <article key={`${item.item.name}-${index}`} className={`profile-workspace__item profile-workspace__item--${itemStatusClass}`}>
                      <div>
                        <strong>{item.item.name}</strong>
                        <span>{item.item.source || item.item.itemType}{item.item.sourceVersion ? ` - ${item.item.sourceVersion}` : ''}</span>
                      </div>
                      <span>
                        {notice?.kind === 'noMatchFound'
                          ? 'No match found'
                          : notice?.kind === 'nexusManual'
                            ? 'Nexus manual'
                            : statusLabels[item.status] || item.status}
                      </span>
                      <p>{notice?.message ?? item.message}</p>
                      {notice?.kind === 'nexusManual' && notice.nexus ? (
                        <div className="profile-workspace__item-actions">
                          <SimmButton
                            type="button"
                            variant="secondary"
                            className="btn btn-secondary btn-small"
                            disabled={busy || nexusManualBusy || pendingNexusImportKey === itemKey}
                            onClick={() => void handleStartNexusManualImport(item, index, notice)}
                          >
                            <Icon name={pendingNexusImportKey === itemKey ? 'spinner' : 'download'} />
                            {pendingNexusImportKey === itemKey ? 'Import Started' : 'Start Nexus Import'}
                          </SimmButton>
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="profile-workspace__empty">
              <Icon name="fileCircleQuestion" />
              <strong>No profile preview yet</strong>
              <span>Paste a shared profile and preview it to see what SIMM can install.</span>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
