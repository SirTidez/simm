import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ApiService } from "../services/api";
import { logger } from "../services/logger";
import { ConfirmOverlay } from "./ConfirmOverlay";
import { NexusDescription } from "./NexusBbCode";
import {
  handleCardActivationKeyDown,
  resolveImageSource,
  safeExternalUrl,
} from "./modCardHelpers";
import { useSettingsStore } from "../stores/settingsStore";
import { useEnvironmentStore } from "../stores/environmentStore";
import { useModLibraryStore } from "../stores/modLibraryStore";
import { useOptionalDownloadStatusStore } from "../stores/downloadStatusStore";
import {
  SecurityScanReportOverlay,
  type SecurityScanReportOption,
} from "./SecurityScanReportOverlay";
import { Icon } from './Icon';
import { ModThumbnail, type ModArtwork } from "./media/ModThumbnail";
import { useModArtwork } from "./media/useModArtwork";
import { type SecurityReportWorkspaceRequest } from "./SecurityScanReportPage";
import {
  AnchoredContextMenu,
  type AnchoredContextMenuItem,
} from "./AnchoredContextMenu";
import {
  InstallTargetsDialog,
  getNormalizedRuntime,
} from "./InstallTargetsDialog";
import { SimmButton, SimmDialogContent } from "./primitives";
import { getSecurityBadgeConfig } from "./securityScanHelpers";
import {
  areVersionsEquivalent,
  areVersionsEquivalentForSource,
  buildDownloadedGroups,
  compareVersionTokensDescForSource,
  compareVersionTokensDesc,
  getNexusFileIdFromTags,
  normalizeThunderstoreName,
  normalizeVersionToken,
  parseThunderstoreSourceId,
  type DownloadedModGroup,
} from "../services/modLibrarySummary";
import {
  findCollectionFileConflicts,
  findStagedCollectionEntry,
} from "../services/nexusCollectionStaging";
import {
  collectionFileKey,
  findCollectionThunderstoreMatches,
  findExactCollectionLibraryEntry,
  inferNexusFileRuntime as inferCollectionNexusFileRuntime,
  resolveCollectionNexusFileForRuntime,
  resolveCollectionStorageId,
  selectCollectionThunderstoreMatch,
  updateCollectionProfileFromLibrary,
  type CollectionThunderstoreMatch,
  type CollectionThunderstorePackage,
} from "../services/collectionProfile";
import type {
  Environment,
  ModLibraryEntry,
  ModLibraryResult,
  NexusDependencyCandidate,
  NexusDependencyRequirement,
  NexusCollection,
  NexusCollectionModFile,
  NexusCollectionRevisionPlan,
  NexusMod,
  NexusModFileDependencies,
  NexusModFile,
  SecurityScanReport,
  SecurityScanSummary,
  StoredModProfile,
} from "../types";

interface ThunderstorePackage {
  uuid4: string;
  name: string;
  owner: string;
  package_url: string;
  date_created: string;
  date_updated: string;
  rating_score: number;
  is_pinned: boolean;
  is_deprecated: boolean;
  categories?: string[];
  full_name: string;
  versions: Array<{
    name: string;
    full_name: string;
    date_created: string;
    date_updated: string;
    uuid4: string;
    version_number: string;
    dependencies: string[];
    download_url: string;
    downloads: number;
    file_size: number;
    description?: string;
    icon?: string;
  }>;
  icon?: string;
  icon_url?: string;
}

type ThunderstoreRuntime = "IL2CPP" | "Mono";

export interface ThunderstorePackageGroup {
  key: string;
  name: string;
  owner: string;
  packageUrl: string;
  packagesByRuntime: Partial<Record<ThunderstoreRuntime, ThunderstorePackage>>;
}

type ThunderstorePackageVersion = ThunderstorePackage["versions"][number];

interface ThunderstoreVersionOption {
  key: string;
  versionNumber: string;
  runtimes: ThunderstoreRuntime[];
  packagesByRuntime: Partial<Record<ThunderstoreRuntime, ThunderstorePackage>>;
  versionsByRuntime: Partial<
    Record<ThunderstoreRuntime, ThunderstorePackageVersion>
  >;
  updatedAt?: string;
  downloads?: number;
  description?: string;
}

type DateLike = string | number | Date | undefined | null;
type NexusModDateAliases = {
  updatedAt?: string;
  createdAt?: string;
  updated_at?: string;
  created_at?: string;
};

interface FeaturedGithubRelease {
  tag_name: string;
  name: string;
  published_at: string;
  prerelease: boolean;
  download_url: string | null;
  body?: string;
}

type RuntimeInstallTargets = Partial<Record<"IL2CPP" | "Mono", string[]>>;

const FEATURED_DOWNLOADS = {
  s1api: {
    key: "featured-s1api",
    sourceId: "ifBars/S1API",
    displayName: "S1API",
    packageUrl: "https://github.com/ifBars/S1API",
    author: "ifBars",
  },
  mlvscan: {
    key: "featured-mlvscan",
    sourceId: "ifBars/MLVScan",
    displayName: "MLVScan",
    packageUrl: "https://github.com/ifBars/MLVScan",
    author: "ifBars",
  },
} as const;

const FEATURED_THUNDERSTORE_DOWNLOADS = {
  meshvault: {
    key: "featured-meshvault",
    sourceId: "hdlmrell/MeshVault",
    displayName: "MeshVault",
    packageUrl: "https://thunderstore.io/c/schedule-i/p/hdlmrell/MeshVault/",
    author: "hdlmrell",
    installBucketLabel: "Plugins",
    summary: "Thunderstore package for shared mesh loading and vault access.",
  },
  s1mapi: {
    key: "featured-s1mapi",
    sourceId: "ifBars/S1MAPI",
    displayName: "S1MAPI",
    packageUrl: "https://thunderstore.io/c/schedule-i/p/ifBars/S1MAPI/",
    author: "ifBars",
    installBucketLabel: "UserLibs",
    summary:
      "Thunderstore package for shared Schedule I mapping and construction APIs.",
  },
  steamnetworklib: {
    key: "featured-steamnetworklib",
    sourceId: "ifBars/SteamNetworkLib_Mono",
    sourceIdsByRuntime: {
      IL2CPP: "ifBars/SteamNetworkLib_Il2Cpp",
      Mono: "ifBars/SteamNetworkLib_Mono",
    },
    displayName: "SteamNetworkLib",
    packageUrl:
      "https://thunderstore.io/c/schedule-i/p/ifBars/SteamNetworkLib_Mono/",
    author: "ifBars",
    installBucketLabel: "UserLibs",
    summary:
      "Thunderstore library for shared Steam networking support used by many tools.",
  },
} as const;

function getDownloadedGroupSourceIds(group: DownloadedModGroup): string[] {
  return group.entries
    .map((entry) => (entry.sourceId || "").toLowerCase())
    .filter(Boolean);
}

function isS1ApiDownloadedGroup(group: DownloadedModGroup): boolean {
  const sourceIds = getDownloadedGroupSourceIds(group);
  return (
    sourceIds.includes("ifbars/s1api") ||
    sourceIds.includes("ifbars/s1api_forked") ||
    normalizeThunderstoreName(group.displayName).toLowerCase() === "s1api"
  );
}

function isMlvscanDownloadedGroup(group: DownloadedModGroup): boolean {
  const sourceIds = getDownloadedGroupSourceIds(group);
  return (
    sourceIds.includes("ifbars/mlvscan") ||
    normalizeThunderstoreName(group.displayName).toLowerCase() === "mlvscan"
  );
}

function isMeshVaultDownloadedGroup(group: DownloadedModGroup): boolean {
  const sourceIds = getDownloadedGroupSourceIds(group);
  return (
    sourceIds.includes("hdlmrell/meshvault") ||
    normalizeThunderstoreName(group.displayName).toLowerCase() === "meshvault"
  );
}

function isS1MApiDownloadedGroup(group: DownloadedModGroup): boolean {
  const sourceIds = getDownloadedGroupSourceIds(group);
  return (
    sourceIds.includes("ifbars/s1mapi") ||
    normalizeThunderstoreName(group.displayName).toLowerCase() === "s1mapi"
  );
}

function isSteamNetworkLibDownloadedGroup(group: DownloadedModGroup): boolean {
  const sourceIds = getDownloadedGroupSourceIds(group);
  return (
    sourceIds.includes("ifbars/steamnetworklib") ||
    sourceIds.includes("ifbars/steamnetworklib_mono") ||
    sourceIds.includes("ifbars/steamnetworklib_il2cpp") ||
    normalizeThunderstoreName(group.displayName).toLowerCase() ===
      "steamnetworklib"
  );
}

function getFeaturedGithubUpdateConfig(
  group: DownloadedModGroup,
):
  | {
      downloader: typeof ApiService.downloadS1APIToLibrary;
      loadLatestRelease: () => Promise<FeaturedGithubRelease | null>;
    }
  | null {
  if (isS1ApiDownloadedGroup(group)) {
    return {
      downloader: ApiService.downloadS1APIToLibrary,
      loadLatestRelease: () => ApiService.getS1APILatestRelease(""),
    };
  }

  if (isMlvscanDownloadedGroup(group)) {
    return {
      downloader: ApiService.downloadMLVScanToLibrary,
      loadLatestRelease: () => ApiService.getMLVScanLatestRelease(""),
    };
  }

  return null;
}

function collectDownloadedGroupStorageIds(
  group: Pick<DownloadedModGroup, "entries">,
): string[] {
  return Array.from(
    new Set(
      group.entries.flatMap(
        (entry) =>
          [
            entry.storageId,
            ...Object.values(entry.storageIdsByRuntime || {}),
          ].filter(Boolean) as string[],
      ),
    ),
  );
}

function mergeInstallTargets(...targets: string[][]): string[] {
  return Array.from(new Set(targets.flat()));
}

function mergeRuntimeInstallTargets(
  ...maps: RuntimeInstallTargets[]
): RuntimeInstallTargets {
  return {
    IL2CPP: mergeInstallTargets(...maps.map((map) => map.IL2CPP || [])),
    Mono: mergeInstallTargets(...maps.map((map) => map.Mono || [])),
  };
}

function getDownloadedVersionSourceId(
  groups: DownloadedModGroup[],
): string | undefined {
  const sourceIds = groups.flatMap(getDownloadedGroupSourceIds);
  if (
    sourceIds.includes("ifbars/s1api") ||
    sourceIds.includes("ifbars/s1api_forked")
  ) {
    return FEATURED_DOWNLOADS.s1api.sourceId;
  }

  return groups
    .flatMap((group) => group.entries)
    .map((entry) => entry.sourceId)
    .find(Boolean);
}

export type DownloadedFilter =
  | "all"
  | "updates"
  | "managed"
  | "external"
  | "installed";
export type LibraryTab = "discover" | "library" | "updates";
type DiscoverSort = "relevance" | "updated" | "popularity" | "newest";
export type NexusCatalogKind = "mods" | "collections";
const NEXUS_CATALOG_PAGE_SIZE = 50;

const DISCOVER_SORT_OPTIONS: Array<{ value: DiscoverSort; label: string }> = [
  { value: "relevance", label: "Relevance" },
  { value: "updated", label: "Last updated" },
  { value: "popularity", label: "Popularity" },
  { value: "newest", label: "Newest" },
];

function LibraryEmpty({
  icon,
  title,
  children,
  action,
}: {
  icon: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="ui-empty lib-empty">
      <span className="ui-empty__emblem" aria-hidden="true">
        <Icon name={icon} />
      </span>
      <p className="ui-empty__title">{title}</p>
      {children ? <p className="ui-empty__copy">{children}</p> : null}
      {action}
    </div>
  );
}

function LibrarySkeletonRows({ label }: { label: string }) {
  return (
    <div className="lib-skeleton" role="status" aria-label={label}>
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="lib-skeleton__row">
          <Skeleton className="lib-skeleton__icon" />
          <div className="lib-skeleton__lines">
            <Skeleton className="lib-skeleton__line" />
            <Skeleton className="lib-skeleton__line lib-skeleton__line--short" />
          </div>
        </div>
      ))}
    </div>
  );
}

type LibraryTagTone = "ok" | "warn" | "danger" | "muted";

function LibraryTag({
  tone,
  children,
}: {
  tone?: LibraryTagTone;
  children: ReactNode;
}) {
  return (
    <span className={cn("ui-tag", tone && tone !== "muted" && `ui-tag--${tone}`)}>
      {children}
    </span>
  );
}

/** One exception per object: security problems first, then pending updates. */
function getExceptionTag(
  summary: SecurityScanSummary | undefined,
  showSecurity: boolean,
  updateAvailable: boolean,
  includeMuted = false,
): { label: string; tone: LibraryTagTone } | null {
  const security = showSecurity ? getSecurityBadgeConfig(summary) : null;
  if (security?.exception && (includeMuted || security.tone !== "muted")) {
    return { label: security.label, tone: security.tone };
  }
  if (updateAvailable) {
    return { label: "Update available", tone: "warn" };
  }
  return null;
}

/** The item's own banner, full width above the title row; absent (no placeholder) without one. */
function DetailMedia({ src, alt }: { src?: string; alt: string }) {
  const source = resolveImageSource(src);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  if (!source || failedSource === source) return null;
  return (
    <figure className="lib-detail__media">
      <img
        src={source}
        alt={alt}
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setFailedSource(source)}
      />
    </figure>
  );
}

/** The icon a featured Thunderstore package publishes, used when the tool is not downloaded yet. */
function getFeaturedPackageArtwork(
  pkg: ThunderstorePackageGroup | null | undefined,
): ModArtwork | null {
  const representative = pkg?.packagesByRuntime.IL2CPP || pkg?.packagesByRuntime.Mono;
  const iconUrl =
    representative?.versions?.[0]?.icon || representative?.icon || representative?.icon_url;
  return iconUrl ? { iconUrl } : null;
}

/** A Nexus Collection's tile image as a 16:9 row thumbnail; a neutral glyph without one. */
function CollectionTile({ src }: { src?: string }) {
  const source = resolveImageSource(src);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const showImage = Boolean(source) && failedSource !== source;
  return (
    <span className={cn("lib-tile", !showImage && "lib-tile--fallback")} aria-hidden="true">
      {showImage ? (
        <img
          src={source}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailedSource(source ?? null)}
        />
      ) : (
        <Icon name="layerGroup" />
      )}
    </span>
  );
}

function ModLibraryDetailHeader({
  backLabel,
  onBack,
  media,
  mediaAlt,
  icon,
  title,
  meta,
  status,
  actions,
}: {
  backLabel: string;
  onBack: () => void;
  media?: string;
  mediaAlt?: string;
  icon: ReactNode;
  title: string;
  meta: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="lib-detail__header">
      <div className="lib-detail__nav">
        <SimmButton
          type="button"
          variant="ghost"
          size="sm"
          className="lib-detail__back"
          onClick={onBack}
        >
          <Icon name="arrowLeft" />
          <span>{backLabel}</span>
        </SimmButton>
      </div>
      <DetailMedia src={media} alt={mediaAlt || `${title} artwork`} />
      <div className="lib-detail__identity">
        {icon}
        <div className="lib-detail__titles">
          <div className="lib-detail__title-row">
            <h2 className="lib-detail__title">{title}</h2>
            {status}
          </div>
          <div className="ui-meta lib-detail__meta">{meta}</div>
        </div>
        {actions ? <div className="lib-detail__actions">{actions}</div> : null}
      </div>
    </header>
  );
}

function ExternalIconLink({
  href,
  label,
  title,
}: {
  href: string;
  label: string;
  title: string;
}) {
  return (
    <a
      className="btn lib-icon-link"
      data-slot="button"
      data-variant="ghost"
      data-size="icon"
      aria-label={label}
      title={title}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      <Icon name="arrowUpRightFromSquare" />
    </a>
  );
}

function LibrarySection({
  id,
  title,
  aside,
  children,
}: {
  id?: string;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="lib-section" aria-labelledby={id}>
      <div className="lib-section__header">
        <h3 id={id} className="ui-section-title lib-section__title">
          {title}
        </h3>
        {aside ? <div className="lib-section__aside">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

function SectionNote({ children }: { children: ReactNode }) {
  return <p className="lib-section__note">{children}</p>;
}

function DiscoverSortSelect({
  value,
  onValueChange,
}: {
  value: DiscoverSort;
  onValueChange: (value: DiscoverSort) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(nextValue) => {
        if (typeof nextValue === "string") {
          onValueChange(nextValue as DiscoverSort);
        }
      }}
    >
      <SelectTrigger
        aria-label="Sort discover results"
        className="lib-select-trigger"
      >
        <SelectValue>
          {(selectedValue) =>
            DISCOVER_SORT_OPTIONS.find((option) => option.value === selectedValue)
              ?.label || "Last updated"
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        <SelectGroup>
          {DISCOVER_SORT_OPTIONS.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              onClick={() => onValueChange(option.value)}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

const DOWNLOADED_FILTER_OPTIONS: Array<{ value: DownloadedFilter; label: string }> = [
  { value: "all", label: "All mods" },
  { value: "installed", label: "Installed" },
  { value: "managed", label: "Managed" },
  { value: "external", label: "External" },
];

function DownloadedFilterSelect({
  value,
  onValueChange,
}: {
  value: DownloadedFilter;
  onValueChange: (value: DownloadedFilter) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(nextValue) => {
        if (typeof nextValue === "string") {
          onValueChange(nextValue as DownloadedFilter);
        }
      }}
    >
      <SelectTrigger aria-label="Show mods" className="lib-select-trigger">
        <SelectValue>
          {(selectedValue) =>
            DOWNLOADED_FILTER_OPTIONS.find((option) => option.value === selectedValue)
              ?.label || (selectedValue === "updates" ? "With updates" : "All mods")
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        <SelectGroup>
          {DOWNLOADED_FILTER_OPTIONS.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              onClick={() => onValueChange(option.value)}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export interface LibraryModViewState {
  id: string;
  storageId?: string;
  name: string;
  source: string;
  author?: string;
  uploader?: string;
  originalAuthor?: string;
  summary?: string;
  iconUrl?: string;
  iconCachePath?: string;
  sourceUrl?: string;
  downloads?: number;
  likesOrEndorsements?: number;
  updatedAt?: string;
  tags?: string[];
  installedVersion?: string;
  latestVersion?: string;
  addedAt?: number;
  installedAt?: number;
  securityScan?: SecurityScanSummary;
  kind: "downloaded" | "thunderstore" | "nexusmods";
}

interface InstallDialogState {
  isOpen: boolean;
  title: string;
  entries: ModLibraryEntry[];
  compatibleEnvironments: Environment[];
  excludedEnvironments: Environment[];
  lockedEnvironmentIds: string[];
  mode: "select" | "installed";
  note?: string;
}

type InstallOutcomeReason =
  | "runtime-incompatible"
  | "blocked-by-sibling-version"
  | "already-installed"
  | "no-targets";

interface InstallExecutionResult {
  status: "installed" | "no-op";
  installedEnvironmentNames: string[];
  reason?: InstallOutcomeReason;
}

interface DownloadBatchFailure {
  label: string;
  message: string;
}

interface SuccessfulLibraryDownload {
  success: boolean;
  storageId?: string;
  alreadyStored?: boolean;
  promptEntry?: ModLibraryEntry;
}

interface SelectedLibraryImportItem {
  filePath: string;
  fileName: string;
}

const buildOptimisticDownloadedEntry = ({
  storageId,
  displayName,
  runtime,
  source,
  sourceId,
  version,
  summary,
  iconUrl,
  sourceUrl,
  author,
  downloads,
  likesOrEndorsements,
  updatedAt,
  tags,
}: {
  storageId: string;
  displayName: string;
  runtime: "IL2CPP" | "Mono";
  source: ModLibraryEntry["source"];
  sourceId?: string;
  version?: string;
  summary?: string;
  iconUrl?: string;
  sourceUrl?: string;
  author?: string;
  downloads?: number;
  likesOrEndorsements?: number;
  updatedAt?: string;
  tags?: string[];
}): ModLibraryEntry => ({
  storageId,
  displayName,
  files: [],
  attachedUserLibs: [],
  source,
  sourceId,
  sourceVersion: version,
  sourceUrl,
  summary,
  iconUrl,
  downloads,
  likesOrEndorsements,
  updatedAt,
  tags,
  installedVersion: version,
  managed: true,
  installedIn: [],
  availableRuntimes: [runtime],
  storageIdsByRuntime: { [runtime]: storageId },
  installedInByRuntime: { [runtime]: [] },
  filesByRuntime: { [runtime]: [] },
  author,
});

const formatVersionTag = (value?: string): string => {
  const normalized = normalizeVersionToken(value);
  return normalized ? `v${normalized}` : "unknown";
};

const stripFileExtension = (fileName: string): string =>
  fileName.replace(/\.(dll|zip|rar|7z|tar\.gz|tgz)$/i, "");

const normalizeNexusVersionRowLabel = (value?: string): string =>
  stripFileExtension(value || "")
    .toLowerCase()
    .replace(/\bv(?=\d)/g, "")
    .replace(/[^a-z0-9]+/g, "");

const getNexusVersionRowDetail = (
  file: Pick<NexusModFile, "file_name" | "name">,
  modName: string,
  versionLabel: string,
): string | null => {
  const candidate = stripFileExtension(file.file_name || file.name || "").trim();
  if (!candidate) {
    return null;
  }

  const normalizedCandidate = normalizeNexusVersionRowLabel(candidate);
  const normalizedModName = normalizeNexusVersionRowLabel(modName);
  const normalizedVersion = normalizeNexusVersionRowLabel(versionLabel);
  const candidateWithoutVersion = normalizedVersion
    ? normalizedCandidate.replace(normalizedVersion, "")
    : normalizedCandidate;

  if (
    normalizedCandidate === normalizedModName ||
    candidateWithoutVersion === normalizedModName ||
    normalizedCandidate === `${normalizedModName}${normalizedVersion}` ||
    normalizedCandidate === `${normalizedVersion}${normalizedModName}`
  ) {
    return null;
  }

  return candidate;
};

const getNexusVersionRowSummary = (
  file: Pick<NexusModFile, "file_name" | "name">,
  modName: string,
  versionLabel: string,
): string | null => {
  const summary = stripFileExtension(file.name || "").trim();
  if (!summary || summary === stripFileExtension(file.file_name || "").trim()) {
    return null;
  }

  return getNexusVersionRowDetail(
    { file_name: summary, name: summary },
    modName,
    versionLabel,
  );
};

const getNexusFileRowTitle = (
  file: Pick<NexusModFile, "file_name" | "name">,
  modName: string,
): string => {
  const title = stripFileExtension(file.file_name || file.name || "").trim();
  return title || modName;
};

const formatNexusFileCategory = (value: string): string => {
  const normalized = value.replace(/_/g, " ").trim().toLowerCase();
  return normalized
    ? `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`
    : value;
};

const formatFileSizeShort = (bytes?: number): string | null => {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) {
    return null;
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

const detectRuntimeFromFileName = (
  fileName: string,
): "IL2CPP" | "Mono" | null => {
  const lower = fileName.toLowerCase();
  if (lower.includes("mono")) return "Mono";
  if (lower.includes("il2cpp")) return "IL2CPP";
  return null;
};

const normalizeSelectedLibraryImportItems = (
  selected:
    | string
    | { path: string; name?: string }
    | Array<string | { path: string; name?: string }>
    | null,
): SelectedLibraryImportItem[] => {
  if (!selected) {
    return [];
  }

  const entries = Array.isArray(selected) ? selected : [selected];
  return entries.map((entry) => {
    if (typeof entry === "string") {
      return {
        filePath: entry,
        fileName: entry.split(/[/\\]/).pop() || "unknown",
      };
    }

    return {
      filePath: entry.path,
      fileName: entry.name || entry.path.split(/[/\\]/).pop() || "unknown",
    };
  });
};

const formatCompactNumber = (value?: number): string => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "unknown";
  }
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
};

const getEffectiveEnvironmentRuntime = (
  environment: Pick<Environment, "branch" | "runtime">,
): "IL2CPP" | "Mono" => {
  return getNormalizedRuntime(environment);
};

const normalizeDateLike = (value: DateLike): number => {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return 0;
    }
    if (/^\d+$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) {
        return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
      }
    }
    const parsed = new Date(trimmed).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const formatInspectorDate = (value?: DateLike): string => {
  if (!value) {
    return "unknown";
  }
  const timestamp = normalizeDateLike(value);
  if (!timestamp) {
    return "unknown";
  }
  const date = new Date(timestamp);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
};

const compareVersions = (a: string, b: string): number => {
  const normalize = (v: string) =>
    normalizeVersionToken(v)
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const aParts = normalize(a);
  const bParts = normalize(b);
  const maxLen = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < maxLen; i++) {
    const aVal = aParts[i] ?? 0;
    const bVal = bParts[i] ?? 0;
    if (aVal < bVal) return -1;
    if (aVal > bVal) return 1;
  }
  return 0;
};

const normalizeDateString = (value: DateLike): string | undefined => {
  const timestamp = normalizeDateLike(value);
  return timestamp ? new Date(timestamp).toISOString() : undefined;
};

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  return fallback;
};

const parseTimestamp = (value?: DateLike): number => normalizeDateLike(value);

const getThunderstorePackageUpdatedAt = (
  pkg?: ThunderstorePackage | null,
): DateLike => {
  if (!pkg) {
    return undefined;
  }

  const latestVersion = pkg.versions?.[0] as
    | (ThunderstorePackageVersion & {
        dateUpdated?: string;
        dateCreated?: string;
      })
    | undefined;
  const packageWithAliases = pkg as ThunderstorePackage & {
    dateUpdated?: string;
    dateCreated?: string;
  };

  return (
    pkg.date_updated ||
    packageWithAliases.dateUpdated ||
    latestVersion?.date_updated ||
    latestVersion?.dateUpdated ||
    pkg.date_created ||
    packageWithAliases.dateCreated ||
    latestVersion?.date_created ||
    latestVersion?.dateCreated
  );
};

const getNexusModUpdatedAt = (
  mod?: (NexusMod & NexusModDateAliases) | null,
): DateLike => {
  if (!mod) {
    return undefined;
  }

  const modWithAliases = mod as NexusMod & NexusModDateAliases;

  return (
    modWithAliases.updated_time ||
    modWithAliases.uploaded_time ||
    modWithAliases.updated_at ||
    modWithAliases.created_at ||
    modWithAliases.updatedAt ||
    modWithAliases.createdAt
  );
};

const getNexusFileUpdatedAt = (
  file?:
    | NexusModFile
    | (NexusModFile & {
        uploaded_time?: string;
        updated_time?: string;
        uploadedAt?: string;
        updatedAt?: string;
        uploaded_at?: string;
        updated_at?: string;
      })
    | null,
): DateLike => {
  if (!file) {
    return undefined;
  }

  if (file.uploaded_timestamp) {
    return new Date(file.uploaded_timestamp * 1000).toISOString();
  }

  return (
    (
      file as NexusModFile & {
        updated_time?: string;
        uploaded_time?: string;
        updated_at?: string;
        uploaded_at?: string;
        updatedAt?: string;
        uploadedAt?: string;
      }
    ).updated_time ||
    (
      file as NexusModFile & {
        updated_time?: string;
        uploaded_time?: string;
        updated_at?: string;
        uploaded_at?: string;
        updatedAt?: string;
        uploadedAt?: string;
      }
    ).uploaded_time ||
    (
      file as NexusModFile & {
        updated_time?: string;
        uploaded_time?: string;
        updated_at?: string;
        uploaded_at?: string;
        updatedAt?: string;
        uploadedAt?: string;
      }
    ).updated_at ||
    (
      file as NexusModFile & {
        updated_time?: string;
        uploaded_time?: string;
        updated_at?: string;
        uploaded_at?: string;
        updatedAt?: string;
        uploadedAt?: string;
      }
    ).uploaded_at ||
    (
      file as NexusModFile & {
        updated_time?: string;
        uploaded_time?: string;
        updated_at?: string;
        uploaded_at?: string;
        updatedAt?: string;
        uploadedAt?: string;
      }
    ).updatedAt ||
    (
      file as NexusModFile & {
        updated_time?: string;
        uploaded_time?: string;
        updated_at?: string;
        uploaded_at?: string;
        updatedAt?: string;
        uploadedAt?: string;
      }
    ).uploadedAt
  );
};

const inferNexusFileRuntime = (
  file: Pick<NexusModFile, "file_name" | "name" | "category_name">,
): "IL2CPP" | "Mono" | "Unknown" => {
  const fileName =
    `${file.file_name || ""} ${file.name || ""} ${file.category_name || ""}`.toLowerCase();
  if (fileName.includes("il2cpp")) {
    return "IL2CPP";
  }
  if (fileName.includes("mono")) {
    return "Mono";
  }
  return "Unknown";
};

const isNexusFomodInstaller = (
  file: Pick<NexusModFile, "file_name" | "name" | "category_name">,
): boolean => {
  const haystack =
    `${file.file_name || ""} ${file.name || ""} ${file.category_name || ""}`.toLowerCase();
  return (
    haystack.includes("vortex installer") ||
    haystack.includes("fomod") ||
    (haystack.includes("installer") && !haystack.includes("melonloader"))
  );
};

const getNexusFileDisplayKind = (
  file: Pick<NexusModFile, "file_name" | "name" | "category_name">,
): "All-in-One" | "IL2CPP" | "Mono" | "Unknown" => {
  if (isNexusFomodInstaller(file)) {
    return "All-in-One";
  }
  return inferNexusFileRuntime(file);
};

const getNexusFileTags = (file: Pick<NexusModFile, "file_id" | "file_name" | "name">): string[] => {
  const tags = [`nexus-file-id:${file.file_id}`];
  const fileName = stripFileExtension(file.file_name || file.name || "").trim();
  if (fileName) {
    tags.push(`nexus-file-name:${fileName}`);
  }
  return tags;
};

const isMelonLoaderDependency = (candidate: NexusDependencyCandidate): boolean => {
  const normalized = `${candidate.modName} ${candidate.modFileName}`
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return normalized.includes("melonloader");
};

const getVisibleNexusDependencyCandidates = (
  requirement: NexusDependencyRequirement,
): NexusDependencyCandidate[] =>
  requirement.candidates.filter((candidate) => !isMelonLoaderDependency(candidate));

const getMissingNexusDependencies = (
  dependencies: NexusModFileDependencies,
  downloadedGroups: DownloadedModGroup[],
): NexusDependencyRequirement[] => {
  const downloadedFileIds = new Set(
    downloadedGroups.flatMap((group) =>
      group.entries
        .filter((entry) => entry.source === "nexusmods")
        .map((entry) => getNexusFileIdFromTags(entry.tags))
        .filter(Boolean),
    ),
  );

  return dependencies.requirements.filter((requirement) => {
    const candidates = getVisibleNexusDependencyCandidates(requirement);
    return (
      candidates.length > 0 &&
      !candidates.some((candidate) =>
        downloadedFileIds.has(candidate.versionGameScopedId),
      )
    );
  });
};

const formatNexusDependencyCandidates = (
  requirement: NexusDependencyRequirement,
): string => {
  const candidates = getVisibleNexusDependencyCandidates(requirement);
  const labels = Array.from(
    new Set(
      candidates.map((candidate) => {
        const version = candidate.version ? ` ${formatVersionTag(candidate.version)}` : "";
        return `${candidate.modName || candidate.modFileName}${version}`.trim();
      }),
    ),
  );
  return labels.join(" or ");
};

interface ThunderstoreDependencyRequirement {
  raw: string;
  packageKey: string;
  minimumVersion: string;
}

const normalizeThunderstoreDependencyKey = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");

const parseThunderstoreDependency = (
  value: string,
): ThunderstoreDependencyRequirement | null => {
  const raw = value.trim();
  if (!raw) {
    return null;
  }

  // Thunderstore encodes direct dependencies as namespace-package-version.
  // The namespace and package can both contain punctuation, so split only at
  // the final semver-like version suffix.
  const versionMatch = raw.match(
    /-(v?\d+(?:\.\d+)*(?:-[0-9A-Za-z.+-]+)?)$/,
  );
  if (!versionMatch || versionMatch.index === undefined) {
    return { raw, packageKey: raw, minimumVersion: "" };
  }

  return {
    raw,
    packageKey: raw.slice(0, versionMatch.index),
    minimumVersion: versionMatch[1],
  };
};

const isMelonLoaderThunderstoreDependency = (
  dependency: ThunderstoreDependencyRequirement,
): boolean =>
  normalizeThunderstoreDependencyKey(dependency.packageKey).includes(
    "melonloader",
  );

const getThunderstoreDependenciesForRuntime = (
  version: ThunderstoreVersionOption | null | undefined,
  runtime: ThunderstoreRuntime | "Both",
): ThunderstoreDependencyRequirement[] => {
  if (!version) {
    return [];
  }

  const runtimes: ThunderstoreRuntime[] =
    runtime === "Both" ? ["IL2CPP", "Mono"] : [runtime];
  const requirements = runtimes.flatMap((targetRuntime) =>
    (version.versionsByRuntime[targetRuntime]?.dependencies || [])
      .map(parseThunderstoreDependency)
      .filter((dependency): dependency is ThunderstoreDependencyRequirement =>
        Boolean(dependency),
      ),
  );

  return Array.from(
    new Map(
      requirements
        .filter(
          (dependency) => !isMelonLoaderThunderstoreDependency(dependency),
        )
        .map((dependency) => [
          `${normalizeThunderstoreDependencyKey(dependency.packageKey)}:${normalizeVersionToken(dependency.minimumVersion)}`,
          dependency,
        ]),
    ).values(),
  );
};

const getMissingThunderstoreDependencies = (
  dependencies: ThunderstoreDependencyRequirement[],
  downloadedGroups: DownloadedModGroup[],
): ThunderstoreDependencyRequirement[] =>
  dependencies.filter((dependency) => {
    const expectedPackageKey = normalizeThunderstoreDependencyKey(
      dependency.packageKey,
    );
    return !downloadedGroups.some((group) =>
      group.entries.some((entry) => {
        if (entry.source !== "thunderstore") {
          return false;
        }

        const source = parseThunderstoreSourceId(entry.sourceId);
        const installedPackageKey = normalizeThunderstoreDependencyKey(
          `${source.owner}-${source.name}`,
        );
        if (installedPackageKey !== expectedPackageKey) {
          return false;
        }

        if (!dependency.minimumVersion) {
          return true;
        }

        const installedVersion = entry.sourceVersion || entry.installedVersion || "";
        return (
          normalizeVersionToken(installedVersion).length > 0 &&
          compareVersionTokensDesc(installedVersion, dependency.minimumVersion) <=
            0
        );
      }),
    );
  });

const sortNexusFilesNewestFirst = (files: NexusModFile[]): NexusModFile[] => {
  return [...files].sort((left, right) => {
    if (Boolean(left.is_primary) !== Boolean(right.is_primary)) {
      return left.is_primary ? -1 : 1;
    }

    const versionDelta = compareVersionTokensDesc(
      left.version || left.mod_version || "",
      right.version || right.mod_version || "",
    );
    if (versionDelta !== 0) {
      return versionDelta;
    }

    const uploadedDelta =
      Number(right.uploaded_timestamp || 0) -
      Number(left.uploaded_timestamp || 0);
    if (uploadedDelta !== 0) {
      return uploadedDelta;
    }

    const rightDate = parseTimestamp(getNexusFileUpdatedAt(right));
    const leftDate = parseTimestamp(getNexusFileUpdatedAt(left));
    const fallbackDateDelta = rightDate - leftDate;
    if (fallbackDateDelta !== 0) {
      return fallbackDateDelta;
    }

    const leftInstaller = isNexusFomodInstaller(left);
    const rightInstaller = isNexusFomodInstaller(right);
    if (leftInstaller !== rightInstaller) {
      return leftInstaller ? 1 : -1;
    }

    return (left.file_name || left.name || "").localeCompare(
      right.file_name || right.name || "",
    );
  });
};

const buildThunderstoreVersionOptions = (
  pkg: ThunderstorePackageGroup | null,
): ThunderstoreVersionOption[] => {
  if (!pkg) {
    return [];
  }

  const grouped = new Map<string, ThunderstoreVersionOption>();
  (["IL2CPP", "Mono"] as const).forEach((runtime) => {
    const runtimePackage = pkg.packagesByRuntime[runtime];
    const versions = runtimePackage?.versions || [];

    versions.forEach((version) => {
      const resolvedUpdatedAt =
        version.date_updated ||
        (
          version as ThunderstorePackageVersion & {
            dateUpdated?: string;
            dateCreated?: string;
          }
        ).dateUpdated ||
        version.date_created ||
        (
          version as ThunderstorePackageVersion & {
            dateUpdated?: string;
            dateCreated?: string;
          }
        ).dateCreated ||
        getThunderstorePackageUpdatedAt(runtimePackage) ||
        runtimePackage?.date_created ||
        (runtimePackage as ThunderstorePackage & { dateCreated?: string })
          ?.dateCreated;
      const normalizedResolvedUpdatedAt =
        normalizeDateString(resolvedUpdatedAt);
      const key = version.version_number || version.uuid4;
      const existing: ThunderstoreVersionOption = grouped.get(key) || {
        key,
        versionNumber: version.version_number || "unknown",
        runtimes: [],
        packagesByRuntime: {} as Partial<
          Record<ThunderstoreRuntime, ThunderstorePackage>
        >,
        versionsByRuntime: {} as Partial<
          Record<ThunderstoreRuntime, ThunderstorePackageVersion>
        >,
        updatedAt: normalizedResolvedUpdatedAt,
        downloads: 0,
        description: version.description,
      };

      if (!existing.runtimes.includes(runtime)) {
        existing.runtimes.push(runtime);
      }
      existing.packagesByRuntime[runtime] = runtimePackage;
      existing.versionsByRuntime[runtime] = version;
      if (!existing.description && version.description) {
        existing.description = version.description;
      }
      existing.updatedAt =
        parseTimestamp(normalizedResolvedUpdatedAt) >
        parseTimestamp(existing.updatedAt)
          ? normalizedResolvedUpdatedAt
          : existing.updatedAt;
      existing.downloads =
        (existing.downloads || 0) + Number(version.downloads || 0);
      grouped.set(key, existing);
    });
  });

  return Array.from(grouped.values()).sort((left, right) => {
    const versionDelta = compareVersionTokensDesc(
      left.versionNumber,
      right.versionNumber,
    );
    if (versionDelta !== 0) {
      return versionDelta;
    }
    return parseTimestamp(right.updatedAt) - parseTimestamp(left.updatedAt);
  });
};

const getLatestThunderstorePackageVersion = (
  pkg?: ThunderstorePackage | null,
  sourceId?: string,
): ThunderstorePackageVersion | null => {
  const versions = pkg?.versions || [];
  if (versions.length === 0) {
    return null;
  }

  return [...versions].sort((left, right) => {
    const versionDelta = compareVersionTokensDescForSource(
      sourceId,
      left.version_number,
      right.version_number,
    );
    if (versionDelta !== 0) {
      return versionDelta;
    }

    const leftUpdatedAt = normalizeDateString(
      left.date_updated ||
        (left as ThunderstorePackageVersion & {
          dateUpdated?: string;
          dateCreated?: string;
        }).dateUpdated ||
        left.date_created ||
        (left as ThunderstorePackageVersion & {
          dateUpdated?: string;
          dateCreated?: string;
        }).dateCreated,
    );
    const rightUpdatedAt = normalizeDateString(
      right.date_updated ||
        (right as ThunderstorePackageVersion & {
          dateUpdated?: string;
          dateCreated?: string;
        }).dateUpdated ||
        right.date_created ||
        (right as ThunderstorePackageVersion & {
          dateUpdated?: string;
          dateCreated?: string;
        }).dateCreated,
    );

    return parseTimestamp(rightUpdatedAt) - parseTimestamp(leftUpdatedAt);
  })[0];
};

const normalizeAttributionName = (value?: string | null): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const getNexusModAttribution = (mod: {
  author?: string;
  uploader?: string;
  original_author?: string;
}): string => {
  const primary =
    normalizeAttributionName(mod.uploader) ||
    normalizeAttributionName(mod.author) ||
    "Unknown";
  const originalAuthor = normalizeAttributionName(mod.original_author);

  if (
    originalAuthor &&
    originalAuthor.localeCompare(primary, undefined, {
      sensitivity: "accent",
    }) !== 0
  ) {
    return `${primary} • Original creator: ${originalAuthor}`;
  }

  return primary;
};

const sortThunderstoreGroups = (
  groups: ThunderstorePackageGroup[],
  sort: DiscoverSort,
): ThunderstorePackageGroup[] => {
  return [...groups].sort((a, b) => {
    const aVersions = Object.values(a.packagesByRuntime).filter(Boolean);
    const bVersions = Object.values(b.packagesByRuntime).filter(Boolean);
    const aUpdated = Math.max(
      ...aVersions.map((pkg) =>
        parseTimestamp(getThunderstorePackageUpdatedAt(pkg)),
      ),
    );
    const bUpdated = Math.max(
      ...bVersions.map((pkg) =>
        parseTimestamp(getThunderstorePackageUpdatedAt(pkg)),
      ),
    );
    const aCreated = Math.max(
      ...aVersions.map((pkg) =>
        parseTimestamp(
          pkg?.date_created ||
            (pkg as ThunderstorePackage & { dateCreated?: string })
              ?.dateCreated ||
            pkg?.versions?.[0]?.date_created ||
            (
              pkg?.versions?.[0] as ThunderstorePackageVersion & {
                dateCreated?: string;
              }
            )?.dateCreated,
        ),
      ),
    );
    const bCreated = Math.max(
      ...bVersions.map((pkg) =>
        parseTimestamp(
          pkg?.date_created ||
            (pkg as ThunderstorePackage & { dateCreated?: string })
              ?.dateCreated ||
            pkg?.versions?.[0]?.date_created ||
            (
              pkg?.versions?.[0] as ThunderstorePackageVersion & {
                dateCreated?: string;
              }
            )?.dateCreated,
        ),
      ),
    );
    const aDownloads = aVersions.reduce(
      (sum, pkg) => sum + (pkg?.versions?.[0]?.downloads || 0),
      0,
    );
    const bDownloads = bVersions.reduce(
      (sum, pkg) => sum + (pkg?.versions?.[0]?.downloads || 0),
      0,
    );

    if (sort === "popularity" && aDownloads !== bDownloads) {
      return bDownloads - aDownloads;
    }
    if (sort === "newest" && aCreated !== bCreated) {
      return bCreated - aCreated;
    }
    if (sort === "updated" && aUpdated !== bUpdated) {
      return bUpdated - aUpdated;
    }
    return a.name.localeCompare(b.name);
  });
};

const buildThunderstoreGroups = (
  packagesByRuntime: Partial<
    Record<ThunderstoreRuntime, ThunderstorePackage[]>
  >,
  sort: DiscoverSort,
): ThunderstorePackageGroup[] => {
  const merged = new Map<string, ThunderstorePackageGroup>();
  const addRuntime = (
    pkg: ThunderstorePackage,
    runtime: ThunderstoreRuntime,
  ) => {
    const baseName = normalizeThunderstoreName(
      pkg.name || pkg.full_name || "",
    );
    const owner = pkg.owner || "";
    const key = `${owner.toLowerCase()}::${baseName.toLowerCase()}`;
    const existing = merged.get(key);
    if (existing) {
      existing.packagesByRuntime[runtime] = pkg;
      if (!existing.packageUrl && pkg.package_url) {
        existing.packageUrl = pkg.package_url;
      }
      return;
    }

    merged.set(key, {
      key,
      name: baseName || pkg.name || pkg.full_name || "Unknown Mod",
      owner,
      packageUrl: pkg.package_url || "",
      packagesByRuntime: {
        [runtime]: pkg,
      },
    });
  };

  (packagesByRuntime.IL2CPP || []).forEach((pkg) =>
    addRuntime(pkg, "IL2CPP"),
  );
  (packagesByRuntime.Mono || []).forEach((pkg) => addRuntime(pkg, "Mono"));

  return sortThunderstoreGroups(Array.from(merged.values()), sort);
};

const isSecurityScanReport = (value: unknown): value is SecurityScanReport => {
  return (
    !!value &&
    typeof value === "object" &&
    "summary" in (value as Record<string, unknown>) &&
    Array.isArray((value as { files?: unknown[] }).files)
  );
};

const getSourceBadgeLabel = (source?: ModLibraryEntry["source"]): string => {
  switch (source) {
    case "thunderstore":
      return "Thunderstore";
    case "nexusmods":
      return "Nexus Mods";
    case "github":
      return "GitHub";
    case "local":
      return "Local";
    case "unknown":
      return "Unknown";
    default:
      return "External";
  }
};

interface Props {
  isOpen: boolean;
  onClose: () => void;
  focusStorageId?: string | null;
  focusRequestId?: number;
  focusModTag?: string | null;
  onOpenAccounts?: () => void;
  onOpenSecurityReport?: (request: SecurityReportWorkspaceRequest) => void;
  onOpenProfile?: (profileId: string) => void;
  navigationState?: ModLibraryNavigationState;
  onNavigationStateChange?: (state: ModLibraryNavigationState) => void;
}

export interface ModLibraryNavigationState {
  libraryTab?: LibraryTab;
  searchSource?: "thunderstore" | "nexusmods";
  discoverSort?: DiscoverSort;
  searchQuery?: string;
  searchResults?: ThunderstorePackageGroup[];
  showSearchResults?: boolean;
  showDiscovery?: boolean;
  nexusModsSearchQuery?: string;
  nexusModsSearchResults?: NexusMod[];
  showNexusModsResults?: boolean;
  nexusCatalogKind?: NexusCatalogKind;
  nexusCollectionsSearchQuery?: string;
  nexusCollectionsSearchResults?: NexusCollection[];
  showNexusCollectionsResults?: boolean;
  selectedNexusCollectionSlug?: string | null;
  downloadedFilter?: DownloadedFilter;
  downloadedSearch?: string;
  activeModView?: LibraryModViewState | null;
}

interface RuntimePromptState {
  title: string;
  message: string;
  onSelect: (runtime: "IL2CPP" | "Mono" | "Both") => void;
  onDismiss?: () => void;
}

type CollectionConflictChoice = "collection" | "existing" | "cancel";
type CollectionSourceChoice = "nexusmods" | "thunderstore";
type CollectionProfileRuntime = "IL2CPP" | "Mono";
type CollectionRuntimePreviewTone = "danger" | "muted" | "source" | "success" | "warning";

interface CollectionRuntimePreviewItem {
  file: NexusCollectionModFile;
  resolutionKey: string;
  statusLabel: string;
  tone: CollectionRuntimePreviewTone;
}

interface CollectionMatchState {
  loading: boolean;
  matches: CollectionThunderstoreMatch[];
  error?: string;
}

interface CollectionConflictState {
  file: NexusCollectionModFile;
  existingEntries: ModLibraryEntry[];
}

export function ModLibraryOverlay({
  isOpen,
  focusStorageId,
  focusRequestId,
  onOpenAccounts,
  onOpenSecurityReport,
  onOpenProfile,
  navigationState,
  onNavigationStateChange,
}: Props) {
  const { settings } = useSettingsStore();
  const lookupArtwork = useModArtwork();
  const defaultSearchSource = useMemo<"thunderstore" | "nexusmods">(() => {
    if (navigationState?.searchSource) {
      return navigationState.searchSource;
    }
    if (
      navigationState?.showSearchResults ||
      (navigationState?.searchResults?.length ?? 0) > 0
    ) {
      return "thunderstore";
    }
    if (
      navigationState?.showNexusModsResults ||
      navigationState?.showNexusCollectionsResults ||
      (navigationState?.nexusModsSearchResults?.length ?? 0) > 0 ||
      (navigationState?.nexusCollectionsSearchResults?.length ?? 0) > 0
    ) {
      return "nexusmods";
    }
    try {
      const stored = localStorage.getItem("simm:last-library-search-source");
      return stored === "thunderstore" ? "thunderstore" : "nexusmods";
    } catch {
      return "nexusmods";
    }
  }, [navigationState]);
  const {
    library,
    loading: loadingLibrary,
    ensureLibrary,
    refreshLibrary: refreshModLibrary,
    invalidateLibrary,
  } = useModLibraryStore();
  const { environments, refreshEnvironments, ensureEnvironments } = useEnvironmentStore();
  const downloadStatusStore = useOptionalDownloadStatusStore();
  const publishDownload = useMemo(
    () => downloadStatusStore?.publishDownload ?? (() => {}),
    [downloadStatusStore?.publishDownload],
  );
  const [, setSelectedModIds] = useState<Set<string>>(new Set());
  const [confirmOverlay, setConfirmOverlay] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    confirmText?: string;
    cancelText?: string;
  }>({
    isOpen: false,
    title: "",
    message: "",
    onConfirm: () => {},
  });
  const [libraryTab, setLibraryTab] = useState<LibraryTab>(
    () => navigationState?.libraryTab ?? "discover",
  );

  const [searchSource, setSearchSource] = useState<
    "thunderstore" | "nexusmods"
  >(defaultSearchSource);
  const [discoverSort, setDiscoverSort] = useState<DiscoverSort>(
    () => navigationState?.discoverSort ?? "updated",
  );
  const [searchQuery, setSearchQuery] = useState(
    () => navigationState?.searchQuery ?? "",
  );
  const [searchResults, setSearchResults] = useState<
    ThunderstorePackageGroup[]
  >(() => navigationState?.searchResults ?? []);
  const [searching, setSearching] = useState(false);
  const [showSearchResults, setShowSearchResults] = useState(
    () => navigationState?.showSearchResults ?? false,
  );
  const [showDiscovery] = useState(
    () => navigationState?.showDiscovery ?? true,
  );

  const [nexusModsSearchQuery, setNexusModsSearchQuery] = useState(
    () => navigationState?.nexusModsSearchQuery ?? "",
  );
  const [nexusModsSearchResults, setNexusModsSearchResults] = useState<
    NexusMod[]
  >(() => navigationState?.nexusModsSearchResults ?? []);
  const [searchingNexusMods, setSearchingNexusMods] = useState(false);
  const [loadingMoreNexusMods, setLoadingMoreNexusMods] = useState(false);
  const [nexusModsTotalCount, setNexusModsTotalCount] = useState(
    () => navigationState?.nexusModsSearchResults?.length ?? 0,
  );
  const [nexusModsHasMore, setNexusModsHasMore] = useState(false);
  const [showNexusModsResults, setShowNexusModsResults] = useState(
    () => navigationState?.showNexusModsResults ?? false,
  );
  const [nexusCatalogKind, setNexusCatalogKind] = useState<NexusCatalogKind>(
    () => navigationState?.nexusCatalogKind ?? "mods",
  );
  const [nexusCollectionsSearchQuery, setNexusCollectionsSearchQuery] = useState(
    () => navigationState?.nexusCollectionsSearchQuery ?? "",
  );
  const [nexusCollectionsSearchResults, setNexusCollectionsSearchResults] = useState<
    NexusCollection[]
  >(() => navigationState?.nexusCollectionsSearchResults ?? []);
  const [searchingNexusCollections, setSearchingNexusCollections] = useState(false);
  const [loadingMoreNexusCollections, setLoadingMoreNexusCollections] = useState(false);
  const [nexusCollectionsTotalCount, setNexusCollectionsTotalCount] = useState(
    () => navigationState?.nexusCollectionsSearchResults?.length ?? 0,
  );
  const [nexusCollectionsHasMore, setNexusCollectionsHasMore] = useState(false);
  const [showNexusCollectionsResults, setShowNexusCollectionsResults] = useState(
    () => navigationState?.showNexusCollectionsResults ?? false,
  );
  const [selectedNexusCollectionSlug, setSelectedNexusCollectionSlug] = useState<
    string | null
  >(() => navigationState?.selectedNexusCollectionSlug ?? null);
  const [nexusCollectionPlanState, setNexusCollectionPlanState] = useState<{
    key: string | null;
    loading: boolean;
    plan: NexusCollectionRevisionPlan | null;
    error: string | null;
  }>({ key: null, loading: false, plan: null, error: null });
  const [nexusCollectionAccess, setNexusCollectionAccess] = useState<{
    connected: boolean;
    canDirectDownload: boolean;
    requiresSiteConfirmation: boolean;
  } | null>(null);
  const [collectionFileDecisions, setCollectionFileDecisions] = useState<
    Record<string, "collection" | "existing">
  >({});
  const [collectionConflict, setCollectionConflict] =
    useState<CollectionConflictState | null>(null);
  const [collectionConflictQueue, setCollectionConflictQueue] = useState<
    CollectionConflictState[]
  >([]);
  const [collectionActiveDownloadIds, setCollectionActiveDownloadIds] =
    useState<Set<number>>(new Set());
  const [creatingCollectionProfile, setCreatingCollectionProfile] =
    useState(false);
  const [collectionProfiles, setCollectionProfiles] = useState<
    StoredModProfile[]
  >([]);
  const [collectionMatchStates, setCollectionMatchStates] = useState<
    Record<string, CollectionMatchState>
  >({});
  const [collectionSourceChoices, setCollectionSourceChoices] = useState<
    Record<string, CollectionSourceChoice>
  >({});
  const [collectionOptionalSelections, setCollectionOptionalSelections] = useState<
    Record<string, boolean>
  >({});
  const [collectionRuntimePreview, setCollectionRuntimePreview] = useState<
    CollectionProfileRuntime | null
  >(null);
  const [collectionNexusFileCatalogs, setCollectionNexusFileCatalogs] = useState<
    Map<number, NexusModFile[]>
  >(new Map());
  const [collectionNexusCatalogLoading, setCollectionNexusCatalogLoading] = useState<Set<number>>(
    new Set(),
  );
  const [collectionNexusCatalogErrors, setCollectionNexusCatalogErrors] = useState<Map<number, string>>(
    new Map(),
  );
  const [applyCollectionSourceToAll, setApplyCollectionSourceToAll] = useState(false);
  const [nexusModsFiles, setNexusModsFiles] = useState<
    Map<number, NexusModFile[]>
  >(new Map());
  const [nexusModsLoading, setNexusModsLoading] = useState<Set<number>>(
    new Set(),
  );
  const [nexusDependencyState, setNexusDependencyState] = useState<{
    key: string | null;
    loading: boolean;
    report: NexusModFileDependencies | null;
    error: string | null;
  }>({ key: null, loading: false, report: null, error: null });

  const [downloading, setDownloading] = useState<string | null>(null);
  const [, setDeleting] = useState<string | null>(null);
  const [activatingGroup, setActivatingGroup] = useState<string | null>(null);
  const [updatingAllGroups, setUpdatingAllGroups] = useState(false);
  const [, setUpdatingGroup] = useState<string | null>(null);
  const [openVersionMenuGroup, setOpenVersionMenuGroup] = useState<
    string | null
  >(null);
  const [selectedStorageByGroup, setSelectedStorageByGroup] = useState<
    Record<string, string>
  >({});
  const [
    selectedThunderstoreVersionByPackage,
    setSelectedThunderstoreVersionByPackage,
  ] = useState<Record<string, string>>({});
  const [selectedNexusFileByModId, setSelectedNexusFileByModId] = useState<
    Record<number, number>
  >({});
  const [runtimePrompt, setRuntimePrompt] = useState<RuntimePromptState | null>(
    null,
  );
  const [downloadedFilter, setDownloadedFilter] = useState<DownloadedFilter>(
    () => navigationState?.downloadedFilter ?? "all",
  );
  const [downloadedSearch, setDownloadedSearch] = useState(
    () => navigationState?.downloadedSearch ?? "",
  );
  const [activeModView, setActiveModView] =
    useState<LibraryModViewState | null>(
      () => navigationState?.activeModView ?? null,
    );
  const [activeSecurityReport, setActiveSecurityReport] =
    useState<SecurityReportWorkspaceRequest | null>(null);
  const [securityActionBusy, setSecurityActionBusy] = useState(false);
  const [, setToastMessage] = useState<string | null>(null);
  const [installDialog, setInstallDialog] = useState<InstallDialogState>({
    isOpen: false,
    title: "",
    entries: [],
    compatibleEnvironments: [],
    excludedEnvironments: [],
    lockedEnvironmentIds: [],
    mode: "select",
    note: undefined,
  });
  const [selectedInstallEnvironmentIds, setSelectedInstallEnvironmentIds] =
    useState<Set<string>>(new Set());
  const [installingTargets, setInstallingTargets] = useState(false);
  const installOperationRef = useRef(0);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: AnchoredContextMenuItem[];
  } | null>(null);
  const libraryScrollContainerRef = useRef<HTMLDivElement | null>(null);
  const libraryScrollTopRef = useRef(0);
  const searchSourceRef = useRef(searchSource);
  const searchQueryRef = useRef(searchQuery);
  const searchResultsRef = useRef(searchResults);
  const discoverSortRef = useRef(discoverSort);
  const nexusCatalogKindRef = useRef(nexusCatalogKind);
  const discoveryPreloadStartedRef = useRef(false);
  const providerSearchGenerationRef = useRef({
    thunderstore: 0,
    nexusmods: 0,
    nexuscollections: 0,
  });
  const nexusModsSearchResultsRef = useRef(nexusModsSearchResults);
  const nexusCollectionsSearchResultsRef = useRef(nexusCollectionsSearchResults);
  const nexusModsSearchQueryRef = useRef(nexusModsSearchQuery);
  const nexusCollectionsSearchQueryRef = useRef(nexusCollectionsSearchQuery);
  const nexusCatalogLoadKeyRef = useRef<string | null>(
    searchSource === "nexusmods" &&
      ((nexusCatalogKind === "mods" && showNexusModsResults) ||
        (nexusCatalogKind === "collections" && showNexusCollectionsResults))
      ? `${nexusCatalogKind}:${discoverSort}`
      : null,
  );
  const thunderstoreCatalogLoadKeyRef = useRef<string | null>(
    searchSource === "thunderstore" && showSearchResults
      ? `${discoverSort}:${searchQuery}`
      : null,
  );
  const nexusManualTimeoutRef = useRef<number | null>(null);
  const activeNexusModIdsRef = useRef<Set<number>>(new Set());
  const nexusModsFileRequestTokenRef = useRef(new Map<number, number>());
  const nexusModsFileRequestSeqRef = useRef(0);
  const nexusDependencyRequestRef = useRef(
    new Map<string, Promise<NexusModFileDependencies | null>>(),
  );
  const nexusDependencyStateRef = useRef(nexusDependencyState);
  const pendingSecurityGateResolutionRef = useRef<
    ((result?: any) => void) | null
  >(null);
  const securityReportOperationRef = useRef(0);
  const pendingNexusManualActionRef = useRef<null | {
    onSuccess: () => Promise<void>;
    onErrorTitle?: string;
  }>(null);
  const collectionConflictResolutionRef = useRef<
    ((choice: CollectionConflictChoice) => void) | null
  >(null);
  const collectionFileDecisionsRef = useRef<
    Record<string, "collection" | "existing">
  >({});
  const collectionProfilesRef = useRef<StoredModProfile[]>([]);
  const collectionProfileRuntimesRef = useRef<Array<"IL2CPP" | "Mono">>([]);
  const activeCollectionProfileKeyRef = useRef<string | null>(null);
  const collectionProfileBuildKeyRef = useRef<string | null>(null);
  const collectionNexusFileCatalogsRef = useRef(new Map<number, NexusModFile[]>());
  const collectionNexusCatalogRequestsRef = useRef(new Map<number, Promise<NexusModFile[]>>());
  const collectionNexusCatalogGenerationRef = useRef(0);
  const lastHandledFocusRequestIdRef = useRef<number | null>(null);
  const toastTimeoutRef = useRef<number | null>(null);
  const navigationChangeHandlerRef = useRef(onNavigationStateChange);

  useEffect(() => {
    navigationChangeHandlerRef.current = onNavigationStateChange;
  }, [onNavigationStateChange]);

  const selectSearchSource = useCallback((source: "thunderstore" | "nexusmods") => {
    // Invalidate both providers synchronously with the toggle. A response from
    // the previous source must not repopulate a view after the user moved on.
    providerSearchGenerationRef.current.thunderstore += 1;
    providerSearchGenerationRef.current.nexusmods += 1;
    providerSearchGenerationRef.current.nexuscollections += 1;
    nexusCatalogLoadKeyRef.current = null;
    thunderstoreCatalogLoadKeyRef.current = null;
    searchSourceRef.current = source;
    setSearchSource(source);
    setSearching(false);
    setSearchingNexusMods(false);
    setSearchingNexusCollections(false);
    setShowSearchResults(false);
    setShowNexusModsResults(false);
    setShowNexusCollectionsResults(false);
    setSelectedNexusCollectionSlug(null);
    setActiveModView(null);
    if (source === "thunderstore" && searchResultsRef.current.length > 0) {
      thunderstoreCatalogLoadKeyRef.current = `${discoverSortRef.current}:${searchQueryRef.current}`;
      setShowSearchResults(true);
    }
  }, []);

  const selectNexusCatalogKind = useCallback((kind: NexusCatalogKind) => {
    providerSearchGenerationRef.current.nexusmods += 1;
    providerSearchGenerationRef.current.nexuscollections += 1;
    nexusCatalogLoadKeyRef.current = null;
    setNexusCatalogKind(kind);
    setSearchingNexusMods(false);
    setSearchingNexusCollections(false);
    setSelectedNexusCollectionSlug(null);
    setActiveModView(null);
  }, []);

  useEffect(() => {
    searchQueryRef.current = searchQuery;
  }, [searchQuery]);

  useEffect(() => {
    searchResultsRef.current = searchResults;
  }, [searchResults]);

  useEffect(() => {
    discoverSortRef.current = discoverSort;
  }, [discoverSort]);

  useEffect(() => {
    nexusCatalogKindRef.current = nexusCatalogKind;
  }, [nexusCatalogKind]);

  useEffect(() => {
    nexusModsSearchResultsRef.current = nexusModsSearchResults;
  }, [nexusModsSearchResults]);

  useEffect(() => {
    nexusCollectionsSearchResultsRef.current = nexusCollectionsSearchResults;
  }, [nexusCollectionsSearchResults]);

  useEffect(() => {
    nexusModsSearchQueryRef.current = nexusModsSearchQuery;
  }, [nexusModsSearchQuery]);

  useEffect(() => {
    nexusCollectionsSearchQueryRef.current = nexusCollectionsSearchQuery;
  }, [nexusCollectionsSearchQuery]);

  useEffect(() => {
    nexusDependencyStateRef.current = nexusDependencyState;
  }, [nexusDependencyState]);

  const reportedNavigationState = useMemo<ModLibraryNavigationState>(
    () => ({
      libraryTab,
      searchSource,
      discoverSort,
      searchQuery,
      searchResults,
      showSearchResults,
      showDiscovery,
      nexusModsSearchQuery,
      nexusModsSearchResults,
      showNexusModsResults,
      nexusCatalogKind,
      nexusCollectionsSearchQuery,
      nexusCollectionsSearchResults,
      showNexusCollectionsResults,
      selectedNexusCollectionSlug,
      downloadedFilter,
      downloadedSearch,
      activeModView,
    }),
    [
      activeModView,
      downloadedFilter,
      discoverSort,
      downloadedSearch,
      libraryTab,
      nexusModsSearchQuery,
      nexusModsSearchResults,
      nexusCatalogKind,
      nexusCollectionsSearchQuery,
      nexusCollectionsSearchResults,
      selectedNexusCollectionSlug,
      searchQuery,
      searchResults,
      searchSource,
      showDiscovery,
      showNexusModsResults,
      showNexusCollectionsResults,
      showSearchResults,
    ],
  );

  useEffect(() => {
    try {
      localStorage.setItem("simm:last-library-search-source", searchSource);
    } catch {
      // Ignore localStorage failures in embedded/webview contexts.
    }
  }, [searchSource]);

  useEffect(() => {
    navigationChangeHandlerRef.current?.(reportedNavigationState);
  }, [reportedNavigationState]);

  const showToast = useCallback((message: string, duration = 6500) => {
    setToastMessage(message);
    if (toastTimeoutRef.current !== null) {
      window.clearTimeout(toastTimeoutRef.current);
    }
    toastTimeoutRef.current = window.setTimeout(() => {
      setToastMessage(null);
      toastTimeoutRef.current = null;
    }, duration);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current !== null) {
        window.clearTimeout(toastTimeoutRef.current);
        toastTimeoutRef.current = null;
      }
    };
  }, []);

  const [s1apiFeaturedRelease, setS1apiFeaturedRelease] =
    useState<FeaturedGithubRelease | null>(null);
  const [mlvscanFeaturedRelease, setMlvscanFeaturedRelease] =
    useState<FeaturedGithubRelease | null>(null);
  const [meshVaultFeaturedPackage, setMeshVaultFeaturedPackage] =
    useState<ThunderstorePackageGroup | null>(null);
  const [s1mapiFeaturedPackage, setS1mapiFeaturedPackage] =
    useState<ThunderstorePackageGroup | null>(null);
  const [steamNetworkLibFeaturedPackage, setSteamNetworkLibFeaturedPackage] =
    useState<ThunderstorePackageGroup | null>(null);

  const downloadedGroups = useMemo(
    () => buildDownloadedGroups(library?.downloaded ?? []),
    [library],
  );

  useEffect(() => {
    if (!isOpen) {
      setActiveModView(null);
      setSelectedNexusCollectionSlug(null);
    }
  }, [isOpen]);
  const openModView = useCallback((nextView: LibraryModViewState) => {
    if (libraryScrollContainerRef.current) {
      libraryScrollTopRef.current = libraryScrollContainerRef.current.scrollTop;
    }
    setSelectedNexusCollectionSlug(null);
    setActiveModView(nextView);
  }, []);

  const closeDetailView = useCallback(() => {
    setActiveModView(null);
    setSelectedNexusCollectionSlug(null);
    window.requestAnimationFrame(() => {
      if (libraryScrollContainerRef.current) {
        libraryScrollContainerRef.current.scrollTop = libraryScrollTopRef.current;
      }
    });
  }, []);

  const getLatestDownloadedVersionForGroups = useCallback(
    (groups: DownloadedModGroup[]): string | undefined => {
      if (groups.length === 0) {
        return undefined;
      }

      const versionSourceId = getDownloadedVersionSourceId(groups);

      const sortedByVersion = groups
        .flatMap((group) => group.entries)
        .sort((a, b) =>
          compareVersionTokensDescForSource(
            versionSourceId,
            a.sourceVersion || a.installedVersion,
            b.sourceVersion || b.installedVersion,
          ),
        );

      const latestEntry = sortedByVersion[0];
      return (
        latestEntry?.sourceVersion || latestEntry?.installedVersion || undefined
      );
    },
    [],
  );

  const s1apiGroups = downloadedGroups.filter(isS1ApiDownloadedGroup);

  const mlvscanGroups = downloadedGroups.filter(isMlvscanDownloadedGroup);
  const meshVaultGroups = downloadedGroups.filter(isMeshVaultDownloadedGroup);
  const s1mapiGroups = downloadedGroups.filter(isS1MApiDownloadedGroup);
  const steamNetworkLibGroups = downloadedGroups.filter(
    isSteamNetworkLibDownloadedGroup,
  );

  const s1apiInLibrary = s1apiGroups.length > 0;
  const mlvscanInLibrary = mlvscanGroups.length > 0;
  const meshVaultInLibrary = meshVaultGroups.length > 0;
  const s1mapiInLibrary = s1mapiGroups.length > 0;
  const steamNetworkLibInLibrary = steamNetworkLibGroups.length > 0;
  const s1apiInstalledVersion =
    getLatestDownloadedVersionForGroups(s1apiGroups);
  const s1apiLatestVersion = s1apiFeaturedRelease?.tag_name;
  const s1apiNeedsUpdate =
    s1apiInLibrary &&
    s1apiInstalledVersion &&
    s1apiLatestVersion &&
    compareVersionTokensDescForSource(
      FEATURED_DOWNLOADS.s1api.sourceId,
      s1apiLatestVersion,
      s1apiInstalledVersion,
    ) < 0;

  const mlvscanInstalledVersion =
    getLatestDownloadedVersionForGroups(mlvscanGroups);
  const mlvscanLatestVersion = mlvscanFeaturedRelease?.tag_name;
  const mlvscanNeedsUpdate =
    mlvscanInLibrary &&
    mlvscanInstalledVersion &&
    mlvscanLatestVersion &&
    compareVersions(mlvscanInstalledVersion, mlvscanLatestVersion) < 0;
  const meshVaultInstalledVersion =
    getLatestDownloadedVersionForGroups(meshVaultGroups);
  const meshVaultLatestVersion =
    buildThunderstoreVersionOptions(meshVaultFeaturedPackage)[0]?.versionNumber;
  const meshVaultNeedsUpdate =
    meshVaultInLibrary &&
    meshVaultInstalledVersion &&
    meshVaultLatestVersion &&
    compareVersionTokensDescForSource(
      FEATURED_THUNDERSTORE_DOWNLOADS.meshvault.sourceId,
      meshVaultLatestVersion,
      meshVaultInstalledVersion,
    ) < 0;
  const s1mapiInstalledVersion =
    getLatestDownloadedVersionForGroups(s1mapiGroups);
  const s1mapiLatestVersion =
    buildThunderstoreVersionOptions(s1mapiFeaturedPackage)[0]?.versionNumber;
  const s1mapiNeedsUpdate =
    s1mapiInLibrary &&
    s1mapiInstalledVersion &&
    s1mapiLatestVersion &&
    compareVersionTokensDescForSource(
      FEATURED_THUNDERSTORE_DOWNLOADS.s1mapi.sourceId,
      s1mapiLatestVersion,
      s1mapiInstalledVersion,
    ) < 0;
  const steamNetworkLibInstalledVersion = getLatestDownloadedVersionForGroups(
    steamNetworkLibGroups,
  );
  const steamNetworkLibLatestVersion = buildThunderstoreVersionOptions(
    steamNetworkLibFeaturedPackage,
  )[0]?.versionNumber;
  const steamNetworkLibNeedsUpdate =
    steamNetworkLibInLibrary &&
    steamNetworkLibInstalledVersion &&
    steamNetworkLibLatestVersion &&
    compareVersionTokensDescForSource(
      getDownloadedVersionSourceId(steamNetworkLibGroups) ||
        FEATURED_THUNDERSTORE_DOWNLOADS.steamnetworklib.sourceId,
      steamNetworkLibLatestVersion,
      steamNetworkLibInstalledVersion,
    ) < 0;

  const isGroupUpdateAvailable = useCallback(
    (group: DownloadedModGroup): boolean => {
      const isS1apiGroup = isS1ApiDownloadedGroup(group);
      if (isS1apiGroup && !!s1apiInstalledVersion && !!s1apiLatestVersion) {
        return !!s1apiNeedsUpdate;
      }

      const isMlvscanGroup = isMlvscanDownloadedGroup(group);
      if (
        isMlvscanGroup &&
        !!mlvscanInstalledVersion &&
        !!mlvscanLatestVersion
      ) {
        return !!mlvscanNeedsUpdate;
      }

      const isMeshVaultGroup = isMeshVaultDownloadedGroup(group);
      if (
        isMeshVaultGroup &&
        !!meshVaultInstalledVersion &&
        !!meshVaultLatestVersion
      ) {
        return !!meshVaultNeedsUpdate;
      }

      const isS1mapiGroup = isS1MApiDownloadedGroup(group);
      if (isS1mapiGroup && !!s1mapiInstalledVersion && !!s1mapiLatestVersion) {
        return !!s1mapiNeedsUpdate;
      }

      const isSteamNetworkLibGroup = isSteamNetworkLibDownloadedGroup(group);
      if (
        isSteamNetworkLibGroup &&
        !!steamNetworkLibInstalledVersion &&
        !!steamNetworkLibLatestVersion
      ) {
        return !!steamNetworkLibNeedsUpdate;
      }

      return !!group.updateAvailable;
    },
    [
      meshVaultInstalledVersion,
      meshVaultLatestVersion,
      meshVaultNeedsUpdate,
      mlvscanInstalledVersion,
      mlvscanLatestVersion,
      mlvscanNeedsUpdate,
      s1mapiInstalledVersion,
      s1mapiLatestVersion,
      s1mapiNeedsUpdate,
      s1apiInstalledVersion,
      s1apiLatestVersion,
      s1apiNeedsUpdate,
      steamNetworkLibInstalledVersion,
      steamNetworkLibLatestVersion,
      steamNetworkLibNeedsUpdate,
    ],
  );

  const downloadedSummary = useMemo(() => {
    const total = downloadedGroups.length;
    const updates = downloadedGroups.filter((group) =>
      isGroupUpdateAvailable(group),
    ).length;
    const installed = downloadedGroups.filter(
      (group) => group.installedIn.length > 0,
    ).length;
    const managed = downloadedGroups.filter((group) => group.managed).length;
    return { total, updates, installed, managed };
  }, [downloadedGroups, isGroupUpdateAvailable]);

  const filteredDownloadedGroups = useMemo(() => {
    const query = downloadedSearch.trim().toLowerCase();
    return downloadedGroups.filter((group) => {
      if (downloadedFilter === "updates" && !isGroupUpdateAvailable(group))
        return false;
      if (downloadedFilter === "managed" && !group.managed) return false;
      if (downloadedFilter === "external" && group.managed) return false;
      if (downloadedFilter === "installed" && group.installedIn.length === 0)
        return false;

      if (!query) return true;
      const author = group.author?.toLowerCase() || "";
      const version = group.sourceVersion?.toLowerCase() || "";
      return (
        group.displayName.toLowerCase().includes(query) ||
        author.includes(query) ||
        version.includes(query)
      );
    });
  }, [
    downloadedGroups,
    downloadedFilter,
    downloadedSearch,
    isGroupUpdateAvailable,
  ]);

  useEffect(() => {
    setSelectedStorageByGroup((prev) => {
      const next: Record<string, string> = { ...prev };

      for (const group of downloadedGroups) {
        const current = next[group.key];
        if (
          current &&
          group.entries.some((entry) => entry.storageId === current)
        ) {
          continue;
        }

        const sorted = [...group.entries].sort((a, b) =>
          compareVersionTokensDesc(
            a.sourceVersion || a.installedVersion,
            b.sourceVersion || b.installedVersion,
          ),
        );
        const installed = sorted.find((entry) => entry.installedIn.length > 0);
        const selected = installed || sorted[0];
        if (selected) {
          next[group.key] = selected.storageId;
        }
      }

      return next;
    });
  }, [downloadedGroups]);

  useEffect(() => {
    if (!openVersionMenuGroup) {
      return;
    }

    const onDocumentMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest("[data-version-switcher]")) {
        setOpenVersionMenuGroup(null);
      }
    };

    document.addEventListener("mousedown", onDocumentMouseDown);
    return () => {
      document.removeEventListener("mousedown", onDocumentMouseDown);
    };
  }, [openVersionMenuGroup]);

  const handleLoadNexusModFiles = useCallback(async (modId: number) => {
    const requestToken = ++nexusModsFileRequestSeqRef.current;
    nexusModsFileRequestTokenRef.current.set(modId, requestToken);
    const isCurrentRequest = () =>
      nexusModsFileRequestTokenRef.current.get(modId) === requestToken;
    const isStillVisible = () => activeNexusModIdsRef.current.has(modId);

    setNexusModsLoading((prev) => new Set(prev).add(modId));
    try {
      const files = await ApiService.getNexusModsModFiles("schedule1", modId);
      if (!isCurrentRequest() || !isStillVisible()) {
        return;
      }
      setNexusModsFiles((prev) => {
        if (!isCurrentRequest() || !isStillVisible()) {
          return prev;
        }
        const next = new Map(prev);
        next.set(modId, files);
        return next;
      });
    } catch (err) {
      console.warn("Failed to load Nexus mod files:", err);
    } finally {
      if (isCurrentRequest()) {
        setNexusModsLoading((prev) => {
          const next = new Set(prev);
          next.delete(modId);
          return next;
        });
      }
    }
  }, []);

  const loadNexusDependencyReport = useCallback(
    async (modId: number, fileId: number): Promise<NexusModFileDependencies | null> => {
      const key = `${modId}:${fileId}`;
      const currentState = nexusDependencyStateRef.current;
      if (currentState.key === key && currentState.report) {
        return currentState.report;
      }
      if (currentState.key === key && currentState.error) {
        return null;
      }
      const pendingRequest = nexusDependencyRequestRef.current.get(key);
      if (pendingRequest) {
        return pendingRequest;
      }

      const access = await ApiService.getNexusOAuthStatus();
      if (!access.connected) {
        setNexusDependencyState({
          key,
          loading: false,
          report: null,
          error: "Connect Nexus to check this file's dependencies.",
        });
        return null;
      }

      setNexusDependencyState({
        key,
        loading: true,
        report: null,
        error: null,
      });
      const request = ApiService.getNexusModFileDependencies(
        "schedule1",
        modId,
        fileId,
      )
        .then((report) => {
          setNexusDependencyState({ key, loading: false, report, error: null });
          return report;
        })
        .catch((error) => {
          const message = getErrorMessage(
            error,
            "Nexus did not provide dependency information for this file.",
          );
          setNexusDependencyState({
            key,
            loading: false,
            report: null,
            error: message,
          });
          return null;
        })
        .finally(() => {
          nexusDependencyRequestRef.current.delete(key);
        });
      nexusDependencyRequestRef.current.set(key, request);
      return request;
    },
    [],
  );

  const selectedNexusModId = useMemo(() => {
    if (activeModView?.kind === "nexusmods") {
      return (
        nexusModsSearchResults.find(
          (modItem) => String(modItem.mod_id) === activeModView.id,
        )?.mod_id ?? null
      );
    }

    if (activeModView?.kind !== "downloaded") {
      return null;
    }

    const group = downloadedGroups.find(
      (candidate) => candidate.key === activeModView.id,
    );
    const selectedStorageId = group
      ? selectedStorageByGroup[group.key]
      : undefined;
    const entry =
      group?.entries.find((candidate) => candidate.storageId === selectedStorageId) ||
      group?.entries[0];
    if (entry?.source !== "nexusmods") {
      return null;
    }

    const modId = Number(entry.sourceId);
    return Number.isSafeInteger(modId) && modId > 0 ? modId : null;
  }, [activeModView, downloadedGroups, nexusModsSearchResults, selectedStorageByGroup]);

  const loadLibrarySnapshot = useCallback(async () => {
    invalidateLibrary();
    return refreshModLibrary();
  }, [invalidateLibrary, refreshModLibrary]);

  const refreshLibrary = useCallback(async () => {
    await loadLibrarySnapshot();
  }, [loadLibrarySnapshot]);

  const closeConfirmOverlay = useCallback(() => {
    setConfirmOverlay({
      isOpen: false,
      title: "",
      message: "",
      onConfirm: () => {},
      confirmText: undefined,
      cancelText: undefined,
    });
  }, []);

  const showLibraryNotice = useCallback(
    (
      title: string,
      message: string,
      action?: { label: string; onAction: () => void; cancelText?: string },
    ) => {
      setConfirmOverlay({
        isOpen: true,
        title,
        message,
        onConfirm: () => {
          action?.onAction();
          closeConfirmOverlay();
        },
        confirmText: action?.label,
        cancelText: action ? (action.cancelText ?? "Dismiss") : undefined,
      });
    },
    [closeConfirmOverlay],
  );

  const handleRefreshLibrary = useCallback(async () => {
    try {
      await ApiService.refreshThunderstorePackageCache("schedule-i");
      await refreshLibrary();
      await refreshEnvironments();
    } catch (error) {
      logger.warn("Failed to refresh Thunderstore package cache", {
        error: error instanceof Error ? error.message : String(error),
      });
      showLibraryNotice(
        "Thunderstore Refresh Failed",
        error instanceof Error
          ? error.message
          : "SIMM could not refresh Thunderstore right now. Local library data is still available.",
      );
    }
  }, [refreshEnvironments, refreshLibrary, showLibraryNotice]);

  const openSecurityReport = useCallback(
    (request: SecurityReportWorkspaceRequest) => {
      securityReportOperationRef.current += 1;
      if (onOpenSecurityReport) {
        onOpenSecurityReport(request);
        return;
      }

      setActiveSecurityReport(request);
    },
    [onOpenSecurityReport],
  );

  const closeSecurityReport = useCallback(() => {
    if (securityActionBusy) {
      return;
    }

    securityReportOperationRef.current += 1;
    pendingSecurityGateResolutionRef.current = null;
    activeSecurityReport?.onDismiss?.();
    setActiveSecurityReport(null);
  }, [activeSecurityReport, securityActionBusy]);

  const handleSecurityReportConfirm = useCallback(async () => {
    const request = activeSecurityReport;
    if (!request?.onConfirm) {
      return;
    }
    const operationId = securityReportOperationRef.current;

    setSecurityActionBusy(true);
    try {
      await request.onConfirm();
      if (operationId === securityReportOperationRef.current) {
        setActiveSecurityReport(null);
      }
    } catch (err) {
      console.error("Security action failed:", err);
      showLibraryNotice(
        "MLVScan Action Failed",
        err instanceof Error
          ? err.message
          : "Unable to continue with this download.",
      );
    } finally {
      setSecurityActionBusy(false);
    }
  }, [activeSecurityReport, showLibraryNotice]);

  const buildSecurityReportOptionLabel = useCallback(
    (entry: ModLibraryEntry) => {
      const versionLabel = formatVersionTag(
        entry.sourceVersion || entry.installedVersion,
      );
      const runtimeLabel =
        entry.availableRuntimes?.length > 0
          ? entry.availableRuntimes.join("/")
          : "Runtime?";
      return `${versionLabel} • ${runtimeLabel}`;
    },
    [],
  );

  const buildSecurityReportOptionDescription = useCallback(
    (entry: ModLibraryEntry) => {
      const fileCount = entry.files.length;
      const fileSummary =
        fileCount <= 2 ? entry.files.join(", ") : `${fileCount} scanned files`;
      return fileSummary || "Stored security report";
    },
    [],
  );

  const loadStoredSecurityReportOptions = useCallback(
    async (entries: ModLibraryEntry[]): Promise<SecurityScanReportOption[]> => {
      const uniqueEntries = entries.filter(
        (entry, index, array) =>
          array.findIndex(
            (candidate) => candidate.storageId === entry.storageId,
          ) === index,
      );

      const reports = await Promise.all(
        uniqueEntries.map(async (entry) => ({
          entry,
          report: await ApiService.getModSecurityScanReport(entry.storageId),
        })),
      );

      return reports
        .filter(
          (
            candidate,
          ): candidate is {
            entry: ModLibraryEntry;
            report: SecurityScanReport;
          } => Boolean(candidate.report),
        )
        .map(({ entry, report }) => ({
          key: entry.storageId,
          label: buildSecurityReportOptionLabel(entry),
          description: buildSecurityReportOptionDescription(entry),
          report,
        }));
    },
    [buildSecurityReportOptionDescription, buildSecurityReportOptionLabel],
  );

  const openStoredSecurityReport = useCallback(
    async (storageId: string, title: string) => {
      try {
        const containingGroup = downloadedGroups.find((group) =>
          group.entries.some(
            (entry) =>
              entry.storageId === storageId ||
              Object.values(entry.storageIdsByRuntime || {}).includes(
                storageId,
              ),
          ),
        );
        const reportOptions = await loadStoredSecurityReportOptions(
          containingGroup?.entries || [],
        );

        if (reportOptions.length > 0) {
          openSecurityReport({
            title,
            report: reportOptions[0].report,
            reportOptions,
            onConfirm: null,
          });
          return;
        }

        const report = await ApiService.getModSecurityScanReport(storageId);
        if (!report) {
          showLibraryNotice(
            "No Security Report",
            "This library entry does not have a stored MLVScan report yet.",
          );
          return;
        }

        openSecurityReport({ title, report, onConfirm: null });
      } catch (err) {
        console.error("Failed to load security report:", err);
        showLibraryNotice(
          "Security Report Error",
          err instanceof Error
            ? err.message
            : "Failed to load the MLVScan report.",
        );
      }
    },
    [
      downloadedGroups,
      loadStoredSecurityReportOptions,
      openSecurityReport,
      showLibraryNotice,
    ],
  );

  const handleSecurityGateResult = useCallback(
    async <T,>(
      title: string,
      result: {
        success: boolean;
        securityScan?: SecurityScanSummary | SecurityScanReport;
        securityScanConfirmationRequired?: boolean;
        securityScanBlocked?: boolean;
        error?: string;
      },
      onConfirm: () => Promise<T>,
    ): Promise<
      | { status: "passthrough" }
      | { status: "confirmed"; value: T }
      | { status: "abort" }
    > => {
      if (!result.securityScan || !isSecurityScanReport(result.securityScan)) {
        return { status: "passthrough" };
      }

      const securityReport = result.securityScan;

      if (result.securityScanBlocked) {
        openSecurityReport({
          title,
          report: securityReport,
          onConfirm: null,
        });
        return { status: "abort" };
      }

      if (result.securityScanConfirmationRequired) {
        pendingSecurityGateResolutionRef.current?.();
        return new Promise((resolve) => {
          const finishResolution = (next: {
            status: "confirmed";
            value: T;
          } | {
            status: "abort";
          }) => {
            if (pendingSecurityGateResolutionRef.current === finishResolution) {
              pendingSecurityGateResolutionRef.current = null;
            }
            resolve(next);
          };

          pendingSecurityGateResolutionRef.current = finishResolution;
          openSecurityReport({
            title,
            report: securityReport,
            confirmLabel: "Continue Download",
            onConfirm: async () => {
              const confirmedValue = await onConfirm();
              finishResolution({
                status: "confirmed",
                value: confirmedValue,
              });
            },
            onDismiss: () => finishResolution({ status: "abort" }),
          });
        });
      }

      return { status: "passthrough" };
    },
    [openSecurityReport],
  );

  const clearNexusManualTimeout = useCallback(() => {
    if (nexusManualTimeoutRef.current !== null) {
      window.clearTimeout(nexusManualTimeoutRef.current);
      nexusManualTimeoutRef.current = null;
    }
  }, []);

  const startNexusManualTimeout = useCallback(() => {
    clearNexusManualTimeout();
    nexusManualTimeoutRef.current = window.setTimeout(
      () => {
        pendingNexusManualActionRef.current = null;
        setDownloading(null);
        setUpdatingGroup(null);
        showLibraryNotice(
          "Nexus Download Timed Out",
          "The Nexus manual download session timed out. Start the download again from the Files page.",
        );
      },
      5 * 60 * 1000,
    );
  }, [clearNexusManualTimeout, showLibraryNotice]);

  const getEffectiveNexusDownloadAccess = useCallback(async () => {
    const status = await ApiService.getNexusOAuthStatus();
    const connected = !!status.connected;
    const isPremium = connected && !!status.account?.isPremium;
    return {
      connected,
      canDirectDownload:
        connected && (isPremium || !!status.account?.canDirectDownload),
      requiresSiteConfirmation:
        connected && !isPremium && !!status.account?.requiresSiteConfirmation,
    };
  }, []);

  const beginManualNexusLibraryDownload = useCallback(
    async (
      modId: number,
      fileId: number,
      runtime: "IL2CPP" | "Mono" | undefined,
      onSuccess: () => Promise<void>,
      onErrorTitle?: string,
    ) => {
      pendingNexusManualActionRef.current = { onSuccess, onErrorTitle };
      try {
        await ApiService.beginNexusManualDownloadSession({
          kind: "library",
          modId,
          fileId,
          gameId: "schedule1",
          runtime,
        });
        startNexusManualTimeout();
        showToast(
          "Opened the Nexus Mods Files tab in your browser. Confirm the download there; SIMM will add it to your library when the nxm link returns.",
        );
      } catch (error) {
        pendingNexusManualActionRef.current = null;
        throw error;
      }
    },
    [showToast, startNexusManualTimeout],
  );

  /** Notify ModsOverlay (and other views) that the library was updated - e.g. after download */
  const notifyLibraryUpdated = useCallback(() => {
    sessionStorage.setItem("library-needs-refresh", "1");
    window.dispatchEvent(new CustomEvent("library-updated"));
  }, []);

  const notifyModUpdateStateChanged = useCallback(() => {
    window.dispatchEvent(new CustomEvent("mod-updates-checked"));
  }, []);

  useEffect(() => {
    const handleManualDownloadResult = async (event: Event) => {
      const detail = (
        event as CustomEvent<{
          success: boolean;
          result?: {
            kind?: "library" | "install";
            requestedKind?: "library" | "install";
            securityScan?: SecurityScanSummary | SecurityScanReport;
            securityScanConfirmationRequired?: boolean;
            securityScanBlocked?: boolean;
          };
          requestedKind?: "library" | "install";
          error?: string;
          nxmUrl?: string;
          securityScan?: SecurityScanSummary | SecurityScanReport;
          securityScanConfirmationRequired?: boolean;
          securityScanBlocked?: boolean;
        }>
      ).detail;
      const pendingAction = pendingNexusManualActionRef.current;
      const requestedKind =
        detail?.requestedKind ?? detail?.result?.requestedKind;
      const isLibraryResult =
        detail?.result?.kind === "library" || requestedKind === "library";

      if (pendingAction && isLibraryResult) {
        const securityScan = detail?.securityScan ?? detail?.result?.securityScan;
        const securityScanConfirmationRequired =
          detail?.securityScanConfirmationRequired
          ?? detail?.result?.securityScanConfirmationRequired;
        const securityScanBlocked =
          detail?.securityScanBlocked ?? detail?.result?.securityScanBlocked;

        if (
          !detail?.success
          && (securityScanConfirmationRequired || securityScanBlocked)
        ) {
          const gateResolution = await handleSecurityGateResult(
            "Security Findings - Nexus manual download",
            {
              success: false,
              securityScan,
              securityScanConfirmationRequired,
              securityScanBlocked,
              error: detail?.error,
            },
            async () => {
              if (!detail?.nxmUrl) {
                throw new Error("The Nexus callback URL is unavailable for the security retry.");
              }
              const retry = await ApiService.completeNexusManualDownloadSession(
                detail.nxmUrl,
                undefined,
                true,
              );
              if (!retry.success) {
                throw new Error(retry.error || "Security-confirmed Nexus download failed.");
              }
              return retry;
            },
          );

          if (gateResolution.status === "confirmed") {
            clearNexusManualTimeout();
            pendingNexusManualActionRef.current = null;
            setDownloading(null);
            setUpdatingGroup(null);
            try {
              await pendingAction.onSuccess();
            } catch (error) {
              showLibraryNotice(
                pendingAction.onErrorTitle || "Nexus Download Failed",
                error instanceof Error
                  ? error.message
                  : "Failed to refresh the mod library after the Nexus download completed.",
              );
            }
          }
          return;
        }

        clearNexusManualTimeout();
        pendingNexusManualActionRef.current = null;
        setDownloading(null);
        setUpdatingGroup(null);

        if (detail?.success) {
          try {
            await pendingAction.onSuccess();
          } catch (error) {
            showLibraryNotice(
              pendingAction.onErrorTitle || "Nexus Download Failed",
              error instanceof Error
                ? error.message
                : "Failed to refresh the mod library after the Nexus download completed.",
            );
          }
          return;
        }

        showLibraryNotice(
          pendingAction.onErrorTitle || "Nexus Download Failed",
          detail?.error || "Failed to complete the Nexus manual download.",
        );
        return;
      }

      if (detail?.success && isLibraryResult && isOpen) {
        await refreshLibrary();
        notifyLibraryUpdated();
      }
    };

    window.addEventListener(
      "nexus-manual-download-result",
      handleManualDownloadResult as EventListener,
    );
    return () => {
      clearNexusManualTimeout();
      window.removeEventListener(
        "nexus-manual-download-result",
        handleManualDownloadResult as EventListener,
      );
    };
  }, [
    clearNexusManualTimeout,
    handleSecurityGateResult,
    isOpen,
    notifyLibraryUpdated,
    refreshLibrary,
    showLibraryNotice,
  ]);

  useEffect(() => {
    if (!isOpen) return;
    const loadLibrary = async () => {
      try {
        await ensureLibrary();
      } catch (err) {
        console.error("Failed to load mod library:", err);
      }
    };
    loadLibrary();
  }, [ensureLibrary, isOpen]);

  useEffect(() => {
    const activeModIds = new Set(
      nexusModsSearchResults.map((modItem) => modItem.mod_id),
    );
    if (selectedNexusModId !== null) {
      activeModIds.add(selectedNexusModId);
    }
    activeNexusModIdsRef.current = activeModIds;
    nexusModsFileRequestTokenRef.current.forEach((_, modId) => {
      if (!activeModIds.has(modId)) {
        nexusModsFileRequestTokenRef.current.delete(modId);
      }
    });

    setNexusModsFiles((prev) => {
      if (prev.size === 0) {
        return prev;
      }

      let changed = false;
      const next = new Map<number, NexusModFile[]>();
      prev.forEach((files, modId) => {
        if (activeModIds.has(modId)) {
          next.set(modId, files);
          return;
        }
        changed = true;
      });
      return changed ? next : prev;
    });

    setNexusModsLoading((prev) => {
      if (prev.size === 0) {
        return prev;
      }

      let changed = false;
      const next = new Set<number>();
      prev.forEach((modId) => {
        if (activeModIds.has(modId)) {
          next.add(modId);
          return;
        }
        changed = true;
      });
      return changed ? next : prev;
    });

    setSelectedNexusFileByModId((prev) => {
      const entries = Object.entries(prev);
      if (entries.length === 0) {
        return prev;
      }

      let changed = false;
      const next: Record<number, number> = {};
      entries.forEach(([modIdKey, fileId]) => {
        const modId = Number(modIdKey);
        if (activeModIds.has(modId)) {
          next[modId] = fileId;
          return;
        }
        changed = true;
      });
      return changed ? next : prev;
    });
  }, [nexusModsSearchResults, selectedNexusModId]);

  useEffect(() => {
    if (
      selectedNexusModId === null ||
      nexusModsFiles.has(selectedNexusModId) ||
      nexusModsLoading.has(selectedNexusModId)
    ) {
      return;
    }

    void handleLoadNexusModFiles(selectedNexusModId);
  }, [
    selectedNexusModId,
    nexusModsFiles,
    nexusModsLoading,
    handleLoadNexusModFiles,
  ]);

  const runThunderstoreSearch = useCallback(
    async (query: string) => {
      const trimmedQuery = query.trim();
      const requestGeneration = ++providerSearchGenerationRef.current.thunderstore;
      setSearching(true);
      setShowSearchResults(false);
      setShowNexusModsResults(false);
      setNexusModsSearchResults([]);
      setActiveModView(null);
      try {
        const { packagesByRuntime } =
          await ApiService.searchThunderstoreByRuntime(
            "schedule-i",
            trimmedQuery,
          );

        if (
          requestGeneration !== providerSearchGenerationRef.current.thunderstore ||
          searchSourceRef.current !== "thunderstore"
        ) {
          return;
        }

        const sortedResults = buildThunderstoreGroups(
          packagesByRuntime as Partial<
            Record<ThunderstoreRuntime, ThunderstorePackage[]>
          >,
          trimmedQuery
            ? discoverSort
            : discoverSort === "relevance"
              ? "updated"
              : discoverSort,
        );
        setSearchResults(sortedResults);
        setShowSearchResults(true);
      } catch (err) {
        if (
          requestGeneration !== providerSearchGenerationRef.current.thunderstore ||
          searchSourceRef.current !== "thunderstore"
        ) {
          return;
        }
        console.error("Error searching Thunderstore:", err);
        showLibraryNotice(
          "Thunderstore API Issue",
          getErrorMessage(
            err,
            "Thunderstore API is having issues. Please try again later.",
          ),
        );
        setSearchResults([]);
      } finally {
        if (requestGeneration === providerSearchGenerationRef.current.thunderstore) {
          setSearching(false);
        }
      }
    },
    [discoverSort, showLibraryNotice],
  );

  const runNexusSearch = useCallback(
    async (query: string, append = false) => {
      const trimmedQuery = query.trim();
      const requestGeneration = ++providerSearchGenerationRef.current.nexusmods;
      const offset = append ? nexusModsSearchResultsRef.current.length : 0;
      if (append) {
        setLoadingMoreNexusMods(true);
      } else {
        setSearchingNexusMods(true);
        setShowNexusModsResults(false);
        setShowNexusCollectionsResults(false);
        setShowSearchResults(false);
        setSearchResults([]);
        setActiveModView(null);
      }
      try {
        const page = await ApiService.browseNexusModsPage(
          "schedule1",
          trimmedQuery,
          discoverSort,
          offset,
          NEXUS_CATALOG_PAGE_SIZE,
        );

        if (
          requestGeneration !== providerSearchGenerationRef.current.nexusmods ||
          searchSourceRef.current !== "nexusmods"
        ) {
          return;
        }

        setNexusModsSearchResults((current) => {
          if (!append) {
            return page.mods;
          }
          const existingIds = new Set(current.map((mod) => mod.mod_id));
          return [
            ...current,
            ...page.mods.filter((mod) => !existingIds.has(mod.mod_id)),
          ];
        });
        setNexusModsTotalCount(page.totalCount);
        setNexusModsHasMore(page.hasMore);
        setShowNexusModsResults(true);
      } catch (err) {
        if (
          requestGeneration !== providerSearchGenerationRef.current.nexusmods ||
          searchSourceRef.current !== "nexusmods"
        ) {
          return;
        }
        console.error("Error searching NexusMods:", err);
        if (!append) {
          setNexusModsSearchResults([]);
          setNexusModsTotalCount(0);
          setNexusModsHasMore(false);
        }
      } finally {
        if (requestGeneration === providerSearchGenerationRef.current.nexusmods) {
          setSearchingNexusMods(false);
          setLoadingMoreNexusMods(false);
        }
      }
    },
    [discoverSort],
  );

  const runNexusCollectionSearch = useCallback(
    async (query: string, append = false) => {
      const trimmedQuery = query.trim();
      const requestGeneration =
        ++providerSearchGenerationRef.current.nexuscollections;
      const offset = append ? nexusCollectionsSearchResultsRef.current.length : 0;
      if (append) {
        setLoadingMoreNexusCollections(true);
      } else {
        setSearchingNexusCollections(true);
        setShowNexusCollectionsResults(false);
        setShowNexusModsResults(false);
        setShowSearchResults(false);
        setSearchResults([]);
        setSelectedNexusCollectionSlug(null);
        setActiveModView(null);
      }

      try {
        const page = await ApiService.browseNexusCollectionsPage(
          "schedule1",
          trimmedQuery,
          discoverSort,
          offset,
          NEXUS_CATALOG_PAGE_SIZE,
        );

        if (
          requestGeneration !==
            providerSearchGenerationRef.current.nexuscollections ||
          searchSourceRef.current !== "nexusmods"
        ) {
          return;
        }

        setNexusCollectionsSearchResults((current) => {
          if (!append) {
            return page.collections;
          }
          const existingSlugs = new Set(
            current.map((collection) => collection.slug),
          );
          return [
            ...current,
            ...page.collections.filter(
              (collection) => !existingSlugs.has(collection.slug),
            ),
          ];
        });
        setNexusCollectionsTotalCount(page.totalCount);
        setNexusCollectionsHasMore(page.hasMore);
        setShowNexusCollectionsResults(true);
      } catch (err) {
        if (
          requestGeneration !==
            providerSearchGenerationRef.current.nexuscollections ||
          searchSourceRef.current !== "nexusmods"
        ) {
          return;
        }
        console.error("Error searching Nexus collections:", err);
        if (!append) {
          setNexusCollectionsSearchResults([]);
          setNexusCollectionsTotalCount(0);
          setNexusCollectionsHasMore(false);
        }
      } finally {
        if (
          requestGeneration ===
          providerSearchGenerationRef.current.nexuscollections
        ) {
          setSearchingNexusCollections(false);
          setLoadingMoreNexusCollections(false);
        }
      }
    },
    [discoverSort],
  );

  const handleSearch = () => runThunderstoreSearch(searchQuery);

  const handleSearchNexusMods = () => runNexusSearch(nexusModsSearchQuery);

  const handleSearchNexusCollections = () =>
    runNexusCollectionSearch(nexusCollectionsSearchQuery);

  const handleLoadMoreNexusMods = () =>
    runNexusSearch(nexusModsSearchQuery, true);

  const handleLoadMoreNexusCollections = () =>
    runNexusCollectionSearch(nexusCollectionsSearchQuery, true);

  const handleRefreshDiscovery = () => {
    if (searchSource === "thunderstore") {
      void runThunderstoreSearch(searchQuery);
    } else if (nexusCatalogKind === "collections") {
      void runNexusCollectionSearch(nexusCollectionsSearchQuery);
    } else {
      void runNexusSearch(nexusModsSearchQuery);
    }
  };

  useEffect(() => {
    if (!isOpen) {
      discoveryPreloadStartedRef.current = false;
      return;
    }
    if (libraryTab !== "discover" || discoveryPreloadStartedRef.current) {
      return;
    }
    discoveryPreloadStartedRef.current = true;

    if (searchSourceRef.current === "nexusmods") {
      return;
    }

    void ApiService.browseNexusModsPage(
      "schedule1",
      "",
      "updated",
      0,
      NEXUS_CATALOG_PAGE_SIZE,
    )
      .then((page) => {
        if (
          nexusModsSearchQueryRef.current.trim() !== "" ||
          discoverSortRef.current !== "updated" ||
          nexusCatalogKindRef.current !== "mods"
        ) {
          return;
        }
        if (
          page.mods.length === 0 &&
          nexusModsSearchResultsRef.current.length === 0
        ) {
          return;
        }
        nexusModsSearchResultsRef.current = page.mods;
        setNexusModsSearchResults(page.mods);
        setNexusModsTotalCount(page.totalCount);
        setNexusModsHasMore(page.hasMore);
        if (searchSourceRef.current === "nexusmods") {
          nexusCatalogLoadKeyRef.current = "mods:updated";
          setShowNexusModsResults(true);
        }
      })
      .catch((error) => {
        logger.warn("Failed to preload the Nexus Mods discover catalog", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, [isOpen, libraryTab]);

  useEffect(() => {
    if (
      !isOpen ||
      libraryTab !== "discover" ||
      searchSource !== "nexusmods"
    ) {
      return;
    }

    const loadKey = `${nexusCatalogKind}:${discoverSort}`;
    if (nexusCatalogLoadKeyRef.current === loadKey) {
      return;
    }
    nexusCatalogLoadKeyRef.current = loadKey;

    if (nexusCatalogKind === "collections") {
      void runNexusCollectionSearch(nexusCollectionsSearchQueryRef.current);
    } else if (
      nexusModsSearchQueryRef.current.trim() === "" &&
      discoverSort === "updated" &&
      nexusModsSearchResultsRef.current.length > 0
    ) {
      setShowNexusModsResults(true);
    } else {
      void runNexusSearch(nexusModsSearchQueryRef.current);
    }
  }, [
    isOpen,
    libraryTab,
    discoverSort,
    nexusCatalogKind,
    runNexusCollectionSearch,
    runNexusSearch,
    searchSource,
  ]);

  useEffect(() => {
    if (
      !isOpen ||
      libraryTab !== "discover" ||
      searchSource !== "thunderstore" ||
      !showSearchResults
    ) {
      return;
    }

    setSearchResults((current) => {
      const sorted = sortThunderstoreGroups(current, discoverSort);
      searchResultsRef.current = sorted;
      return sorted;
    });
  }, [discoverSort, isOpen, libraryTab, searchSource, showSearchResults]);

  const getEntryVersionLabel = useCallback((entry: ModLibraryEntry): string => {
    return entry.sourceVersion || entry.installedVersion || "unknown";
  }, []);

  const downloadThunderstoreWithSecurity = useCallback(
    async (
      packageUuid: string,
      runtime?: "IL2CPP" | "Mono",
      versionUuid?: string,
      title = "Security Findings",
    ): Promise<Awaited<
      ReturnType<typeof ApiService.downloadThunderstoreToLibrary>
    > | null> => {
      const result = await ApiService.downloadThunderstoreToLibrary(
        packageUuid,
        runtime,
        undefined,
        versionUuid,
      );
      if (!result.success) {
        const gateResolution = await handleSecurityGateResult(
          title,
          result,
          async () => {
            const retry = await ApiService.downloadThunderstoreToLibrary(
              packageUuid,
              runtime,
              true,
              versionUuid,
            );
            if (!retry.success) {
              throw new Error(
                retry.error ||
                  "Failed to continue the download after confirming the MLVScan findings.",
              );
            }
            await refreshLibrary();
            notifyLibraryUpdated();
            return retry;
          },
        );

        if (gateResolution.status === "abort") {
          return null;
        }
        if (gateResolution.status === "confirmed") {
          return gateResolution.value;
        }

        throw new Error(
          result.error ||
            "Failed to download the selected Thunderstore package.",
        );
      }

      await refreshLibrary();
      notifyLibraryUpdated();
      return result;
    },
    [handleSecurityGateResult, notifyLibraryUpdated, refreshLibrary],
  );

  const downloadGithubReleaseWithSecurity = useCallback(
    async (
      downloadAction: (
        versionTag: string,
        securityOverride?: boolean,
      ) => Promise<
        {
          success: boolean;
          storageId?: string;
          alreadyStored?: boolean;
        } & {
          securityScan?: SecurityScanSummary | SecurityScanReport;
          securityScanConfirmationRequired?: boolean;
          securityScanBlocked?: boolean;
          error?: string;
        }
      >,
      versionTag: string,
      title: string,
    ): Promise<Awaited<ReturnType<typeof downloadAction>> | null> => {
      const result = await downloadAction(versionTag);
      if (!result.success) {
        const gateResolution = await handleSecurityGateResult(
          title,
          result,
          async () => {
            const retry = await downloadAction(versionTag, true);
            if (!retry.success) {
              throw new Error(
                retry.error ||
                  "Failed to continue the download after confirming the MLVScan findings.",
              );
            }
            await refreshLibrary();
            notifyLibraryUpdated();
            return retry;
          },
        );

        if (gateResolution.status === "abort") {
          return null;
        }
        if (gateResolution.status === "confirmed") {
          return gateResolution.value;
        }

        throw new Error(
          result.error || "Failed to download the selected GitHub release.",
        );
      }

      await refreshLibrary();
      notifyLibraryUpdated();
      return result;
    },
    [handleSecurityGateResult, notifyLibraryUpdated, refreshLibrary],
  );

  const downloadNexusWithSecurity = useCallback(
    async (
      modId: number,
      fileId: number,
      runtime?: "IL2CPP" | "Mono",
      title = "Security Findings",
    ): Promise<Awaited<
      ReturnType<typeof ApiService.downloadNexusModToLibrary>
    > | null> => {
      const result = await ApiService.downloadNexusModToLibrary(
        modId,
        fileId,
        runtime,
      );
      if (!result.success) {
        const gateResolution = await handleSecurityGateResult(
          title,
          result,
          async () => {
            const retry = await ApiService.downloadNexusModToLibrary(
              modId,
              fileId,
              runtime,
              true,
            );
            if (!retry.success) {
              throw new Error(
                retry.error ||
                  "Failed to continue the download after confirming the MLVScan findings.",
              );
            }
            await refreshLibrary();
            notifyLibraryUpdated();
            return retry;
          },
        );

        if (gateResolution.status === "abort") {
          return null;
        }
        if (gateResolution.status === "confirmed") {
          return gateResolution.value;
        }

        throw new Error(
          result.error || "Failed to download the selected Nexus mod.",
        );
      }

      await refreshLibrary();
      notifyLibraryUpdated();
      return result;
    },
    [handleSecurityGateResult, notifyLibraryUpdated, refreshLibrary],
  );

  const activateGroupEntry = useCallback(
    async (
      group: DownloadedModGroup,
      targetEntry: ModLibraryEntry,
      installTargets?: {
        installedIn: string[];
        installedInByRuntime: RuntimeInstallTargets;
        replaceStorageIds: string[];
      },
    ) => {
      const installedIn = installTargets?.installedIn || group.installedIn;
      const installedInByRuntime =
        installTargets?.installedInByRuntime || group.installedInByRuntime;

      if (installedIn.length === 0) {
        return;
      }

      setActivatingGroup(group.key);
      try {
        const warningMessages: string[] = [];
        const allStorageIds = Array.from(
          new Set([
            ...collectDownloadedGroupStorageIds(group),
            ...(installTargets?.replaceStorageIds || []),
          ]),
        );

        const runtimeTargets = (["IL2CPP", "Mono"] as const)
          .map((runtime) => ({
            runtime,
            envIds: installedInByRuntime[runtime] || [],
          }))
          .filter(
            (
              target,
            ): target is { runtime: "IL2CPP" | "Mono"; envIds: string[] } =>
              target.envIds.length > 0,
          );

        const handledEnvIds = new Set<string>();

        for (const target of runtimeTargets) {
          target.envIds.forEach((id) => handledEnvIds.add(id));

          const selectedStorageId =
            targetEntry.storageIdsByRuntime?.[target.runtime] ||
            targetEntry.storageId;
          if (!selectedStorageId) {
            continue;
          }

          const previousStorageIds = allStorageIds.filter(
            (id) => id !== selectedStorageId,
          );
          for (const oldStorageId of previousStorageIds) {
            await ApiService.uninstallDownloadedMod(
              oldStorageId,
              target.envIds,
            );
          }

          const installResult = await ApiService.installDownloadedMod(
            selectedStorageId,
            target.envIds,
          );
          warningMessages.push(
            ...installResult.results.flatMap((result) => result.warnings || []),
          );
        }

        const remainingEnvIds = installedIn.filter(
          (id) => !handledEnvIds.has(id),
        );
        if (remainingEnvIds.length > 0) {
          const fallbackStorageId = targetEntry.storageId;
          if (fallbackStorageId) {
            const previousStorageIds = allStorageIds.filter(
              (id) => id !== fallbackStorageId,
            );
            for (const oldStorageId of previousStorageIds) {
              await ApiService.uninstallDownloadedMod(
                oldStorageId,
                remainingEnvIds,
              );
            }
            const installResult = await ApiService.installDownloadedMod(
              fallbackStorageId,
              remainingEnvIds,
            );
            warningMessages.push(
              ...installResult.results.flatMap(
                (result) => result.warnings || [],
              ),
            );
          }
        }

        if (warningMessages.length > 0) {
          showToast(
            warningMessages.length === 1
              ? warningMessages[0]
              : `${warningMessages[0]} (+${warningMessages.length - 1} more warning${warningMessages.length > 2 ? "s" : ""})`,
          );
        }
        await refreshLibrary();
        setSelectedStorageByGroup((prev) => ({
          ...prev,
          [group.key]: targetEntry.storageId,
        }));
        notifyModUpdateStateChanged();
      } finally {
        setActivatingGroup(null);
      }
    },
    [refreshLibrary, notifyModUpdateStateChanged, showToast],
  );

  const findThunderstorePackageForRuntime = useCallback(
    async (
      sourceId: string,
      runtime: "IL2CPP" | "Mono",
    ): Promise<ThunderstorePackage | null> => {
      const parsed = parseThunderstoreSourceId(sourceId);
      if (!parsed.owner || !parsed.name) {
        return null;
      }

      const targetOwner = parsed.owner.toLowerCase();
      const targetName = normalizeThunderstoreName(parsed.name).toLowerCase();
      const query = normalizeThunderstoreName(parsed.name) || parsed.name;
      const searchResult = await ApiService.searchThunderstore(
        "schedule-i",
        query,
        runtime,
      );
      const packages = (searchResult?.packages || []) as ThunderstorePackage[];

      const exact = packages.find((pkg) => {
        const pkgOwner = (pkg.owner || "").toLowerCase();
        const pkgName = normalizeThunderstoreName(
          pkg.name || pkg.full_name || "",
        ).toLowerCase();
        return pkgOwner === targetOwner && pkgName === targetName;
      });
      if (exact) {
        return exact;
      }

      const rawNameMatch = packages.find((pkg) => {
        const pkgOwner = (pkg.owner || "").toLowerCase();
        const pkgName = (pkg.name || "").toLowerCase();
        return pkgOwner === targetOwner && pkgName === parsed.name.toLowerCase();
      });
      if (rawNameMatch) {
        return rawNameMatch;
      }

      const normalizedContainsMatch = packages.find((pkg) => {
        const pkgOwner = (pkg.owner || "").toLowerCase();
        const pkgName = normalizeThunderstoreName(
          pkg.name || pkg.full_name || "",
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
        (pkg) => (pkg.owner || "").toLowerCase() === targetOwner,
      );
      return soleOwnerMatch.length === 1 ? soleOwnerMatch[0] : null;
    },
    [],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const loadFeaturedReleases = async () => {
      const buildFeaturedThunderstorePackage = (
        featured:
          (typeof FEATURED_THUNDERSTORE_DOWNLOADS)[keyof typeof FEATURED_THUNDERSTORE_DOWNLOADS],
        packagesByRuntime: Partial<Record<ThunderstoreRuntime, ThunderstorePackage>>,
      ): ThunderstorePackageGroup | null => {
        const representative =
          packagesByRuntime.IL2CPP || packagesByRuntime.Mono || null;
        if (!representative) {
          return null;
        }

        return {
          key: `${featured.author.toLowerCase()}::${normalizeThunderstoreName(featured.displayName).toLowerCase()}`,
          name: featured.displayName,
          owner: featured.author,
          packageUrl: representative.package_url || featured.packageUrl,
          packagesByRuntime,
        };
      };

      const [s1apiResult, mlvscanResult] = await Promise.allSettled([
        ApiService.getS1APILatestRelease(""),
        ApiService.getMLVScanLatestRelease(""),
      ]);

      if (s1apiResult.status === "fulfilled") {
        setS1apiFeaturedRelease(s1apiResult.value);
      } else {
        logger.warn("Failed to load featured S1API release metadata", {
          error:
            s1apiResult.reason instanceof Error
              ? s1apiResult.reason.message
              : String(s1apiResult.reason),
        });
        setS1apiFeaturedRelease(null);
      }

      if (mlvscanResult.status === "fulfilled") {
        setMlvscanFeaturedRelease(mlvscanResult.value);
      } else {
        logger.warn("Failed to load featured MLVScan release metadata", {
          error:
            mlvscanResult.reason instanceof Error
              ? mlvscanResult.reason.message
              : String(mlvscanResult.reason),
        });
        setMlvscanFeaturedRelease(null);
      }

      const thunderstoreFeatured = await Promise.allSettled([
        ApiService.searchThunderstoreByRuntime("schedule-i", ""),
      ]);
      const packagesByRuntime =
        thunderstoreFeatured[0].status === "fulfilled"
          ? thunderstoreFeatured[0].value.packagesByRuntime
          : {};
      if (thunderstoreFeatured[0].status === "rejected") {
        logger.warn("Failed to load featured Thunderstore metadata", {
          error:
            thunderstoreFeatured[0].reason instanceof Error
              ? thunderstoreFeatured[0].reason.message
              : String(thunderstoreFeatured[0].reason),
        });
      } else if (searchQueryRef.current.trim() === "") {
        const groups = buildThunderstoreGroups(
          packagesByRuntime as Partial<
            Record<ThunderstoreRuntime, ThunderstorePackage[]>
          >,
          discoverSortRef.current,
        );
        if (groups.length > 0 && searchResultsRef.current.length === 0) {
          searchResultsRef.current = groups;
          setSearchResults(groups);
        }
        if (
          groups.length > 0 &&
          searchSourceRef.current === "thunderstore"
        ) {
          thunderstoreCatalogLoadKeyRef.current = `${discoverSortRef.current}:`;
          setShowSearchResults(true);
        }
      }

      const findFeaturedPackage = (
        sourceId: string,
        runtime: ThunderstoreRuntime,
      ): ThunderstorePackage | null => {
        const parsed = parseThunderstoreSourceId(sourceId);
        if (!parsed.owner || !parsed.name) {
          return null;
        }
        const targetOwner = parsed.owner.toLowerCase();
        const targetName = normalizeThunderstoreName(parsed.name).toLowerCase();
        const packages = (packagesByRuntime[runtime] || []) as ThunderstorePackage[];

        return (
          packages.find((pkg) => {
            const pkgOwner = (pkg.owner || "").toLowerCase();
            const pkgName = normalizeThunderstoreName(
              pkg.name || pkg.full_name || "",
            ).toLowerCase();
            return pkgOwner === targetOwner && pkgName === targetName;
          }) ||
          packages.find((pkg) => {
            const pkgOwner = (pkg.owner || "").toLowerCase();
            const pkgName = (pkg.name || "").toLowerCase();
            return pkgOwner === targetOwner && pkgName === parsed.name.toLowerCase();
          }) ||
          null
        );
      };

      const getFeaturedThunderstoreSourceId = (
        featured:
          (typeof FEATURED_THUNDERSTORE_DOWNLOADS)[keyof typeof FEATURED_THUNDERSTORE_DOWNLOADS],
        runtime: ThunderstoreRuntime,
      ) =>
        ("sourceIdsByRuntime" in featured
          ? featured.sourceIdsByRuntime?.[runtime]
          : undefined) || featured.sourceId;

      setMeshVaultFeaturedPackage(
        buildFeaturedThunderstorePackage(FEATURED_THUNDERSTORE_DOWNLOADS.meshvault, {
          IL2CPP:
            findFeaturedPackage(
              getFeaturedThunderstoreSourceId(
                FEATURED_THUNDERSTORE_DOWNLOADS.meshvault,
                "IL2CPP",
              ),
              "IL2CPP",
            ) || undefined,
          Mono:
            findFeaturedPackage(
              getFeaturedThunderstoreSourceId(
                FEATURED_THUNDERSTORE_DOWNLOADS.meshvault,
                "Mono",
              ),
              "Mono",
            ) || undefined,
        }),
      );

      setS1mapiFeaturedPackage(
        buildFeaturedThunderstorePackage(FEATURED_THUNDERSTORE_DOWNLOADS.s1mapi, {
          IL2CPP:
            findFeaturedPackage(
              getFeaturedThunderstoreSourceId(
                FEATURED_THUNDERSTORE_DOWNLOADS.s1mapi,
                "IL2CPP",
              ),
              "IL2CPP",
            ) || undefined,
          Mono:
            findFeaturedPackage(
              getFeaturedThunderstoreSourceId(
                FEATURED_THUNDERSTORE_DOWNLOADS.s1mapi,
                "Mono",
              ),
              "Mono",
            ) || undefined,
        }),
      );

      setSteamNetworkLibFeaturedPackage(
        buildFeaturedThunderstorePackage(
          FEATURED_THUNDERSTORE_DOWNLOADS.steamnetworklib,
          {
            IL2CPP:
              findFeaturedPackage(
                getFeaturedThunderstoreSourceId(
                  FEATURED_THUNDERSTORE_DOWNLOADS.steamnetworklib,
                  "IL2CPP",
                ),
                "IL2CPP",
              ) || undefined,
            Mono:
              findFeaturedPackage(
                getFeaturedThunderstoreSourceId(
                  FEATURED_THUNDERSTORE_DOWNLOADS.steamnetworklib,
                  "Mono",
                ),
                "Mono",
              ) || undefined,
          },
        ),
      );
    };

    void loadFeaturedReleases();
  }, [isOpen]);

  const pickNexusFileForVersionAndRuntime = useCallback(
    (
      files: NexusModFile[],
      runtime: "IL2CPP" | "Mono",
      targetVersion?: string,
    ): NexusModFile | undefined => {
      if (!files.length) {
        return undefined;
      }

      const runtimeLower = runtime.toLowerCase();
      const runtimeFiles = files.filter((file) => {
        const fileName = (file.file_name || file.name || "").toLowerCase();
        return fileName.includes(runtimeLower);
      });

      if (targetVersion) {
        const versionToken = normalizeVersionToken(targetVersion);
        const versionMatchInRuntime = runtimeFiles.find((file) => {
          const fileVersion = normalizeVersionToken(
            file.version || file.mod_version || "",
          );
          return fileVersion === versionToken;
        });
        if (versionMatchInRuntime) {
          return versionMatchInRuntime;
        }

        const versionMatchAny = files.find((file) => {
          const fileVersion = normalizeVersionToken(
            file.version || file.mod_version || "",
          );
          return fileVersion === versionToken;
        });
        if (versionMatchAny) {
          return versionMatchAny;
        }
      }

      return selectNexusFileForRuntime(files, runtime);
    },
    [],
  );

  const handleUpdateAndActivateGroup = useCallback(
    async (group: DownloadedModGroup) => {
      const sourceEntry = group.entries.find(
        (entry) =>
          entry.source === "thunderstore" ||
          entry.source === "nexusmods" ||
          entry.source === "github",
      );
      if (!sourceEntry || !sourceEntry.source) {
        logger.warn("Downloaded mod group is missing supported source metadata for update", {
          groupKey: group.key,
          displayName: group.displayName,
        });
        showLibraryNotice(
          "Mod Update Failed",
          "This downloaded mod is missing supported source metadata, so SIMM cannot fetch an update for it.",
        );
        return;
      }

      const versionSourceId =
        sourceEntry.sourceId || group.entries[0]?.sourceId;
      const existingLatestEntry = group.remoteVersion
        ? group.entries.find((entry) =>
            areVersionsEquivalentForSource(
              entry.sourceId || versionSourceId,
              getEntryVersionLabel(entry),
              group.remoteVersion,
            ),
          )
        : undefined;

      if (existingLatestEntry) {
        const latestAlreadyActive =
          group.installedIn.length > 0 &&
          group.entries.every((entry) => {
            const hasInstallations = entry.installedIn.length > 0;
            if (!hasInstallations) {
              return true;
            }
            return entry.storageId === existingLatestEntry.storageId;
          });

        await activateGroupEntry(group, existingLatestEntry);
        if (latestAlreadyActive) {
          showLibraryNotice(
            "Already Updated",
            `The latest version ${formatVersionTag(group.remoteVersion)} is already downloaded and active for this mod.`,
          );
        }
        return;
      }

      const targetRuntimes = (["IL2CPP", "Mono"] as const).filter((runtime) => {
        return (group.installedInByRuntime[runtime] || []).length > 0;
      });
      const runtimesToUpdate: Array<"IL2CPP" | "Mono"> =
        targetRuntimes.length > 0
          ? [...targetRuntimes]
          : group.availableRuntimes.length > 0
            ? [...group.availableRuntimes]
            : ["IL2CPP"];

      logger.info("Starting mod library update", {
        groupKey: group.key,
        displayName: group.displayName,
        source: sourceEntry.source,
        sourceId: sourceEntry.sourceId,
        remoteVersion: group.remoteVersion,
        runtimesToUpdate,
      });

      setUpdatingGroup(group.key);
      let keepPendingUpdate = false;
      try {
        const downloadedStorageIds: string[] = [];
        let downloadedUpdatedRuntime = false;
        const thunderstoreMissingRuntimes: Array<"IL2CPP" | "Mono"> = [];
        const featuredGithubUpdate = getFeaturedGithubUpdateConfig(group);

        if (featuredGithubUpdate) {
          const latestVersionTag =
            group.remoteVersion ||
            (await featuredGithubUpdate.loadLatestRelease())?.tag_name;

          if (!latestVersionTag) {
            throw new Error("Could not resolve the latest GitHub release.");
          }

          logger.debug("Resolved featured GitHub update target for mod group", {
            groupKey: group.key,
            displayName: group.displayName,
            versionTag: latestVersionTag,
          });

          const result = await downloadGithubReleaseWithSecurity(
            featuredGithubUpdate.downloader,
            latestVersionTag,
            `Security Findings - ${group.displayName}`,
          );
          if (!result) {
            logger.warn("Featured GitHub mod update ended without a stored download", {
              groupKey: group.key,
              displayName: group.displayName,
              versionTag: latestVersionTag,
            });
            return;
          }
          if (result.storageId) {
            downloadedStorageIds.push(result.storageId);
            downloadedUpdatedRuntime = true;
          }
        } else if (sourceEntry.source === "thunderstore") {
          if (!sourceEntry.sourceId) {
            throw new Error("Missing Thunderstore source id for update");
          }

          for (const runtime of runtimesToUpdate) {
            const pkg = await findThunderstorePackageForRuntime(
              sourceEntry.sourceId,
              runtime,
            );
            if (!pkg) {
              thunderstoreMissingRuntimes.push(runtime);
              continue;
            }
            const latestVersion = getLatestThunderstorePackageVersion(
              pkg,
              sourceEntry.sourceId,
            );
            if (!latestVersion?.uuid4) {
              thunderstoreMissingRuntimes.push(runtime);
              continue;
            }
            const result = await downloadThunderstoreWithSecurity(
              pkg.uuid4,
              runtime,
              latestVersion.uuid4,
              `Security Findings - ${group.displayName}`,
            );
            if (!result) {
              return;
            }
            if (result?.storageId) {
              downloadedStorageIds.push(result.storageId);
              downloadedUpdatedRuntime = true;
            }
          }

          if (downloadedStorageIds.length === 0) {
            if (thunderstoreMissingRuntimes.length > 0) {
              throw new Error(
                `Could not resolve the latest Thunderstore package for ${thunderstoreMissingRuntimes.join("/")} runtime.`,
              );
            }
            throw new Error(
              "Thunderstore update did not produce a downloadable library entry.",
            );
          }
        } else if (sourceEntry.source === "nexusmods") {
          const modId = Number(sourceEntry.sourceId || "0");
          if (!Number.isFinite(modId) || modId <= 0) {
            throw new Error("Missing NexusMods mod id for update");
          }

          const access = await getEffectiveNexusDownloadAccess();
          if (!access.connected) {
            throw new Error("Nexus login is required to download Nexus mods.");
          }

          const files = await ApiService.getNexusModsModFiles(
            "schedule1",
            modId,
          );

          if (!access.canDirectDownload && access.requiresSiteConfirmation) {
            const beginManualUpdateForRuntime = async (
              runtime: "IL2CPP" | "Mono",
            ) => {
              const file = pickNexusFileForVersionAndRuntime(
                files,
                runtime,
                group.remoteVersion,
              );
              if (!file?.file_id) {
                throw new Error(`No Nexus file found for ${runtime}.`);
              }

              await beginManualNexusLibraryDownload(
                modId,
                file.file_id,
                runtime,
                async () => {
                  await refreshLibrary();

                  if (runtimesToUpdate.length > 1) {
                    showLibraryNotice(
                      "One Runtime Updated",
                      "Downloaded one runtime for this Nexus mod. Repeat the update for the other runtime before re-activating the version across all environments.",
                    );
                    return;
                  }

                  const nextLibrary = await loadLibrarySnapshot();
                  notifyLibraryUpdated();

                  const refreshedGroup = buildDownloadedGroups(
                    nextLibrary.downloaded,
                  ).find((item) => item.key === group.key);
                  const selectedEntry =
                    refreshedGroup?.entries.find((entry) => {
                      return (
                        group.remoteVersion &&
                        areVersionsEquivalent(
                          getEntryVersionLabel(entry),
                          group.remoteVersion,
                        )
                      );
                    }) || refreshedGroup?.entries[0];

                  if (refreshedGroup && selectedEntry) {
                    await activateGroupEntry(refreshedGroup, selectedEntry);
                  }
                },
                "Nexus Update Failed",
              );
              keepPendingUpdate = true;
            };

            if (runtimesToUpdate.length > 1) {
              setRuntimePrompt({
                title: "Select Runtime",
                message:
                  "Free Nexus downloads must be confirmed one file at a time. Choose the runtime to update now.",
                onSelect: (runtime) => {
                  if (runtime === "Both") {
                    showLibraryNotice(
                      "Select One Runtime",
                      "Choose Mono or IL2CPP for this update. Repeat the update for the other runtime separately.",
                    );
                    return;
                  }
                  setRuntimePrompt(null);
                  setUpdatingGroup(group.key);
                  void beginManualUpdateForRuntime(runtime).catch((error) => {
                    setUpdatingGroup(null);
                    showLibraryNotice(
                      "Nexus Update Failed",
                      error instanceof Error
                        ? error.message
                        : "Failed to start the Nexus manual update.",
                    );
                  });
                },
              });
              return;
            }

            await beginManualUpdateForRuntime(runtimesToUpdate[0]);
            return;
          }

          for (const runtime of runtimesToUpdate) {
            const file = pickNexusFileForVersionAndRuntime(
              files,
              runtime,
              group.remoteVersion,
            );
            if (!file?.file_id) {
              continue;
            }
            const result = await downloadNexusWithSecurity(
              modId,
              file.file_id,
              runtime,
              "Security Findings - Nexus Update",
            );
            if (!result) {
              return;
            }
            if (result?.storageId) {
              downloadedStorageIds.push(result.storageId);
              downloadedUpdatedRuntime = true;
            }
          }
        } else if (sourceEntry.source === "github") {
          const normalizedSourceId = (sourceEntry.sourceId || "").toLowerCase();
          const downloader =
            normalizedSourceId === "ifbars/s1api" ||
            normalizedSourceId === "ifbars/s1api_forked"
              ? ApiService.downloadS1APIToLibrary
              : normalizedSourceId === "ifbars/mlvscan"
                ? ApiService.downloadMLVScanToLibrary
                : null;
          if (!downloader) {
            throw new Error(
              "This GitHub-backed download does not have a configured update source.",
            );
          }

          const latestVersionTag =
            group.remoteVersion ||
            (normalizedSourceId === "ifbars/s1api" ||
            normalizedSourceId === "ifbars/s1api_forked"
              ? (await ApiService.getS1APILatestRelease("")).tag_name
              : (await ApiService.getMLVScanLatestRelease("")).tag_name);

          if (!latestVersionTag) {
            throw new Error("Could not resolve the latest GitHub release.");
          }

          const result = await downloadGithubReleaseWithSecurity(
            downloader,
            latestVersionTag,
            `Security Findings - ${group.displayName}`,
          );
          if (!result) {
            logger.warn("GitHub-backed mod update ended without a stored download", {
              groupKey: group.key,
              displayName: group.displayName,
              sourceId: sourceEntry.sourceId,
              versionTag: latestVersionTag,
            });
            return;
          }
          if (result.storageId) {
            downloadedStorageIds.push(result.storageId);
            downloadedUpdatedRuntime = true;
          }
        }

        if (!downloadedUpdatedRuntime) {
          throw new Error(
            "No updated mod package could be downloaded for the selected runtime.",
          );
        }

        const nextLibrary = await loadLibrarySnapshot();
        notifyLibraryUpdated();

        const refreshedGroups = buildDownloadedGroups(nextLibrary.downloaded);
        const refreshedGroup =
          refreshedGroups.find((item) =>
            item.entries.some((entry) =>
              [
                entry.storageId,
                ...Object.values(entry.storageIdsByRuntime || {}),
              ].some((id) => downloadedStorageIds.includes(id)),
            ),
          ) || refreshedGroups.find((item) => item.key === group.key);
        const selectedEntry =
          refreshedGroup?.entries.find((entry) => {
            return (
              (group.remoteVersion &&
                areVersionsEquivalentForSource(
                  entry.sourceId || versionSourceId,
                  getEntryVersionLabel(entry),
                  group.remoteVersion,
                )) ||
              [
                entry.storageId,
                ...Object.values(entry.storageIdsByRuntime || {}),
              ].some((id) => downloadedStorageIds.includes(id))
            );
          }) || refreshedGroup?.entries[0];

        if (!refreshedGroup) {
          throw new Error(
            "Updated mod entry was not found in the library after download.",
          );
        }

        if (!selectedEntry) {
          throw new Error(
            "Updated mod version could not be selected after download.",
          );
        }

        if (
          group.remoteVersion &&
          !areVersionsEquivalentForSource(
            selectedEntry.sourceId || versionSourceId,
            getEntryVersionLabel(selectedEntry),
            group.remoteVersion,
          )
        ) {
          throw new Error(
            `Downloaded library entry did not match the expected latest version ${formatVersionTag(group.remoteVersion)}.`,
          );
        }

        const needsCrossGroupActivation =
          refreshedGroup.key !== group.key && group.installedIn.length > 0;

        logger.info("Downloaded mod update resolved to library entry", {
          originalGroupKey: group.key,
          refreshedGroupKey: refreshedGroup.key,
          selectedStorageId: selectedEntry.storageId,
          downloadedStorageIds,
          expectedVersion: group.remoteVersion,
          selectedVersion: getEntryVersionLabel(selectedEntry),
        });

        await activateGroupEntry(
          refreshedGroup,
          selectedEntry,
          needsCrossGroupActivation
            ? {
                installedIn: mergeInstallTargets(
                  group.installedIn,
                  refreshedGroup.installedIn,
                ),
                installedInByRuntime: mergeRuntimeInstallTargets(
                  group.installedInByRuntime,
                  refreshedGroup.installedInByRuntime,
                ),
                replaceStorageIds: Array.from(
                  new Set([
                    ...collectDownloadedGroupStorageIds(group),
                    ...collectDownloadedGroupStorageIds(refreshedGroup),
                  ]),
                ),
              }
            : undefined,
        );
      } catch (err) {
        logger.error("Failed to update and activate mod version", {
          groupKey: group.key,
          displayName: group.displayName,
          source: sourceEntry.source,
          sourceId: sourceEntry.sourceId,
          remoteVersion: group.remoteVersion,
          error: err instanceof Error ? err.message : String(err),
        });
        showLibraryNotice(
          "Mod Update Failed",
          err instanceof Error
            ? err.message
            : "Failed to update this mod version.",
        );
      } finally {
        if (!keepPendingUpdate) {
          setUpdatingGroup(null);
        }
      }
    },
    [
      activateGroupEntry,
      beginManualNexusLibraryDownload,
      downloadNexusWithSecurity,
      downloadThunderstoreWithSecurity,
      findThunderstorePackageForRuntime,
      downloadGithubReleaseWithSecurity,
      getEffectiveNexusDownloadAccess,
      getEntryVersionLabel,
      loadLibrarySnapshot,
      notifyLibraryUpdated,
      pickNexusFileForVersionAndRuntime,
      refreshLibrary,
      showLibraryNotice,
    ],
  );

  const handleSelectVersion = useCallback(
    async (group: DownloadedModGroup, storageId: string) => {
      setSelectedStorageByGroup((prev) => ({
        ...prev,
        [group.key]: storageId,
      }));
      setOpenVersionMenuGroup(null);

      const selectedEntry =
        group.entries.find((entry) => entry.storageId === storageId) ||
        group.entries[0];
      if (!selectedEntry) {
        return;
      }

      try {
        await activateGroupEntry(group, selectedEntry);
      } catch (err) {
        console.error("Failed to activate selected mod version:", err);
      }
    },
    [activateGroupEntry],
  );

  const getSortedGroupEntries = useCallback((group: DownloadedModGroup) => {
    return [...group.entries].sort((a, b) =>
      compareVersionTokensDesc(
        a.sourceVersion || a.installedVersion,
        b.sourceVersion || b.installedVersion,
      ),
    );
  }, []);

  const getActiveEntryForGroup = useCallback(
    (group: DownloadedModGroup) => {
      const sorted = getSortedGroupEntries(group);
      const selectedStorageId = selectedStorageByGroup[group.key];
      return (
        sorted.find((entry) => entry.storageId === selectedStorageId) ||
        sorted.find((entry) => entry.installedIn.length > 0) ||
        sorted[0] ||
        null
      );
    },
    [getSortedGroupEntries, selectedStorageByGroup],
  );

  const entrySupportsRuntime = useCallback(
    (entry: ModLibraryEntry, runtime: "IL2CPP" | "Mono") => {
      if (entry.storageIdsByRuntime?.[runtime]) {
        return true;
      }
      if ((entry.availableRuntimes?.length || 0) > 0) {
        return entry.availableRuntimes.includes(runtime);
      }
      return !!entry.storageId;
    },
    [],
  );

  const getEntryStorageIds = useCallback((entry: ModLibraryEntry) => {
    return Array.from(
      new Set(
        [
          entry.storageId,
          ...Object.values(entry.storageIdsByRuntime || {}),
        ].filter((id): id is string => Boolean(id)),
      ),
    );
  }, []);

  const getContainingDownloadedGroup = useCallback(
    (entry: ModLibraryEntry) => {
      const entryStorageIds = new Set(getEntryStorageIds(entry));
      return (
        downloadedGroups.find((group) =>
          group.entries.some((candidate) =>
            getEntryStorageIds(candidate).some((storageId) =>
              entryStorageIds.has(storageId),
            ),
          ),
        ) || null
      );
    },
    [downloadedGroups, getEntryStorageIds],
  );

  const getInstallableEntry = useCallback(
    (entry: ModLibraryEntry): ModLibraryEntry => {
      const containingGroup = getContainingDownloadedGroup(entry);
      if (!containingGroup) {
        return entry;
      }

      const entryVersion = getEntryVersionLabel(entry);
      const matchingEntries = containingGroup.entries.filter((candidate) =>
        areVersionsEquivalentForSource(
          candidate.sourceId || entry.sourceId,
          getEntryVersionLabel(candidate),
          entryVersion,
        ),
      );

      if (matchingEntries.length <= 1) {
        return entry;
      }

      const availableRuntimes = Array.from(
        new Set(
          matchingEntries.flatMap(
            (candidate) => candidate.availableRuntimes || [],
          ),
        ),
      );
      const storageIdsByRuntime: Record<string, string> = {
        ...(entry.storageIdsByRuntime || {}),
      };
      const installedInByRuntime: Record<string, string[]> = {
        ...(entry.installedInByRuntime || {}),
      };
      const filesByRuntime: Record<string, string[]> = {
        ...(entry.filesByRuntime || {}),
      };
      const installedIn = new Set(entry.installedIn || []);
      const attachedUserLibs = new Set(entry.attachedUserLibs || []);
      const attachedUserData = new Set(entry.attachedUserData || []);

      for (const candidate of matchingEntries) {
        const candidateRuntimes = candidate.availableRuntimes || [];
        const candidateStorageIds = candidate.storageIdsByRuntime || {};

        for (const [runtime, storageId] of Object.entries(
          candidateStorageIds,
        )) {
          if (storageId) {
            storageIdsByRuntime[runtime] = storageId;
          }
        }

        if (candidateRuntimes.length === 1 && candidate.storageId) {
          const runtime = candidateRuntimes[0];
          if (runtime && !storageIdsByRuntime[runtime]) {
            storageIdsByRuntime[runtime] = candidate.storageId;
          }
        }

        for (const [runtime, envIds] of Object.entries(
          candidate.installedInByRuntime || {},
        )) {
          installedInByRuntime[runtime] = Array.from(
            new Set([...(installedInByRuntime[runtime] || []), ...envIds]),
          );
        }

        for (const [runtime, files] of Object.entries(
          candidate.filesByRuntime || {},
        )) {
          filesByRuntime[runtime] = Array.from(
            new Set([...(filesByRuntime[runtime] || []), ...files]),
          );
        }

        for (const envId of candidate.installedIn || []) {
          installedIn.add(envId);
        }

        for (const userLib of candidate.attachedUserLibs || []) {
          attachedUserLibs.add(userLib);
        }
        for (const userDataPath of candidate.attachedUserData || []) {
          attachedUserData.add(userDataPath);
        }
      }

      return {
        ...entry,
        installedIn: Array.from(installedIn),
        attachedUserLibs: Array.from(attachedUserLibs),
        attachedUserData: Array.from(attachedUserData),
        availableRuntimes,
        storageIdsByRuntime,
        installedInByRuntime,
        filesByRuntime,
      };
    },
    [getContainingDownloadedGroup, getEntryVersionLabel],
  );

  const hasSiblingVersionInstalledInEnvironment = useCallback(
    (entry: ModLibraryEntry, environment: Environment) => {
      const containingGroup = getContainingDownloadedGroup(entry);
      if (!containingGroup) {
        return false;
      }

      const environmentRuntime = getEffectiveEnvironmentRuntime(environment);
      const targetStorageIds = new Set(getEntryStorageIds(entry));
      return containingGroup.entries.some((candidate) => {
        const candidateStorageIds = getEntryStorageIds(candidate);
        if (
          candidateStorageIds.some((storageId) =>
            targetStorageIds.has(storageId),
          )
        ) {
          return false;
        }
        const siblingInstalledIds =
          candidate.installedInByRuntime?.[environmentRuntime] ||
          candidate.installedIn ||
          [];
        return siblingInstalledIds.includes(environment.id);
      });
    },
    [getContainingDownloadedGroup, getEntryStorageIds],
  );

  const summarizeCompatibleInstallTargets = useCallback(
    (
      entry: ModLibraryEntry,
      installMoreOnly: boolean,
      availableEnvironments: Environment[],
    ) => {
      const installEntry = getInstallableEntry(entry);
      const runtimeIncompatible: Environment[] = [];
      const blockedBySiblingVersion: Environment[] = [];
      const alreadyInstalled: Environment[] = [];
      const installable: Environment[] = [];

      availableEnvironments.forEach((environment) => {
        const environmentRuntime = getEffectiveEnvironmentRuntime(environment);
        if (!entrySupportsRuntime(installEntry, environmentRuntime)) {
          runtimeIncompatible.push(environment);
          return;
        }

        if (
          hasSiblingVersionInstalledInEnvironment(installEntry, environment)
        ) {
          blockedBySiblingVersion.push(environment);
          return;
        }

        const installedIds =
          installEntry.installedInByRuntime?.[environmentRuntime] ||
          installEntry.installedIn ||
          [];
        if (installedIds.includes(environment.id)) {
          alreadyInstalled.push(environment);
          return;
        }

        installable.push(environment);
      });

      const compatible = installMoreOnly
        ? installable
        : [...alreadyInstalled, ...installable];

      const excluded = runtimeIncompatible;

      return {
        installEntry,
        runtimeIncompatible,
        blockedBySiblingVersion,
        alreadyInstalled,
        installable,
        compatible,
        excluded,
      };
    },
    [
      entrySupportsRuntime,
      getInstallableEntry,
      hasSiblingVersionInstalledInEnvironment,
    ],
  );

  const getCompatibleInstallSummary = useCallback(
    (entry: ModLibraryEntry, installMoreOnly: boolean) =>
      summarizeCompatibleInstallTargets(entry, installMoreOnly, environments),
    [environments, summarizeCompatibleInstallTargets],
  );

  const closeInstallDialog = useCallback(() => {
    if (installingTargets) return;
    setInstallDialog({
      isOpen: false,
      title: "",
      entries: [],
      compatibleEnvironments: [],
      excludedEnvironments: [],
      lockedEnvironmentIds: [],
      mode: "select",
      note: undefined,
    });
    setSelectedInstallEnvironmentIds(new Set());
  }, [installingTargets]);

  const installEntryToEnvironmentIds = useCallback(
    async (
      entry: ModLibraryEntry,
      environmentIds: string[],
    ): Promise<InstallExecutionResult> => {
      const selectedTargets = environments.filter((environment) =>
        environmentIds.includes(environment.id),
      );
      const runtimeGroups = new Map<"IL2CPP" | "Mono", string[]>();
      const warningMessages: string[] = [];
      const installedEnvironmentNames: string[] = [];
      const runtimeIncompatibleEnvironmentNames: string[] = [];
      const blockedBySiblingEnvironmentNames: string[] = [];
      const alreadyInstalledEnvironmentNames: string[] = [];

      logger.debug("Mod library install requested", {
        displayName: entry.displayName,
        storageId: entry.storageId,
        requestedEnvironmentIds: environmentIds,
        entryAvailableRuntimes: entry.availableRuntimes,
        entryStorageIdsByRuntime: entry.storageIdsByRuntime,
        entryInstalledInByRuntime: entry.installedInByRuntime,
        selectedTargets: selectedTargets.map((environment) => ({
          id: environment.id,
          name: environment.name,
          branch: environment.branch,
          runtime: getEffectiveEnvironmentRuntime(environment),
        })),
      });

      for (const environment of selectedTargets) {
        const environmentRuntime = getEffectiveEnvironmentRuntime(environment);
        if (!entrySupportsRuntime(entry, environmentRuntime)) {
          logger.debug("Skipping install target due to runtime mismatch", {
            displayName: entry.displayName,
            storageId: entry.storageId,
            environmentId: environment.id,
            environmentName: environment.name,
            environmentRuntime,
            entryAvailableRuntimes: entry.availableRuntimes,
            entryStorageIdsByRuntime: entry.storageIdsByRuntime,
          });
          runtimeIncompatibleEnvironmentNames.push(environment.name);
          continue;
        }
        if (hasSiblingVersionInstalledInEnvironment(entry, environment)) {
          logger.debug(
            "Skipping install target because sibling version is already installed",
            {
              displayName: entry.displayName,
              storageId: entry.storageId,
              environmentId: environment.id,
              environmentName: environment.name,
              environmentRuntime,
            },
          );
          blockedBySiblingEnvironmentNames.push(environment.name);
          continue;
        }
        const existing = runtimeGroups.get(environmentRuntime) || [];
        const installedIds =
          entry.installedInByRuntime?.[environmentRuntime] ||
          entry.installedIn ||
          [];
        if (installedIds.includes(environment.id)) {
          alreadyInstalledEnvironmentNames.push(environment.name);
          continue;
        }
        existing.push(environment.id);
        runtimeGroups.set(environmentRuntime, existing);
      }

      logger.debug("Resolved runtime groups for install", {
        displayName: entry.displayName,
        storageId: entry.storageId,
        runtimeGroups: Array.from(runtimeGroups.entries()).map(
          ([runtime, targetIds]) => ({
            runtime,
            targetIds,
            storageId:
              entry.storageIdsByRuntime?.[runtime] || entry.storageId || null,
          }),
        ),
      });

      for (const [runtime, targetIds] of runtimeGroups.entries()) {
        const storageId =
          entry.storageIdsByRuntime?.[runtime] || entry.storageId;
        if (!storageId || targetIds.length === 0) {
          logger.debug(
            "Skipping runtime install because storage mapping is missing or empty",
            {
              displayName: entry.displayName,
              requestedRuntime: runtime,
              resolvedStorageId: storageId || null,
              targetIds,
              entryStorageIdsByRuntime: entry.storageIdsByRuntime,
            },
          );
          continue;
        }
        const installResult = await ApiService.installDownloadedMod(
          storageId,
          targetIds,
        );
        logger.debug("Completed runtime install for library entry", {
          displayName: entry.displayName,
          requestedRuntime: runtime,
          storageId,
          targetIds,
          installResult,
        });
        installedEnvironmentNames.push(
          ...selectedTargets
            .filter((environment) => targetIds.includes(environment.id))
            .map((environment) => environment.name),
        );
        warningMessages.push(
          ...installResult.results.flatMap((result) => result.warnings || []),
        );
      }

      if (warningMessages.length > 0) {
        showToast(
          warningMessages.length === 1
            ? warningMessages[0]
            : `${warningMessages[0]} (+${warningMessages.length - 1} more warning${warningMessages.length > 2 ? "s" : ""})`,
        );
      }

      const uniqueInstalledEnvironmentNames = Array.from(
        new Set(installedEnvironmentNames),
      );
      if (uniqueInstalledEnvironmentNames.length > 0) {
        return {
          status: "installed",
          installedEnvironmentNames: uniqueInstalledEnvironmentNames,
        };
      }

      if (runtimeIncompatibleEnvironmentNames.length > 0) {
        return {
          status: "no-op",
          installedEnvironmentNames: [],
          reason: "runtime-incompatible",
        };
      }

      if (blockedBySiblingEnvironmentNames.length > 0) {
        return {
          status: "no-op",
          installedEnvironmentNames: [],
          reason: "blocked-by-sibling-version",
        };
      }

      if (alreadyInstalledEnvironmentNames.length > 0) {
        return {
          status: "no-op",
          installedEnvironmentNames: [],
          reason: "already-installed",
        };
      }

      return {
        status: "no-op",
        installedEnvironmentNames: [],
        reason: "no-targets",
      };
    },
    [
      entrySupportsRuntime,
      environments,
      hasSiblingVersionInstalledInEnvironment,
      showToast,
    ],
  );

  const showInstallSuccessNotice = useCallback(
    (installedEnvironmentNames: string[]) => {
      const uniqueNames = Array.from(
        new Set(installedEnvironmentNames.filter(Boolean)),
      );
      if (uniqueNames.length === 0) {
        return;
      }
      showLibraryNotice(
        "Installed",
        `Installed to ${uniqueNames.join(", ")}. It may take a couple seconds before it shows in Mods.`,
      );
    },
    [showLibraryNotice],
  );

  const buildInstallNoOpNotice = useCallback(
    (
      summary: ReturnType<typeof getCompatibleInstallSummary>,
      installMoreOnly: boolean,
    ) => {
      if (
        summary.runtimeIncompatible.length > 0 &&
        summary.installable.length === 0
      ) {
        return {
          title: "No Compatible Environments",
          message:
            summary.blockedBySiblingVersion.length > 0
              ? `This version does not support the selected runtime for ${summary.runtimeIncompatible.length} environment${summary.runtimeIncompatible.length === 1 ? "" : "s"}, and another version of this mod is already installed in ${summary.blockedBySiblingVersion.length} compatible environment${summary.blockedBySiblingVersion.length === 1 ? "" : "s"}.`
              : `This version does not support the selected runtime for ${summary.runtimeIncompatible.length} environment${summary.runtimeIncompatible.length === 1 ? "" : "s"}.`,
        };
      }

      if (
        summary.blockedBySiblingVersion.length > 0 &&
        summary.installable.length === 0
      ) {
        return {
          title: "Already Installed Elsewhere",
          message: `Another version of this mod is already installed in ${summary.blockedBySiblingVersion.length} compatible environment${summary.blockedBySiblingVersion.length === 1 ? "" : "s"}. Remove the other version first to install this one.`,
        };
      }

      if (
        installMoreOnly &&
        summary.alreadyInstalled.length > 0 &&
        summary.installable.length === 0
      ) {
        return {
          title: "Already Installed",
          message: `This version is already installed in every compatible environment (${summary.alreadyInstalled.length}).`,
        };
      }

      return {
        title: "No Install Targets",
        message: "No installable environments remain for this mod version.",
      };
    },
    [],
  );

  const formatDownloadBatchNote = useCallback(
    (entries: ModLibraryEntry[], failures: DownloadBatchFailure[]) => {
      const entryCount = entries.length;
      const failureCount = failures.length;
      const intro =
        entryCount === 1
          ? "Choose where to install this downloaded mod."
          : "Choose where to install the downloaded files. SIMM will route each one to environments that support its runtime.";

      if (failureCount === 0) {
        return intro;
      }

      const failureSummary =
        failureCount === 1
          ? `1 download failed: ${failures[0].label} (${failures[0].message})`
          : `${failureCount} downloads failed. ${failures[0].label} (${failures[0].message})`;

      return `${intro} ${failureSummary}`;
    },
    [],
  );

  const resolveDownloadedEntriesByStorageIds = useCallback(
    (entries: ModLibraryEntry[], storageIds: string[]) => {
      const targetIds = new Set(storageIds.filter(Boolean));
      const matches: ModLibraryEntry[] = [];

      for (const entry of entries) {
        const entryStorageIds = getEntryStorageIds(entry);
        if (entryStorageIds.some((storageId) => targetIds.has(storageId))) {
          matches.push(entry);
        }
      }

      return matches;
    },
    [getEntryStorageIds],
  );

  const promptDownloadedInstallTargets = useCallback(
    async (
      entries: ModLibraryEntry[],
      title: string,
      failures: DownloadBatchFailure[] = [],
      environmentOverride?: Environment[],
    ) => {
      const availableEnvironments =
        environmentOverride && environmentOverride.length > 0
          ? environmentOverride
          : await ensureEnvironments().catch((error) => {
              console.warn(
                "Failed to load environments for post-download install prompt:",
                error,
              );
              return [];
            });

      const installEntries = entries
        .map((entry) => getInstallableEntry(entry))
        .filter(
          (entry, index, all) =>
            all.findIndex(
              (candidate) => candidate.storageId === entry.storageId,
            ) === index,
        );

      if (installEntries.length === 0) {
        if (failures.length > 0) {
          showLibraryNotice(
            "Download Failed",
            failures
              .map((failure) => `${failure.label}: ${failure.message}`)
              .join("\n"),
          );
        }
        return;
      }

      const installableEnvironmentIds = new Set<string>();
      const excludedEnvironmentIds = new Set(
        availableEnvironments.map((environment) => environment.id),
      );

      for (const entry of installEntries) {
        const summary = summarizeCompatibleInstallTargets(
          entry,
          false,
          availableEnvironments,
        );
        for (const environment of summary.installable) {
          installableEnvironmentIds.add(environment.id);
          excludedEnvironmentIds.delete(environment.id);
        }
      }

      const compatibleEnvironments = availableEnvironments.filter(
        (environment) => installableEnvironmentIds.has(environment.id),
      );
      const excludedEnvironments = availableEnvironments.filter((environment) =>
        excludedEnvironmentIds.has(environment.id),
      );

      if (compatibleEnvironments.length === 0) {
        showLibraryNotice(
          "No Install Targets",
          failures.length > 0
            ? `${failures
                .map((failure) => `${failure.label}: ${failure.message}`)
                .join(
                  "\n",
                )}\n\nNo compatible environments are available for the downloaded files.`
            : "No compatible environments are available for the downloaded files.",
        );
        return;
      }

      setSelectedInstallEnvironmentIds(new Set());
      setInstallDialog({
        isOpen: true,
        title,
        entries: installEntries,
        compatibleEnvironments,
        excludedEnvironments,
        lockedEnvironmentIds: [],
        mode: "select",
        note: formatDownloadBatchNote(installEntries, failures),
      });
    },
    [
      ensureEnvironments,
      formatDownloadBatchNote,
      getInstallableEntry,
      showLibraryNotice,
      summarizeCompatibleInstallTargets,
    ],
  );

  const finalizeLibraryDownloadBatch = useCallback(
    async (
      results: SuccessfulLibraryDownload[],
      title: string,
      failures: DownloadBatchFailure[] = [],
      resolveFallbackEntries?: (library: ModLibraryResult) => ModLibraryEntry[],
    ) => {
      const nextLibrary = await loadLibrarySnapshot();
      notifyLibraryUpdated();
      const availableEnvironments = await ensureEnvironments().catch(
        (error) => {
          console.warn(
            "Failed to load environments for post-download install prompt:",
            error,
          );
          return [];
        },
      );

      const matchedEntries = resolveDownloadedEntriesByStorageIds(
        nextLibrary.downloaded || [],
        results
          .map((result) => result.storageId)
          .filter((storageId): storageId is string => Boolean(storageId)),
      );
      const fallbackEntries = resolveFallbackEntries?.(nextLibrary) || [];
      const optimisticEntries = results
        .map((result) => result.promptEntry)
        .filter((entry): entry is ModLibraryEntry => Boolean(entry?.storageId))
        .filter(
          (entry, index, all) =>
            all.findIndex(
              (candidate) => candidate.storageId === entry.storageId,
            ) === index,
        );
      const resolvedEntries =
        matchedEntries.length > 0
          ? matchedEntries
          : fallbackEntries.length > 0
            ? fallbackEntries
            : optimisticEntries;

      await promptDownloadedInstallTargets(
        resolvedEntries,
        title,
        failures,
        availableEnvironments,
      );
    },
    [
      ensureEnvironments,
      loadLibrarySnapshot,
      notifyLibraryUpdated,
      promptDownloadedInstallTargets,
      resolveDownloadedEntriesByStorageIds,
    ],
  );

  const promptInstallTargets = useCallback(
    async (entry: ModLibraryEntry, title: string, installMoreOnly: boolean) => {
      const {
        installEntry,
        runtimeIncompatible,
        blockedBySiblingVersion,
        alreadyInstalled,
        installable,
        compatible,
        excluded,
      } = getCompatibleInstallSummary(entry, installMoreOnly);

      if (installable.length === 0) {
        if (installMoreOnly && alreadyInstalled.length > 0) {
          const lockedEnvironmentIds = alreadyInstalled.map(
            (environment) => environment.id,
          );
          setSelectedInstallEnvironmentIds(new Set(lockedEnvironmentIds));
          setInstallDialog({
            isOpen: true,
            title,
            entries: [installEntry],
            compatibleEnvironments: alreadyInstalled,
            excludedEnvironments: excluded,
            lockedEnvironmentIds,
            mode: "installed",
            note: undefined,
          });
          return;
        }

        const noOpNotice = buildInstallNoOpNotice(
          {
            installEntry,
            runtimeIncompatible,
            blockedBySiblingVersion,
            alreadyInstalled,
            installable,
            compatible,
            excluded,
          },
          installMoreOnly,
        );
        showLibraryNotice(noOpNotice.title, noOpNotice.message);
        return;
      }

      if (installable.length === 1) {
        setInstallingTargets(true);
        try {
          const result = await installEntryToEnvironmentIds(installEntry, [
            installable[0].id,
          ]);
          if (result.status === "installed") {
            showInstallSuccessNotice(result.installedEnvironmentNames);
          } else {
            const noOpNotice = buildInstallNoOpNotice(
              {
                installEntry,
                runtimeIncompatible,
                blockedBySiblingVersion,
                alreadyInstalled,
                installable,
                compatible,
                excluded,
              },
              installMoreOnly,
            );
            showLibraryNotice(noOpNotice.title, noOpNotice.message);
          }
          await refreshLibrary();
          notifyLibraryUpdated();
          notifyModUpdateStateChanged();
        } catch (error) {
          showLibraryNotice(
            "Install Failed",
            getErrorMessage(error, "Failed to install this mod."),
          );
        } finally {
          setInstallingTargets(false);
        }
        return;
      }

      setSelectedInstallEnvironmentIds(new Set());
      setInstallDialog({
        isOpen: true,
        title,
        entries: [installEntry],
        compatibleEnvironments: installable,
        excludedEnvironments: excluded,
        lockedEnvironmentIds: [],
        mode: "select",
        note: undefined,
      });
    },
    [
      buildInstallNoOpNotice,
      getCompatibleInstallSummary,
      installEntryToEnvironmentIds,
      notifyLibraryUpdated,
      notifyModUpdateStateChanged,
      refreshLibrary,
      showInstallSuccessNotice,
      showLibraryNotice,
    ],
  );

  const handleConfirmInstallTargets = useCallback(async () => {
    if (
      installDialog.entries.length === 0 ||
      selectedInstallEnvironmentIds.size === 0
    ) {
      return;
    }

    const operationId = ++installOperationRef.current;
    const targetEnvironmentIds = Array.from(selectedInstallEnvironmentIds);
    const entries = installDialog.entries;
    const mode = installDialog.mode;
    setInstallingTargets(true);
    try {
      const results = await Promise.all(
        entries.map((entry) =>
          installEntryToEnvironmentIds(entry, targetEnvironmentIds),
        ),
      );
      if (operationId !== installOperationRef.current) return;
      closeInstallDialog();
      const installedEnvironmentNames = Array.from(
        new Set(results.flatMap((result) => result.installedEnvironmentNames)),
      );

      if (installedEnvironmentNames.length > 0) {
        showInstallSuccessNotice(installedEnvironmentNames);
      } else {
        const noOpNotice = buildInstallNoOpNotice(
          getCompatibleInstallSummary(
            entries[0],
            mode === "installed",
          ),
          mode === "installed",
        );
        showLibraryNotice(noOpNotice.title, noOpNotice.message);
      }
      await refreshLibrary();
      notifyLibraryUpdated();
      notifyModUpdateStateChanged();
    } catch (error) {
      showLibraryNotice(
        "Install Failed",
        getErrorMessage(error, "Failed to install the selected environments."),
      );
    } finally {
      if (operationId === installOperationRef.current) {
        setInstallingTargets(false);
      }
    }
  }, [
    closeInstallDialog,
    buildInstallNoOpNotice,
    getCompatibleInstallSummary,
    installDialog.entries,
    installDialog.mode,
    installEntryToEnvironmentIds,
    notifyLibraryUpdated,
    notifyModUpdateStateChanged,
    refreshLibrary,
    selectedInstallEnvironmentIds,
    showInstallSuccessNotice,
    showLibraryNotice,
  ]);
  const handleDownloadFeaturedGithubRelease = useCallback(
    async (
      featured: (typeof FEATURED_DOWNLOADS)[keyof typeof FEATURED_DOWNLOADS],
      latestRelease: FeaturedGithubRelease | null,
      downloader: typeof ApiService.downloadS1APIToLibrary,
    ) => {
      if (!latestRelease?.tag_name) {
        logger.warn("Featured GitHub release is unavailable for download", {
          displayName: featured.displayName,
          sourceId: featured.sourceId,
        });
        showLibraryNotice(
          `${featured.displayName} Unavailable`,
          `The latest ${featured.displayName} release could not be resolved. Try refreshing and retry the download.`,
        );
        return;
      }

      logger.info("Starting featured GitHub download", {
        displayName: featured.displayName,
        sourceId: featured.sourceId,
        versionTag: latestRelease.tag_name,
      });

      setDownloading(featured.key);
      try {
        const result = await downloadGithubReleaseWithSecurity(
          downloader,
          latestRelease.tag_name,
          `Security Findings - ${featured.displayName}`,
        );
        if (!result) {
          logger.warn("Featured GitHub download ended without storing a library entry", {
            displayName: featured.displayName,
            sourceId: featured.sourceId,
            versionTag: latestRelease.tag_name,
          });
          return;
        }

        logger.info("Stored featured GitHub download in library", {
          displayName: featured.displayName,
          sourceId: featured.sourceId,
          versionTag: latestRelease.tag_name,
          storageId: result.storageId,
          alreadyStored: result.alreadyStored ?? false,
        });

        await finalizeLibraryDownloadBatch(
          [
            {
              ...result,
              promptEntry: result.storageId
                ? buildOptimisticDownloadedEntry({
                    storageId: result.storageId,
                    displayName: featured.displayName,
                    runtime:
                      featured.sourceId.toLowerCase() === "ifbars/mlvscan"
                        ? "IL2CPP"
                        : "Mono",
                    source: "github",
                    sourceId: featured.sourceId,
                    version: latestRelease.tag_name,
                    summary: latestRelease.body,
                    sourceUrl: featured.packageUrl,
                    author: featured.author,
                    updatedAt: latestRelease.published_at,
                  })
                : undefined,
            },
          ],
          "Install Downloaded Mod",
        );
      } catch (err) {
        logger.error(`Failed to download ${featured.displayName}`, {
          sourceId: featured.sourceId,
          versionTag: latestRelease.tag_name,
          error: err instanceof Error ? err.message : String(err),
        });
        showLibraryNotice(
          `${featured.displayName} Download Failed`,
          err instanceof Error
            ? err.message
            : `Failed to download ${featured.displayName}.`,
        );
      } finally {
        setDownloading(null);
      }
    },
    [
      downloadGithubReleaseWithSecurity,
      finalizeLibraryDownloadBatch,
      showLibraryNotice,
    ],
  );

  const handleDownloadS1APIClick = () => {
    void handleDownloadFeaturedGithubRelease(
      FEATURED_DOWNLOADS.s1api,
      s1apiFeaturedRelease,
      ApiService.downloadS1APIToLibrary,
    );
  };

  const handleDownloadMlvscanClick = () => {
    void handleDownloadFeaturedGithubRelease(
      FEATURED_DOWNLOADS.mlvscan,
      mlvscanFeaturedRelease,
      ApiService.downloadMLVScanToLibrary,
    );
  };

  const handleDownloadFeaturedThunderstoreClick = (
    featured:
      (typeof FEATURED_THUNDERSTORE_DOWNLOADS)[keyof typeof FEATURED_THUNDERSTORE_DOWNLOADS],
    pkg: ThunderstorePackageGroup | null,
  ) => {
    if (!pkg) {
      showLibraryNotice(
        `${featured.displayName} Unavailable`,
        `The featured ${featured.displayName} package could not be resolved from Thunderstore. Try refreshing and retry the download.`,
      );
      return;
    }

    void handleDownloadThunderstore(pkg);
  };

  const handleDownloadMeshVaultClick = () => {
    handleDownloadFeaturedThunderstoreClick(
      FEATURED_THUNDERSTORE_DOWNLOADS.meshvault,
      meshVaultFeaturedPackage,
    );
  };

  const handleDownloadS1MapiClick = () => {
    handleDownloadFeaturedThunderstoreClick(
      FEATURED_THUNDERSTORE_DOWNLOADS.s1mapi,
      s1mapiFeaturedPackage,
    );
  };

  const handleDownloadSteamNetworkLibClick = () => {
    handleDownloadFeaturedThunderstoreClick(
      FEATURED_THUNDERSTORE_DOWNLOADS.steamnetworklib,
      steamNetworkLibFeaturedPackage,
    );
  };

  const storeLocalArchiveWithSecurity = useCallback(
    async (
      item: SelectedLibraryImportItem,
      runtime?: "IL2CPP" | "Mono",
      securityOverride?: boolean,
    ): Promise<SuccessfulLibraryDownload | null> => {
      const result = await ApiService.storeModArchive(
        item.filePath,
        item.fileName,
        runtime,
        {
          source: "local",
          modName: stripFileExtension(item.fileName),
        },
        undefined,
        false,
        securityOverride,
      );

      if (!result.success) {
        const gateResolution = await handleSecurityGateResult(
          `Security Findings - ${item.fileName}`,
          result,
          async () => {
            const retry = await ApiService.storeModArchive(
              item.filePath,
              item.fileName,
              runtime,
              {
                source: "local",
                modName: stripFileExtension(item.fileName),
              },
              undefined,
              false,
              true,
            );

            if (!retry.success) {
              throw new Error(
                retry.error ||
                  "Failed to continue the import after confirming the MLVScan findings.",
              );
            }

            return retry;
          },
        );

        if (gateResolution.status === "abort") {
          return null;
        }
        if (gateResolution.status === "confirmed") {
          return {
            ...gateResolution.value,
            promptEntry:
              gateResolution.value.storageId && runtime
                ? buildOptimisticDownloadedEntry({
                    storageId: gateResolution.value.storageId,
                    displayName: stripFileExtension(item.fileName),
                    runtime,
                    source: "local",
                  })
                : undefined,
          };
        }

        throw new Error(result.error || "Failed to add this file to the library.");
      }

      return {
        ...result,
        promptEntry:
          result.storageId && runtime
            ? buildOptimisticDownloadedEntry({
                storageId: result.storageId,
                displayName: stripFileExtension(item.fileName),
                runtime,
                source: "local",
              })
            : undefined,
      };
    },
    [handleSecurityGateResult],
  );

  const requestLibraryImportRuntime = useCallback(
    (fileName: string) =>
      new Promise<"IL2CPP" | "Mono" | undefined>((resolve) => {
        setRuntimePrompt({
          title: "Select Mod Runtime",
          message: `SIMM could not determine the runtime for ${fileName}. Choose a runtime before adding it to the library.`,
          onSelect: (runtime) => {
            resolve(runtime === "Both" ? undefined : runtime);
          },
          onDismiss: () => resolve(undefined),
        });
      }),
    [],
  );

  const handleAddFilesClick = useCallback(async () => {
    setDownloading("library-import");
    try {
      const selected = (await open({
        multiple: true,
        filters: [
          {
            name: "Mod Files",
            extensions: ["dll", "zip", "rar", "7z", "tar.gz", "tgz"],
          },
        ],
        title: "Select Mod Files",
      })) as
        | string
        | { path: string; name?: string }
        | Array<string | { path: string; name?: string }>
        | null;

      const items = normalizeSelectedLibraryImportItems(selected);
      if (items.length === 0) {
        return;
      }

      const results: SuccessfulLibraryDownload[] = [];
      const failures: DownloadBatchFailure[] = [];

      for (const item of items) {
        try {
          let runtime: "IL2CPP" | "Mono" | undefined =
            detectRuntimeFromFileName(item.fileName) ?? undefined;
          if (!runtime && item.fileName.toLowerCase().endsWith(".dll")) {
            runtime = await requestLibraryImportRuntime(item.fileName);
            if (!runtime) {
              failures.push({
                label: item.fileName,
                message: "Runtime selection canceled.",
              });
              continue;
            }
          }

          const result = await storeLocalArchiveWithSecurity(item, runtime);
          if (result) {
            results.push(result);
          }
        } catch (error) {
          failures.push({
            label: item.fileName,
            message:
              error instanceof Error
                ? error.message
                : "Failed to add this file to the library.",
          });
        }
      }

      if (results.length > 0) {
        await finalizeLibraryDownloadBatch(
          results,
          "Install Downloaded Mod",
          failures,
        );
        return;
      }

      if (failures.length > 0) {
        showLibraryNotice(
          "Library Import Failed",
          failures
            .map((failure) => `${failure.label}: ${failure.message}`)
            .join(" "),
        );
      }
    } catch (error) {
      showLibraryNotice(
        "Library Import Failed",
        error instanceof Error
          ? error.message
          : "Failed to open the file picker.",
      );
    } finally {
      setDownloading(null);
    }
  }, [
    finalizeLibraryDownloadBatch,
    requestLibraryImportRuntime,
    showLibraryNotice,
    storeLocalArchiveWithSecurity,
  ]);

  const handleDeleteDownloadedGroup = useCallback(async (group: DownloadedModGroup) => {
    const installedEnvironmentIds = Array.from(new Set(group.installedIn));
    const installedEnvironmentNames = installedEnvironmentIds.map((envId) => {
      return (
        environments.find((environment) => environment.id === envId)?.name ||
        envId
      );
    });
    const installedSummary =
      installedEnvironmentNames.length > 0
        ? installedEnvironmentNames.length <= 3
          ? installedEnvironmentNames.join(", ")
          : `${installedEnvironmentNames.slice(0, 3).join(", ")} and ${installedEnvironmentNames.length - 3} more`
        : "";

    setConfirmOverlay({
      isOpen: true,
      title:
        installedEnvironmentIds.length > 0
          ? "Uninstall and Delete?"
          : "Delete Downloaded Files",
      message:
        installedEnvironmentIds.length > 0
          ? `This library copy is installed in ${installedEnvironmentIds.length} environment${installedEnvironmentIds.length === 1 ? "" : "s"}${installedSummary ? `: ${installedSummary}` : ""}. Delete will uninstall it from those environments and remove the downloaded files from the library. Continue?`
        : "Delete the downloaded files from the library? This cannot be undone.",
      confirmText:
        installedEnvironmentIds.length > 0
          ? "Uninstall and Delete"
          : "Delete Files",
      onConfirm: async () => {
        setConfirmOverlay({
          isOpen: false,
          title: "",
          message: "",
          onConfirm: () => {},
        });
        setDeleting(group.key);
        try {
          for (const entry of group.entries) {
            const storageIds = getEntryStorageIds(entry);
            for (const storageId of storageIds) {
              await ApiService.deleteDownloadedMod(storageId);
            }
          }
          await refreshLibrary();
          setSelectedModIds((prev) => {
            const next = new Set(prev);
            group.storageIds.forEach((id) => next.delete(id));
            return next;
          });
        } catch (err) {
          console.error("Failed to delete downloaded mod files:", err);
          showLibraryNotice(
            "Delete Failed",
            err instanceof Error
              ? err.message
              : "Failed to delete downloaded mod files.",
          );
        } finally {
          setDeleting(null);
        }
      },
    });
  }, [environments, getEntryStorageIds, refreshLibrary, showLibraryNotice]);
  const handleDownloadThunderstore = async (
    pkg: ThunderstorePackageGroup,
    selectedVersionOption?: ThunderstoreVersionOption | null,
  ) => {
    const resolvedVersionOption =
      selectedVersionOption || buildThunderstoreVersionOptions(pkg)[0] || null;
    const hasIl2cpp = Boolean(resolvedVersionOption?.versionsByRuntime.IL2CPP);
    const hasMono = Boolean(resolvedVersionOption?.versionsByRuntime.Mono);
    const runDownload = async (
      runtime: "IL2CPP" | "Mono" | "Both",
      skipDependencyWarning = false,
    ) => {
      const missingDependencies = getMissingThunderstoreDependencies(
        getThunderstoreDependenciesForRuntime(resolvedVersionOption, runtime),
        downloadedGroups,
      );
      if (!skipDependencyWarning && missingDependencies.length > 0) {
        showLibraryNotice(
          "Required Dependencies Missing",
          `${pkg.name} requires the following Thunderstore package${missingDependencies.length === 1 ? "" : "s"} before it can work correctly:\n\n${missingDependencies
            .map(
              (dependency) =>
                `• ${dependency.packageKey}${dependency.minimumVersion ? ` ${formatVersionTag(dependency.minimumVersion)} or newer` : ""}`,
            )
            .join("\n")}\n\nMelonLoader is managed separately. You can still add this mod to your library now.`,
          {
            label: "Download anyway",
            cancelText: "Cancel",
            onAction: () => {
              void runDownload(runtime, true);
            },
          },
        );
        return;
      }

      setDownloading(pkg.key);
      try {
        const results: SuccessfulLibraryDownload[] = [];
        const failures: DownloadBatchFailure[] = [];
        if (runtime === "Both") {
          const il2cppVersion = resolvedVersionOption?.versionsByRuntime.IL2CPP;
          if (pkg.packagesByRuntime.IL2CPP && il2cppVersion) {
            try {
              const result = await downloadThunderstoreWithSecurity(
                pkg.packagesByRuntime.IL2CPP.uuid4,
                "IL2CPP",
                il2cppVersion.uuid4,
                `Security Findings - ${pkg.name}`,
              );
              if (result) {
                results.push({
                  ...result,
                  promptEntry: result.storageId
                    ? buildOptimisticDownloadedEntry({
                        storageId: result.storageId,
                        displayName: pkg.name,
                        runtime: "IL2CPP",
                        source: "thunderstore",
                        sourceId: pkg.key,
                        version: il2cppVersion.version_number,
                        summary:
                          il2cppVersion.description ||
                          resolvedVersionOption?.description,
                        iconUrl:
                          il2cppVersion.icon ||
                          pkg.packagesByRuntime.IL2CPP.icon ||
                          undefined,
                        sourceUrl: pkg.packageUrl,
                        author: pkg.owner,
                        downloads: il2cppVersion.downloads,
                        updatedAt: il2cppVersion.date_updated,
                      })
                    : undefined,
                });
              }
            } catch (error) {
              failures.push({
                label: `${pkg.name} IL2CPP`,
                message:
                  error instanceof Error
                    ? error.message
                    : "Failed to download this Thunderstore mod.",
              });
            }
          }
          const monoVersion = resolvedVersionOption?.versionsByRuntime.Mono;
          if (pkg.packagesByRuntime.Mono && monoVersion) {
            try {
              const result = await downloadThunderstoreWithSecurity(
                pkg.packagesByRuntime.Mono.uuid4,
                "Mono",
                monoVersion.uuid4,
                `Security Findings - ${pkg.name}`,
              );
              if (result) {
                results.push({
                  ...result,
                  promptEntry: result.storageId
                    ? buildOptimisticDownloadedEntry({
                        storageId: result.storageId,
                        displayName: pkg.name,
                        runtime: "Mono",
                        source: "thunderstore",
                        sourceId: pkg.key,
                        version: monoVersion.version_number,
                        summary:
                          monoVersion.description ||
                          resolvedVersionOption?.description,
                        iconUrl:
                          monoVersion.icon ||
                          pkg.packagesByRuntime.Mono.icon ||
                          undefined,
                        sourceUrl: pkg.packageUrl,
                        author: pkg.owner,
                        downloads: monoVersion.downloads,
                        updatedAt: monoVersion.date_updated,
                      })
                    : undefined,
                });
              }
            } catch (error) {
              failures.push({
                label: `${pkg.name} Mono`,
                message:
                  error instanceof Error
                    ? error.message
                    : "Failed to download this Thunderstore mod.",
              });
            }
          }
        } else if (
          pkg.packagesByRuntime[runtime] &&
          resolvedVersionOption?.versionsByRuntime[runtime]
        ) {
          try {
            const result = await downloadThunderstoreWithSecurity(
              pkg.packagesByRuntime[runtime]!.uuid4,
              runtime,
              resolvedVersionOption.versionsByRuntime[runtime]!.uuid4,
              `Security Findings - ${pkg.name}`,
            );
            if (result) {
              results.push({
                ...result,
                promptEntry: result.storageId
                  ? buildOptimisticDownloadedEntry({
                      storageId: result.storageId,
                      displayName: pkg.name,
                      runtime,
                      source: "thunderstore",
                      sourceId: pkg.key,
                      version:
                        resolvedVersionOption.versionsByRuntime[runtime]
                          ?.version_number,
                      summary:
                        resolvedVersionOption.versionsByRuntime[runtime]
                          ?.description || resolvedVersionOption.description,
                      iconUrl:
                        resolvedVersionOption.versionsByRuntime[runtime]?.icon ||
                        pkg.packagesByRuntime[runtime]?.icon ||
                        undefined,
                      sourceUrl: pkg.packageUrl,
                      author: pkg.owner,
                      downloads:
                        resolvedVersionOption.versionsByRuntime[runtime]
                          ?.downloads,
                      updatedAt:
                        resolvedVersionOption.versionsByRuntime[runtime]
                          ?.date_updated,
                    })
                  : undefined,
              });
            }
          } catch (error) {
            failures.push({
              label: `${pkg.name} ${runtime}`,
              message:
                error instanceof Error
                  ? error.message
                  : "Failed to download this Thunderstore mod.",
            });
          }
        }

        if (results.length === 0) {
          if (failures.length > 0) {
            showLibraryNotice(
              "Thunderstore Download Failed",
              failures
                .map((failure) => `${failure.label}: ${failure.message}`)
                .join("\n"),
            );
            return;
          }

          showLibraryNotice(
            "Download Cancelled",
            `No ${pkg.name} files were added to your mod library.`,
          );
          return;
        }

        await finalizeLibraryDownloadBatch(
          results,
          `Install ${pkg.name}`,
          failures,
          (nextLibrary) => {
            const refreshedGroup = findDownloadedGroupForThunderstorePackage(
              pkg,
              nextLibrary,
            );
            if (!refreshedGroup) {
              return [];
            }

            return refreshedGroup.entries.filter((entry) =>
              areVersionsEquivalent(
                getEntryVersionLabel(entry),
                resolvedVersionOption?.versionNumber,
              ),
            );
          },
        );
      } catch (err) {
        console.error("Failed to download Thunderstore mod:", err);
        showLibraryNotice(
          "Thunderstore Download Failed",
          err instanceof Error
            ? err.message
            : "Failed to download this Thunderstore mod.",
        );
      } finally {
        setDownloading(null);
      }
    };

    if (!hasIl2cpp && !hasMono) {
      setRuntimePrompt({
        title: "Select Runtime",
        message: `Select the runtime for ${pkg.name} ${formatVersionTag(
          resolvedVersionOption?.versionNumber,
        )}.`,
        onSelect: runDownload,
      });
      return;
    }

    if (hasIl2cpp && hasMono) {
      void runDownload("Both");
      return;
    }

    void runDownload(hasIl2cpp ? "IL2CPP" : "Mono");
  };

  const selectNexusFileForRuntime = (
    files: NexusModFile[],
    runtime: "IL2CPP" | "Mono",
  ) => {
    const runtimeLower = runtime.toLowerCase();
    const otherRuntime = runtimeLower === "il2cpp" ? "mono" : "il2cpp";
    const runtimeFiles = files.filter((f: any) => {
      const fileName = (f.file_name || f.name || "").toLowerCase();
      return fileName.includes(runtimeLower);
    });

    if (runtimeFiles.length > 0) {
      return sortNexusFilesNewestFirst(runtimeFiles)[0];
    }

    const compatibleFiles = files.filter((f: any) => {
      const fileName = (f.file_name || f.name || "").toLowerCase();
      return !fileName.includes(otherRuntime);
    });

    return sortNexusFilesNewestFirst(
      compatibleFiles.length > 0 ? compatibleFiles : files,
    )[0];
  };

  const handleDownloadNexusMod = async (
    modId: number,
    selectedFile?: NexusModFile | null,
    skipDependencyWarning = false,
  ) => {
    const files = nexusModsFiles.get(modId) || [];
    if (files.length === 0) {
      await handleLoadNexusModFiles(modId);
      return;
    }

    if (!skipDependencyWarning && selectedFile?.file_id) {
      const dependencyReport = await loadNexusDependencyReport(
        modId,
        selectedFile.file_id,
      );
      const missingRequirements = dependencyReport
        ? getMissingNexusDependencies(dependencyReport, downloadedGroups)
        : [];
      if (missingRequirements.length > 0) {
        const missingLabels = missingRequirements
          .map(formatNexusDependencyCandidates)
          .filter(Boolean);
        showLibraryNotice(
          "Required Dependencies Missing",
          `SIMM could not find a compatible downloaded version of ${missingLabels.join(", ")}. You can download this file anyway, but it may not work until its required mods are added to your library and installed.`,
          {
            label: "Download anyway",
            cancelText: "Cancel",
            onAction: () => {
              void handleDownloadNexusMod(modId, selectedFile, true);
            },
          },
        );
        return;
      }
    }

    const fileNames = files.map((file) =>
      (file.file_name || file.name || "").toLowerCase(),
    );
    const hasIl2cpp = fileNames.some((name) => name.includes("il2cpp"));
    const hasMono = fileNames.some((name) => name.includes("mono"));
    const fomodInstallerFile =
      sortNexusFilesNewestFirst(
        files.filter((file) => isNexusFomodInstaller(file)),
      )[0] || null;

    const access = await getEffectiveNexusDownloadAccess();
    if (!access.connected) {
      showLibraryNotice(
        "Nexus Login Required",
        "Log into Nexus in Accounts before downloading Nexus mods.",
        onOpenAccounts
          ? {
              label: "Open Accounts",
              onAction: onOpenAccounts,
            }
          : undefined,
      );
      return;
    }

    const isManualNexusDownloadRequiredError = (error: unknown) => {
      const message =
        error instanceof Error ? error.message : String(error ?? "");
      const normalized = message.toLowerCase();
      return (
        normalized.includes("download-link request failed (403)") ||
        normalized.includes("forbidden") ||
        normalized.includes("requires website confirmation") ||
        normalized.includes("confirm downloads") ||
        normalized.includes("confirm the download") ||
        normalized.includes("site confirmation") ||
        normalized.includes("premium")
      );
    };

    const promptManualNexusConfirmation = (
      fileId: number,
      runtime: "IL2CPP" | "Mono" | undefined,
    ) => {
      showLibraryNotice(
        "Nexus Download Failed",
        "This Nexus account must confirm the download on the Nexus Mods website. Press Confirm to open the Files page in your browser, then approve the download there.",
        {
          label: "Confirm",
          cancelText: "Cancel",
          onAction: () => {
            setDownloading(`nexus-${modId}`);
            const manualFile = files.find((file) => file.file_id === fileId);
            void beginManualNexusLibraryDownload(
              modId,
              fileId,
              runtime,
              async () => {
                const nextLibrary = await loadLibrarySnapshot();
                notifyLibraryUpdated();
                const refreshedGroup = findDownloadedGroupForNexusMod(
                  modId,
                  nextLibrary,
                  fileId,
                );
                await promptDownloadedInstallTargets(
                  refreshedGroup?.entries.filter((entry) =>
                    areVersionsEquivalent(
                      getEntryVersionLabel(entry),
                      manualFile?.version || manualFile?.mod_version,
                    ),
                  ) || [],
                  "Install Downloaded Mod",
                );
              },
              "Nexus Download Failed",
            ).catch((manualError) => {
              setDownloading(null);
              showLibraryNotice(
                "Nexus Download Failed",
                manualError instanceof Error
                  ? manualError.message
                  : "Failed to open the Nexus manual download flow.",
              );
            });
          },
        },
      );
    };

    const tryDownloadNexusFile = async (
      fileId: number,
      runtime: "IL2CPP" | "Mono" | undefined,
    ) => {
      try {
        const result = await downloadNexusWithSecurity(
          modId,
          fileId,
          runtime,
          "Security Findings - Nexus Download",
        );
        return {
          result,
          manualConfirmationPrompted: false,
        };
      } catch (error) {
        if (!isManualNexusDownloadRequiredError(error)) {
          throw error;
        }

        promptManualNexusConfirmation(fileId, runtime);
        return {
          result: null,
          manualConfirmationPrompted: true,
        };
      }
    };

    const runDownload = async (runtime: "IL2CPP" | "Mono" | "Both") => {
      setDownloading(`nexus-${modId}`);
      let keepPendingDownload = false;
      try {
        const results: SuccessfulLibraryDownload[] = [];
        const failures: DownloadBatchFailure[] = [];
        const downloadedVersionTokens = new Set<string>();
        logger.debug("Starting Nexus library download flow", {
          modId,
          requestedRuntime: runtime,
          selectedFileId: selectedFile?.file_id ?? null,
          selectedFileName:
            selectedFile?.file_name || selectedFile?.name || null,
          availableFiles: files.map((file) => ({
            fileId: file.file_id,
            fileName: file.file_name || file.name || null,
            version: file.version || file.mod_version || null,
            inferredRuntime: inferNexusFileRuntime(file),
            uploadedAt: getNexusFileUpdatedAt(file) || null,
          })),
        });
        if (!access.canDirectDownload && access.requiresSiteConfirmation) {
          if (selectedFile?.file_id) {
            const inferredRuntime = inferNexusFileRuntime(selectedFile);
            await beginManualNexusLibraryDownload(
              modId,
              selectedFile.file_id,
              inferredRuntime === "Unknown" ? undefined : inferredRuntime,
              async () => {
                const nextLibrary = await loadLibrarySnapshot();
                notifyLibraryUpdated();
                const refreshedGroup = findDownloadedGroupForNexusMod(
                  modId,
                  nextLibrary,
                  selectedFile.file_id,
                );
                await promptDownloadedInstallTargets(
                  refreshedGroup?.entries.filter((entry) =>
                    areVersionsEquivalent(
                      getEntryVersionLabel(entry),
                      selectedFile.version || selectedFile.mod_version,
                    ),
                  ) || [],
                  "Install Downloaded Mod",
                );
              },
            );
            keepPendingDownload = true;
            return;
          }

          if (runtime === "Both") {
            throw new Error(
              "Manual Nexus download flow requires a single runtime selection.",
            );
          }

          const targetFile = selectNexusFileForRuntime(files, runtime);
          if (!targetFile?.file_id) {
            throw new Error(`No Nexus file found for ${runtime}.`);
          }

          await beginManualNexusLibraryDownload(
            modId,
            targetFile.file_id,
            runtime,
            async () => {
              const nextLibrary = await loadLibrarySnapshot();
              notifyLibraryUpdated();
              const refreshedGroup = findDownloadedGroupForNexusMod(
                modId,
                nextLibrary,
                targetFile.file_id,
              );
              await promptDownloadedInstallTargets(
                refreshedGroup?.entries.filter((entry) =>
                  areVersionsEquivalent(
                    getEntryVersionLabel(entry),
                    targetFile.version || targetFile.mod_version,
                  ),
                ) || [],
                "Install Downloaded Mod",
              );
            },
          );
          keepPendingDownload = true;
          return;
        }

        if (selectedFile?.file_id) {
          const inferredRuntime = inferNexusFileRuntime(selectedFile);
          const { result, manualConfirmationPrompted } =
            await tryDownloadNexusFile(
              selectedFile.file_id,
              inferredRuntime === "Unknown" ? undefined : inferredRuntime,
            );
          if (manualConfirmationPrompted) {
            return;
          }
          if (result) {
            results.push({
              ...result,
              promptEntry:
                result.storageId &&
                (inferredRuntime === "IL2CPP" || inferredRuntime === "Mono")
                  ? buildOptimisticDownloadedEntry({
                      storageId: result.storageId,
                      displayName: activeModView?.name || `Nexus Mod ${modId}`,
                      runtime: inferredRuntime,
                      source: "nexusmods",
                      sourceId: String(modId),
                      version:
                        selectedFile.version || selectedFile.mod_version,
                      summary: activeModView?.summary,
                      iconUrl: activeModView?.iconUrl,
                      sourceUrl:
                        safeExternalUrl(
                          `https://www.nexusmods.com/schedule1/mods/${modId}`,
                        ) || undefined,
                      author: activeModView?.author,
                      downloads: selectedNexusResult?.mod_downloads,
                      likesOrEndorsements:
                        selectedNexusResult?.endorsement_count,
                      updatedAt: selectedNexusResult?.updated_time,
                      tags: getNexusFileTags(selectedFile),
                    })
                  : undefined,
            });
            downloadedVersionTokens.add(
              normalizeVersionToken(
                selectedFile.version || selectedFile.mod_version || "",
              ),
            );
            logger.debug("Downloaded selected Nexus file to library", {
              modId,
              fileId: selectedFile.file_id,
              requestedRuntime:
                inferredRuntime === "Unknown" ? null : inferredRuntime,
              result,
            });
          }
        } else if (runtime === "Both") {
          const il2cppFile = selectNexusFileForRuntime(files, "IL2CPP");
          const monoFile = selectNexusFileForRuntime(files, "Mono");
          if (il2cppFile?.file_id) {
            try {
              const { result, manualConfirmationPrompted } =
                await tryDownloadNexusFile(il2cppFile.file_id, "IL2CPP");
              if (manualConfirmationPrompted) {
                return;
              }
              if (result) {
                results.push({
                  ...result,
                  promptEntry: result.storageId
                    ? buildOptimisticDownloadedEntry({
                        storageId: result.storageId,
                        displayName:
                          activeModView?.name || `Nexus Mod ${modId}`,
                        runtime: "IL2CPP",
                        source: "nexusmods",
                        sourceId: String(modId),
                        version:
                          il2cppFile.version || il2cppFile.mod_version,
                        summary: activeModView?.summary,
                        iconUrl: activeModView?.iconUrl,
                        sourceUrl:
                          safeExternalUrl(
                            `https://www.nexusmods.com/schedule1/mods/${modId}`,
                          ) || undefined,
                        author: activeModView?.author,
                        downloads: selectedNexusResult?.mod_downloads,
                        likesOrEndorsements:
                          selectedNexusResult?.endorsement_count,
                        updatedAt: selectedNexusResult?.updated_time,
                        tags: getNexusFileTags(il2cppFile),
                      })
                    : undefined,
                });
                downloadedVersionTokens.add(
                  normalizeVersionToken(
                    il2cppFile.version || il2cppFile.mod_version || "",
                  ),
                );
                logger.debug("Downloaded Nexus IL2CPP runtime to library", {
                  modId,
                  fileId: il2cppFile.file_id,
                  requestedRuntime: "IL2CPP",
                  result,
                });
              }
            } catch (error) {
              failures.push({
                label: `Nexus mod ${modId} IL2CPP`,
                message:
                  error instanceof Error
                    ? error.message
                    : "Failed to download Nexus mod.",
              });
            }
          }
          if (monoFile?.file_id && monoFile?.file_id !== il2cppFile?.file_id) {
            try {
              const { result, manualConfirmationPrompted } =
                await tryDownloadNexusFile(monoFile.file_id, "Mono");
              if (manualConfirmationPrompted) {
                return;
              }
              if (result) {
                results.push({
                  ...result,
                  promptEntry: result.storageId
                    ? buildOptimisticDownloadedEntry({
                        storageId: result.storageId,
                        displayName:
                          activeModView?.name || `Nexus Mod ${modId}`,
                        runtime: "Mono",
                        source: "nexusmods",
                        sourceId: String(modId),
                        version: monoFile.version || monoFile.mod_version,
                        summary: activeModView?.summary,
                        iconUrl: activeModView?.iconUrl,
                        sourceUrl:
                          safeExternalUrl(
                            `https://www.nexusmods.com/schedule1/mods/${modId}`,
                          ) || undefined,
                        author: activeModView?.author,
                        downloads: selectedNexusResult?.mod_downloads,
                        likesOrEndorsements:
                          selectedNexusResult?.endorsement_count,
                        updatedAt: selectedNexusResult?.updated_time,
                        tags: getNexusFileTags(monoFile),
                      })
                    : undefined,
                });
                downloadedVersionTokens.add(
                  normalizeVersionToken(
                    monoFile.version || monoFile.mod_version || "",
                  ),
                );
                logger.debug("Downloaded Nexus Mono runtime to library", {
                  modId,
                  fileId: monoFile.file_id,
                  requestedRuntime: "Mono",
                  result,
                });
              }
            } catch (error) {
              failures.push({
                label: `Nexus mod ${modId} Mono`,
                message:
                  error instanceof Error
                    ? error.message
                    : "Failed to download Nexus mod.",
              });
            }
          }
        } else {
          const targetFile = selectNexusFileForRuntime(files, runtime);
          if (!targetFile?.file_id) return;
          try {
            const { result, manualConfirmationPrompted } =
              await tryDownloadNexusFile(targetFile.file_id, runtime);
            if (manualConfirmationPrompted) {
              return;
            }
            if (result) {
              results.push({
                ...result,
                promptEntry: result.storageId
                  ? buildOptimisticDownloadedEntry({
                      storageId: result.storageId,
                      displayName:
                        activeModView?.name || `Nexus Mod ${modId}`,
                      runtime,
                      source: "nexusmods",
                      sourceId: String(modId),
                      version: targetFile.version || targetFile.mod_version,
                      summary: activeModView?.summary,
                      iconUrl: activeModView?.iconUrl,
                      sourceUrl:
                        safeExternalUrl(
                          `https://www.nexusmods.com/schedule1/mods/${modId}`,
                        ) || undefined,
                      author: activeModView?.author,
                      downloads: selectedNexusResult?.mod_downloads,
                      likesOrEndorsements:
                        selectedNexusResult?.endorsement_count,
                      updatedAt: selectedNexusResult?.updated_time,
                      tags: getNexusFileTags(targetFile),
                    })
                  : undefined,
              });
              downloadedVersionTokens.add(
                normalizeVersionToken(
                  targetFile.version || targetFile.mod_version || "",
                ),
              );
              logger.debug("Downloaded Nexus runtime to library", {
                modId,
                fileId: targetFile.file_id,
                requestedRuntime: runtime,
                result,
              });
            }
          } catch (error) {
            failures.push({
              label: `Nexus mod ${modId} ${runtime}`,
              message:
                error instanceof Error
                  ? error.message
                  : "Failed to download Nexus mod.",
            });
          }
        }
        if (results.length === 0) {
          if (failures.length > 0) {
            showLibraryNotice(
              "Nexus Download Failed",
              failures
                .map((failure) => `${failure.label}: ${failure.message}`)
                .join("\n"),
            );
          }
          return;
        }

        await finalizeLibraryDownloadBatch(
          results,
          `Install Downloaded Mod`,
          failures,
          (nextLibrary) => {
            const refreshedGroup = findDownloadedGroupForNexusMod(
              modId,
              nextLibrary,
              selectedFile?.file_id ?? undefined,
            );
            if (!refreshedGroup) {
              return [];
            }

            return refreshedGroup.entries.filter((entry) =>
              downloadedVersionTokens.has(
                normalizeVersionToken(getEntryVersionLabel(entry)),
              ),
            );
          },
        );
      } catch (err) {
        console.error("Failed to download Nexus mod:", err);
        showLibraryNotice(
          "Nexus Download Failed",
          err instanceof Error ? err.message : "Failed to download Nexus mod.",
        );
      } finally {
        if (!keepPendingDownload) {
          setDownloading(null);
        }
      }
    };

    const runFomodInstallerDownload = async (file: NexusModFile) => {
      setDownloading(`nexus-${modId}`);
      let keepPendingDownload = false;
      try {
        if (!access.canDirectDownload && access.requiresSiteConfirmation) {
          await beginManualNexusLibraryDownload(
            modId,
            file.file_id,
            undefined,
            async () => {
              const nextLibrary = await loadLibrarySnapshot();
              notifyLibraryUpdated();
              const refreshedGroup = findDownloadedGroupForNexusMod(
                modId,
                nextLibrary,
                file.file_id,
              );
              await promptDownloadedInstallTargets(
                refreshedGroup?.entries.filter((entry) =>
                  areVersionsEquivalent(
                    getEntryVersionLabel(entry),
                    file.version || file.mod_version,
                  ),
                ) || [],
                "Install Downloaded Mod",
              );
            },
          );
          keepPendingDownload = true;
          return;
        }

        const { result, manualConfirmationPrompted } =
          await tryDownloadNexusFile(file.file_id, undefined);
        if (manualConfirmationPrompted) {
          return;
        }
        if (!result) {
          return;
        }

        await finalizeLibraryDownloadBatch(
          [result],
          "Install Downloaded Mod",
          [],
          (nextLibrary) => {
            const refreshedGroup = findDownloadedGroupForNexusMod(
              modId,
              nextLibrary,
              file.file_id,
            );
            return (
              refreshedGroup?.entries.filter((entry) =>
                areVersionsEquivalent(
                  getEntryVersionLabel(entry),
                  file.version || file.mod_version,
                ),
              ) || []
            );
          },
        );
      } catch (err) {
        console.error("Failed to download Nexus FOMOD installer:", err);
        showLibraryNotice(
          "Nexus Download Failed",
          err instanceof Error ? err.message : "Failed to download Nexus mod.",
        );
      } finally {
        if (!keepPendingDownload) {
          setDownloading(null);
        }
      }
    };

    if (selectedFile?.file_id) {
      if (isNexusFomodInstaller(selectedFile)) {
        void runFomodInstallerDownload(selectedFile);
        return;
      }

      const runtime = inferNexusFileRuntime(selectedFile);
      void runDownload(runtime === "Unknown" ? "Mono" : runtime);
      return;
    }

    if (!hasIl2cpp && !hasMono && fomodInstallerFile?.file_id) {
      void runFomodInstallerDownload(fomodInstallerFile);
      return;
    }

    if (!hasIl2cpp && !hasMono) {
      setRuntimePrompt({
        title: "Select Runtime",
        message: "Select the runtime for this Nexus mod download.",
        onSelect: runDownload,
      });
      return;
    }

    if (
      !access.canDirectDownload &&
      access.requiresSiteConfirmation &&
      hasIl2cpp &&
      hasMono
    ) {
      setRuntimePrompt({
        title: "Select Runtime",
        message:
          "Free Nexus downloads must be confirmed one file at a time. Choose the runtime to download now.",
        onSelect: (runtime) => {
          if (runtime === "Both") {
            showLibraryNotice(
              "Select One Runtime",
              "Choose Mono or IL2CPP for this manual Nexus download. Repeat the download for the other runtime separately.",
            );
            return;
          }
          setRuntimePrompt(null);
          void runDownload(runtime);
        },
      });
      return;
    }

    if (hasIl2cpp && hasMono) {
      runDownload("Both");
      return;
    }

    runDownload(hasIl2cpp ? "IL2CPP" : "Mono");
  };

  const openDownloadedModView = useCallback(
    (group: DownloadedModGroup, preferredStorageId?: string) => {
      const preferredEntry = preferredStorageId
        ? group.entries.find((entry) => {
            if (entry.storageId === preferredStorageId) {
              return true;
            }

            return Object.values(entry.storageIdsByRuntime || {}).includes(
              preferredStorageId,
            );
          })
        : null;
      const activeEntry =
        preferredEntry || getActiveEntryForGroup(group) || group.entries[0];
      openModView({
        id: group.key,
        storageId: activeEntry?.storageId,
        name: group.displayName,
        source: activeEntry?.source || "unknown",
        author: group.author,
        summary: activeEntry?.summary,
        iconUrl: activeEntry?.iconUrl,
        iconCachePath: activeEntry?.iconCachePath,
        sourceUrl: activeEntry?.sourceUrl,
        downloads: activeEntry?.downloads,
        likesOrEndorsements: activeEntry?.likesOrEndorsements,
        updatedAt: activeEntry?.updatedAt,
        tags: activeEntry?.tags,
        installedVersion:
          activeEntry?.installedVersion || activeEntry?.sourceVersion,
        latestVersion: group.remoteVersion,
        addedAt: activeEntry?.libraryAddedAt,
        installedAt: activeEntry?.installedAt,
        securityScan: activeEntry?.securityScan,
        kind: "downloaded",
      });
    },
    [getActiveEntryForGroup, openModView],
  );

  useEffect(() => {
    if (!isOpen || !focusStorageId || !focusRequestId) {
      return;
    }

    if (lastHandledFocusRequestIdRef.current === focusRequestId) {
      return;
    }

    if (downloadedGroups.length === 0) {
      return;
    }

    const targetGroup = downloadedGroups.find((group) =>
      group.entries.some(
        (entry) =>
          entry.storageId === focusStorageId ||
          Object.values(entry.storageIdsByRuntime || {}).includes(
            focusStorageId,
          ),
      ),
    );

    if (!targetGroup) {
      return;
    }

    lastHandledFocusRequestIdRef.current = focusRequestId;
    void handleSelectVersion(targetGroup, focusStorageId);
    openDownloadedModView(targetGroup, focusStorageId);
  }, [
    downloadedGroups,
    focusRequestId,
    focusStorageId,
    handleSelectVersion,
    isOpen,
    openDownloadedModView,
  ]);

  const openThunderstoreModView = useCallback(
    (pkg: ThunderstorePackageGroup) => {
      const il2cpp = pkg.packagesByRuntime.IL2CPP;
      const mono = pkg.packagesByRuntime.Mono;
      const representative = il2cpp || mono;
      const version = representative?.versions?.[0];
      const downloads =
        representative?.versions?.reduce(
          (sum, item) => sum + (item.downloads || 0),
          0,
        ) || 0;

      openModView({
        id: pkg.key,
        name: pkg.name,
        source: "thunderstore",
        author: pkg.owner,
        summary: version?.description,
        iconUrl:
          version?.icon ||
          (representative as any)?.icon ||
          (representative as any)?.icon_url,
        sourceUrl: pkg.packageUrl,
        downloads,
        likesOrEndorsements: representative?.rating_score || 0,
        updatedAt: normalizeDateString(
          getThunderstorePackageUpdatedAt(representative),
        ),
        tags: representative?.categories || [],
        installedVersion: version?.version_number,
        kind: "thunderstore",
      });
    },
    [openModView],
  );

  const openNexusModView = useCallback(
    (mod: NexusMod) => {
      openModView({
        id: String(mod.mod_id),
        name: mod.name,
        source: "nexusmods",
        author: mod.author,
        uploader: mod.uploader,
        originalAuthor: mod.original_author,
        summary: mod.summary,
        iconUrl: mod.picture_url,
        sourceUrl: `https://www.nexusmods.com/schedule1/mods/${mod.mod_id}`,
        downloads: mod.mod_downloads,
        likesOrEndorsements: mod.endorsement_count,
        updatedAt: normalizeDateString(getNexusModUpdatedAt(mod)),
        installedVersion: mod.version,
        kind: "nexusmods",
      });
    },
    [openModView],
  );

  const openNexusCollectionView = useCallback((collection: NexusCollection) => {
    if (libraryScrollContainerRef.current) {
      libraryScrollTopRef.current = libraryScrollContainerRef.current.scrollTop;
    }
    setActiveModView(null);
    setSelectedNexusCollectionSlug(collection.slug);
  }, []);

  const findDownloadedGroupForThunderstorePackage = useCallback(
    (
      pkg: ThunderstorePackageGroup,
      sourceLibrary?: ModLibraryResult | null,
    ) => {
      const groups = buildDownloadedGroups(
        sourceLibrary?.downloaded ?? library?.downloaded ?? [],
      );
      return (
        groups.find((group) =>
          group.entries.some((entry) => {
            if (entry.source !== "thunderstore") {
              return false;
            }
            const parsed = parseThunderstoreSourceId(entry.sourceId);
            return (
              parsed.owner.toLowerCase() === pkg.owner.toLowerCase() &&
              normalizeThunderstoreName(parsed.name).toLowerCase() ===
                normalizeThunderstoreName(pkg.name).toLowerCase()
            );
          }),
        ) || null
      );
    },
    [library],
  );

  const findDownloadedGroupForNexusMod = useCallback(
    (
      modId: number,
      sourceLibrary?: ModLibraryResult | null,
      fileId?: number | null,
    ) => {
      const groups = buildDownloadedGroups(
        sourceLibrary?.downloaded ?? library?.downloaded ?? [],
      );
      const nexusGroups = groups.filter((group) =>
        group.entries.some(
          (entry) =>
            entry.source === "nexusmods" &&
            Number(entry.sourceId || "0") === modId,
        ),
      );
      const requestedFileId =
        typeof fileId === "number" ? String(fileId) : null;
      if (!requestedFileId) {
        return nexusGroups[0] || null;
      }

      return (
        nexusGroups.find((group) =>
          group.entries.some(
            (entry) => getNexusFileIdFromTags(entry.tags) === requestedFileId,
          ),
        ) ||
        (nexusGroups.length === 1 ? nexusGroups[0] : null)
      );
    },
    [library],
  );

  const displayedDownloadedGroups = useMemo(() => {
    if (libraryTab === "updates") {
      return filteredDownloadedGroups.filter((group) =>
        isGroupUpdateAvailable(group),
      );
    }
    return filteredDownloadedGroups;
  }, [
    filteredDownloadedGroups,
    isGroupUpdateAvailable,
    libraryTab,
  ]);

  const selectedDownloadedGroup = useMemo(() => {
    if (activeModView?.kind !== "downloaded") {
      return null;
    }
    return (
      downloadedGroups.find((group) => group.key === activeModView.id) || null
    );
  }, [activeModView, downloadedGroups]);

  const selectedDownloadedEntry = useMemo(() => {
    if (!selectedDownloadedGroup) {
      return null;
    }
    return (
      getActiveEntryForGroup(selectedDownloadedGroup) ||
      selectedDownloadedGroup.entries[0] ||
      null
    );
  }, [getActiveEntryForGroup, selectedDownloadedGroup]);

  const selectedDownloadedGroupEntries = useMemo(() => {
    if (!selectedDownloadedGroup) {
      return [];
    }
    return getSortedGroupEntries(selectedDownloadedGroup);
  }, [getSortedGroupEntries, selectedDownloadedGroup]);

  const selectedThunderstorePackage = useMemo(() => {
    if (activeModView?.kind !== "thunderstore") {
      return null;
    }
    return searchResults.find((pkg) => pkg.key === activeModView.id) || null;
  }, [activeModView, searchResults]);

  const selectedThunderstoreVersionOptions = useMemo(
    () => buildThunderstoreVersionOptions(selectedThunderstorePackage),
    [selectedThunderstorePackage],
  );

  const selectedThunderstoreVersion = useMemo(() => {
    if (!selectedThunderstorePackage) {
      return null;
    }
    const selectedKey =
      selectedThunderstoreVersionByPackage[selectedThunderstorePackage.key];
    return (
      selectedThunderstoreVersionOptions.find(
        (version) => version.key === selectedKey,
      ) ||
      selectedThunderstoreVersionOptions[0] ||
      null
    );
  }, [
    selectedThunderstorePackage,
    selectedThunderstoreVersionByPackage,
    selectedThunderstoreVersionOptions,
  ]);

  const selectedThunderstoreRepresentativePackage =
    selectedThunderstorePackage?.packagesByRuntime.IL2CPP ||
    selectedThunderstorePackage?.packagesByRuntime.Mono;
  const selectedThunderstoreLatestVersion =
    selectedThunderstoreRepresentativePackage?.versions?.[0];
  const selectedThunderstoreRuntimeLabels = (["IL2CPP", "Mono"] as const).filter(
    (runtime) => !!selectedThunderstorePackage?.packagesByRuntime[runtime],
  );
  const selectedThunderstoreCategories =
    selectedThunderstoreRepresentativePackage?.categories || [];

  const selectedThunderstoreDependencies =
    getThunderstoreDependenciesForRuntime(selectedThunderstoreVersion, "Both");
  const missingSelectedThunderstoreDependencies =
    getMissingThunderstoreDependencies(
      selectedThunderstoreDependencies,
      downloadedGroups,
    );

  const selectedNexusResult = useMemo(() => {
    if (activeModView?.kind !== "nexusmods") {
      return null;
    }
    return (
      nexusModsSearchResults.find(
        (mod) => String(mod.mod_id) === activeModView.id,
      ) || null
    );
  }, [activeModView, nexusModsSearchResults]);

  const selectedNexusCollection = useMemo(
    () =>
      nexusCollectionsSearchResults.find(
        (collection) => collection.slug === selectedNexusCollectionSlug,
      ) || null,
    [nexusCollectionsSearchResults, selectedNexusCollectionSlug],
  );

  const detailPageOpen = Boolean(
    selectedNexusCollection ||
      (selectedDownloadedGroup && selectedDownloadedEntry) ||
      selectedThunderstorePackage ||
      selectedNexusResult,
  );
  const detailSelectionLoading =
    (activeModView?.kind === "downloaded" && loadingLibrary) ||
    (activeModView?.kind === "thunderstore" && searching) ||
    (activeModView?.kind === "nexusmods" && searchingNexusMods) ||
    (selectedNexusCollectionSlug !== null && searchingNexusCollections);
  const detailPageBackLabel =
    libraryTab === "discover"
      ? "Back to Discover"
      : libraryTab === "updates"
        ? "Back to Updates"
        : "Back to Library";

  useEffect(() => {
    if (
      !isOpen ||
      detailPageOpen ||
      detailSelectionLoading ||
      (!activeModView && !selectedNexusCollectionSlug)
    ) {
      return;
    }

    closeDetailView();
  }, [
    activeModView,
    closeDetailView,
    detailPageOpen,
    detailSelectionLoading,
    isOpen,
    selectedNexusCollectionSlug,
  ]);

  useEffect(() => {
    const revisionNumber = selectedNexusCollection?.revision_number;
    if (!selectedNexusCollection || !revisionNumber) {
      setNexusCollectionPlanState({
        key: null,
        loading: false,
        plan: null,
        error: selectedNexusCollection
          ? "This collection does not expose a published revision."
          : null,
      });
      setNexusCollectionAccess(null);
      return;
    }

    const key = `${selectedNexusCollection.slug}:${revisionNumber}`;
    let cancelled = false;
    setNexusCollectionPlanState({ key, loading: true, plan: null, error: null });
    void Promise.all([
      ApiService.getNexusCollectionRevisionPlan(
        selectedNexusCollection.slug,
        revisionNumber,
      ),
      getEffectiveNexusDownloadAccess(),
      ensureLibrary(),
    ])
      .then(([plan, access]) => {
        if (cancelled) return;
        setNexusCollectionPlanState({ key, loading: false, plan, error: null });
        setNexusCollectionAccess(access);
      })
      .catch((error) => {
        if (cancelled) return;
        setNexusCollectionPlanState({
          key,
          loading: false,
          plan: null,
          error:
            error instanceof Error
              ? error.message
              : "SIMM could not load this collection revision.",
        });
        setNexusCollectionAccess(null);
      });

    return () => {
      cancelled = true;
    };
  }, [
    ensureLibrary,
    getEffectiveNexusDownloadAccess,
    selectedNexusCollection,
  ]);

  const getStagedCollectionEntry = useCallback(
    (file: NexusCollectionModFile, entries = library?.downloaded || []) =>
      findStagedCollectionEntry(file, entries),
    [library?.downloaded],
  );

  const selectedCollectionPlan = nexusCollectionPlanState.plan;

  const getCollectionFileDecisionKey = useCallback(
    (file: NexusCollectionModFile) =>
      `${selectedNexusCollection?.slug || "collection"}:${selectedCollectionPlan?.revisionNumber || 0}:${file.modId || 0}:${file.fileId}`,
    [selectedCollectionPlan?.revisionNumber, selectedNexusCollection?.slug],
  );

  const getCollectionConflictingEntries = useCallback(
    (file: NexusCollectionModFile, entries = library?.downloaded || []) =>
      findCollectionFileConflicts(file, entries),
    [library?.downloaded],
  );

  const resolveCollectionConflict = useCallback(
    (choice: CollectionConflictChoice) => {
      collectionConflictResolutionRef.current?.(choice);
      collectionConflictResolutionRef.current = null;
      setCollectionConflict(null);
    },
    [],
  );

  const recordCollectionFileDecision = useCallback(
    (key: string, decision: "collection" | "existing") => {
      const next = {
        ...collectionFileDecisionsRef.current,
        [key]: decision,
      };
      collectionFileDecisionsRef.current = next;
      setCollectionFileDecisions(next);
    },
    [],
  );

  const enqueueCollectionConflict = useCallback(
    (file: NexusCollectionModFile, existingEntries: ModLibraryEntry[]) => {
      const conflict = { file, existingEntries };
      setCollectionConflict((current) => {
        if (!current) return conflict;
        if (current.file.fileId === file.fileId) return current;
        setCollectionConflictQueue((queue) =>
          queue.some((item) => item.file.fileId === file.fileId)
            ? queue
            : [...queue, conflict],
        );
        return current;
      });
    },
    [],
  );

  useEffect(() => {
    if (collectionConflict || collectionConflictQueue.length === 0) return;
    const [next, ...remaining] = collectionConflictQueue;
    setCollectionConflictQueue(remaining);
    setCollectionConflict(next);
  }, [collectionConflict, collectionConflictQueue]);

  const loadCollectionNexusRuntimeCatalogs = useCallback(async (
    files: NexusCollectionModFile[],
  ): Promise<Map<number, NexusModFile[]>> => {
    const generation = collectionNexusCatalogGenerationRef.current;
    const modIds = Array.from(new Set(files.flatMap((file) =>
      file.modId && inferCollectionNexusFileRuntime(file.fileName, file.modName)
        ? [file.modId]
        : [],
    )));
    const missingIds = modIds.filter((modId) => !collectionNexusFileCatalogsRef.current.has(modId));
    if (missingIds.length === 0) return collectionNexusFileCatalogsRef.current;

    setCollectionNexusCatalogLoading((current) => new Set([...current, ...missingIds]));
    const results = await Promise.all(missingIds.map(async (modId) => {
      let request = collectionNexusCatalogRequestsRef.current.get(modId);
      if (!request) {
        request = ApiService.getNexusModsModFiles('schedule1', modId);
        collectionNexusCatalogRequestsRef.current.set(modId, request);
      }
      try {
        return { modId, files: await request, error: null as string | null };
      } catch (error) {
        return {
          modId,
          files: [] as NexusModFile[],
          error: error instanceof Error ? error.message : 'Nexus file lookup failed.',
        };
      } finally {
        collectionNexusCatalogRequestsRef.current.delete(modId);
      }
    }));
    if (generation !== collectionNexusCatalogGenerationRef.current) {
      return collectionNexusFileCatalogsRef.current;
    }

    const nextCatalogs = new Map(collectionNexusFileCatalogsRef.current);
    for (const result of results) {
      nextCatalogs.set(result.modId, result.files);
    }
    collectionNexusFileCatalogsRef.current = nextCatalogs;
    setCollectionNexusFileCatalogs(nextCatalogs);
    setCollectionNexusCatalogErrors((current) => {
      const next = new Map(current);
      for (const result of results) {
        if (result.error) next.set(result.modId, result.error);
        else next.delete(result.modId);
      }
      return next;
    });
    setCollectionNexusCatalogLoading((current) => {
      const next = new Set(current);
      for (const modId of missingIds) next.delete(modId);
      return next;
    });
    return nextCatalogs;
  }, []);

  useEffect(() => {
    collectionNexusCatalogGenerationRef.current += 1;
    collectionNexusFileCatalogsRef.current = new Map();
    collectionNexusCatalogRequestsRef.current.clear();
    activeCollectionProfileKeyRef.current = nexusCollectionPlanState.key;
    setCollectionFileDecisions({});
    collectionFileDecisionsRef.current = {};
    collectionConflictResolutionRef.current?.("cancel");
    collectionConflictResolutionRef.current = null;
    setCollectionConflict(null);
    setCollectionConflictQueue([]);
    setCollectionProfiles([]);
    collectionProfilesRef.current = [];
    collectionProfileRuntimesRef.current = [];
    collectionProfileBuildKeyRef.current = null;
    setCollectionMatchStates({});
    setCollectionSourceChoices({});
    setCollectionOptionalSelections({});
    setCollectionRuntimePreview(null);
    setCollectionNexusFileCatalogs(new Map());
    setCollectionNexusCatalogLoading(new Set());
    setCollectionNexusCatalogErrors(new Map());
    setApplyCollectionSourceToAll(false);
  }, [nexusCollectionPlanState.key]);

  useEffect(() => {
    if (!selectedCollectionPlan || !nexusCollectionAccess?.canDirectDownload) return;
    void loadCollectionNexusRuntimeCatalogs(selectedCollectionPlan.modFiles);
  }, [loadCollectionNexusRuntimeCatalogs, nexusCollectionAccess?.canDirectDownload, selectedCollectionPlan]);

  useEffect(() => {
    if (!selectedCollectionPlan || nexusCollectionAccess?.canDirectDownload) return;
    let cancelled = false;
    const files = selectedCollectionPlan.modFiles;
    const loadingStates = Object.fromEntries(files.map((file) => [
      collectionFileKey(file),
      { loading: Boolean(file.author && file.version), matches: [] },
    ])) satisfies Record<string, CollectionMatchState>;
    setCollectionMatchStates(loadingStates);

    void Promise.all(files.map(async (file) => {
      const key = collectionFileKey(file);
      if (!file.author || !file.version) {
        return [key, {
          loading: false,
          matches: [],
          error: !file.author
            ? 'Nexus did not provide an author, so SIMM cannot make a high-confidence match.'
            : 'The collection did not request a version.',
        }] as const;
      }
      try {
        const result = await ApiService.searchThunderstoreByRuntime('schedule-i', file.modName);
        const matches = findCollectionThunderstoreMatches(file, result.packagesByRuntime as Partial<Record<'IL2CPP' | 'Mono', CollectionThunderstorePackage[]>>);
        return [key, { loading: false, matches }] as const;
      } catch (error) {
        return [key, {
          loading: false,
          matches: [],
          error: error instanceof Error ? error.message : 'Thunderstore search failed.',
        }] as const;
      }
    })).then((results) => {
      if (cancelled) return;
      const states = Object.fromEntries(results) as Record<string, CollectionMatchState>;
      setCollectionMatchStates(states);
      setCollectionSourceChoices(Object.fromEntries(files.map((file) => {
        const hasExactMatch = (states[collectionFileKey(file)]?.matches.length ?? 0) > 0;
        return [collectionFileKey(file), !file.optional && hasExactMatch ? 'thunderstore' : 'nexusmods'];
      })));
      setCollectionOptionalSelections(Object.fromEntries(
        files.filter((file) => file.optional).map((file) => [collectionFileKey(file), false]),
      ));
    });

    return () => {
      cancelled = true;
    };
  }, [nexusCollectionAccess?.canDirectDownload, selectedCollectionPlan]);

  const setCollectionSourceChoice = useCallback((
    file: NexusCollectionModFile,
    choice: CollectionSourceChoice,
  ) => {
    setCollectionSourceChoices((current) => {
      const next = { ...current, [collectionFileKey(file)]: choice };
      if (applyCollectionSourceToAll && selectedCollectionPlan) {
        for (const candidate of selectedCollectionPlan.modFiles) {
          const key = collectionFileKey(candidate);
          if (choice === 'nexusmods' || (collectionMatchStates[key]?.matches.length ?? 0) > 0) {
            next[key] = choice;
          }
        }
      }
      return next;
    });
  }, [applyCollectionSourceToAll, collectionMatchStates, selectedCollectionPlan]);

  const requestCollectionConflictChoice = useCallback(
    (file: NexusCollectionModFile, existingEntries: ModLibraryEntry[]) =>
      new Promise<CollectionConflictChoice>((resolve) => {
        collectionConflictResolutionRef.current?.("cancel");
        collectionConflictResolutionRef.current = resolve;
        setCollectionConflict({ file, existingEntries });
      }),
    [],
  );

  useEffect(
    () => () => {
      collectionConflictResolutionRef.current?.("cancel");
      collectionConflictResolutionRef.current = null;
    },
    [],
  );

  const requiredCollectionFiles = useMemo(
    () => selectedCollectionPlan?.modFiles.filter((file) => !file.optional) || [],
    [selectedCollectionPlan],
  );
  const optionalCollectionFiles = useMemo(
    () => selectedCollectionPlan?.modFiles.filter((file) => file.optional) || [],
    [selectedCollectionPlan],
  );
  const selectedOptionalCollectionCount = useMemo(
    () => optionalCollectionFiles.filter((file) =>
      Boolean(collectionOptionalSelections[collectionFileKey(file)]),
    ).length,
    [collectionOptionalSelections, optionalCollectionFiles],
  );
  const selectedCollectionFiles = useMemo(
    () => selectedCollectionPlan?.modFiles.filter((file) =>
      !file.optional || Boolean(collectionOptionalSelections[collectionFileKey(file)]),
    ) || [],
    [collectionOptionalSelections, selectedCollectionPlan],
  );
  const stagedRequiredCollectionFiles = useMemo(
    () =>
      requiredCollectionFiles.filter((file) =>
        Boolean(getStagedCollectionEntry(file)),
      ),
    [getStagedCollectionEntry, requiredCollectionFiles],
  );
  const missingSelectedCollectionFiles = useMemo(
    () =>
      selectedCollectionFiles.filter(
        (file) => {
          const keepingExisting =
            collectionFileDecisions[getCollectionFileDecisionKey(file)] ===
              "existing" && getCollectionConflictingEntries(file).length > 0;
          return (
            file.available &&
            file.modId !== undefined &&
            !getStagedCollectionEntry(file) &&
            !keepingExisting
          );
        },
      ),
    [
      collectionFileDecisions,
      getCollectionConflictingEntries,
      getCollectionFileDecisionKey,
      getStagedCollectionEntry,
      selectedCollectionFiles,
    ],
  );
  const keptExistingCollectionFiles = useMemo(
    () =>
      requiredCollectionFiles.filter(
        (file) =>
          collectionFileDecisions[getCollectionFileDecisionKey(file)] ===
            "existing" && getCollectionConflictingEntries(file).length > 0,
      ),
    [
      collectionFileDecisions,
      getCollectionConflictingEntries,
      getCollectionFileDecisionKey,
      requiredCollectionFiles,
    ],
  );
  const unavailableRequiredCollectionFiles = useMemo(
    () =>
      requiredCollectionFiles.filter(
        (file) => !file.available || file.modId === undefined,
      ),
    [requiredCollectionFiles],
  );
  const unavailableSelectedCollectionFiles = useMemo(
    () =>
      selectedCollectionFiles.filter(
        (file) => !file.available || file.modId === undefined,
      ),
    [selectedCollectionFiles],
  );
  const requiredExternalCollectionResources = useMemo(
    () =>
      selectedCollectionPlan?.externalResources.filter(
        (resource) => !resource.optional,
      ) || [],
    [selectedCollectionPlan],
  );
  const collectionDownloadBusy =
    collectionActiveDownloadIds.size > 0 ||
    (downloading?.startsWith("collection-manual-") ?? false);
  const collectionMatchesLoading = Object.values(collectionMatchStates).some((state) => state.loading);
  const collectionReadyForProfile =
    selectedCollectionFiles.length > 0 &&
    missingSelectedCollectionFiles.length === 0 &&
    unavailableSelectedCollectionFiles.length === 0 &&
    requiredExternalCollectionResources.length === 0;
  const collectionRuntimePreviewByRuntime = useMemo<
    Record<CollectionProfileRuntime, CollectionRuntimePreviewItem[]>
  >(() => {
    const entries = library?.downloaded ?? [];
    const buildPreview = (
      runtime: CollectionProfileRuntime,
    ): CollectionRuntimePreviewItem[] =>
      (selectedCollectionPlan?.modFiles ?? []).map((file) => {
        const key = collectionFileKey(file);
        const selected = !file.optional || Boolean(collectionOptionalSelections[key]);
        if (!selected) {
          return {
            file,
            resolutionKey: "optional-off",
            statusLabel: "Optional off",
            tone: "muted",
          };
        }
        if (!file.available || !file.modId) {
          return {
            file,
            resolutionKey: "unavailable",
            statusLabel: "Unavailable",
            tone: "danger",
          };
        }

        const reusableEntry = findExactCollectionLibraryEntry(file, entries, runtime);
        if (reusableEntry) {
          return {
            file,
            resolutionKey: `library:${reusableEntry.source}:${resolveCollectionStorageId(reusableEntry, runtime)}`,
            statusLabel: `Library · ${getSourceBadgeLabel(reusableEntry.source)}`,
            tone: "success",
          };
        }

        if (nexusCollectionAccess?.canDirectDownload) {
          const catalog = file.modId ? collectionNexusFileCatalogs.get(file.modId) : undefined;
          const resolved = resolveCollectionNexusFileForRuntime(file, catalog, runtime);
          const sourceRuntime = inferCollectionNexusFileRuntime(file.fileName, file.modName);
          if (!resolved && sourceRuntime && sourceRuntime !== runtime) {
            const loading = Boolean(file.modId && collectionNexusCatalogLoading.has(file.modId));
            const lookupError = file.modId ? collectionNexusCatalogErrors.get(file.modId) : null;
            return {
              file,
              resolutionKey: loading ? `checking:${runtime}` : `unavailable:${runtime}`,
              statusLabel: loading
                ? 'Checking Nexus…'
                : lookupError
                  ? 'Nexus lookup failed'
                  : `No exact ${runtime} file`,
              tone: loading ? 'muted' : 'danger',
            };
          }
          return {
            file,
            resolutionKey: `nexus-download:${resolved?.fileId ?? file.fileId}`,
            statusLabel: resolved?.fileId !== file.fileId
              ? `Nexus file ${resolved?.fileId}`
              : 'Nexus download',
            tone: "source",
          };
        }

        const sourceChoice = collectionSourceChoices[key] ?? "nexusmods";
        if (sourceChoice === "thunderstore") {
          const selection = selectCollectionThunderstoreMatch(
            collectionMatchStates[key]?.matches ?? [],
            runtime,
          );
          if (selection.match && !selection.runtimeMismatch) {
            return {
              file,
              resolutionKey: `thunderstore:${selection.match.versionUuid}`,
              statusLabel: "Thunderstore",
              tone: "success",
            };
          }
          if (selection.match) {
            return {
              file,
              resolutionKey: `runtime-mismatch:${selection.match.runtime}`,
              statusLabel: `Only ${selection.match.runtime}`,
              tone: "warning",
            };
          }
        }

        return {
          file,
          resolutionKey: "nexus-website",
          statusLabel: "Nexus website",
          tone: "source",
        };
      });

    return {
      IL2CPP: buildPreview("IL2CPP"),
      Mono: buildPreview("Mono"),
    };
  }, [
    collectionMatchStates,
    collectionOptionalSelections,
    collectionSourceChoices,
    collectionNexusCatalogErrors,
    collectionNexusCatalogLoading,
    collectionNexusFileCatalogs,
    library?.downloaded,
    nexusCollectionAccess?.canDirectDownload,
    selectedCollectionPlan,
  ]);
  const collectionRuntimeDifferenceCount = useMemo(() => {
    const monoItems = collectionRuntimePreviewByRuntime.Mono;
    const il2cppItems = collectionRuntimePreviewByRuntime.IL2CPP;
    return monoItems.reduce(
      (count, item, index) =>
        count + (item.resolutionKey === il2cppItems[index]?.resolutionKey ? 0 : 1),
      0,
    );
  }, [collectionRuntimePreviewByRuntime]);
  const activeCollectionRuntimePreview = collectionRuntimePreview
    ? collectionRuntimePreviewByRuntime[collectionRuntimePreview]
    : null;

  const refreshCollectionStaging = useCallback(async () => {
    const nextLibrary = await loadLibrarySnapshot();
    notifyLibraryUpdated();
    return nextLibrary;
  }, [loadLibrarySnapshot, notifyLibraryUpdated]);

  const requestCollectionProfileRuntimes = useCallback(async () => {
    const stagedRuntimes = new Set<"IL2CPP" | "Mono">();
    for (const file of selectedCollectionPlan?.modFiles || []) {
      const staged = getStagedCollectionEntry(file);
      for (const runtime of staged?.availableRuntimes || []) {
        if (runtime === "IL2CPP") stagedRuntimes.add("IL2CPP");
        if (runtime === "Mono" || runtime === "MONO") stagedRuntimes.add("Mono");
      }
    }
    if (stagedRuntimes.size > 0) return Array.from(stagedRuntimes);

    const configuredRuntimes = new Set<"IL2CPP" | "Mono">();
    for (const environment of environments) {
      const runtime = getNormalizedRuntime(environment);
      if (runtime === "IL2CPP" || runtime === "Mono") {
        configuredRuntimes.add(runtime);
      }
    }
    if (configuredRuntimes.size === 1) return Array.from(configuredRuntimes);

    return new Promise<Array<"IL2CPP" | "Mono">>((resolve) => {
      setRuntimePrompt({
        title: "Choose collection profile runtime",
        message:
          "Collection profiles are runtime-specific. Choose the game runtime this collection should prepare, or choose Both if you switch between Mono and IL2CPP environments.",
        onSelect: (runtime) =>
          resolve(runtime === "Both" ? ["Mono", "IL2CPP"] : [runtime]),
        onDismiss: () => resolve([]),
      });
    });
  }, [environments, getStagedCollectionEntry, selectedCollectionPlan?.modFiles]);

  const persistCollectionProfiles = useCallback(
    async (
      entries: ModLibraryEntry[],
      requestedRuntimes?: Array<"IL2CPP" | "Mono">,
      nexusCatalogs = collectionNexusFileCatalogsRef.current,
    ) => {
      if (!selectedNexusCollection || !selectedCollectionPlan) return [];
      const profileKey = `${selectedNexusCollection.slug}:${selectedCollectionPlan.revisionNumber}`;
      if (activeCollectionProfileKeyRef.current !== profileKey) return [];
      const runtimes =
        requestedRuntimes && requestedRuntimes.length > 0
          ? requestedRuntimes
          : collectionProfileRuntimesRef.current;
      if (runtimes.length === 0) return [];

      collectionProfileRuntimesRef.current = runtimes;
      const resolvedByFile = selectedCollectionPlan.modFiles.map((file) => {
        const exact = getStagedCollectionEntry(file, entries);
        if (exact) return { file, candidates: [exact] };
        const decision =
          collectionFileDecisionsRef.current[
            getCollectionFileDecisionKey(file)
          ];
        return {
          file,
          candidates:
            decision === "existing"
              ? getCollectionConflictingEntries(file, entries)
              : [],
        };
      });
      const buildKey = `${selectedNexusCollection.slug}:${selectedCollectionPlan.revisionNumber}:${runtimes.join(",")}:${resolvedByFile
        .map(({ file, candidates }) =>
          `${file.fileId}:${candidates
            .map((entry) => entry.storageId)
            .sort()
            .join("+") || "pending"}:${collectionSourceChoices[collectionFileKey(file)] ?? 'nexusmods'}:${collectionOptionalSelections[collectionFileKey(file)] ?? false}:${runtimes
              .map((runtime) => {
                const resolution = resolveCollectionNexusFileForRuntime(
                  file,
                  file.modId ? nexusCatalogs.get(file.modId) : undefined,
                  runtime,
                );
                if (!resolution) return `${runtime}:unavailable`;
                const runtimeFile = { ...file, fileId: resolution.fileId, fileName: resolution.fileName };
                const entry = findExactCollectionLibraryEntry(runtimeFile, entries, runtime);
                return `${runtime}:${resolution.fileId}:${entry ? resolveCollectionStorageId(entry, runtime) : 'pending'}`;
              })
              .join('+')}`,
        )
        .join(",")}`;
      if (collectionProfileBuildKeyRef.current === buildKey) {
        return collectionProfilesRef.current;
      }

      setCreatingCollectionProfile(true);
      try {
        const now = new Date().toISOString();
        const savedProfiles: StoredModProfile[] = [];
        for (const runtime of runtimes) {
          const existingProfile = collectionProfilesRef.current.find(
            (profile) =>
              profile.runtime === runtime ||
              (runtime === "Mono" && profile.runtime === "MONO"),
          );
          const profileName =
            runtimes.length === 1
              ? `${selectedNexusCollection.name} (Revision ${selectedCollectionPlan.revisionNumber})`
              : `${selectedNexusCollection.name} (Revision ${selectedCollectionPlan.revisionNumber}, ${runtime})`;
          const resolvedItems = resolvedByFile.map(({ file, candidates }) => {
            const key = collectionFileKey(file);
            const requestedChoice = nexusCollectionAccess?.canDirectDownload
              ? 'nexusmods'
              : collectionSourceChoices[key] ?? 'nexusmods';
            const nexusResolution = requestedChoice === 'nexusmods'
              ? resolveCollectionNexusFileForRuntime(
                file,
                file.modId ? nexusCatalogs.get(file.modId) : undefined,
                runtime,
              )
              : null;
            const runtimeFile = nexusResolution
              ? {
                ...file,
                fileId: nexusResolution.fileId,
                fileName: nexusResolution.fileName,
              }
              : file;
            const sourceRuntime = inferCollectionNexusFileRuntime(file.fileName, file.modName);
            const nexusRuntimeUnavailable = Boolean(
              nexusCollectionAccess?.canDirectDownload
              && requestedChoice === 'nexusmods'
              && sourceRuntime
              && sourceRuntime !== runtime
              && !nexusResolution,
            );
            const exactLibraryEntry = nexusRuntimeUnavailable
              ? null
              : findExactCollectionLibraryEntry(runtimeFile, entries, runtime);
            const entry = exactLibraryEntry ||
              candidates.find(
                (candidate) =>
                  candidate.availableRuntimes.length === 0 ||
                  candidate.availableRuntimes.some(
                    (candidateRuntime) =>
                      candidateRuntime === runtime ||
                      (runtime === "Mono" && candidateRuntime === "MONO"),
                  ),
              ) || null;
            const storageId = entry
              ? resolveCollectionStorageId(entry, runtime)
              : null;
            const selected = !file.optional || Boolean(collectionOptionalSelections[key]);
            const matchSelection = selectCollectionThunderstoreMatch(
              collectionMatchStates[key]?.matches ?? [],
              runtime,
            );
            const sourceChoice: 'library' | CollectionSourceChoice = entry ? 'library' : requestedChoice;
            const item = {
              itemType: "mod" as const,
              name: entry?.displayName || file.modName,
              fileName: entry?.files[0] || runtimeFile.fileName,
              required: !file.optional,
              enabled: selected,
              source: entry?.source || (requestedChoice === 'thunderstore' && matchSelection.match
                ? 'thunderstore' as const
                : 'nexusmods' as const),
              sourceId:
                entry?.sourceId
                || (requestedChoice === 'thunderstore' ? matchSelection.match?.sourceId : null)
                || (file.modId ? String(file.modId) : null),
              sourceVersion:
                entry?.sourceVersion || entry?.installedVersion || file.version,
              sourceUrl:
                entry?.sourceUrl ||
                (requestedChoice === 'thunderstore' ? matchSelection.match?.packageUrl : null) ||
                (file.modId
                  ? `https://www.nexusmods.com/schedule1/mods/${file.modId}`
                  : null),
              runtime,
              storageId,
              nexusFileId:
                entry?.nexusFileId ||
                (entry ? getNexusFileIdFromTags(entry.tags) : null) ||
                String(runtimeFile.fileId),
              manualReason: !selected
                ? "This optional collection mod was not selected."
                : storageId
                  ? null
                  : nexusRuntimeUnavailable
                    ? `Nexus does not expose an exact ${file.version} file for ${runtime}.`
                  : requestedChoice === 'thunderstore' && matchSelection.runtimeMismatch
                  ? `Exact version ${file.version} is available for ${matchSelection.match?.runtime}, not ${runtime}. Confirm this download individually if you still want it.`
                : requestedChoice === 'thunderstore' && matchSelection.match
                  ? `Exact Thunderstore version ${file.version} is queued for this collection profile.`
                : file.available
                  ? "Download the exact Nexus file from the website to complete this profile item."
                  : "This collection file is no longer available from Nexus.",
            };
            const collectionItem = {
              key,
              nexusModId: file.modId ?? null,
              collectionFileId: String(file.fileId),
              nexusFileId: String(runtimeFile.fileId),
              requestedName: file.modName,
              requestedAuthor: file.author ?? null,
              requestedVersion: file.version,
              requestedSizeInBytes: file.sizeInBytes ?? null,
              optional: file.optional,
              selected,
              sourceChoice,
              status: !selected
                ? 'pending' as const
                : storageId
                  ? 'ready' as const
                  : nexusRuntimeUnavailable
                    ? 'runtimeMismatch' as const
                  : requestedChoice === 'thunderstore' && matchSelection.runtimeMismatch
                    ? 'runtimeMismatch' as const
                    : requestedChoice === 'thunderstore' && matchSelection.match
                      ? 'queued' as const
                      : 'manualRequired' as const,
              statusMessage: !selected
                ? 'Optional mod not selected.'
                : storageId
                  ? `Reused the exact ${entry?.source ?? 'library'} copy already in the library.`
                  : nexusRuntimeUnavailable
                    ? `No exact ${file.version} Nexus file is available for ${runtime}. The ${file.fileId} collection file targets ${sourceRuntime}.`
                  : requestedChoice === 'thunderstore' && matchSelection.runtimeMismatch
                    ? `Exact ${file.version} match is for ${matchSelection.match?.runtime}; ${runtime} profile requires confirmation.`
                    : requestedChoice === 'thunderstore' && matchSelection.match
                      ? `Exact ${file.version} Thunderstore match queued.`
                      : `Exact Nexus file ${file.fileId} must be downloaded from Nexus.`,
              thunderstoreMatch: matchSelection.match ? {
                packageUuid: matchSelection.match.packageUuid,
                versionUuid: matchSelection.match.versionUuid,
                sourceId: matchSelection.match.sourceId,
                packageUrl: matchSelection.match.packageUrl,
                runtime: matchSelection.match.runtime,
              } : null,
              runtimeMismatch: nexusRuntimeUnavailable || matchSelection.runtimeMismatch,
            };
            return { item, collectionItem };
          });
          const items = resolvedItems.map(({ item }) => item);
          const saved = await ApiService.saveModProfile({
            profileId: existingProfile?.id,
            name: profileName,
            runtime,
            manifest: {
              schemaVersion: 1,
              kind: "simm.profile",
              profileId: existingProfile?.id || null,
              isDefault: false,
              createdAt: existingProfile?.createdAt || null,
              updatedAt: existingProfile?.updatedAt || null,
              profile: {
                name: profileName,
                game: "schedule-i",
                environmentId: null,
                runtime,
                branch: "any",
                gameVersion: null,
                exportedAt: now,
              },
              items,
              collection: {
                slug: selectedNexusCollection.slug,
                name: selectedNexusCollection.name,
                revisionNumber: selectedCollectionPlan.revisionNumber,
                sourceUrl: `https://next.nexusmods.com/schedule1/collections/${selectedNexusCollection.slug}`,
                items: resolvedItems.map(({ collectionItem }) => collectionItem),
              },
            },
          });
          savedProfiles.push(saved);
          window.dispatchEvent(new CustomEvent('mod-profiles-updated', { detail: { profileId: saved.id } }));
        }
        collectionProfilesRef.current = savedProfiles;
        setCollectionProfiles(savedProfiles);
        collectionProfileBuildKeyRef.current = buildKey;
        return savedProfiles;
      } finally {
        setCreatingCollectionProfile(false);
      }
    },
    [
      getCollectionConflictingEntries,
      getCollectionFileDecisionKey,
      getStagedCollectionEntry,
      collectionMatchStates,
      collectionOptionalSelections,
      collectionSourceChoices,
      nexusCollectionAccess?.canDirectDownload,
      selectedCollectionPlan,
      selectedNexusCollection,
    ],
  );

  const ensureCollectionProfilesStarted = useCallback(async () => {
    const runtimes = collectionProfileRuntimesRef.current.length > 0
      ? collectionProfileRuntimesRef.current
      : await requestCollectionProfileRuntimes();
    if (runtimes.length === 0) return [];
    try {
      const nexusCatalogs = nexusCollectionAccess?.canDirectDownload && selectedCollectionPlan
        ? await loadCollectionNexusRuntimeCatalogs(selectedCollectionPlan.modFiles)
        : collectionNexusFileCatalogsRef.current;
      return await persistCollectionProfiles(
        library?.downloaded || [],
        runtimes,
        nexusCatalogs,
      );
    } catch (error) {
      showLibraryNotice(
        "Collection Profile Failed",
        error instanceof Error
          ? error.message
          : "SIMM could not create the collection profile before staging files.",
      );
      return [];
    }
  }, [
    library?.downloaded,
    loadCollectionNexusRuntimeCatalogs,
    nexusCollectionAccess?.canDirectDownload,
    persistCollectionProfiles,
    requestCollectionProfileRuntimes,
    selectedCollectionPlan,
    showLibraryNotice,
  ]);

  const saveCollectionFileStatus = useCallback(async (
    profiles: StoredModProfile[],
    file: NexusCollectionModFile,
    status: 'downloading' | 'error',
    statusMessage: string,
    targetRuntimes?: Array<'IL2CPP' | 'Mono'>,
    resolvedFile?: { fileId: number; fileName: string },
  ) => {
    const key = collectionFileKey(file);
    const savedProfiles: StoredModProfile[] = [];
    for (const profile of profiles) {
      const profileRuntime = profile.runtime === 'IL2CPP' ? 'IL2CPP' : 'Mono';
      if (targetRuntimes && !targetRuntimes.includes(profileRuntime)) {
        savedProfiles.push(profile);
        continue;
      }
      const collection = profile.manifest.collection;
      if (!collection || !collection.items.some((item) => item.key === key && item.selected)) {
        savedProfiles.push(profile);
        continue;
      }
      const currentCollectionItem = collection.items.find((item) => item.key === key);
      const resolvedFileId = String(resolvedFile?.fileId ?? currentCollectionItem?.nexusFileId ?? file.fileId);
      const saved = await ApiService.saveModProfile({
        profileId: profile.id,
        name: profile.name,
        runtime: profile.runtime === 'MONO' ? 'Mono' : profile.runtime,
        manifest: {
          ...profile.manifest,
          items: profile.manifest.items.map((item) => {
            const matchesCollectionItem = item.nexusFileId === currentCollectionItem?.nexusFileId
              || (
                item.sourceId === String(file.modId ?? '')
                && normalizeVersionToken(item.sourceVersion ?? '') === normalizeVersionToken(file.version)
              );
            return matchesCollectionItem
              ? {
                ...item,
                fileName: resolvedFile?.fileName ?? item.fileName,
                nexusFileId: resolvedFileId,
                runtime: profileRuntime,
              }
              : item;
          }),
          collection: {
            ...collection,
            items: collection.items.map((item) => item.key === key
              ? {
                ...item,
                collectionFileId: item.collectionFileId ?? String(file.fileId),
                nexusFileId: resolvedFileId,
                status,
                statusMessage,
              }
              : item),
          },
        },
      });
      savedProfiles.push(saved);
      window.dispatchEvent(new CustomEvent('mod-profiles-updated', { detail: { profileId: saved.id } }));
    }
    collectionProfilesRef.current = savedProfiles;
    setCollectionProfiles(savedProfiles);
    return savedProfiles;
  }, []);

  const runCollectionThunderstoreBatch = useCallback(async (initialProfiles: StoredModProfile[]) => {
    if (!selectedNexusCollection) return;
    const downloadId = `collection:${selectedNexusCollection.slug}:${selectedCollectionPlan?.revisionNumber ?? 0}`;
    const startedAt = Date.now();
    const profiles = [...initialProfiles];
    const autoItems = profiles.flatMap((profile, profileIndex) =>
      (profile.manifest.collection?.items ?? [])
        .filter((item) => item.selected && item.sourceChoice === 'thunderstore' && item.status === 'queued' && !item.runtimeMismatch)
        .map((item) => ({ profileIndex, key: item.key })),
    );
    const selectedItems = profiles.flatMap((profile) =>
      (profile.manifest.collection?.items ?? []).filter((item) => item.selected),
    );
    const readyAtStart = selectedItems.filter((item) => item.status === 'ready').length;
    const manualCount = selectedItems.filter((item) => item.status === 'manualRequired' || item.status === 'runtimeMismatch').length;
    let completed = 0;
    let failed = 0;

    const publish = (status: 'downloading' | 'completed' | 'error', message: string, error?: string) => {
      const finished = status === 'downloading' ? null : Date.now();
      const done = readyAtStart + completed;
      const total = Math.max(1, selectedItems.length);
      publishDownload({
        id: downloadId,
        kind: 'collection',
        label: selectedNexusCollection.name,
        contextLabel: `Revision ${selectedCollectionPlan?.revisionNumber ?? selectedNexusCollection.revision_number ?? ''} collection profile`,
        status,
        progress: status === 'completed' ? 100 : Math.round((done / total) * 100),
        downloadedFiles: done,
        totalFiles: selectedItems.length,
        iconUrl: selectedNexusCollection.tile_image_url,
        message,
        error,
        startedAt,
        finishedAt: finished,
        profileId: profiles[0]?.id,
        persistent: true,
      });
    };

    const saveItemStatus = async (
      profileIndex: number,
      key: string,
      status: 'downloading' | 'error',
      statusMessage: string,
    ) => {
      const profile = profiles[profileIndex];
      const collection = profile.manifest.collection;
      if (!collection) return;
      const saved = await ApiService.saveModProfile({
        profileId: profile.id,
        name: profile.name,
        runtime: profile.runtime === 'MONO' ? 'Mono' : profile.runtime,
        manifest: {
          ...profile.manifest,
          collection: {
            ...collection,
            items: collection.items.map((item) => item.key === key ? {
              ...item,
              status,
              statusMessage,
            } : item),
          },
        },
      });
      profiles[profileIndex] = saved;
      window.dispatchEvent(new CustomEvent('mod-profiles-updated', { detail: { profileId: saved.id } }));
    };

    publish('downloading', autoItems.length > 0
      ? `Downloading ${autoItems.length} exact Thunderstore ${autoItems.length === 1 ? 'match' : 'matches'} in the background.`
      : 'Collection profile created. Review the remaining items in Profiles.');

    for (const work of autoItems) {
      const profile = profiles[work.profileIndex];
      const collectionItem = profile.manifest.collection?.items.find((item) => item.key === work.key);
      const match = collectionItem?.thunderstoreMatch;
      if (!collectionItem || !match) continue;
      try {
        await saveItemStatus(work.profileIndex, work.key, 'downloading', `Downloading exact Thunderstore version ${collectionItem.requestedVersion}.`);
        const result = await ApiService.downloadThunderstoreToLibrary(
          match.packageUuid,
          profile.runtime === 'IL2CPP' ? 'IL2CPP' : 'Mono',
          undefined,
          match.versionUuid,
        );
        if (!result.success) {
          const gated = result.securityScanConfirmationRequired || result.securityScanBlocked;
          throw new Error(gated
            ? 'Security review is required. Retry this item from the collection profile.'
            : 'Thunderstore did not complete the download.');
        }
        const nextLibrary = await ApiService.getModLibrary();
        const synced = updateCollectionProfileFromLibrary(profiles[work.profileIndex], nextLibrary.downloaded);
        profiles[work.profileIndex] = await ApiService.saveModProfile({
          profileId: synced.id,
          name: synced.name,
          runtime: synced.runtime === 'MONO' ? 'Mono' : synced.runtime,
          manifest: synced.manifest,
        });
        completed += 1;
        window.dispatchEvent(new CustomEvent('mod-profiles-updated', { detail: { profileId: synced.id } }));
        publish('downloading', `${readyAtStart + completed} of ${selectedItems.length} collection items are ready.`);
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : 'Thunderstore download failed.';
        await saveItemStatus(work.profileIndex, work.key, 'error', message);
        publish('downloading', `${readyAtStart + completed} of ${selectedItems.length} collection items are ready; ${failed} failed.`);
      }
    }

    const summary = `${readyAtStart + completed} ready${manualCount > 0 ? `, ${manualCount} need individual action` : ''}${failed > 0 ? `, ${failed} failed` : ''}.`;
    publish(failed > 0 ? 'error' : 'completed', summary, failed > 0 ? 'Some collection items need another attempt.' : undefined);
  }, [publishDownload, selectedCollectionPlan?.revisionNumber, selectedNexusCollection]);

  const beginCollectionManualStage = useCallback(
    async (file: NexusCollectionModFile) => {
      if (!file.modId || !file.available) {
        showLibraryNotice(
          "Collection File Unavailable",
          "Nexus no longer exposes the exact file required by this collection revision.",
        );
        return;
      }
      setDownloading(`collection-manual-${file.fileId}`);
      try {
        await beginManualNexusLibraryDownload(
          file.modId,
          file.fileId,
          undefined,
          async () => {
            const nextLibrary = await refreshCollectionStaging();
            await persistCollectionProfiles(nextLibrary.downloaded);
            showToast(
              `${file.modName} is staged in the collection profile. Continue with the next missing file when ready.`,
            );
          },
          "Collection Staging Failed",
        );
      } catch (error) {
        setDownloading(null);
        showLibraryNotice(
          "Collection Staging Failed",
          error instanceof Error
            ? error.message
            : "SIMM could not open the Nexus manual download flow.",
        );
      }
    },
    [
      beginManualNexusLibraryDownload,
      persistCollectionProfiles,
      refreshCollectionStaging,
      showLibraryNotice,
      showToast,
    ],
  );

  const downloadCollectionFile = useCallback(
    async (
      file: NexusCollectionModFile,
      decisionOverride?: "collection" | "existing",
      runtime?: 'IL2CPP' | 'Mono',
    ) => {
      if (!nexusCollectionAccess?.connected) {
        showLibraryNotice(
          "Nexus Login Required",
          "Log into Nexus in Accounts before staging collection files.",
          onOpenAccounts
            ? { label: "Open Accounts", onAction: onOpenAccounts }
            : undefined,
        );
        return "failed" as const;
      }
      const decisionKey = getCollectionFileDecisionKey(file);
      const conflictingEntries = getCollectionConflictingEntries(file);
      let decision = decisionOverride || collectionFileDecisions[decisionKey];
      if (conflictingEntries.length > 0 && !decision) {
        if (nexusCollectionAccess.canDirectDownload) {
          enqueueCollectionConflict(file, conflictingEntries);
          return "queued" as const;
        }
        const choice = await requestCollectionConflictChoice(
          file,
          conflictingEntries,
        );
        if (choice === "cancel") return "cancelled" as const;
        decision = choice;
        recordCollectionFileDecision(decisionKey, choice);
      }
      if (decision === "existing") {
        return "kept" as const;
      }
      if (!nexusCollectionAccess.canDirectDownload) {
        await beginCollectionManualStage(file);
        return "manual" as const;
      }
      if (!file.modId || !file.available) {
        return "failed" as const;
      }

      setCollectionActiveDownloadIds((current) =>
        new Set(current).add(file.fileId),
      );
      try {
        const result = await downloadNexusWithSecurity(
          file.modId,
          file.fileId,
          runtime,
          `Security Findings - ${file.modName}${runtime ? ` (${runtime})` : ''}`,
        );
        return result?.success ? ("downloaded" as const) : ("failed" as const);
      } finally {
        setCollectionActiveDownloadIds((current) => {
          const next = new Set(current);
          next.delete(file.fileId);
          return next;
        });
      }
    },
    [
      beginCollectionManualStage,
      collectionFileDecisions,
      downloadNexusWithSecurity,
      enqueueCollectionConflict,
      getCollectionConflictingEntries,
      getCollectionFileDecisionKey,
      nexusCollectionAccess,
      onOpenAccounts,
      recordCollectionFileDecision,
      requestCollectionConflictChoice,
      showLibraryNotice,
    ],
  );

  const handleStageSingleCollectionFile = useCallback(
    async (
      file: NexusCollectionModFile,
      decisionOverride?: "collection" | "existing",
    ) => {
      const profiles = await ensureCollectionProfilesStarted();
      if (profiles.length === 0) return;
      try {
        const outcome = await downloadCollectionFile(file, decisionOverride);
        if (outcome === "downloaded" || outcome === "kept") {
          const nextLibrary = await refreshCollectionStaging();
          await persistCollectionProfiles(nextLibrary.downloaded);
        }
      } catch (error) {
        showLibraryNotice(
          "Collection Staging Failed",
          error instanceof Error
            ? error.message
            : "SIMM could not stage this collection file.",
        );
      }
    }, [
      downloadCollectionFile,
      ensureCollectionProfilesStarted,
      persistCollectionProfiles,
      refreshCollectionStaging,
      showLibraryNotice,
    ]);

  const handleCollectionConflictChoice = useCallback(
    (choice: CollectionConflictChoice) => {
      const conflict = collectionConflict;
      if (!conflict) return;
      const hadWaitingDownload =
        collectionConflictResolutionRef.current !== null;
      if (choice !== "cancel") {
        const decisionKey = getCollectionFileDecisionKey(conflict.file);
        recordCollectionFileDecision(decisionKey, choice);
      }
      resolveCollectionConflict(choice);
      if (
        !hadWaitingDownload &&
        choice === "collection" &&
        nexusCollectionAccess?.canDirectDownload
      ) {
        void handleStageSingleCollectionFile(conflict.file, "collection");
      }
    },
    [
      collectionConflict,
      getCollectionFileDecisionKey,
      handleStageSingleCollectionFile,
      nexusCollectionAccess?.canDirectDownload,
      recordCollectionFileDecision,
      resolveCollectionConflict,
    ],
  );

  const handleStageCollection = useCallback(async () => {
    if (!selectedNexusCollection || !selectedCollectionPlan) return;
    let profiles = await ensureCollectionProfilesStarted();
    if (profiles.length === 0) return;
    onOpenProfile?.(profiles[0].id);

    if (!nexusCollectionAccess?.canDirectDownload) {
      void runCollectionThunderstoreBatch(profiles);
      return;
    }
    if (!nexusCollectionAccess?.connected) {
      showLibraryNotice(
        "Nexus Login Required",
        "Log into Nexus in Accounts before staging this collection.",
        onOpenAccounts
          ? { label: "Open Accounts", onAction: onOpenAccounts }
          : undefined,
      );
      return;
    }

    const failures = unavailableSelectedCollectionFiles.flatMap((file) =>
      profiles.map((profile) => `${file.modName} (${profile.runtime === 'IL2CPP' ? 'IL2CPP' : 'Mono'}): exact Nexus file is unavailable`),
    );
    const runtimeResolutionFailures = new Set<string>();
    const downloadTasks = new Map<string, {
      file: NexusCollectionModFile;
      resolvedFile: { fileId: number; fileName: string };
      targetRuntimes: Array<'IL2CPP' | 'Mono'>;
    }>();
    for (const file of selectedCollectionFiles) {
      for (const profile of profiles) {
        const runtime = profile.runtime === 'IL2CPP' ? 'IL2CPP' : 'Mono';
        const item = profile.manifest.collection?.items.find(
          (candidate) => candidate.key === collectionFileKey(file),
        );
        if (!item?.selected || item.status === 'ready') continue;
        if (item.status === 'runtimeMismatch') {
          runtimeResolutionFailures.add(`${file.modName} (${runtime}): ${item.statusMessage || `no exact ${runtime} file is available`}`);
          continue;
        }
        const fileId = Number(item.nexusFileId);
        if (!Number.isFinite(fileId) || fileId <= 0) {
          runtimeResolutionFailures.add(`${file.modName} (${runtime}): Nexus did not provide a valid exact-version file ID`);
          continue;
        }
        const profileItem = profile.manifest.items.find((candidate) =>
          candidate.nexusFileId === item.nexusFileId
          || (
            candidate.sourceId === String(file.modId ?? '')
            && normalizeVersionToken(candidate.sourceVersion ?? '') === normalizeVersionToken(file.version)
          ),
        );
        const taskKey = `${file.modId ?? 0}:${fileId}`;
        const existingTask = downloadTasks.get(taskKey);
        if (existingTask) {
          if (!existingTask.targetRuntimes.includes(runtime)) existingTask.targetRuntimes.push(runtime);
        } else {
          downloadTasks.set(taskKey, {
            file,
            resolvedFile: {
              fileId,
              fileName: profileItem?.fileName || file.fileName,
            },
            targetRuntimes: [runtime],
          });
        }
      }
    }
    failures.push(...runtimeResolutionFailures);
    const premiumDownloads = Array.from(downloadTasks.values());
    const aggregateId = `collection:${selectedNexusCollection.slug}:${selectedCollectionPlan.revisionNumber}`;
    const aggregateStartedAt = Date.now();
    const aggregateTotal = profiles.reduce(
      (count, profile) => count + (profile.manifest.collection?.items.filter((item) => item.selected).length ?? 0),
      0,
    );
    const countReadyProfileItems = (currentProfiles: StoredModProfile[]) => currentProfiles.reduce(
      (count, profile) => count + (profile.manifest.collection?.items.filter((item) => item.selected && item.status === 'ready').length ?? 0),
      0,
    );
    let completedFiles = countReadyProfileItems(profiles);
    const publishPremiumProgress = (status: 'downloading' | 'completed' | 'error', message: string, error?: string) => {
      publishDownload({
        id: aggregateId,
        kind: 'collection',
        label: selectedNexusCollection.name,
        contextLabel: `Revision ${selectedCollectionPlan.revisionNumber} collection profile`,
        status,
        progress: status === 'completed' ? 100 : Math.round((completedFiles / Math.max(1, aggregateTotal)) * 100),
        downloadedFiles: completedFiles,
        totalFiles: aggregateTotal,
        iconUrl: selectedNexusCollection.tile_image_url,
        message,
        error,
        startedAt: aggregateStartedAt,
        finishedAt: status === 'downloading' ? null : Date.now(),
        profileId: profiles[0].id,
        persistent: true,
      });
    };
    publishPremiumProgress(
      'downloading',
      `Downloading ${premiumDownloads.length} exact Nexus ${premiumDownloads.length === 1 ? 'file' : 'files'} for ${profiles.length} runtime ${profiles.length === 1 ? 'profile' : 'profiles'}.`,
    );
    try {
      for (const task of premiumDownloads) {
        const runtimeLabel = task.targetRuntimes.length === 1 ? task.targetRuntimes[0] : 'shared runtimes';
        const downloadFile = {
          ...task.file,
          fileId: task.resolvedFile.fileId,
          fileName: task.resolvedFile.fileName,
        };
        try {
          profiles = await saveCollectionFileStatus(
            profiles,
            task.file,
            'downloading',
            `Downloading exact Nexus file ${task.resolvedFile.fileId} for ${runtimeLabel}.`,
            task.targetRuntimes,
            task.resolvedFile,
          );
          publishPremiumProgress(
            'downloading',
            `Downloading ${task.file.modName} for ${runtimeLabel}. ${completedFiles} of ${aggregateTotal} profile items are ready.`,
          );
          const outcome = await downloadCollectionFile(
            downloadFile,
            'collection',
            task.targetRuntimes.length === 1 ? task.targetRuntimes[0] : undefined,
          );
          if (outcome === "cancelled" || outcome === "manual") {
            break;
          }
          if (outcome === "failed") {
            failures.push(`${task.file.modName} (${runtimeLabel})`);
            profiles = await saveCollectionFileStatus(
              profiles,
              task.file,
              'error',
              `The exact Nexus download or its security scan did not complete for ${runtimeLabel}. Retry this item from the profile.`,
              task.targetRuntimes,
              task.resolvedFile,
            );
            continue;
          }
          if (outcome === "downloaded" || outcome === "kept") {
            const nextLibrary = await refreshCollectionStaging();
            profiles = await persistCollectionProfiles(
              nextLibrary.downloaded,
              undefined,
              collectionNexusFileCatalogsRef.current,
            );
            const unresolvedRuntimes = task.targetRuntimes.filter((runtime) =>
              profiles.some((profile) => {
                const profileRuntime = profile.runtime === 'IL2CPP' ? 'IL2CPP' : 'Mono';
                return profileRuntime === runtime
                  && profile.manifest.collection?.items.some(
                    (item) => item.key === collectionFileKey(task.file) && item.selected && item.status !== 'ready',
                  );
              }),
            );
            if (unresolvedRuntimes.length > 0) {
              const unresolvedLabel = unresolvedRuntimes.join(' + ');
              const message = `Nexus file ${task.resolvedFile.fileId} downloaded, but it did not contain a compatible ${unresolvedLabel} payload.`;
              failures.push(`${task.file.modName} (${unresolvedLabel}): ${message}`);
              profiles = await saveCollectionFileStatus(
                profiles,
                task.file,
                'error',
                message,
                unresolvedRuntimes,
                task.resolvedFile,
              );
            }
            completedFiles = countReadyProfileItems(profiles);
            publishPremiumProgress('downloading', `${completedFiles} of ${aggregateTotal} selected profile items are ready.`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "download failed";
          failures.push(`${task.file.modName} (${runtimeLabel}): ${message}`);
          profiles = await saveCollectionFileStatus(
            profiles,
            task.file,
            'error',
            `${runtimeLabel}: ${message}`,
            task.targetRuntimes,
            task.resolvedFile,
          );
        }
      }
      const nextLibrary = await refreshCollectionStaging();
      profiles = await persistCollectionProfiles(
        nextLibrary.downloaded,
        undefined,
        collectionNexusFileCatalogsRef.current,
      );
      completedFiles = countReadyProfileItems(profiles);
      if (failures.length > 0) {
        publishPremiumProgress('error', `${completedFiles} of ${aggregateTotal} selected profile items are ready.`, 'Some runtime-specific collection files need another attempt.');
        showLibraryNotice(
          "Collection Profile Partially Staged",
          `SIMM kept every completed file in the collection profiles. ${failures.length} runtime-specific ${failures.length === 1 ? "item needs" : "items need"} attention; the first issue was ${failures[0]}.`,
        );
      } else {
        publishPremiumProgress('completed', `${completedFiles} of ${aggregateTotal} selected profile items are ready.`);
        showLibraryNotice(
          "Collection Files Staged",
          `${selectedNexusCollection.name} has all selected Nexus files in the library.`,
        );
      }
    } finally {
      setDownloading(null);
    }
  }, [
    downloadCollectionFile,
    ensureCollectionProfilesStarted,
    nexusCollectionAccess,
    onOpenAccounts,
    onOpenProfile,
    publishDownload,
    persistCollectionProfiles,
    refreshCollectionStaging,
    selectedNexusCollection,
    selectedCollectionPlan,
    selectedCollectionFiles,
    saveCollectionFileStatus,
    showLibraryNotice,
    runCollectionThunderstoreBatch,
    unavailableSelectedCollectionFiles,
  ]);

  const confirmStageCollection = useCallback(() => {
    if (!selectedNexusCollection || !selectedCollectionPlan) return;
    const exactMatches = selectedCollectionPlan.modFiles.filter((file) => {
      const key = collectionFileKey(file);
      return (!file.optional || collectionOptionalSelections[key])
        && collectionSourceChoices[key] === 'thunderstore'
        && (collectionMatchStates[key]?.matches.length ?? 0) > 0;
    }).length;
    const nexusRequired = selectedCollectionPlan.modFiles.filter((file) => {
      const key = collectionFileKey(file);
      return (!file.optional || collectionOptionalSelections[key])
        && (collectionSourceChoices[key] ?? 'nexusmods') === 'nexusmods';
    }).length;
    setConfirmOverlay({
      isOpen: true,
      title: `Create ${selectedNexusCollection.name} profile?`,
      message: nexusCollectionAccess?.canDirectDownload
        ? `SIMM will create and open a new collection profile, then download ${missingSelectedCollectionFiles.length} exact Nexus files in the background. All required mods and ${selectedOptionalCollectionCount} selected optional ${selectedOptionalCollectionCount === 1 ? 'mod are' : 'mods are'} included. Existing profiles and installed mods are not overwritten.`
        : `SIMM will create and open a new collection profile. ${exactMatches} exact Thunderstore ${exactMatches === 1 ? 'match' : 'matches'} can download automatically; ${nexusRequired} ${nexusRequired === 1 ? 'item keeps' : 'items keep'} the Nexus website flow. Optional mods remain excluded unless selected.`,
      confirmText: 'Create Profile & Start',
      cancelText: 'Review choices',
      onConfirm: () => {
        closeConfirmOverlay();
        void handleStageCollection();
      },
    });
  }, [
    closeConfirmOverlay,
    collectionMatchStates,
    collectionOptionalSelections,
    collectionSourceChoices,
    handleStageCollection,
    missingSelectedCollectionFiles.length,
    nexusCollectionAccess?.canDirectDownload,
    selectedOptionalCollectionCount,
    selectedCollectionPlan,
    selectedNexusCollection,
  ]);

  const createCollectionProfiles = useCallback(async () => {
    if (creatingCollectionProfile) return;
    const savedProfiles = await ensureCollectionProfilesStarted();
    if (savedProfiles.length > 0) {
      onOpenProfile?.(savedProfiles[0].id);
      showLibraryNotice(
        collectionReadyForProfile
          ? "Collection Profile Ready"
          : "Collection Profile Started",
        `${savedProfiles.map((profile) => profile.name).join(" and ")} ${collectionReadyForProfile ? "is ready to switch on" : "now contains the complete collection manifest and will retain each file as it is staged"}. Your current installed state was not overwritten.`,
      );
    }
  }, [
    collectionReadyForProfile,
    creatingCollectionProfile,
    ensureCollectionProfilesStarted,
    onOpenProfile,
    showLibraryNotice,
  ]);

  const selectedNexusFiles = useMemo(() => {
    if (selectedNexusModId === null) {
      return [];
    }
    return sortNexusFilesNewestFirst(
      nexusModsFiles.get(selectedNexusModId) || [],
    );
  }, [nexusModsFiles, selectedNexusModId]);

  const selectedNexusStoredFileId = useMemo(() => {
    if (selectedDownloadedEntry?.source !== "nexusmods") {
      return null;
    }
    const fileId = Number(getNexusFileIdFromTags(selectedDownloadedEntry.tags));
    return Number.isSafeInteger(fileId) && fileId > 0 ? fileId : null;
  }, [selectedDownloadedEntry]);

  const selectedNexusFile = useMemo(() => {
    if (selectedNexusModId === null) {
      return null;
    }
    if (selectedNexusStoredFileId !== null) {
      return (
        selectedNexusFiles.find(
          (file) => file.file_id === selectedNexusStoredFileId,
        ) || null
      );
    }
    const selectedFileId =
      selectedNexusFileByModId[selectedNexusModId];
    return (
      selectedNexusFiles.find((file) => file.file_id === selectedFileId) ||
      selectedNexusFiles[0] ||
      null
    );
  }, [
    selectedNexusFileByModId,
    selectedNexusFiles,
    selectedNexusModId,
    selectedNexusStoredFileId,
  ]);

  useEffect(() => {
    if (selectedNexusModId === null || !selectedNexusFile?.file_id) {
      setNexusDependencyState((previous) => {
        if (
          previous.key === null &&
          !previous.loading &&
          previous.report === null &&
          previous.error === null
        ) {
          return previous;
        }
        return { key: null, loading: false, report: null, error: null };
      });
      return;
    }

    void loadNexusDependencyReport(selectedNexusModId, selectedNexusFile.file_id);
  }, [loadNexusDependencyReport, selectedNexusFile?.file_id, selectedNexusModId]);

  const selectedNexusDependencyKey =
    selectedNexusModId !== null && selectedNexusFile?.file_id
      ? `${selectedNexusModId}:${selectedNexusFile.file_id}`
      : null;
  const selectedNexusDependencies =
    nexusDependencyState.key === selectedNexusDependencyKey
      ? nexusDependencyState.report
      : null;
  const visibleSelectedNexusRequirements =
    selectedNexusDependencies?.requirements.filter(
      (requirement) => getVisibleNexusDependencyCandidates(requirement).length > 0,
    ) || [];
  const missingSelectedNexusRequirements = selectedNexusDependencies
    ? getMissingNexusDependencies(selectedNexusDependencies, downloadedGroups)
    : [];

  const downloadedGroupForSelectedThunderstore = useMemo(() => {
    if (!selectedThunderstorePackage) {
      return null;
    }
    return findDownloadedGroupForThunderstorePackage(
      selectedThunderstorePackage,
    );
  }, [findDownloadedGroupForThunderstorePackage, selectedThunderstorePackage]);

  const downloadedGroupForSelectedNexus = useMemo(() => {
    if (selectedNexusModId === null) {
      return null;
    }
    return findDownloadedGroupForNexusMod(
      selectedNexusModId,
      undefined,
      selectedNexusFile?.file_id ?? undefined,
    );
  }, [findDownloadedGroupForNexusMod, selectedNexusFile, selectedNexusModId]);

  const selectedThunderstoreDownloadedEntry = useMemo(() => {
    if (!downloadedGroupForSelectedThunderstore) {
      return null;
    }
    return (
      getActiveEntryForGroup(downloadedGroupForSelectedThunderstore) ||
      downloadedGroupForSelectedThunderstore.entries[0] ||
      null
    );
  }, [downloadedGroupForSelectedThunderstore, getActiveEntryForGroup]);

  const selectedNexusDownloadedEntry = useMemo(() => {
    if (!downloadedGroupForSelectedNexus) {
      return null;
    }
    return (
      getActiveEntryForGroup(downloadedGroupForSelectedNexus) ||
      downloadedGroupForSelectedNexus.entries[0] ||
      null
    );
  }, [downloadedGroupForSelectedNexus, getActiveEntryForGroup]);

  useEffect(() => {
    if (
      !selectedThunderstorePackage ||
      selectedThunderstoreVersionOptions.length === 0
    ) {
      return;
    }

    setSelectedThunderstoreVersionByPackage((prev) => {
      if (
        prev[selectedThunderstorePackage.key] &&
        selectedThunderstoreVersionOptions.some(
          (option) => option.key === prev[selectedThunderstorePackage.key],
        )
      ) {
        return prev;
      }

      return {
        ...prev,
        [selectedThunderstorePackage.key]:
          selectedThunderstoreVersionOptions[0].key,
      };
    });
  }, [selectedThunderstorePackage, selectedThunderstoreVersionOptions]);

  useEffect(() => {
    if (selectedNexusModId === null || selectedNexusFiles.length === 0) {
      return;
    }

    setSelectedNexusFileByModId((prev) => {
      if (
        prev[selectedNexusModId] &&
        selectedNexusFiles.some(
          (file) => file.file_id === prev[selectedNexusModId],
        )
      ) {
        return prev;
      }

      const storedFile = selectedNexusFiles.find(
        (file) => file.file_id === selectedNexusStoredFileId,
      );
      if (selectedNexusStoredFileId !== null && !storedFile) {
        return prev;
      }

      return {
        ...prev,
        [selectedNexusModId]: storedFile?.file_id || selectedNexusFiles[0].file_id,
      };
    });
  }, [selectedNexusFiles, selectedNexusModId, selectedNexusStoredFileId]);

  useEffect(() => {
    if (
      !isOpen ||
      loadingLibrary ||
      libraryTab === "discover" ||
      activeModView?.kind !== "downloaded"
    ) {
      return;
    }

    const stillValid = displayedDownloadedGroups.some(
      (group) => group.key === activeModView.id,
    );
    if (!stillValid) {
      setActiveModView(null);
    }
  }, [
    activeModView,
    displayedDownloadedGroups,
    isOpen,
    libraryTab,
    loadingLibrary,
  ]);

  // Updates whose current scan result is an exception (potentially malicious, known threat,
  // needs review, not scannable) stay out of "Update All"; their own Update action keeps the gate.
  const isGroupSecurityFlagged = useCallback(
    (group: DownloadedModGroup): boolean => {
      const entry = getActiveEntryForGroup(group) || group.entries[0];
      return Boolean(getSecurityBadgeConfig(entry?.securityScan)?.exception);
    },
    [getActiveEntryForGroup],
  );

  const updatableDownloadedGroups = useMemo(
    () =>
      libraryTab === "updates"
        ? displayedDownloadedGroups.filter((group) => isGroupUpdateAvailable(group))
        : [],
    [displayedDownloadedGroups, isGroupUpdateAvailable, libraryTab],
  );
  const flaggedUpdateGroupCount = updatableDownloadedGroups.filter(isGroupSecurityFlagged).length;
  const bulkUpdateGroupCount = updatableDownloadedGroups.length - flaggedUpdateGroupCount;
  const updateAllGroupsTitle =
    flaggedUpdateGroupCount === 0
      ? undefined
      : bulkUpdateGroupCount === 0
        ? `Every available update needs a security review. Open ${flaggedUpdateGroupCount === 1 ? "the mod" : "each mod"} and update it from its own page.`
        : `${flaggedUpdateGroupCount} ${flaggedUpdateGroupCount === 1 ? "update needs" : "updates need"} a security review and ${flaggedUpdateGroupCount === 1 ? "is" : "are"} not included. Open ${flaggedUpdateGroupCount === 1 ? "the mod" : "each mod"} to update it on its own.`;

  const handleUpdateAllGroups = useCallback(async () => {
    const groups = displayedDownloadedGroups.filter(
      (group) => isGroupUpdateAvailable(group) && !isGroupSecurityFlagged(group),
    );
    if (groups.length === 0) {
      return;
    }
    setUpdatingAllGroups(true);
    try {
      for (const group of groups) {
        try {
          await handleUpdateAndActivateGroup(group);
        } catch (error) {
          logger.warn("Update All skipped a mod that failed to update", {
            groupKey: group.key,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      setUpdatingAllGroups(false);
    }
  }, [displayedDownloadedGroups, handleUpdateAndActivateGroup, isGroupSecurityFlagged, isGroupUpdateAvailable]);

  const openContextMenu = useCallback(
    (event: ReactMouseEvent, items: AnchoredContextMenuItem[]) => {
      event.preventDefault();
      setContextMenu({ x: event.clientX, y: event.clientY, items });
    },
    [],
  );

  const downloadedContextMenuItems = useCallback(
    (group: DownloadedModGroup): AnchoredContextMenuItem[] => {
      const entry = getActiveEntryForGroup(group) || group.entries[0];
      return [
        {
          key: "install",
          label: "Install to…",
          icon: "fas fa-download",
          disabled: !entry,
          onSelect: () => {
            if (entry) {
              void promptInstallTargets(
                entry,
                `Install ${entry.displayName}`,
                group.installedIn.length > 0,
              );
            }
          },
        },
        {
          key: "update",
          label: "Update",
          icon: "fas fa-arrow-up",
          disabled: !isGroupUpdateAvailable(group),
          onSelect: () => {
            void handleUpdateAndActivateGroup(group);
          },
        },
        {
          key: "activate",
          label: "Activate version",
          icon: "fas fa-check",
          disabled: !entry || group.installedIn.length === 0,
          onSelect: () => {
            if (entry) {
              void handleSelectVersion(group, entry.storageId);
            }
          },
        },
        {
          key: "source",
          label: "Open source page",
          icon: "fas fa-arrow-up-right-from-square",
          disabled: !safeExternalUrl(entry?.sourceUrl),
          onSelect: () => {
            const url = safeExternalUrl(entry?.sourceUrl);
            if (url) {
              window.open(url, "_blank", "noopener,noreferrer");
            }
          },
        },
        {
          key: "delete",
          label: "Delete downloaded files",
          icon: "fas fa-trash",
          danger: true,
          onSelect: () => {
            void handleDeleteDownloadedGroup(group);
          },
        },
      ];
    },
    [
      getActiveEntryForGroup,
      handleDeleteDownloadedGroup,
      handleSelectVersion,
      handleUpdateAndActivateGroup,
      isGroupUpdateAvailable,
      promptInstallTargets,
    ],
  );

  const s1apiActionLabel = s1apiInLibrary
    ? s1apiNeedsUpdate
      ? "Update"
      : "Downloaded"
    : "Download";
  const mlvscanActionLabel = mlvscanInLibrary
    ? mlvscanNeedsUpdate
      ? "Update"
      : "Downloaded"
    : "Download";
  const meshVaultActionLabel = meshVaultInLibrary
    ? meshVaultNeedsUpdate
      ? "Update"
      : "Downloaded"
    : "Download";
  const s1mapiActionLabel = s1mapiInLibrary
    ? s1mapiNeedsUpdate
      ? "Update"
      : "Downloaded"
    : "Download";
  const steamNetworkLibActionLabel = steamNetworkLibInLibrary
    ? steamNetworkLibNeedsUpdate
      ? "Update"
      : "Downloaded"
    : "Download";
  if (!isOpen) return null;


  return (
    <>
      <ConfirmOverlay
        isOpen={confirmOverlay.isOpen}
        onClose={() =>
          setConfirmOverlay({
            isOpen: false,
            title: "",
            message: "",
            onConfirm: () => {},
          })
        }
        onConfirm={confirmOverlay.onConfirm}
        title={confirmOverlay.title}
        message={confirmOverlay.message}
        confirmText={confirmOverlay.confirmText}
        cancelText={confirmOverlay.cancelText}
        isNested
      />
      <InstallTargetsDialog
        isOpen={installDialog.isOpen}
        title={installDialog.title}
        entries={installDialog.entries}
        compatibleEnvironments={installDialog.compatibleEnvironments}
        excludedEnvironments={installDialog.excludedEnvironments}
        lockedEnvironmentIds={installDialog.lockedEnvironmentIds}
        mode={installDialog.mode}
        note={installDialog.note}
        selectedEnvironmentIds={selectedInstallEnvironmentIds}
        onToggleEnvironment={(environmentId) => {
          setSelectedInstallEnvironmentIds((previous) => {
            const next = new Set(previous);
            if (next.has(environmentId)) next.delete(environmentId);
            else next.add(environmentId);
            return next;
          });
        }}
        onSelectAllCompatible={() =>
          setSelectedInstallEnvironmentIds(
            new Set(
              installDialog.compatibleEnvironments.map(
                (environment) => environment.id,
              ),
            ),
          )
        }
        onSelectRuntime={(runtime) =>
          setSelectedInstallEnvironmentIds(
            new Set(
              installDialog.compatibleEnvironments
                .filter(
                  (environment) =>
                    !installDialog.lockedEnvironmentIds.includes(
                      environment.id,
                    ) && getNormalizedRuntime(environment) === runtime,
                )
                .map((environment) => environment.id),
            ),
          )
        }
        onClear={() => setSelectedInstallEnvironmentIds(new Set())}
        onClose={closeInstallDialog}
        onConfirm={() => void handleConfirmInstallTargets()}
        installing={installingTargets}
      />
      <SecurityScanReportOverlay
        isOpen={!!activeSecurityReport}
        title={activeSecurityReport?.title || "Security Findings"}
        report={activeSecurityReport?.report || null}
        reportOptions={activeSecurityReport?.reportOptions}
        onClose={closeSecurityReport}
        onConfirm={
          activeSecurityReport?.onConfirm
            ? () => {
                void handleSecurityReportConfirm();
              }
            : undefined
        }
        confirmLabel={activeSecurityReport?.confirmLabel || "Continue Download"}
        busy={securityActionBusy}
      />
      {collectionConflict && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) handleCollectionConflictChoice("cancel");
          }}
        >
          <SimmDialogContent
            nested
            showCloseButton={false}
            className="app-dialog collection-conflict-dialog"
          >
            <div className="modal-header">
              <div>
                <h2>Choose which mod to keep</h2>
                <p>
                  This collection requests a different Nexus file for a mod
                  already in your library.
                </p>
              </div>
              <SimmButton
                type="button"
                variant="ghost"
                size="icon-sm"
                className="modal-close"
                onClick={() => handleCollectionConflictChoice("cancel")}
                aria-label="Review this conflict later"
              >
                <Icon name="times" />
              </SimmButton>
            </div>
            <div className="app-dialog__body collection-conflict-dialog__body">
              <button
                type="button"
                className="collection-conflict-choice"
                onClick={() => handleCollectionConflictChoice("collection")}
              >
                <strong className="collection-conflict-choice__action">
                  Use collection version
                </strong>
                <span className="collection-conflict-choice__name">
                  {collectionConflict.file.modName}
                  <span className="ui-mono"> {collectionConflict.file.fileName}</span>
                </span>
                <dl className="ui-kv collection-conflict-choice__facts">
                  <dt>Version</dt>
                  <dd className="ui-mono">{collectionConflict.file.version || "Unknown"}</dd>
                  <dt>Nexus file</dt>
                  <dd className="ui-mono">{collectionConflict.file.fileId}</dd>
                  <dt>Size</dt>
                  <dd>
                    {collectionConflict.file.sizeInBytes
                      ? formatFileSizeShort(collectionConflict.file.sizeInBytes)
                      : "Unknown"}
                  </dd>
                </dl>
                <span className="collection-conflict-choice__consequence">
                  Download and install the exact file selected by this collection.
                  Your current version remains stored in the library.
                </span>
              </button>
              <button
                type="button"
                className="collection-conflict-choice"
                onClick={() => handleCollectionConflictChoice("existing")}
              >
                <strong className="collection-conflict-choice__action">
                  Keep current version
                </strong>
                <span className="collection-conflict-choice__name">
                  {collectionConflict.existingEntries[0]?.displayName ||
                    collectionConflict.file.modName}
                </span>
                <span className="collection-conflict-choice__existing-list">
                  {collectionConflict.existingEntries.map((entry) => (
                    <span key={entry.storageId}>
                      {formatVersionTag(entry.sourceVersion || entry.installedVersion)}
                      {` · Nexus file ${entry.nexusFileId || getNexusFileIdFromTags(entry.tags) || "unknown"}`}
                      {entry.installedIn.length > 0
                        ? ` · Installed in ${entry.installedIn
                            .map(
                              (environmentId) =>
                                environments.find(
                                  (environment) => environment.id === environmentId,
                                )?.name || environmentId,
                            )
                            .join(", ")}`
                        : " · Stored in library"}
                    </span>
                  ))}
                </span>
                <span className="collection-conflict-choice__consequence">
                  SIMM skips the collection file and preserves your current
                  installation.
                </span>
              </button>
            </div>
            {collectionConflictQueue.length > 0 && (
              <p className="collection-conflict-dialog__queue">
                {collectionConflictQueue.length} more collection{" "}
                {collectionConflictQueue.length === 1 ? "conflict" : "conflicts"}{" "}
                queued. Other Premium downloads continue in the background.
              </p>
            )}
          </SimmDialogContent>
        </Dialog>
      )}
      {runtimePrompt && (
        <Dialog open onOpenChange={(open) => {
          if (!open) {
            runtimePrompt.onDismiss?.();
            setRuntimePrompt(null);
          }
        }}>
          <SimmDialogContent
            nested
            showCloseButton={false}
            className="app-dialog app-dialog--message app-runtime-dialog app-collection-runtime-dialog"
          >
            <DialogHeader className="modal-header app-dialog__header">
              <DialogTitle>{runtimePrompt.title}</DialogTitle>
              <SimmButton
                type="button"
                variant="ghost"
                size="icon-sm"
                className="modal-close"
                aria-label="Close collection runtime dialog"
                onClick={() => {
                  runtimePrompt.onDismiss?.();
                  setRuntimePrompt(null);
                }}
              >
                <Icon name="times" />
              </SimmButton>
            </DialogHeader>
            <div className="app-dialog__body app-runtime-dialog__body app-collection-runtime-dialog__body">
              <DialogDescription>
                {runtimePrompt.message}
              </DialogDescription>
            </div>
            <DialogFooter className="app-dialog__footer">
              <div className="app-collection-runtime-dialog__actions">
                <SimmButton
                  type="button"
                  variant="secondary"
                  className="btn btn-secondary"
                  onClick={() => {
                    const handler = runtimePrompt.onSelect;
                    setRuntimePrompt(null);
                    handler("Mono");
                  }}
                >
                  Mono
                </SimmButton>
                <SimmButton
                  type="button"
                  variant="secondary"
                  className="btn btn-secondary"
                  onClick={() => {
                    const handler = runtimePrompt.onSelect;
                    setRuntimePrompt(null);
                    handler("IL2CPP");
                  }}
                >
                  IL2CPP
                </SimmButton>
                <SimmButton
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    const handler = runtimePrompt.onSelect;
                    setRuntimePrompt(null);
                    handler("Both");
                  }}
                >
                  Both
                </SimmButton>
              </div>
            </DialogFooter>
          </SimmDialogContent>
        </Dialog>
      )}

      <div className="ui-page lib-page">
        {!detailPageOpen && (
          <>
            <header className="lib-header">
              <div className="ui-page-header__titles">
                <h1 className="ui-page-title">Mod Library</h1>
                <p className="ui-page-subtitle">
                  Download mods once, then install them into any environment.
                </p>
              </div>
            </header>
            <nav
              className="ui-tabs-line lib-tabs"
              aria-label="Mod Library sections"
            >
              {(
                [
                  ["discover", "Discover", "compass", null],
                  ["library", "Library", "bookOpen", downloadedSummary.total],
                  ["updates", "Updates", "arrowUp", downloadedSummary.updates],
                ] as Array<[LibraryTab, string, string, number | null]>
              ).map(([tab, label, icon, count]) => (
                <button
                  key={tab}
                  type="button"
                  className="ui-tabs-line__tab"
                  aria-current={libraryTab === tab ? "page" : undefined}
                  onClick={() => setLibraryTab(tab)}
                >
                  <Icon name={icon} />
                  {label}
                  {count !== null && count > 0 && (
                    <span
                      className={cn(
                        "ui-tabs-line__count",
                        tab === "updates" && "ui-tabs-line__count--attention",
                      )}
                      aria-label={
                        tab === "updates"
                          ? `${count} ${count === 1 ? "update" : "updates"}`
                          : `${count} ${count === 1 ? "mod" : "mods"}`
                      }
                    >
                      {count}
                    </span>
                  )}
                </button>
              ))}
            </nav>

            <div className="ui-toolbar lib-toolbar">
              {libraryTab === "discover" ? (
                <>
                  <div
                    className="lib-segmented"
                    role="group"
                    aria-label="Search source"
                  >
                    {(
                      [
                        ["thunderstore", "Thunderstore"],
                        ["nexusmods", "Nexus Mods"],
                      ] as const
                    ).map(([source, label]) => (
                      <button
                        key={source}
                        type="button"
                        className="lib-segmented__option"
                        aria-pressed={searchSource === source}
                        onClick={() => selectSearchSource(source)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {searchSource === "nexusmods" && (
                    <div
                      className="lib-segmented"
                      role="group"
                      aria-label="Nexus catalog"
                    >
                      {(
                        [
                          ["mods", "Mods"],
                          ["collections", "Collections"],
                        ] as const
                      ).map(([kind, label]) => (
                        <button
                          key={kind}
                          type="button"
                          className="lib-segmented__option"
                          aria-pressed={nexusCatalogKind === kind}
                          onClick={() => selectNexusCatalogKind(kind)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="lib-search">
                    <Input
                      type="search"
                      className="lib-search__input"
                      aria-label={
                        searchSource === "thunderstore"
                          ? "Search Thunderstore"
                          : nexusCatalogKind === "collections"
                            ? "Search Nexus Collections"
                            : "Search Nexus Mods"
                      }
                      placeholder={
                        searchSource === "thunderstore"
                          ? "Search or browse Thunderstore mods..."
                          : nexusCatalogKind === "collections"
                            ? "Search Nexus Collections..."
                            : "Search or browse Nexus Mods..."
                      }
                      value={
                        searchSource === "thunderstore"
                          ? searchQuery
                          : nexusCatalogKind === "collections"
                            ? nexusCollectionsSearchQuery
                            : nexusModsSearchQuery
                      }
                      onChange={(event) => {
                        if (searchSource === "thunderstore") {
                          setSearchQuery(event.target.value);
                        } else if (nexusCatalogKind === "collections") {
                          setNexusCollectionsSearchQuery(event.target.value);
                        } else {
                          setNexusModsSearchQuery(event.target.value);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          if (searchSource === "thunderstore") handleSearch();
                          else if (nexusCatalogKind === "collections")
                            handleSearchNexusCollections();
                          else handleSearchNexusMods();
                        }
                      }}
                    />
                    <SimmButton
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="lib-search__submit"
                      aria-label="Search"
                      title="Search (Enter)"
                      onClick={
                        searchSource === "thunderstore"
                          ? handleSearch
                          : nexusCatalogKind === "collections"
                            ? handleSearchNexusCollections
                            : handleSearchNexusMods
                      }
                      disabled={
                        searchSource === "thunderstore"
                          ? searching
                          : nexusCatalogKind === "collections"
                            ? searchingNexusCollections
                            : searchingNexusMods
                      }
                    >
                      <Icon name="search" />
                    </SimmButton>
                  </div>
                  <DiscoverSortSelect
                    value={discoverSort}
                    onValueChange={setDiscoverSort}
                  />
                  <SimmButton
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Refresh"
                    title="Refresh results"
                    onClick={handleRefreshDiscovery}
                    disabled={
                      searching || searchingNexusMods || searchingNexusCollections
                    }
                  >
                    <Icon
                      name="syncAlt"
                      spin={searching || searchingNexusMods || searchingNexusCollections}
                    />
                  </SimmButton>
                </>
              ) : (
                <>
                  <Input
                    type="search"
                    className="lib-filter-input"
                    aria-label="Filter downloaded mods"
                    value={downloadedSearch}
                    onChange={(event) => setDownloadedSearch(event.target.value)}
                    placeholder="Filter by mod, author, or version"
                  />
                  <DownloadedFilterSelect
                    value={downloadedFilter}
                    onValueChange={setDownloadedFilter}
                  />
                  <div className="ui-toolbar__spacer" />
                  <SimmButton
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Refresh"
                    title="Refresh library"
                    onClick={handleRefreshLibrary}
                    disabled={loadingLibrary}
                  >
                    <Icon name="syncAlt" spin={loadingLibrary} />
                  </SimmButton>
                  {libraryTab === "library" ? (
                    <SimmButton
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="More library actions"
                      aria-haspopup="menu"
                      title="More actions"
                      onClick={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        setContextMenu({
                          x: rect.right - 200,
                          y: rect.bottom + 4,
                          items: [
                            {
                              key: "add-files",
                              label:
                                downloading === "library-import"
                                  ? "Adding files…"
                                  : "Add Files",
                              icon: "fas fa-plus",
                              disabled: downloading === "library-import",
                              onSelect: () => {
                                void handleAddFilesClick();
                              },
                            },
                          ],
                        });
                      }}
                    >
                      <Icon name="ellipsisH" />
                    </SimmButton>
                  ) : (
                    <>
                      {flaggedUpdateGroupCount > 0 && (
                        <span className="lib-toolbar__note" title={updateAllGroupsTitle}>
                          {flaggedUpdateGroupCount} {flaggedUpdateGroupCount === 1 ? "needs" : "need"} review
                        </span>
                      )}
                      <SimmButton
                        type="button"
                        onClick={() => void handleUpdateAllGroups()}
                        disabled={updatingAllGroups || bulkUpdateGroupCount === 0}
                        title={updateAllGroupsTitle}
                      >
                        <Icon name={updatingAllGroups ? "spinner" : "arrowUp"} spin={updatingAllGroups} />
                        <span>
                          {updatingAllGroups
                            ? "Updating…"
                            : `Update All (${bulkUpdateGroupCount})`}
                        </span>
                      </SimmButton>
                    </>
                  )}
                </>
              )}
            </div>

            <div className="lib-body" ref={libraryScrollContainerRef}>
              {libraryTab === "discover" &&
                searchSource === "thunderstore" &&
                searchQuery.trim() === "" && (
                  <div
                    className="lib-recommended"
                    role="group"
                    aria-label="Recommended tools"
                  >
                    <span className="lib-recommended__label">Recommended tools</span>
                    {(
                      [
                        {
                          key: "s1api",
                          name: "S1API",
                          artwork: lookupArtwork("S1API"),
                          description: "Shared APIs and interoperability (GitHub release).",
                          state: s1apiActionLabel,
                          onClick: handleDownloadS1APIClick,
                          disabled: false,
                        },
                        {
                          key: "mlvscan",
                          name: "MLVScan",
                          artwork: lookupArtwork("MLVScan"),
                          description: "Library scanning and validation (GitHub release).",
                          state: mlvscanActionLabel,
                          onClick: handleDownloadMlvscanClick,
                          disabled: false,
                        },
                        {
                          key: "meshvault",
                          name: "MeshVault",
                          artwork: lookupArtwork("MeshVault") ?? getFeaturedPackageArtwork(meshVaultFeaturedPackage),
                          description: "Installs its runtime DLLs into Plugins (Thunderstore).",
                          state: meshVaultActionLabel,
                          onClick: handleDownloadMeshVaultClick,
                          disabled: !meshVaultFeaturedPackage,
                        },
                        {
                          key: "s1mapi",
                          name: "S1MAPI",
                          artwork: lookupArtwork("S1MAPI") ?? getFeaturedPackageArtwork(s1mapiFeaturedPackage),
                          description: "Shared Schedule I mapping APIs in UserLibs (Thunderstore).",
                          state: s1mapiActionLabel,
                          onClick: handleDownloadS1MapiClick,
                          disabled: !s1mapiFeaturedPackage,
                        },
                        {
                          key: "steamnetworklib",
                          name: "SteamNetworkLib",
                          artwork: lookupArtwork("SteamNetworkLib") ?? getFeaturedPackageArtwork(steamNetworkLibFeaturedPackage),
                          description: "Shared Steam networking in UserLibs (Thunderstore).",
                          state: steamNetworkLibActionLabel,
                          onClick: handleDownloadSteamNetworkLibClick,
                          disabled: !steamNetworkLibFeaturedPackage,
                        },
                      ] as const
                    ).map((tool) => (
                      <button
                        key={tool.key}
                        type="button"
                        className="lib-recommended__item"
                        title={tool.description}
                        onClick={tool.onClick}
                        disabled={tool.disabled}
                      >
                        {tool.artwork && (
                          <ModThumbnail {...tool.artwork} name={tool.name} size={20} />
                        )}
                        <span className="lib-recommended__name">{tool.name}</span>
                        <span
                          className={cn(
                            "lib-recommended__state",
                            tool.state === "Update" && "lib-recommended__state--update",
                            tool.state === "Download" && "lib-recommended__state--download",
                          )}
                        >
                          {tool.state}
                        </span>
                      </button>
                    ))}
                  </div>
                )}

              {libraryTab === "discover" &&
                ((searchSource === "thunderstore" && searching && !showSearchResults) ||
                  (searchSource === "nexusmods" &&
                    ((nexusCatalogKind === "mods" &&
                      searchingNexusMods &&
                      !showNexusModsResults) ||
                      (nexusCatalogKind === "collections" &&
                        searchingNexusCollections &&
                        !showNexusCollectionsResults)))) && (
                  <LibrarySkeletonRows
                    label={
                      searchSource === "thunderstore"
                        ? "Loading Thunderstore mods"
                        : `Loading Nexus ${nexusCatalogKind}`
                    }
                  />
                )}

              {libraryTab === "discover" &&
                searchSource === "thunderstore" &&
                !searching &&
                !showSearchResults && (
                  <LibraryEmpty
                    icon="compass"
                    title="Browse Thunderstore"
                    action={
                      <SimmButton type="button" variant="outline" onClick={handleSearch}>
                        Browse
                      </SimmButton>
                    }
                  >
                    Search by name or author, or load the latest mods for Schedule I.
                  </LibraryEmpty>
                )}

              {libraryTab === "discover" &&
                ((searchSource === "thunderstore" && showSearchResults) ||
                  (searchSource === "nexusmods" &&
                    ((nexusCatalogKind === "mods" && showNexusModsResults) ||
                      (nexusCatalogKind === "collections" &&
                        showNexusCollectionsResults)))) && (
                  <div className="lib-table">
                    {searchSource === "nexusmods" &&
                    nexusCatalogKind === "collections" ? (
                      <div
                        className="lib-table__head lib-grid lib-grid--collections"
                        aria-hidden="true"
                      >
                        <span />
                        <span>Collection</span>
                        <span>Curator</span>
                        <span className="lib-cell--num">Mods</span>
                        <span>Revision</span>
                        <span>Updated</span>
                      </div>
                    ) : (
                      <div
                        className="lib-table__head lib-grid lib-grid--discover"
                        aria-hidden="true"
                      >
                        <span />
                        <span>Mod</span>
                        <span>Author</span>
                        <span>{searchSource === "thunderstore" ? "Runtime" : "Category"}</span>
                        <span>Version</span>
                        <span className="lib-cell--num">Downloads</span>
                        <span>Updated</span>
                      </div>
                    )}
                    {searchSource === "thunderstore" &&
                      showSearchResults &&
                      searchResults.map((pkg) => {
                        const representative =
                          pkg.packagesByRuntime.IL2CPP ||
                          pkg.packagesByRuntime.Mono;
                        const latestVersion =
                          getLatestThunderstorePackageVersion(representative);
                        const runtimeLabel = (["IL2CPP", "Mono"] as const)
                          .filter((runtime) => pkg.packagesByRuntime[runtime])
                          .join(" + ");
                        const updatedLabel = formatInspectorDate(
                          getThunderstorePackageUpdatedAt(representative),
                        );
                        const downloadedGroup =
                          findDownloadedGroupForThunderstorePackage(pkg);
                        const isSelected =
                          activeModView?.kind === "thunderstore" &&
                          activeModView.id === pkg.key;
                        return (
                          <div
                            key={pkg.key}
                            className={cn(
                              "lib-row lib-row--discover lib-grid lib-grid--discover",
                              isSelected && "lib-row--selected",
                            )}
                            role="button"
                            tabIndex={0}
                            onClick={() => openThunderstoreModView(pkg)}
                            onKeyDown={(event) =>
                              handleCardActivationKeyDown(event, () =>
                                openThunderstoreModView(pkg),
                              )
                            }
                          >
                            <ModThumbnail
                              name={pkg.name}
                              iconUrl={
                                latestVersion?.icon ||
                                representative?.icon ||
                                representative?.icon_url
                              }
                              size={32}
                            />
                            <div className="lib-cell lib-cell--name">
                              <div className="lib-row__title-line">
                                <span className="lib-row__title">{pkg.name}</span>
                                {downloadedGroup &&
                                  (isGroupUpdateAvailable(downloadedGroup) ? (
                                    <LibraryTag tone="warn">Update available</LibraryTag>
                                  ) : (
                                    <LibraryTag>Downloaded</LibraryTag>
                                  ))}
                              </div>
                              <p className="lib-row__summary">
                                {latestVersion?.description || "No summary provided."}
                              </p>
                            </div>
                            <div className="lib-cell lib-cell--text">{pkg.owner}</div>
                            <div className="lib-cell lib-cell--text">{runtimeLabel || "—"}</div>
                            <div className="lib-cell lib-cell--version">
                              {formatVersionTag(latestVersion?.version_number)}
                            </div>
                            <div
                              className="lib-cell lib-cell--num"
                              title={
                                representative?.rating_score !== undefined
                                  ? `${formatCompactNumber(representative.rating_score)} rating score`
                                  : undefined
                              }
                            >
                              {formatCompactNumber(latestVersion?.downloads)}
                            </div>
                            <div className="lib-cell lib-cell--text">
                              {updatedLabel !== "unknown" ? updatedLabel : "—"}
                            </div>
                          </div>
                        );
                      })}

                    {searchSource === "nexusmods" &&
                      nexusCatalogKind === "mods" &&
                      showNexusModsResults &&
                      nexusModsSearchResults.map((mod) => {
                        const updatedLabel = formatInspectorDate(
                          getNexusModUpdatedAt(mod),
                        );
                        const endorsementsLabel = formatCompactNumber(
                          mod.endorsement_count,
                        );
                        const downloadedGroup =
                          findDownloadedGroupForNexusMod(mod.mod_id);
                        const isSelected =
                          activeModView?.kind === "nexusmods" &&
                          activeModView.id === String(mod.mod_id);
                        return (
                          <div
                            key={mod.mod_id}
                            className={cn(
                              "lib-row lib-row--discover lib-grid lib-grid--discover",
                              isSelected && "lib-row--selected",
                            )}
                            role="button"
                            tabIndex={0}
                            onClick={() => openNexusModView(mod)}
                            onKeyDown={(event) =>
                              handleCardActivationKeyDown(event, () =>
                                openNexusModView(mod),
                              )
                            }
                          >
                            <ModThumbnail
                              name={mod.name}
                              iconUrl={mod.thumbnail_url || mod.picture_url}
                              size={32}
                            />
                            <div className="lib-cell lib-cell--name">
                              <div className="lib-row__title-line">
                                <span className="lib-row__title">{mod.name}</span>
                                {mod.contains_adult_content ? (
                                  <LibraryTag tone="danger">Adult content</LibraryTag>
                                ) : downloadedGroup ? (
                                  isGroupUpdateAvailable(downloadedGroup) ? (
                                    <LibraryTag tone="warn">Update available</LibraryTag>
                                  ) : (
                                    <LibraryTag>Downloaded</LibraryTag>
                                  )
                                ) : null}
                              </div>
                              <p className="lib-row__summary">
                                {mod.summary || "No summary provided."}
                              </p>
                            </div>
                            <div className="lib-cell lib-cell--text">
                              {getNexusModAttribution(mod)}
                            </div>
                            <div className="lib-cell lib-cell--text">
                              {mod.category_name || "—"}
                            </div>
                            <div className="lib-cell lib-cell--version">
                              {formatVersionTag(mod.version)}
                            </div>
                            <div
                              className="lib-cell lib-cell--num"
                              title={`${formatCompactNumber(mod.unique_downloads)} unique downloads · ${endorsementsLabel} endorsements`}
                            >
                              {formatCompactNumber(mod.mod_downloads)}
                            </div>
                            <div className="lib-cell lib-cell--text">
                              {updatedLabel !== "unknown" ? updatedLabel : "—"}
                            </div>
                          </div>
                        );
                      })}

                    {searchSource === "nexusmods" &&
                      nexusCatalogKind === "collections" &&
                      showNexusCollectionsResults &&
                      nexusCollectionsSearchResults.map((collection) => {
                        const updatedLabel = formatInspectorDate(
                          collection.updated_at || collection.revision_updated_at,
                        );
                        const isSelected =
                          selectedNexusCollectionSlug === collection.slug;
                        return (
                          <div
                            key={collection.slug}
                            className={cn(
                              "lib-row lib-row--discover lib-row--collection lib-grid lib-grid--collections",
                              isSelected && "lib-row--selected",
                            )}
                            role="button"
                            tabIndex={0}
                            onClick={() => openNexusCollectionView(collection)}
                            onKeyDown={(event) =>
                              handleCardActivationKeyDown(event, () =>
                                openNexusCollectionView(collection),
                              )
                            }
                          >
                            <CollectionTile src={collection.tile_image_url} />
                            <div className="lib-cell lib-cell--name">
                              <div className="lib-row__title-line">
                                <span className="lib-row__title">{collection.name}</span>
                                {collection.contains_adult_content && (
                                  <LibraryTag tone="danger">Adult content</LibraryTag>
                                )}
                              </div>
                              <p className="lib-row__summary">
                                {collection.summary || "No summary provided."}
                              </p>
                            </div>
                            <div className="lib-cell lib-cell--text">
                              {collection.curator_name}
                            </div>
                            <div className="lib-cell lib-cell--num">
                              {collection.mod_count.toLocaleString()}
                            </div>
                            <div className="lib-cell lib-cell--text">
                              {collection.revision_number !== undefined
                                ? `Revision ${collection.revision_number}`
                                : "—"}
                            </div>
                            <div className="lib-cell lib-cell--text">
                              {updatedLabel !== "unknown" ? updatedLabel : "—"}
                            </div>
                          </div>
                        );
                      })}

                    {searchSource === "thunderstore" &&
                      showSearchResults &&
                      searchResults.length === 0 && (
                        <LibraryEmpty icon="search" title="No Thunderstore mods found">
                          Nothing matched this search. Check the spelling or try the
                          mod author&apos;s name.
                        </LibraryEmpty>
                      )}
                    {searchSource === "nexusmods" &&
                      nexusCatalogKind === "mods" &&
                      showNexusModsResults &&
                      nexusModsSearchResults.length === 0 && (
                        <LibraryEmpty icon="search" title="No Nexus Mods found">
                          Nothing matched this search. Check the spelling or try a
                          shorter name.
                        </LibraryEmpty>
                      )}
                    {searchSource === "nexusmods" &&
                      nexusCatalogKind === "collections" &&
                      showNexusCollectionsResults &&
                      nexusCollectionsSearchResults.length === 0 && (
                        <LibraryEmpty icon="search" title="No Nexus Collections found">
                          Nothing matched this search. Try a broader term.
                        </LibraryEmpty>
                      )}
                    {searchSource === "nexusmods" &&
                      nexusCatalogKind === "mods" &&
                      showNexusModsResults &&
                      nexusModsSearchResults.length > 0 && (
                        <div className="lib-table__footer">
                          <span>
                            Showing {nexusModsSearchResults.length.toLocaleString()} of{" "}
                            {nexusModsTotalCount.toLocaleString()} Nexus Mods
                          </span>
                          {nexusModsHasMore && (
                            <SimmButton
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={handleLoadMoreNexusMods}
                              disabled={loadingMoreNexusMods}
                            >
                              {loadingMoreNexusMods ? "Loading…" : "Load more"}
                            </SimmButton>
                          )}
                        </div>
                      )}
                    {searchSource === "nexusmods" &&
                      nexusCatalogKind === "collections" &&
                      showNexusCollectionsResults &&
                      nexusCollectionsSearchResults.length > 0 && (
                        <div className="lib-table__footer">
                          <span>
                            Showing {nexusCollectionsSearchResults.length.toLocaleString()} of{" "}
                            {nexusCollectionsTotalCount.toLocaleString()} Nexus Collections
                          </span>
                          {nexusCollectionsHasMore && (
                            <SimmButton
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={handleLoadMoreNexusCollections}
                              disabled={loadingMoreNexusCollections}
                            >
                              {loadingMoreNexusCollections ? "Loading…" : "Load more"}
                            </SimmButton>
                          )}
                        </div>
                      )}
                  </div>
                )}

              {(libraryTab === "library" || libraryTab === "updates") && (
                <>
                  {loadingLibrary && <LibrarySkeletonRows label="Loading mod library" />}
                  {!loadingLibrary &&
                    displayedDownloadedGroups.length === 0 &&
                    (downloadedSearch.trim() !== "" || downloadedFilter !== "all" ? (
                      <LibraryEmpty
                        icon="filter"
                        title="No mods match this filter"
                        action={
                          <SimmButton
                            type="button"
                            variant="outline"
                            onClick={() => {
                              setDownloadedSearch("");
                              setDownloadedFilter("all");
                            }}
                          >
                            Clear Filter
                          </SimmButton>
                        }
                      >
                        Clear the filter to see every downloaded mod.
                      </LibraryEmpty>
                    ) : libraryTab === "updates" ? (
                      <LibraryEmpty icon="circleCheck" title="Everything is up to date">
                        SIMM checks your downloaded mods against Thunderstore, Nexus
                        Mods and GitHub. New versions show up here.
                      </LibraryEmpty>
                    ) : (
                      <LibraryEmpty
                        icon="puzzlePiece"
                        title="No downloaded mods yet"
                        action={
                          <div className="lib-empty__actions">
                            <SimmButton type="button" onClick={() => setLibraryTab("discover")}>
                              <Icon name="compass" />
                              <span>Browse Discover</span>
                            </SimmButton>
                            <SimmButton
                              type="button"
                              variant="outline"
                              onClick={() => void handleAddFilesClick()}
                              disabled={downloading === "library-import"}
                            >
                              Add Files
                            </SimmButton>
                          </div>
                        }
                      >
                        Mods you download are stored here once and can be installed into
                        any environment.
                      </LibraryEmpty>
                    ))}
                  {!loadingLibrary && displayedDownloadedGroups.length > 0 && (
                    <div
                      className={cn(
                        "lib-table lib-table--sized",
                        libraryTab === "updates" ? "lib-table--updates" : "lib-table--library",
                      )}
                    >
                      {libraryTab === "updates" ? (
                        <div
                          className="lib-table__head lib-grid lib-grid--updates"
                          aria-hidden="true"
                        >
                          <span />
                          <span>Mod</span>
                          <span>Source</span>
                          <span>Current</span>
                          <span>Latest</span>
                          <span>Installed in</span>
                        </div>
                      ) : (
                        <div
                          className="lib-table__head lib-grid lib-grid--library"
                          aria-hidden="true"
                        >
                          <span />
                          <span>Mod</span>
                          <span>Author</span>
                          <span>Source</span>
                          <span>Runtime</span>
                          <span>Version</span>
                          <span>Installed in</span>
                        </div>
                      )}
                      {displayedDownloadedGroups.map((group) => {
                        const activeEntry =
                          getActiveEntryForGroup(group) || group.entries[0];
                        const updateAvailable = isGroupUpdateAvailable(group);
                        const exception = getExceptionTag(
                          activeEntry?.securityScan,
                          settings?.showSecurityScanBadges !== false,
                          libraryTab === "library" && updateAvailable,
                          // In Updates, an unscannable mod is held out of Update All: say why.
                          libraryTab === "updates",
                        );
                        const isSelected =
                          activeModView?.kind === "downloaded" &&
                          activeModView.id === group.key;
                        const installedNames = group.installedIn.map(
                          (environmentId) =>
                            environments.find(
                              (environment) => environment.id === environmentId,
                            )?.name || environmentId,
                        );
                        const installedLabel =
                          installedNames.length === 0
                            ? "—"
                            : installedNames.length === 1
                              ? installedNames[0]
                              : `${installedNames.length} environments`;
                        const versionLabel = activeEntry
                          ? formatVersionTag(getEntryVersionLabel(activeEntry))
                          : "—";
                        return (
                          <div
                            key={group.key}
                            className={cn(
                              "lib-row lib-row--downloaded lib-grid",
                              libraryTab === "updates"
                                ? "lib-grid--updates"
                                : "lib-grid--library",
                              isSelected && "lib-row--selected",
                            )}
                            role="button"
                            tabIndex={0}
                            onClick={() => openDownloadedModView(group)}
                            onKeyDown={(event) =>
                              handleCardActivationKeyDown(event, () =>
                                openDownloadedModView(group),
                              )
                            }
                            onContextMenu={(event) =>
                              openContextMenu(event, downloadedContextMenuItems(group))
                            }
                          >
                            <ModThumbnail
                              name={group.displayName}
                              iconCachePath={activeEntry?.iconCachePath}
                              iconUrl={activeEntry?.iconUrl}
                              size={32}
                            />
                            <div className="lib-cell lib-cell--name">
                              <div className="lib-row__title-line">
                                <span className="lib-row__title">{group.displayName}</span>
                                {exception && (
                                  <LibraryTag tone={exception.tone}>{exception.label}</LibraryTag>
                                )}
                              </div>
                              <p className="lib-row__summary">
                                {activeEntry?.summary || "No summary provided."}
                              </p>
                            </div>
                            {libraryTab === "library" && (
                              <div className="lib-cell lib-cell--text">
                                {group.author || "—"}
                              </div>
                            )}
                            <div className="lib-cell lib-cell--text">
                              {getSourceBadgeLabel(activeEntry?.source)}
                            </div>
                            {libraryTab === "library" && (
                              <div className="lib-cell lib-cell--text">
                                {group.availableRuntimes.length > 0
                                  ? group.availableRuntimes.join(" + ")
                                  : "—"}
                              </div>
                            )}
                            <div className="lib-cell lib-cell--version">{versionLabel}</div>
                            {libraryTab === "updates" && (
                              <div className="lib-cell lib-cell--version lib-cell--attention">
                                {group.remoteVersion
                                  ? formatVersionTag(group.remoteVersion)
                                  : "—"}
                              </div>
                            )}
                            <div
                              className={cn(
                                "lib-cell lib-cell--text",
                                installedNames.length === 0 && "lib-cell--empty",
                              )}
                              title={
                                installedNames.length > 0
                                  ? installedNames.join(", ")
                                  : "Not installed in any environment"
                              }
                            >
                              {installedLabel}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}

        {detailPageOpen && (
          <main className="lib-detail">
            {selectedNexusCollection && (
              <ModLibraryDetailHeader
                backLabel={detailPageBackLabel}
                onBack={closeDetailView}
                media={selectedNexusCollection.tile_image_url}
                mediaAlt={selectedNexusCollection.tile_image_alt}
                icon={
                  <ModThumbnail
                    className="lib-detail__icon"
                    name={selectedNexusCollection.name}
                    iconUrl={selectedNexusCollection.tile_image_url}
                    size={48}
                  />
                }
                title={selectedNexusCollection.name}
                meta={
                  <>
                    <span>Curated by {selectedNexusCollection.curator_name}</span>
                    <span>Nexus Collection</span>
                    {selectedNexusCollection.category_name && (
                      <span>{selectedNexusCollection.category_name}</span>
                    )}
                    {selectedNexusCollection.revision_number !== undefined && (
                      <span>Revision {selectedNexusCollection.revision_number}</span>
                    )}
                    <span>
                      {selectedNexusCollection.mod_count.toLocaleString()}{" "}
                      {selectedNexusCollection.mod_count === 1 ? "mod" : "mods"}
                    </span>
                    {selectedNexusCollection.total_downloads !== undefined && (
                      <span>
                        {formatCompactNumber(selectedNexusCollection.total_downloads)} downloads
                      </span>
                    )}
                    {selectedNexusCollection.file_size !== undefined && (
                      <span>{formatFileSizeShort(selectedNexusCollection.file_size)}</span>
                    )}
                    <span>
                      Updated{" "}
                      {formatInspectorDate(
                        selectedNexusCollection.updated_at ||
                          selectedNexusCollection.revision_updated_at,
                      )}
                    </span>
                  </>
                }
                status={
                  selectedNexusCollection.contains_adult_content ? (
                    <LibraryTag tone="danger">Adult content</LibraryTag>
                  ) : null
                }
                actions={
                  <>
                    {!nexusCollectionAccess?.connected ? (
                      <SimmButton
                        type="button"
                        onClick={onOpenAccounts}
                        disabled={!onOpenAccounts}
                      >
                        <Icon name="user" />
                        <span>Connect Nexus</span>
                      </SimmButton>
                    ) : (
                      <SimmButton
                        type="button"
                        aria-label="Start collection download"
                        title={
                          nexusCollectionAccess.canDirectDownload
                            ? "Create and open a collection profile, then download every required mod plus the optional mods selected below."
                            : "Create and open a collection profile, automatically download selected exact Thunderstore matches, and retain the remaining Nexus downloads for individual completion."
                        }
                        onClick={confirmStageCollection}
                        disabled={
                          nexusCollectionPlanState.loading ||
                          collectionMatchesLoading ||
                          collectionDownloadBusy
                        }
                      >
                        <Icon
                          name={collectionDownloadBusy ? "spinner" : "download"}
                          spin={collectionDownloadBusy}
                        />
                        <span>{collectionDownloadBusy ? "Starting…" : "Start Download"}</span>
                      </SimmButton>
                    )}
                    <SimmButton
                      type="button"
                      variant="outline"
                      disabled={
                        creatingCollectionProfile || collectionProfiles.length > 0
                      }
                      onClick={() => void createCollectionProfiles()}
                      title={
                        collectionProfiles.length > 0
                          ? collectionReadyForProfile
                            ? "The complete collection profile is saved in Profiles."
                            : "The partial collection profile is saved in Profiles and will update as files are staged."
                          : "Create and open the collection profile without starting downloads. Choose individual mod downloads from the profile page."
                      }
                    >
                      <span>
                        {creatingCollectionProfile
                          ? "Creating…"
                          : collectionProfiles.length > 0
                            ? collectionReadyForProfile
                              ? "Profile ready"
                              : "Profile saved"
                            : "Create profile & choose mods"}
                      </span>
                    </SimmButton>
                    <ExternalIconLink
                      label="Open Collection on Nexus Mods"
                      title="View on Nexus Mods"
                      href={`https://next.nexusmods.com/schedule1/collections/${selectedNexusCollection.slug}`}
                    />
                  </>
                }
              />
            )}
            {selectedDownloadedGroup && selectedDownloadedEntry && (() => {
              const updateAvailable = isGroupUpdateAvailable(selectedDownloadedGroup);
              const installMoreOnly = selectedDownloadedGroup.installedIn.length > 0;
              const {
                installable,
                runtimeIncompatible,
                blockedBySiblingVersion,
                alreadyInstalled,
              } = getCompatibleInstallSummary(selectedDownloadedEntry, installMoreOnly);
              const installDisabled = installable.length === 0;
              const installTitle = installDisabled
                ? buildInstallNoOpNotice(
                    {
                      installEntry: selectedDownloadedEntry,
                      runtimeIncompatible,
                      blockedBySiblingVersion,
                      alreadyInstalled,
                      installable,
                      compatible: installable,
                      excluded: runtimeIncompatible,
                    },
                    installMoreOnly,
                  ).message
                : undefined;
              const exception = getExceptionTag(
                selectedDownloadedEntry.securityScan,
                settings?.showSecurityScanBadges !== false,
                updateAvailable,
              );
              const sourceUrl = safeExternalUrl(selectedDownloadedEntry.sourceUrl);
              const selectedVersionLabel = formatVersionTag(
                getEntryVersionLabel(selectedDownloadedEntry),
              );
              return (
                <ModLibraryDetailHeader
                  backLabel={detailPageBackLabel}
                  onBack={closeDetailView}
                  icon={
                    <ModThumbnail
                      className="lib-detail__icon"
                      name={selectedDownloadedGroup.displayName}
                      iconCachePath={selectedDownloadedEntry.iconCachePath}
                      iconUrl={selectedDownloadedEntry.iconUrl}
                      size={48}
                    />
                  }
                  title={selectedDownloadedGroup.displayName}
                  meta={
                    <>
                      {selectedDownloadedGroup.author && (
                        <span>{selectedDownloadedGroup.author}</span>
                      )}
                      <span>{getSourceBadgeLabel(selectedDownloadedEntry.source)}</span>
                      <span className="ui-mono">{selectedVersionLabel}</span>
                      {selectedDownloadedGroup.remoteVersion &&
                        formatVersionTag(selectedDownloadedGroup.remoteVersion) !==
                          selectedVersionLabel && (
                          <span>
                            Latest{" "}
                            <span className="ui-mono">
                              {formatVersionTag(selectedDownloadedGroup.remoteVersion)}
                            </span>
                          </span>
                        )}
                      <span>
                        {selectedDownloadedGroupEntries.length}{" "}
                        {selectedDownloadedGroupEntries.length === 1
                          ? "version"
                          : "versions"}{" "}
                        downloaded
                      </span>
                    </>
                  }
                  status={
                    exception ? (
                      <LibraryTag tone={exception.tone}>{exception.label}</LibraryTag>
                    ) : null
                  }
                  actions={
                    <>
                      {/* Same rule on every detail page: downloaded → Install to… is primary. */}
                      <SimmButton
                        type="button"
                        onClick={() =>
                          void promptInstallTargets(
                            selectedDownloadedEntry,
                            `Install ${selectedDownloadedEntry.displayName}`,
                            installMoreOnly,
                          )
                        }
                        disabled={installDisabled}
                        title={installTitle ?? `Install ${selectedVersionLabel} to environments`}
                      >
                        <span>Install to…</span>
                      </SimmButton>
                      {updateAvailable && (
                        <SimmButton
                          type="button"
                          variant="outline"
                          onClick={() =>
                            void handleUpdateAndActivateGroup(selectedDownloadedGroup)
                          }
                        >
                          <Icon name="arrowUp" />
                          <span>Update and Activate</span>
                        </SimmButton>
                      )}
                      {sourceUrl && (
                        <ExternalIconLink
                          label="Open Source Page"
                          title="Open source page"
                          href={sourceUrl}
                        />
                      )}
                    </>
                  }
                />
              );
            })()}
            {selectedThunderstorePackage && (() => {
              const downloadedGroup = downloadedGroupForSelectedThunderstore;
              const updateAvailable = downloadedGroup
                ? isGroupUpdateAvailable(downloadedGroup)
                : false;
              const hasLibraryVersion = Boolean(
                downloadedGroup && selectedThunderstoreDownloadedEntry,
              );
              const selectedThunderstoreVersionLabel = formatVersionTag(
                selectedThunderstoreVersion?.versionNumber ??
                  selectedThunderstoreLatestVersion?.version_number,
              );
              const runtimeNames = new Set(
                selectedThunderstoreRuntimeLabels.map((runtime) => runtime.toLowerCase()),
              );
              runtimeNames.add("il2cpp");
              runtimeNames.add("mono");
              const categories = selectedThunderstoreCategories
                .filter((category) => !runtimeNames.has(category.trim().toLowerCase()))
                .slice(0, 4);
              const packageUrl = safeExternalUrl(selectedThunderstorePackage.packageUrl);
              return (
                <ModLibraryDetailHeader
                  backLabel={detailPageBackLabel}
                  onBack={closeDetailView}
                  icon={
                    // Thunderstore has no banners: the package icon is the artwork.
                    <ModThumbnail
                      className="lib-detail__icon"
                      name={selectedThunderstorePackage.name}
                      iconUrl={
                        selectedThunderstoreLatestVersion?.icon ||
                        selectedThunderstoreRepresentativePackage?.icon ||
                        selectedThunderstoreRepresentativePackage?.icon_url
                      }
                      size={96}
                    />
                  }
                  title={selectedThunderstorePackage.name}
                  meta={
                    <>
                      <span>by {selectedThunderstorePackage.owner}</span>
                      <span>Thunderstore</span>
                      <span>
                        {selectedThunderstoreRuntimeLabels.length > 0
                          ? selectedThunderstoreRuntimeLabels.join(" + ")
                          : "Unknown runtime"}
                      </span>
                      {categories.length > 0 && <span>{categories.join(", ")}</span>}
                      <span className="ui-mono">
                        {formatVersionTag(selectedThunderstoreLatestVersion?.version_number)}
                      </span>
                      <span>
                        {formatCompactNumber(selectedThunderstoreLatestVersion?.downloads)}{" "}
                        downloads
                      </span>
                      <span>
                        Updated{" "}
                        {formatInspectorDate(
                          getThunderstorePackageUpdatedAt(
                            selectedThunderstoreRepresentativePackage,
                          ),
                        )}
                      </span>
                    </>
                  }
                  status={
                    selectedThunderstoreRepresentativePackage?.is_deprecated ? (
                      <LibraryTag tone="danger">Deprecated</LibraryTag>
                    ) : updateAvailable ? (
                      <LibraryTag tone="warn">Update available</LibraryTag>
                    ) : downloadedGroup ? (
                      <LibraryTag>Downloaded</LibraryTag>
                    ) : null
                  }
                  actions={
                    <>
                      {/* Same rule on every detail page: not downloaded → Download is primary,
                          downloaded → Install to… is primary and Download secondary. */}
                      {downloadedGroup && selectedThunderstoreDownloadedEntry && (
                        <SimmButton
                          type="button"
                          onClick={() =>
                            void promptInstallTargets(
                              selectedThunderstoreDownloadedEntry,
                              `Install ${selectedThunderstoreDownloadedEntry.displayName}`,
                              downloadedGroup.installedIn.length > 0,
                            )
                          }
                          title={`Install ${formatVersionTag(getEntryVersionLabel(selectedThunderstoreDownloadedEntry))} from your library to environments`}
                        >
                          <span>Install to…</span>
                        </SimmButton>
                      )}
                      <SimmButton
                        type="button"
                        variant={hasLibraryVersion ? "outline" : "default"}
                        onClick={() =>
                          void handleDownloadThunderstore(
                            selectedThunderstorePackage,
                            selectedThunderstoreVersion,
                          )
                        }
                        title={`Download ${selectedThunderstoreVersionLabel} to your library`}
                      >
                        {!hasLibraryVersion && <Icon name="download" />}
                        <span>Download</span>
                      </SimmButton>
                      {packageUrl && (
                        <ExternalIconLink
                          label="Open Source Page"
                          title="Open on Thunderstore"
                          href={packageUrl}
                        />
                      )}
                    </>
                  }
                />
              );
            })()}
            {selectedNexusResult && (() => {
              const downloadedGroup = downloadedGroupForSelectedNexus;
              const updateAvailable = downloadedGroup
                ? isGroupUpdateAvailable(downloadedGroup)
                : false;
              const hasLibraryVersion = Boolean(
                downloadedGroup && selectedNexusDownloadedEntry,
              );
              return (
                <ModLibraryDetailHeader
                  backLabel={detailPageBackLabel}
                  onBack={closeDetailView}
                  media={selectedNexusResult.picture_url}
                  icon={
                    <ModThumbnail
                      className="lib-detail__icon"
                      name={selectedNexusResult.name}
                      iconUrl={
                        selectedNexusResult.thumbnail_url ||
                        selectedNexusResult.picture_url
                      }
                      size={48}
                    />
                  }
                  title={selectedNexusResult.name}
                  meta={
                    <>
                      <span>{getNexusModAttribution(selectedNexusResult)}</span>
                      <span>Nexus Mods</span>
                      {selectedNexusResult.category_name && (
                        <span>{selectedNexusResult.category_name}</span>
                      )}
                      <span className="ui-mono">
                        {formatVersionTag(selectedNexusResult.version)}
                      </span>
                      <span>
                        {formatCompactNumber(selectedNexusResult.endorsement_count)}{" "}
                        endorsements
                      </span>
                      <span>
                        {formatCompactNumber(
                          selectedNexusResult.mod_downloads ||
                            selectedNexusResult.unique_downloads,
                        )}{" "}
                        downloads
                      </span>
                      <span>
                        Updated{" "}
                        {formatInspectorDate(getNexusModUpdatedAt(selectedNexusResult))}
                      </span>
                      {selectedNexusResult.status &&
                        selectedNexusResult.status !== "published" && (
                          <span>{selectedNexusResult.status}</span>
                        )}
                    </>
                  }
                  status={
                    selectedNexusResult.contains_adult_content ? (
                      <LibraryTag tone="danger">Adult content</LibraryTag>
                    ) : updateAvailable ? (
                      <LibraryTag tone="warn">Update available</LibraryTag>
                    ) : downloadedGroup ? (
                      <LibraryTag>Downloaded</LibraryTag>
                    ) : null
                  }
                  actions={
                    <>
                      {/* Same rule on every detail page: not downloaded → Download is primary,
                          downloaded → Install to… is primary and Download secondary. */}
                      {downloadedGroup &&
                        selectedNexusDownloadedEntry &&
                        (() => {
                          const installMoreOnly =
                            downloadedGroup.installedIn.length > 0;
                          const {
                            installable,
                            runtimeIncompatible,
                            blockedBySiblingVersion,
                            alreadyInstalled,
                          } = getCompatibleInstallSummary(
                            selectedNexusDownloadedEntry,
                            installMoreOnly,
                          );
                          const installDisabled = installable.length === 0;
                          const installTitle = installDisabled
                            ? buildInstallNoOpNotice(
                                {
                                  installEntry: selectedNexusDownloadedEntry,
                                  runtimeIncompatible,
                                  blockedBySiblingVersion,
                                  alreadyInstalled,
                                  installable,
                                  compatible: installable,
                                  excluded: runtimeIncompatible,
                                },
                                installMoreOnly,
                              ).message
                            : undefined;
                          return (
                            <SimmButton
                              type="button"
                              onClick={() =>
                                void promptInstallTargets(
                                  selectedNexusDownloadedEntry,
                                  `Install ${selectedNexusDownloadedEntry.displayName}`,
                                  installMoreOnly,
                                )
                              }
                              disabled={installDisabled}
                              title={
                                installTitle ??
                                `Install ${formatVersionTag(getEntryVersionLabel(selectedNexusDownloadedEntry))} from your library to environments`
                              }
                            >
                              <span>Install to…</span>
                            </SimmButton>
                          );
                        })()}
                      <SimmButton
                        type="button"
                        variant={hasLibraryVersion ? "outline" : "default"}
                        onClick={() =>
                          void handleDownloadNexusMod(
                            selectedNexusResult.mod_id,
                            selectedNexusFile,
                          )
                        }
                        disabled={selectedNexusFiles.length === 0}
                        title={
                          selectedNexusFile
                            ? `Download ${selectedNexusFile.name || selectedNexusFile.file_name || "the selected file"} to your library`
                            : undefined
                        }
                      >
                        {!hasLibraryVersion && <Icon name="download" />}
                        <span>Download</span>
                      </SimmButton>
                      <ExternalIconLink
                        label="Open Source Page"
                        title="Open on Nexus Mods"
                        href={`https://www.nexusmods.com/schedule1/mods/${selectedNexusResult.mod_id}`}
                      />
                    </>
                  }
                />
              );
            })()}

            <div className="lib-detail__body">
              {selectedNexusCollection && (
                <>
                  <p className="lib-detail__summary">
                    {selectedNexusCollection.summary ||
                      "No summary provided for this collection."}
                  </p>
                  {selectedCollectionPlan && (
                    <LibrarySection id="collection-profile-preview" title="Profile preview">
                      <SectionNote>
                        {collectionRuntimeDifferenceCount > 0 ? (
                          <>
                            <strong className="lib-text-warn">
                              {`${collectionRuntimeDifferenceCount.toLocaleString()} ${collectionRuntimeDifferenceCount === 1 ? "mod differs" : "mods differ"} by runtime`}
                            </strong>
                            {" "}
                            These mods use a different library copy, download source, or
                            availability state in the Mono and IL2CPP profiles.
                          </>
                        ) : (
                          <>
                            <strong>Same mods in both profiles</strong>{" "}
                            {`Both profiles currently add the same ${selectedCollectionPlan.modFiles.length.toLocaleString()} mods from the same known sources.`}
                          </>
                        )}
                      </SectionNote>
                      <div
                        className="lib-segmented lib-segmented--inline"
                        role="group"
                        aria-label="Collection profile preview"
                      >
                        {(["Mono", "IL2CPP"] as const).map((runtime) => {
                          const active = collectionRuntimePreview === runtime;
                          return (
                            <button
                              key={runtime}
                              type="button"
                              className="lib-segmented__option"
                              aria-label={`${active ? "Hide" : "Show"} ${runtime} profile list`}
                              aria-pressed={active}
                              onClick={() =>
                                setCollectionRuntimePreview((current) =>
                                  current === runtime ? null : runtime,
                                )
                              }
                            >
                              {runtime}
                              <span className="lib-segmented__count">
                                {collectionRuntimePreviewByRuntime[runtime].length.toLocaleString()}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      {collectionRuntimePreview && activeCollectionRuntimePreview && (
                        <div
                          className="lib-list"
                          role="list"
                          aria-label={`${collectionRuntimePreview} collection profile mods`}
                        >
                          {activeCollectionRuntimePreview.map((item) => (
                            <div
                              className="lib-list__row"
                              key={`${collectionRuntimePreview}-${collectionFileKey(item.file)}`}
                              role="listitem"
                            >
                              <span className="lib-list__name lib-list__name--thumb">
                                <ModThumbnail
                                  {...lookupArtwork(item.file.modName)}
                                  name={item.file.modName}
                                  size={24}
                                />
                                <span className="ui-truncate">{item.file.modName}</span>
                              </span>
                              <span className="lib-list__meta">
                                <span className="ui-mono">
                                  {item.file.version || "Version unknown"}
                                </span>
                                {item.file.optional ? " · Optional" : ""}
                              </span>
                              <span
                                className={cn(
                                  "lib-list__status",
                                  `lib-list__status--${item.tone}`,
                                )}
                              >
                                {item.statusLabel}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </LibrarySection>
                  )}
                  {(!nexusCollectionAccess?.canDirectDownload ||
                    optionalCollectionFiles.length > 0) && (
                    <LibrarySection
                      id="collection-staging"
                      title={
                        nexusCollectionAccess?.canDirectDownload
                          ? "Optional content"
                          : "Collection staging"
                      }
                      aside={
                        selectedCollectionPlan ? (
                          <span
                            className={cn(
                              "lib-section__count",
                              !collectionReadyForProfile && "lib-text-warn",
                            )}
                          >
                            {nexusCollectionAccess?.canDirectDownload
                              ? `${selectedOptionalCollectionCount.toLocaleString()} / ${optionalCollectionFiles.length.toLocaleString()} selected`
                              : `${(
                                  stagedRequiredCollectionFiles.length +
                                  keptExistingCollectionFiles.length
                                ).toLocaleString()} / ${requiredCollectionFiles.length.toLocaleString()} ready`}
                          </span>
                        ) : null
                      }
                    >
                      <SectionNote>
                        {nexusCollectionAccess?.canDirectDownload
                          ? "Required mods are included automatically. Choose which optional mods SIMM should add before starting the download."
                          : "Thunderstore alternatives require an exact name, author, and version match. Choose each mod or apply one choice to every match."}
                      </SectionNote>
                      {nexusCollectionPlanState.loading ? (
                        <LibrarySkeletonRows label="Loading collection files" />
                      ) : nexusCollectionPlanState.error ? (
                        <div className="ui-callout ui-callout--danger">
                          {nexusCollectionPlanState.error}
                        </div>
                      ) : selectedCollectionPlan ? (
                        <>
                          {!nexusCollectionAccess?.canDirectDownload &&
                            unavailableRequiredCollectionFiles.length > 0 && (
                              <div className="ui-callout ui-callout--danger lib-callout">
                                <strong>Revision is incomplete on Nexus</strong>
                                <span>
                                  {unavailableRequiredCollectionFiles.length} required{" "}
                                  {unavailableRequiredCollectionFiles.length === 1
                                    ? "file is"
                                    : "files are"}{" "}
                                  no longer available. SIMM will not substitute another
                                  file.
                                </span>
                              </div>
                            )}
                          {!nexusCollectionAccess?.canDirectDownload &&
                            requiredExternalCollectionResources.length > 0 && (
                              <div className="ui-callout ui-callout--warn lib-callout">
                                <strong>External resources required</strong>
                                <span>
                                  Add these outside Nexus before installing; SIMM cannot
                                  verify them automatically.
                                </span>
                                <span className="lib-callout__links">
                                  {requiredExternalCollectionResources.map((resource) =>
                                    resource.resourceUrl ? (
                                      <a
                                        key={resource.id}
                                        href={resource.resourceUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                      >
                                        {resource.name}
                                      </a>
                                    ) : (
                                      <span key={resource.id}>{resource.name}</span>
                                    ),
                                  )}
                                </span>
                              </div>
                            )}
                          {!nexusCollectionAccess?.canDirectDownload && (
                            <div className="lib-stage-policy">
                              <label className="lib-check">
                                <Checkbox
                                  checked={applyCollectionSourceToAll}
                                  onCheckedChange={(checked) =>
                                    setApplyCollectionSourceToAll(Boolean(checked))
                                  }
                                />
                                <span>
                                  Apply next choice to all matches
                                  <small>Leave off to choose each mod separately.</small>
                                </span>
                              </label>
                              {collectionMatchesLoading && (
                                <span className="lib-stage-policy__status">
                                  <Icon name="spinner" spin /> Matching exact versions on
                                  Thunderstore…
                                </span>
                              )}
                            </div>
                          )}
                          <div className="lib-list">
                            {(nexusCollectionAccess?.canDirectDownload
                              ? optionalCollectionFiles
                              : selectedCollectionPlan.modFiles
                            ).map((file) => {
                              const key = collectionFileKey(file);
                              const stagedEntry = getStagedCollectionEntry(file);
                              const reusableEntry =
                                stagedEntry ||
                                findExactCollectionLibraryEntry(
                                  file,
                                  library?.downloaded ?? [],
                                  "IL2CPP",
                                ) ||
                                findExactCollectionLibraryEntry(
                                  file,
                                  library?.downloaded ?? [],
                                  "Mono",
                                );
                              const matchState = collectionMatchStates[key];
                              const exactMatches = matchState?.matches ?? [];
                              const sourceChoice =
                                collectionSourceChoices[key] ?? "nexusmods";
                              const optionalSelected =
                                !file.optional ||
                                Boolean(collectionOptionalSelections[key]);
                              const matchRuntimes = Array.from(
                                new Set(exactMatches.map((match) => match.runtime)),
                              ).join(" + ");
                              const decision =
                                collectionFileDecisions[
                                  getCollectionFileDecisionKey(file)
                                ];
                              const keptExisting =
                                decision === "existing" &&
                                getCollectionConflictingEntries(file).length > 0;
                              return (
                                <div
                                  className="lib-stage-file"
                                  key={file.collectionRevisionModId || file.fileId}
                                >
                                  <div className="lib-stage-file__copy">
                                    <span className="lib-list__name">{file.modName}</span>
                                    <span className="ui-meta lib-stage-file__meta">
                                      {file.version && (
                                        <span className="ui-mono">{file.version}</span>
                                      )}
                                      {file.author && <span>{file.author}</span>}
                                      <span>Nexus file {file.fileId}</span>
                                      <span className="ui-mono ui-truncate">{file.fileName}</span>
                                    </span>
                                    {!nexusCollectionAccess?.canDirectDownload && (
                                      <small
                                        className={cn(
                                          "lib-stage-file__note",
                                          matchState?.error && "lib-text-warn",
                                        )}
                                      >
                                        {matchState?.loading
                                          ? "Checking Thunderstore for the exact name, author, and version…"
                                          : exactMatches.length > 0
                                            ? `Exact Thunderstore version found for ${matchRuntimes}. Runtime-incompatible choices will require individual confirmation.`
                                            : matchState?.error ??
                                              "No exact high-confidence Thunderstore match. Keep the Nexus source for this item."}
                                      </small>
                                    )}
                                  </div>
                                  <div className="lib-stage-file__actions">
                                    {file.optional && (
                                      <label className="lib-check">
                                        <Checkbox
                                          checked={Boolean(collectionOptionalSelections[key])}
                                          onCheckedChange={(checked) =>
                                            setCollectionOptionalSelections((current) => ({
                                              ...current,
                                              [key]: Boolean(checked),
                                            }))
                                          }
                                        />
                                        <span>
                                          {nexusCollectionAccess?.canDirectDownload
                                            ? "Include in download"
                                            : "Include optional"}
                                        </span>
                                      </label>
                                    )}
                                    {nexusCollectionAccess?.canDirectDownload ? (
                                      <span
                                        className={cn(
                                          "lib-stage-file__state",
                                          !optionalSelected && "lib-stage-file__state--muted",
                                        )}
                                      >
                                        {optionalSelected
                                          ? reusableEntry
                                            ? `Reuse from ${getSourceBadgeLabel(reusableEntry.source)}`
                                            : "Include with download"
                                          : "Not included"}
                                      </span>
                                    ) : reusableEntry ? (
                                      <span className="lib-stage-file__state lib-stage-file__state--ok">
                                        Reuse from {getSourceBadgeLabel(reusableEntry.source)}
                                      </span>
                                    ) : keptExisting ? (
                                      <span className="lib-stage-file__state">
                                        Keeping current
                                      </span>
                                    ) : !file.available || !file.modId ? (
                                      <LibraryTag tone="danger">Unavailable</LibraryTag>
                                    ) : (
                                      <div
                                        className="lib-segmented"
                                        role="group"
                                        aria-label={`Download source for ${file.modName}`}
                                      >
                                        {exactMatches.length > 0 && (
                                          <button
                                            type="button"
                                            className="lib-segmented__option"
                                            aria-pressed={sourceChoice === "thunderstore"}
                                            disabled={
                                              Boolean(matchState?.loading) ||
                                              !optionalSelected
                                            }
                                            onClick={() =>
                                              setCollectionSourceChoice(file, "thunderstore")
                                            }
                                          >
                                            Use Thunderstore
                                          </button>
                                        )}
                                        <button
                                          type="button"
                                          className="lib-segmented__option"
                                          aria-pressed={sourceChoice === "nexusmods"}
                                          disabled={
                                            Boolean(matchState?.loading) ||
                                            !optionalSelected
                                          }
                                          onClick={() =>
                                            setCollectionSourceChoice(file, "nexusmods")
                                          }
                                        >
                                          Keep Nexus
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </>
                      ) : null}
                    </LibrarySection>
                  )}
                </>
              )}

              {selectedDownloadedGroup && selectedDownloadedEntry && (() => {
                const installedNames = selectedDownloadedGroup.installedIn.map(
                  (environmentId) =>
                    environments.find((environment) => environment.id === environmentId)
                      ?.name || environmentId,
                );
                const securityConfig = getSecurityBadgeConfig(
                  selectedDownloadedEntry.securityScan,
                );
                const canActivate =
                  selectedDownloadedGroup.installedIn.length > 0 &&
                  selectedDownloadedGroupEntries.length > 1 &&
                  selectedDownloadedEntry.installedIn.length <
                    selectedDownloadedGroup.installedIn.length;
                return (
                  <>
                    <p className="lib-detail__summary">
                      {selectedDownloadedEntry.summary || "No summary provided."}
                    </p>
                    <LibrarySection id="downloaded-details" title="Details">
                      <dl className="ui-kv lib-kv">
                        <dt>
                          <label htmlFor={`mod-library-version-${selectedDownloadedGroup.key}`}>
                            Version
                          </label>
                        </dt>
                        <dd className="lib-kv__control">
                          <Select
                            value={selectedDownloadedEntry.storageId}
                            onValueChange={(nextStorageId) => {
                              if (typeof nextStorageId === "string") {
                                setSelectedStorageByGroup((prev) => ({
                                  ...prev,
                                  [selectedDownloadedGroup.key]: nextStorageId,
                                }));
                              }
                            }}
                            disabled={selectedDownloadedGroupEntries.length < 2}
                          >
                            <SelectTrigger
                              id={`mod-library-version-${selectedDownloadedGroup.key}`}
                              aria-label="Available versions"
                              className="lib-select-trigger lib-select-trigger--version"
                            >
                              <SelectValue>
                                {(selectedStorageId) => {
                                  const selectedEntry =
                                    selectedDownloadedGroupEntries.find(
                                      (entry) => entry.storageId === selectedStorageId,
                                    ) || selectedDownloadedEntry;
                                  return `${formatVersionTag(getEntryVersionLabel(selectedEntry))} - ${selectedEntry.availableRuntimes?.length ? selectedEntry.availableRuntimes.join("/") : "Runtime?"}`;
                                }}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent align="start">
                              <SelectGroup>
                                {selectedDownloadedGroupEntries.map((entry) => (
                                  <SelectItem
                                    key={entry.storageId}
                                    value={entry.storageId}
                                    onClick={() =>
                                      setSelectedStorageByGroup((prev) => ({
                                        ...prev,
                                        [selectedDownloadedGroup.key]: entry.storageId,
                                      }))
                                    }
                                  >
                                    {`${formatVersionTag(getEntryVersionLabel(entry))} - ${entry.availableRuntimes?.length ? entry.availableRuntimes.join("/") : "Runtime?"}`}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                          {canActivate && (
                            <SimmButton
                              type="button"
                              variant="outline"
                              size="sm"
                              aria-label="Activate selected version"
                              title="Install this version in place of the active one"
                              onClick={() =>
                                void handleSelectVersion(
                                  selectedDownloadedGroup,
                                  selectedDownloadedEntry.storageId,
                                )
                              }
                              disabled={activatingGroup === selectedDownloadedGroup.key}
                            >
                              {activatingGroup === selectedDownloadedGroup.key && (
                                <Icon name="spinner" spin />
                              )}
                              <span>
                                {activatingGroup === selectedDownloadedGroup.key
                                  ? "Activating…"
                                  : "Activate"}
                              </span>
                            </SimmButton>
                          )}
                        </dd>
                        <dt>Runtime</dt>
                        <dd>
                          {selectedDownloadedEntry.availableRuntimes?.length
                            ? selectedDownloadedEntry.availableRuntimes.join(" + ")
                            : "Unknown"}
                        </dd>
                        <dt>Installed in</dt>
                        <dd>
                          {installedNames.length > 0
                            ? installedNames.join(", ")
                            : "Not installed in any environment"}
                        </dd>
                        {selectedDownloadedEntry.securityScan && (
                          <>
                            <dt>Security scan</dt>
                            <dd className="lib-kv__control">
                              {securityConfig && (
                                <span className={`ui-status ui-status--${securityConfig.tone}`}>
                                  {securityConfig.label}
                                </span>
                              )}
                              {selectedDownloadedEntry.storageId && (
                                <SimmButton
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  aria-label="Security Report"
                                  onClick={() =>
                                    void openStoredSecurityReport(
                                      selectedDownloadedEntry.storageId,
                                      `Security Findings - ${selectedDownloadedEntry.displayName}`,
                                    )
                                  }
                                >
                                  View report
                                </SimmButton>
                              )}
                            </dd>
                          </>
                        )}
                      </dl>
                    </LibrarySection>
                    {selectedDownloadedEntry.source === "nexusmods" && (
                      <LibrarySection
                        id="nexus-downloaded-inspector-dependencies"
                        title="Required dependencies"
                        aside={
                          visibleSelectedNexusRequirements.length > 0 ? (
                            <span className="lib-section__count">
                              {visibleSelectedNexusRequirements.length} required
                            </span>
                          ) : null
                        }
                      >
                        {selectedNexusDependencyKey === nexusDependencyState.key &&
                        nexusDependencyState.loading ? (
                          <SectionNote>Checking published Nexus dependencies…</SectionNote>
                        ) : nexusDependencyState.error &&
                          selectedNexusDependencyKey === nexusDependencyState.key ? (
                          <SectionNote>
                            Dependency information is unavailable for this file. Connect
                            Nexus and try again before downloading if you need a
                            compatibility check.
                          </SectionNote>
                        ) : selectedNexusDependencies ? (
                          visibleSelectedNexusRequirements.length > 0 ? (
                            <div className="lib-list">
                              {visibleSelectedNexusRequirements.map((requirement) => {
                                const isMissing = missingSelectedNexusRequirements.some(
                                  (missingRequirement) =>
                                    missingRequirement.id === requirement.id,
                                );
                                return (
                                  <div className="lib-list__row" key={requirement.id}>
                                    <span className="lib-list__name">
                                      {formatNexusDependencyCandidates(requirement)}
                                    </span>
                                    <span className="lib-list__meta">
                                      Any listed version satisfies this requirement.
                                    </span>
                                    {isMissing ? (
                                      <LibraryTag tone="warn">Missing</LibraryTag>
                                    ) : (
                                      <span className="lib-list__status lib-list__status--success">
                                        In library
                                      </span>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            <SectionNote>
                              No additional Nexus mod dependencies are declared for this
                              file. MelonLoader is managed separately.
                            </SectionNote>
                          )
                        ) : (
                          <SectionNote>
                            {selectedNexusStoredFileId !== null
                              ? "The stored Nexus file is no longer available to inspect."
                              : "Select a file to check its published dependencies."}
                          </SectionNote>
                        )}
                      </LibrarySection>
                    )}
                    <div className="ui-danger-zone lib-danger-zone">
                      <p className="lib-danger-zone__copy">
                        Removes every stored version of {selectedDownloadedGroup.displayName}{" "}
                        from the library. SIMM asks before touching environments where it is
                        installed.
                      </p>
                      <SimmButton
                        type="button"
                        variant="destructive"
                        onClick={() =>
                          void handleDeleteDownloadedGroup(selectedDownloadedGroup)
                        }
                      >
                        <Icon name="trash" />
                        <span>Delete downloaded files</span>
                      </SimmButton>
                    </div>
                  </>
                );
              })()}

              {selectedThunderstorePackage && (
                <>
                  <p className="lib-detail__summary">
                    {selectedThunderstoreLatestVersion?.description ||
                      "No description provided for this package."}
                  </p>
                  <LibrarySection
                    id="thunderstore-inspector-versions"
                    title="Versions"
                    aside={
                      <span className="lib-section__count">
                        {selectedThunderstoreVersionOptions.length} available
                      </span>
                    }
                  >
                    <div
                      className="lib-versions"
                      role="listbox"
                      aria-label="Thunderstore available versions"
                    >
                      {selectedThunderstoreVersionOptions.map((versionOption) => {
                        const isActive =
                          selectedThunderstoreVersion?.key === versionOption.key;
                        const description =
                          versionOption.description &&
                          versionOption.description !==
                            selectedThunderstoreLatestVersion?.description
                            ? versionOption.description
                            : null;
                        return (
                          <button
                            key={versionOption.key}
                            type="button"
                            role="option"
                            aria-selected={isActive}
                            className="lib-version"
                            onClick={() =>
                              setSelectedThunderstoreVersionByPackage((prev) => ({
                                ...prev,
                                [selectedThunderstorePackage.key]: versionOption.key,
                              }))
                            }
                          >
                            <span className="lib-version__check" aria-hidden="true">
                              {isActive && <Icon name="check" />}
                            </span>
                            <span className="lib-version__name ui-mono">
                              {formatVersionTag(versionOption.versionNumber)}
                            </span>
                            <span className="lib-version__cell">
                              {versionOption.runtimes.join(" + ")}
                            </span>
                            <span className="lib-version__cell">
                              {formatInspectorDate(versionOption.updatedAt)}
                            </span>
                            <span className="lib-version__cell lib-cell--num">
                              {formatCompactNumber(versionOption.downloads)} downloads
                            </span>
                            {description && (
                              <span className="lib-version__summary">{description}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </LibrarySection>
                  <LibrarySection
                    id="thunderstore-inspector-dependencies"
                    title="Required dependencies"
                    aside={
                      selectedThunderstoreDependencies.length > 0 ? (
                        <span className="lib-section__count">
                          {selectedThunderstoreDependencies.length} required
                        </span>
                      ) : null
                    }
                  >
                    {!selectedThunderstoreVersion ? (
                      <SectionNote>Select a version to review its dependencies.</SectionNote>
                    ) : selectedThunderstoreDependencies.length === 0 ? (
                      <SectionNote>
                        No additional Thunderstore dependencies are declared for this
                        version. MelonLoader is managed separately.
                      </SectionNote>
                    ) : (
                      <div className="lib-list">
                        {selectedThunderstoreDependencies.map((dependency) => {
                          const isMissing = missingSelectedThunderstoreDependencies.some(
                            (missing) => missing.raw === dependency.raw,
                          );
                          return (
                            <div key={dependency.raw} className="lib-list__row">
                              <span className="lib-list__name lib-list__name--thumb">
                                <ModThumbnail
                                  {...lookupArtwork(
                                    dependency.packageKey.split("-").pop() ||
                                      dependency.packageKey,
                                  )}
                                  name={
                                    dependency.packageKey.split("-").pop() ||
                                    dependency.packageKey
                                  }
                                  size={24}
                                />
                                <span className="ui-truncate">
                                  {dependency.packageKey}
                                  {dependency.minimumVersion && (
                                    <span className="ui-mono">
                                      {" "}
                                      {formatVersionTag(dependency.minimumVersion)}
                                    </span>
                                  )}
                                </span>
                              </span>
                              <span className="lib-list__meta">
                                {dependency.minimumVersion
                                  ? "This version or newer"
                                  : "Version requirement unavailable"}
                              </span>
                              {isMissing ? (
                                <LibraryTag tone="warn">Missing</LibraryTag>
                              ) : (
                                <span className="lib-list__status lib-list__status--success">
                                  In library
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </LibrarySection>
                </>
              )}

              {selectedNexusResult && (
                <>
                  <div className="lib-detail__summary lib-detail__summary--rich">
                    <NexusDescription key={selectedNexusResult.mod_id}>
                      {selectedNexusResult.description ||
                        selectedNexusResult.summary ||
                        "No description provided for this mod."}
                    </NexusDescription>
                  </div>
                  <LibrarySection
                    id="nexus-inspector-versions"
                    title="Files"
                    aside={
                      <span className="lib-section__count">
                        {selectedNexusFiles.length} available
                      </span>
                    }
                  >
                    {selectedNexusFiles.length > 0 ? (
                      <div
                        className="lib-versions"
                        role="listbox"
                        aria-label="Nexus available files"
                      >
                        {selectedNexusFiles.map((file) => {
                          const displayKind = getNexusFileDisplayKind(file);
                          const versionLabel =
                            file.version || file.mod_version || "unknown";
                          const fileTitle = getNexusFileRowTitle(
                            file,
                            selectedNexusResult.name,
                          );
                          const fileSizeLabel = formatFileSizeShort(file.size);
                          const isActive = selectedNexusFile?.file_id === file.file_id;
                          const detailLabel = getNexusVersionRowDetail(
                            file,
                            selectedNexusResult.name,
                            versionLabel,
                          );
                          const summaryLabel = getNexusVersionRowSummary(
                            file,
                            selectedNexusResult.name,
                            versionLabel,
                          );
                          const effectiveSummaryLabel =
                            summaryLabel &&
                            normalizeNexusVersionRowLabel(summaryLabel) !==
                              normalizeNexusVersionRowLabel(fileTitle)
                              ? summaryLabel
                              : null;
                          return (
                            <button
                              key={file.file_id}
                              type="button"
                              role="option"
                              aria-selected={isActive}
                              className="lib-version lib-version--file"
                              onClick={() =>
                                setSelectedNexusFileByModId((prev) => ({
                                  ...prev,
                                  [selectedNexusResult.mod_id]: file.file_id,
                                }))
                              }
                            >
                              <span className="lib-version__check" aria-hidden="true">
                                {isActive && <Icon name="check" />}
                              </span>
                              <span className="lib-version__file">
                                <span className="lib-version__file-title" title={fileTitle}>
                                  {fileTitle}
                                </span>
                                <span className="ui-meta lib-version__meta">
                                  <span className="ui-mono">{formatVersionTag(versionLabel)}</span>
                                  <span>{displayKind}</span>
                                  {file.is_primary && <span>Primary</span>}
                                  {file.category_name && (
                                    <span>{formatNexusFileCategory(file.category_name)}</span>
                                  )}
                                  <span>
                                    Uploaded{" "}
                                    {formatInspectorDate(
                                      getNexusFileUpdatedAt(file) ||
                                        getNexusModUpdatedAt(selectedNexusResult),
                                    )}
                                  </span>
                                  {fileSizeLabel && <span>{fileSizeLabel}</span>}
                                  {detailLabel &&
                                    normalizeNexusVersionRowLabel(detailLabel) !==
                                      normalizeNexusVersionRowLabel(fileTitle) && (
                                      <span>{detailLabel}</span>
                                    )}
                                </span>
                                {effectiveSummaryLabel && (
                                  <span className="lib-version__summary">
                                    {effectiveSummaryLabel}
                                  </span>
                                )}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <SectionNote>
                        No downloadable files were returned for this Nexus mod yet.
                      </SectionNote>
                    )}
                  </LibrarySection>
                </>
              )}
            </div>
          </main>
        )}
      </div>

      {contextMenu && (
        <AnchoredContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
}
