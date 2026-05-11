import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Dialog } from "@/components/ui/dialog";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
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
import {
  handleCardActivationKeyDown,
  resolveImageSource,
  safeExternalUrl,
} from "./modCardHelpers";
import { onModMetadataRefreshStatus } from "../services/events";
import { useSettingsStore } from "../stores/settingsStore";
import {
  SecurityScanReportOverlay,
  type SecurityScanReportOption,
} from "./SecurityScanReportOverlay";
import { Icon } from './Icon';
import { type SecurityReportWorkspaceRequest } from "./SecurityScanReportPage";
import {
  AnchoredContextMenu,
  type AnchoredContextMenuItem,
} from "./AnchoredContextMenu";
import {
  InstallTargetsDialog,
  getNormalizedRuntime,
} from "./InstallTargetsDialog";
import { SimmBadge, SimmButton, SimmDialogContent } from "./primitives";
import { WorkspacePageHeader } from "./WorkspacePageHeader";
import { getSecurityBadgeConfig } from "./securityScanHelpers";
import {
  areVersionsEquivalent,
  areVersionsEquivalentForSource,
  buildDownloadedGroups,
  compareVersionTokensDescForSource,
  compareVersionTokensDesc,
  normalizeThunderstoreName,
  normalizeVersionToken,
  parseThunderstoreSourceId,
  type DownloadedModGroup,
} from "../services/modLibrarySummary";
import { normalizeLibraryFeaturedDownloads } from "../services/featuredDownloads";
import type {
  Environment,
  ModLibraryEntry,
  ModLibraryResult,
  NexusMod,
  NexusModFile,
  SecurityScanReport,
  SecurityScanSummary,
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

const DISCOVER_SORT_OPTIONS: Array<{ value: DiscoverSort; label: string }> = [
  { value: "relevance", label: "Relevance" },
  { value: "updated", label: "Last updated" },
  { value: "popularity", label: "Popularity" },
  { value: "newest", label: "Newest" },
];

function CollectionEmpty({ children }: { children: string }) {
  return (
    <Empty className="workspace-collection__empty">
      <EmptyHeader>
        <EmptyTitle>{children}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}

function InspectorEmpty({ children }: { children: string }) {
  return (
    <Empty className="workspace-collection__inspector-empty">
      <EmptyHeader>
        <EmptyTitle>{children}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}

type WorkspaceBadgeTone = "source" | "success" | "warning" | "danger";

function WorkspaceBadge({
  children,
  tone,
  className,
  style,
}: {
  children: ReactNode;
  tone?: WorkspaceBadgeTone;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <SimmBadge
      variant="outline"
      className={cn(
        "workspace-pill",
        tone && `workspace-pill--${tone}`,
        className,
      )}
      style={style}
    >
      {children}
    </SimmBadge>
  );
}

function SecurityScanBadge({ summary }: { summary?: SecurityScanSummary }) {
  const config = getSecurityBadgeConfig(summary);

  if (!config) {
    return null;
  }

  return (
    <div className="workspace-inspector-card__badge-row">
      <WorkspaceBadge
        className="workspace-pill--security"
        style={{
          borderColor: config.border,
          background: config.background,
          color: config.color,
        }}
      >
        <Icon name={`fas ${config.icon}`} style={{ fontSize: "0.7rem" }} />
        {config.label}
      </WorkspaceBadge>
    </div>
  );
}

function InspectorCardEmpty({ children }: { children: string }) {
  return (
    <Empty className="workspace-inspector-card__empty">
      <EmptyHeader>
        <EmptyTitle>{children}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
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
        className="workspace-collection__toolbar-select-trigger"
      >
        <SelectValue>
          {(selectedValue) =>
            DISCOVER_SORT_OPTIONS.find((option) => option.value === selectedValue)
              ?.label || "Last updated"
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="workspace-collection__select-content" align="start">
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
  const normalizedBranch = (environment.branch || "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-");

  if (
    normalizedBranch === "alternate" ||
    normalizedBranch === "alternate-beta" ||
    normalizedBranch === "alternatebeta"
  ) {
    return "Mono";
  }

  if (normalizedBranch === "main" || normalizedBranch === "beta") {
    return "IL2CPP";
  }

  return environment.runtime === "Mono" ? "Mono" : "IL2CPP";
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

const normalizeSearchText = (value?: string): string => {
  return (value || "").toLowerCase().replace(/[\s_-]+/g, "");
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

const matchesNexusQueryLocally = (mod: NexusMod, query: string): boolean => {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return true;
  }

  const haystacks = [
    mod.name,
    mod.summary,
    mod.author,
    mod.uploader,
    mod.original_author,
  ];

  return haystacks.some((value) =>
    normalizeSearchText(value).includes(normalizedQuery),
  );
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

const sortNexusMods = (mods: NexusMod[], sort: DiscoverSort): NexusMod[] => {
  return [...mods].sort((a, b) => {
    const aUpdated = parseTimestamp(getNexusModUpdatedAt(a));
    const bUpdated = parseTimestamp(getNexusModUpdatedAt(b));
    const aCreated = parseTimestamp(
      a.uploaded_time ||
        (a as NexusMod & { created_at?: string; createdAt?: string })
          .created_at ||
        (a as NexusMod & { created_at?: string; createdAt?: string }).createdAt,
    );
    const bCreated = parseTimestamp(
      b.uploaded_time ||
        (b as NexusMod & { created_at?: string; createdAt?: string })
          .created_at ||
        (b as NexusMod & { created_at?: string; createdAt?: string }).createdAt,
    );
    const aDownloads = a.mod_downloads || a.unique_downloads || 0;
    const bDownloads = b.mod_downloads || b.unique_downloads || 0;

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

export function ModLibraryOverlay({
  isOpen,
  focusStorageId,
  focusRequestId,
  focusModTag,
  onOpenAccounts,
  onOpenSecurityReport,
  navigationState,
  onNavigationStateChange,
}: Props) {
  const { settings } = useSettingsStore();
  const defaultSearchSource = useMemo<"thunderstore" | "nexusmods">(() => {
    if (navigationState?.searchSource) {
      return navigationState.searchSource;
    }
    try {
      const stored = localStorage.getItem("simm:last-library-search-source");
      return stored === "thunderstore" ? "thunderstore" : "nexusmods";
    } catch {
      return "nexusmods";
    }
  }, [navigationState?.searchSource]);
  const [library, setLibrary] = useState<ModLibraryResult | null>(null);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [, setSelectedModIds] = useState<Set<string>>(new Set());
  const [environments, setEnvironments] = useState<Environment[]>([]);
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
  const [showNexusModsResults, setShowNexusModsResults] = useState(
    () => navigationState?.showNexusModsResults ?? false,
  );
  const [nexusModsFiles, setNexusModsFiles] = useState<
    Map<number, NexusModFile[]>
  >(new Map());
  const [nexusModsLoading, setNexusModsLoading] = useState<Set<number>>(
    new Set(),
  );

  const [downloading, setDownloading] = useState<string | null>(null);
  const [, setDeleting] = useState<string | null>(null);
  const [activatingGroup, setActivatingGroup] = useState<string | null>(null);
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
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: AnchoredContextMenuItem[];
  } | null>(null);
  const [openedFromLogs, setOpenedFromLogs] = useState<{
    active: boolean;
    modTag: string | null;
  }>({
    active: false,
    modTag: null,
  });
  const libraryScrollContainerRef = useRef<HTMLDivElement | null>(null);
  const libraryScrollTopRef = useRef(0);
  const metadataRefreshRunningRef = useRef(false);
  const nexusManualTimeoutRef = useRef<number | null>(null);
  const activeNexusModIdsRef = useRef<Set<number>>(new Set());
  const nexusModsFileRequestTokenRef = useRef(new Map<number, number>());
  const nexusModsFileRequestSeqRef = useRef(0);
  const pendingSecurityGateResolutionRef = useRef<
    ((result?: any) => void) | null
  >(null);
  const pendingNexusManualActionRef = useRef<null | {
    onSuccess: () => Promise<void>;
    onErrorTitle?: string;
  }>(null);
  const lastHandledFocusRequestIdRef = useRef<number | null>(null);
  const toastTimeoutRef = useRef<number | null>(null);
  const previousDiscoverSortRef = useRef(discoverSort);
  const navigationChangeHandlerRef = useRef(onNavigationStateChange);

  useEffect(() => {
    navigationChangeHandlerRef.current = onNavigationStateChange;
  }, [onNavigationStateChange]);

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
      searchQuery,
      searchResults,
      searchSource,
      showDiscovery,
      showNexusModsResults,
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
      setOpenedFromLogs({ active: false, modTag: null });
    }
  }, [isOpen]);
  const openModView = useCallback((nextView: LibraryModViewState) => {
    if (libraryScrollContainerRef.current) {
      libraryScrollTopRef.current = libraryScrollContainerRef.current.scrollTop;
    }
    setActiveModView(nextView);
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
      getLatestDownloadedVersionForGroups,
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

  const selectedNexusModId = useMemo(() => {
    if (activeModView?.kind !== "nexusmods") {
      return null;
    }

    return (
      nexusModsSearchResults.find(
        (modItem) => String(modItem.mod_id) === activeModView.id,
      )?.mod_id ?? null
    );
  }, [activeModView, nexusModsSearchResults]);

  const loadLibrarySnapshot = useCallback(async () => {
    try {
      const data = await normalizeLibraryFeaturedDownloads(
        await ApiService.getModLibrary(),
      );
      return data ?? { downloaded: [] };
    } catch (error) {
      logger.error("Failed to load mod library snapshot", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }, []);

  const refreshLibrary = useCallback(async () => {
    const data = await loadLibrarySnapshot();
    setLibrary(data);
  }, [loadLibrarySnapshot]);

  const refreshEnvironments = useCallback(async () => {
    try {
      const data = await ApiService.getEnvironments();
      setEnvironments(data);
    } catch (error) {
      console.warn("Failed to load environments for install targets:", error);
      setEnvironments([]);
    }
  }, []);

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
    setLoadingLibrary(true);
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
    } finally {
      setLoadingLibrary(false);
    }
  }, [refreshEnvironments, refreshLibrary, showLibraryNotice]);

  const openSecurityReport = useCallback(
    (request: SecurityReportWorkspaceRequest) => {
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

    pendingSecurityGateResolutionRef.current = null;
    activeSecurityReport?.onDismiss?.();
    setActiveSecurityReport(null);
  }, [activeSecurityReport, securityActionBusy]);

  const handleSecurityReportConfirm = useCallback(async () => {
    if (!activeSecurityReport?.onConfirm) {
      return;
    }

    setSecurityActionBusy(true);
    try {
      await activeSecurityReport.onConfirm();
      setActiveSecurityReport(null);
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
    [],
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
    return {
      connected: !!status.connected,
      canDirectDownload:
        !!status.connected && !!status.account?.canDirectDownload,
      requiresSiteConfirmation:
        !!status.connected && !!status.account?.requiresSiteConfirmation,
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
          };
          requestedKind?: "library" | "install";
          error?: string;
        }>
      ).detail;
      const pendingAction = pendingNexusManualActionRef.current;
      const requestedKind =
        detail?.requestedKind ?? detail?.result?.requestedKind;
      const isLibraryResult =
        detail?.result?.kind === "library" || requestedKind === "library";

      if (pendingAction && isLibraryResult) {
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
    isOpen,
    notifyLibraryUpdated,
    refreshLibrary,
    showLibraryNotice,
  ]);

  useEffect(() => {
    if (!isOpen) return;
    const loadLibrary = async () => {
      setLoadingLibrary(true);
      try {
        await refreshLibrary();
        await refreshEnvironments();
      } catch (err) {
        console.error("Failed to load mod library:", err);
        setLibrary({ downloaded: [] });
      } finally {
        setLoadingLibrary(false);
      }
    };
    loadLibrary();
  }, [isOpen, refreshEnvironments, refreshLibrary]);

  useEffect(() => {
    const activeModIds = new Set(
      nexusModsSearchResults.map((modItem) => modItem.mod_id),
    );
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
  }, [nexusModsSearchResults]);

  useEffect(() => {
    if (
      !showNexusModsResults ||
      selectedNexusModId === null ||
      nexusModsFiles.has(selectedNexusModId) ||
      nexusModsLoading.has(selectedNexusModId)
    ) {
      return;
    }

    void handleLoadNexusModFiles(selectedNexusModId);
  }, [
    showNexusModsResults,
    selectedNexusModId,
    nexusModsFiles,
    nexusModsLoading,
    handleLoadNexusModFiles,
  ]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onModMetadataRefreshStatus((data) => {
      const running = Boolean(data.running) || (data.activeCount || 0) > 0;
      const wasRunning = metadataRefreshRunningRef.current;
      metadataRefreshRunningRef.current = running;

      if (wasRunning && !running) {
        void refreshLibrary();
      }
    })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch((error) => {
        console.warn(
          "Failed to register mod metadata refresh listener:",
          error,
        );
      });

    return () => {
      disposed = true;
      unlisten?.();
      metadataRefreshRunningRef.current = false;
    };
  }, [isOpen, refreshLibrary]);
  const runThunderstoreSearch = useCallback(
    async (query: string) => {
      const trimmedQuery = query.trim();
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

        (packagesByRuntime.IL2CPP || []).forEach((pkg: ThunderstorePackage) =>
          addRuntime(pkg, "IL2CPP"),
        );
        (packagesByRuntime.Mono || []).forEach((pkg: ThunderstorePackage) =>
          addRuntime(pkg, "Mono"),
        );

        const sortedResults = sortThunderstoreGroups(
          Array.from(merged.values()),
          trimmedQuery
            ? discoverSort
            : discoverSort === "relevance"
              ? "updated"
              : discoverSort,
        );
        setSearchResults(sortedResults);
        setShowSearchResults(true);
      } catch (err) {
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
        setSearching(false);
      }
    },
    [discoverSort, showLibraryNotice],
  );

  const runNexusSearch = useCallback(
    async (query: string) => {
      const trimmedQuery = query.trim();
      setSearchingNexusMods(true);
      setShowNexusModsResults(false);
      setShowSearchResults(false);
      setSearchResults([]);
      setActiveModView(null);
      try {
        let mods: NexusMod[] = [];
        if (!trimmedQuery) {
          const result =
            discoverSort === "popularity"
              ? await ApiService.getNexusModsTrending("schedule1")
              : discoverSort === "newest"
                ? await ApiService.getNexusModsLatestAdded("schedule1")
                : await ApiService.getNexusModsLatestUpdated("schedule1");
          mods = result.mods || [];
        } else {
          const searchResult = await ApiService.searchNexusMods(
            "schedule1",
            trimmedQuery,
          );
          mods = (searchResult.mods || []).filter((mod) =>
            matchesNexusQueryLocally(mod, trimmedQuery),
          );
        }

        setNexusModsSearchResults(
          sortNexusMods(
            mods,
            trimmedQuery
              ? discoverSort
              : discoverSort === "relevance"
                ? "updated"
                : discoverSort,
          ),
        );
        setShowNexusModsResults(true);
      } catch (err) {
        console.error("Error searching NexusMods:", err);
        setNexusModsSearchResults([]);
      } finally {
        setSearchingNexusMods(false);
      }
    },
    [discoverSort],
  );

  const handleSearch = () => runThunderstoreSearch(searchQuery);

  const handleSearchNexusMods = () => runNexusSearch(nexusModsSearchQuery);

  useEffect(() => {
    if (previousDiscoverSortRef.current === discoverSort) {
      return;
    }
    previousDiscoverSortRef.current = discoverSort;

    if (!isOpen || libraryTab !== "discover") {
      return;
    }

    if (showSearchResults) {
      void runThunderstoreSearch(searchQuery);
      return;
    }

    if (showNexusModsResults) {
      void runNexusSearch(nexusModsSearchQuery);
    }
  }, [
    discoverSort,
    isOpen,
    libraryTab,
    nexusModsSearchQuery,
    runNexusSearch,
    runThunderstoreSearch,
    searchQuery,
    showNexusModsResults,
    showSearchResults,
  ]);

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
                  setLibrary(nextLibrary);
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
        setLibrary(nextLibrary);
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
      getLatestThunderstorePackageVersion,
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
  }, []);

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
          : environments.length > 0
            ? environments
            : await ApiService.getEnvironments().catch((error) => {
                console.warn(
                  "Failed to load environments for post-download install prompt:",
                  error,
                );
                return [];
              });

      if (environments.length === 0 && availableEnvironments.length > 0) {
        setEnvironments(availableEnvironments);
      }

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
      environments,
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
      setLibrary(nextLibrary);
      notifyLibraryUpdated();
      const availableEnvironments = await ApiService.getEnvironments().catch(
        (error) => {
          console.warn(
            "Failed to load environments for post-download install prompt:",
            error,
          );
          return [];
        },
      );
      setEnvironments(availableEnvironments);

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

    setInstallingTargets(true);
    try {
      const targetEnvironmentIds = Array.from(selectedInstallEnvironmentIds);
      const results = await Promise.all(
        installDialog.entries.map((entry) =>
          installEntryToEnvironmentIds(entry, targetEnvironmentIds),
        ),
      );
      closeInstallDialog();
      const installedEnvironmentNames = Array.from(
        new Set(results.flatMap((result) => result.installedEnvironmentNames)),
      );

      if (installedEnvironmentNames.length > 0) {
        showInstallSuccessNotice(installedEnvironmentNames);
      } else {
        const noOpNotice = buildInstallNoOpNotice(
          getCompatibleInstallSummary(
            installDialog.entries[0],
            installDialog.mode === "installed",
          ),
          installDialog.mode === "installed",
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
      setInstallingTargets(false);
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
    const runDownload = async (runtime: "IL2CPP" | "Mono" | "Both") => {
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
  ) => {
    const files = nexusModsFiles.get(modId) || [];
    if (files.length === 0) {
      await handleLoadNexusModFiles(modId);
      return;
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
                setLibrary(nextLibrary);
                notifyLibraryUpdated();
                const refreshedGroup = findDownloadedGroupForNexusMod(
                  modId,
                  nextLibrary,
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
                setLibrary(nextLibrary);
                notifyLibraryUpdated();
                const refreshedGroup = findDownloadedGroupForNexusMod(
                  modId,
                  nextLibrary,
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
              setLibrary(nextLibrary);
              notifyLibraryUpdated();
              const refreshedGroup = findDownloadedGroupForNexusMod(
                modId,
                nextLibrary,
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
              setLibrary(nextLibrary);
              notifyLibraryUpdated();
              const refreshedGroup = findDownloadedGroupForNexusMod(
                modId,
                nextLibrary,
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
    setOpenedFromLogs({ active: true, modTag: focusModTag ?? null });
    void handleSelectVersion(targetGroup, focusStorageId);
    openDownloadedModView(targetGroup, focusStorageId);
  }, [
    downloadedGroups,
    focusModTag,
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
    (modId: number, sourceLibrary?: ModLibraryResult | null) => {
      const groups = buildDownloadedGroups(
        sourceLibrary?.downloaded ?? library?.downloaded ?? [],
      );
      return (
        groups.find((group) =>
          group.entries.some(
            (entry) =>
              entry.source === "nexusmods" &&
              Number(entry.sourceId || "0") === modId,
          ),
        ) || null
      );
    },
    [library],
  );

  const renderCardIcon = useCallback(
    (
      name: string,
      iconCachePath?: string,
      iconUrl?: string,
      variant: "inline" | "rail" = "inline",
    ) => {
      const local = resolveImageSource(iconCachePath);
      const remote = resolveImageSource(iconUrl);
      const source = local || remote;
      const className =
        variant === "rail" ? "mod-card-icon-rail" : "mod-card-icon-inline";

      if (!source) {
        return (
          <div className={`${className} mod-card-icon-fallback`}>
            <Icon name="fas fa-puzzle-piece" />
          </div>
        );
      }

      return (
        <div className={className}>
          <img
            src={source}
            alt={`${name} icon`}
            className="mod-card-icon-image"
            onError={(e) => {
              if (remote && e.currentTarget.src !== remote) {
                e.currentTarget.src = remote;
                return;
              }
              e.currentTarget.style.display = "none";
            }}
          />
        </div>
      );
    },
    [],
  );

  const displayedDownloadedGroups = useMemo(() => {
    if (libraryTab === "updates") {
      return filteredDownloadedGroups.filter((group) =>
        isGroupUpdateAvailable(group),
      );
    }
    return filteredDownloadedGroups;
  }, [
    downloadedGroups,
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

  const selectedNexusFiles = useMemo(() => {
    if (!selectedNexusResult) {
      return [];
    }
    return sortNexusFilesNewestFirst(
      nexusModsFiles.get(selectedNexusResult.mod_id) || [],
    );
  }, [nexusModsFiles, selectedNexusResult]);

  const selectedNexusFile = useMemo(() => {
    if (!selectedNexusResult) {
      return null;
    }
    const selectedFileId = selectedNexusFileByModId[selectedNexusResult.mod_id];
    return (
      selectedNexusFiles.find((file) => file.file_id === selectedFileId) ||
      selectedNexusFiles[0] ||
      null
    );
  }, [selectedNexusFileByModId, selectedNexusFiles, selectedNexusResult]);

  const downloadedGroupForSelectedThunderstore = useMemo(() => {
    if (!selectedThunderstorePackage) {
      return null;
    }
    return findDownloadedGroupForThunderstorePackage(
      selectedThunderstorePackage,
    );
  }, [findDownloadedGroupForThunderstorePackage, selectedThunderstorePackage]);

  const downloadedGroupForSelectedNexus = useMemo(() => {
    if (!selectedNexusResult) {
      return null;
    }
    return findDownloadedGroupForNexusMod(selectedNexusResult.mod_id);
  }, [findDownloadedGroupForNexusMod, selectedNexusResult]);

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
  const discoverResultCount = showSearchResults
    ? searchResults.length
    : showNexusModsResults
      ? nexusModsSearchResults.length
      : 0;
  const activeQueueCount = downloading || installingTargets ? 1 : 0;

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
    if (!selectedNexusResult || selectedNexusFiles.length === 0) {
      return;
    }

    setSelectedNexusFileByModId((prev) => {
      if (
        prev[selectedNexusResult.mod_id] &&
        selectedNexusFiles.some(
          (file) => file.file_id === prev[selectedNexusResult.mod_id],
        )
      ) {
        return prev;
      }

      return {
        ...prev,
        [selectedNexusResult.mod_id]: selectedNexusFiles[0].file_id,
      };
    });
  }, [selectedNexusFiles, selectedNexusResult]);

  useEffect(() => {
    if (!isOpen || openedFromLogs.active || libraryTab === "discover") {
      return;
    }

    if (displayedDownloadedGroups.length === 0) {
      return;
    }

    const stillValid =
      activeModView?.kind === "downloaded" &&
      displayedDownloadedGroups.some((group) => group.key === activeModView.id);
    if (!stillValid) {
      openDownloadedModView(displayedDownloadedGroups[0]);
    }
  }, [
    activeModView,
    displayedDownloadedGroups,
    isOpen,
    libraryTab,
    openDownloadedModView,
    openedFromLogs.active,
  ]);

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
          label: group.installedIn.length > 0 ? "Install to more…" : "Install…",
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
            style={{ maxWidth: "420px" }}
          >
            <div className="modal-header">
              <h2>{runtimePrompt.title}</h2>
              <SimmButton
                type="button"
                variant="ghost"
                size="icon-sm"
                className="modal-close"
                onClick={() => {
                  runtimePrompt.onDismiss?.();
                  setRuntimePrompt(null);
                }}
              >
                ×
              </SimmButton>
            </div>
            <div style={{ padding: "1rem 1.25rem 1.25rem" }}>
              <p style={{ marginTop: 0, color: "#ccc" }}>
                {runtimePrompt.message}
              </p>
              <div
                style={{
                  display: "flex",
                  gap: "0.5rem",
                  justifyContent: "flex-end",
                }}
              >
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
            </div>
          </SimmDialogContent>
        </Dialog>
      )}

      <div className="mods-overlay mods-overlay--library workspace-collection-shell">
        <WorkspacePageHeader
          eyebrow="Workspace"
          title="Mod Library"
          description="Browse sources, manage downloaded entries, and install library versions into environments."
        />

        <div className="workspace-collection">
          <div className="workspace-collection__main">
            <div className="workspace-collection__header">
              <div className="workspace-collection__nav">
                <div className="workspace-collection__rail-group workspace-collection__rail-group--inline">
                  {(
                    [
                      ["discover", "Discover", "fas fa-compass"],
                      ["library", "Library", "fas fa-book-open"],
                      ["updates", "Updates", "fas fa-arrow-up"],
                    ] as Array<[LibraryTab, string, string]>
                  ).map(([tab, label, icon]) => (
                    <SimmButton
                      key={tab}
                      type="button"
                      variant="ghost"
                      className={`workspace-collection__rail-button ${libraryTab === tab ? "workspace-collection__rail-button--active" : ""}`}
                      onClick={() => setLibraryTab(tab)}
                    >
                      <Icon name={icon} />
                      <span>{label}</span>
                    </SimmButton>
                  ))}
                </div>

                <div className="workspace-collection__summary">
                  <div className="workspace-collection__summary-chip">
                    <span>{libraryTab === "discover" ? "Sources" : "Downloaded"}</span>
                    <strong>{libraryTab === "discover" ? 2 : downloadedSummary.total}</strong>
                  </div>
                  <div className="workspace-collection__summary-chip">
                    <span>{libraryTab === "discover" ? "Results" : "Updates"}</span>
                    <strong>{libraryTab === "discover" ? discoverResultCount : downloadedSummary.updates}</strong>
                  </div>
                  <div className="workspace-collection__summary-chip">
                    <span>{libraryTab === "discover" ? "Queue" : "Installed"}</span>
                    <strong>{libraryTab === "discover" ? activeQueueCount : downloadedSummary.installed}</strong>
                  </div>
                </div>
              </div>

              {(libraryTab === "library" || libraryTab === "updates") && (
                <div className="workspace-collection__rail-group workspace-collection__rail-group--inline workspace-collection__filters-row">
                  {(
                    [
                      "all",
                      "updates",
                      "managed",
                      "external",
                      "installed",
                    ] as DownloadedFilter[]
                  ).map((filter) => (
                    <SimmButton
                      key={filter}
                      type="button"
                      variant="ghost"
                      className={`workspace-collection__rail-button workspace-collection__rail-button--subtle ${downloadedFilter === filter ? "workspace-collection__rail-button--active" : ""}`}
                      onClick={() => setDownloadedFilter(filter)}
                    >
                      {filter === "all"
                        ? "All"
                        : filter === "updates"
                          ? "Updates"
                          : filter === "managed"
                            ? "Managed"
                            : filter === "external"
                              ? "External"
                              : "Installed"}
                    </SimmButton>
                  ))}
                </div>
              )}

              <div className="workspace-collection__toolbar">
                {libraryTab === "discover" ? (
                  <>
                    <div className="workspace-collection__toolbar-group workspace-source-toggle" aria-label="Search source">
                      <span className="workspace-control-label">Sources</span>
                      <SimmButton
                        type="button"
                        variant={searchSource === "thunderstore" ? "default" : "secondary"}
                        className={`btn btn-small ${searchSource === "thunderstore" ? "btn-primary" : "btn-secondary"}`}
                        onClick={() => {
                          setSearchSource("thunderstore");
                          setShowSearchResults(false);
                          setShowNexusModsResults(false);
                          setActiveModView(null);
                        }}
                      >
                        Thunderstore
                      </SimmButton>
                      <SimmButton
                        type="button"
                        variant={searchSource === "nexusmods" ? "default" : "secondary"}
                        className={`btn btn-small ${searchSource === "nexusmods" ? "btn-primary" : "btn-secondary"}`}
                        onClick={() => {
                          setSearchSource("nexusmods");
                          setShowSearchResults(false);
                          setShowNexusModsResults(false);
                          setActiveModView(null);
                        }}
                      >
                        Nexus Mods
                      </SimmButton>
                    </div>
                    <div className="workspace-collection__toolbar-search">
                      <Input
                        type="text"
                        placeholder={
                          searchSource === "thunderstore"
                            ? "Search or browse Thunderstore mods..."
                            : "Search or browse Nexus Mods..."
                        }
                        value={
                          searchSource === "thunderstore"
                            ? searchQuery
                            : nexusModsSearchQuery
                        }
                        onChange={(event) =>
                          searchSource === "thunderstore"
                            ? setSearchQuery(event.target.value)
                            : setNexusModsSearchQuery(event.target.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            if (searchSource === "thunderstore") handleSearch();
                            else handleSearchNexusMods();
                          }
                        }}
                      />
                      <SimmButton
                        type="button"
                        className="btn btn-primary btn-small"
                        onClick={
                          searchSource === "thunderstore"
                            ? handleSearch
                            : handleSearchNexusMods
                        }
                        disabled={
                          searchSource === "thunderstore"
                            ? searching
                            : searchingNexusMods
                        }
                      >
                        {(
                          searchSource === "thunderstore"
                            ? searchQuery.trim()
                            : nexusModsSearchQuery.trim()
                        )
                          ? "Search"
                          : "Browse"}
                      </SimmButton>
                    </div>
                    <div className="workspace-collection__toolbar-group">
                      <span className="workspace-control-label">Sort</span>
                      <div className="workspace-collection__toolbar-select">
                        <DiscoverSortSelect
                          value={discoverSort}
                          onValueChange={setDiscoverSort}
                        />
                      </div>
                    </div>
                    <SimmButton
                      type="button"
                      variant="secondary"
                      className="btn btn-secondary btn-small"
                      onClick={handleRefreshLibrary}
                      disabled={loadingLibrary}
                    >
                      <Icon name={`fas ${loadingLibrary ? "fa-spinner fa-spin" : "fa-sync-alt"}`}
                       />
                      <span>Refresh</span>
                    </SimmButton>
                  </>
                ) : (
                  <>
                    <div className="workspace-collection__toolbar-group workspace-collection__toolbar-group--summary">
                      <strong>
                        {libraryTab === "updates"
                          ? "Available Updates"
                          : "Downloaded Library"}
                      </strong>
                      <span>
                        {displayedDownloadedGroups.length}{" "}
                        {displayedDownloadedGroups.length === 1
                          ? "group"
                          : "groups"}
                      </span>
                    </div>
                    <div className="workspace-collection__toolbar-search">
                      <Input
                        type="text"
                        value={downloadedSearch}
                        onChange={(event) =>
                          setDownloadedSearch(event.target.value)
                        }
                        placeholder="Filter by mod, author, or version"
                      />
                    </div>
                    {libraryTab === "library" ? (
                      <SimmButton
                        type="button"
                        className="btn btn-primary btn-small"
                        onClick={handleAddFilesClick}
                        disabled={downloading === "library-import"}
                      >
                        <Icon name={`fas ${downloading === "library-import" ? "fa-spinner fa-spin" : "fa-plus"}`}
                         />
                        <span>
                          {downloading === "library-import"
                            ? "Adding..."
                            : "Add Files"}
                        </span>
                      </SimmButton>
                    ) : null}
                    <SimmButton
                      type="button"
                      variant="secondary"
                      className="btn btn-secondary btn-small"
                      onClick={handleRefreshLibrary}
                      disabled={loadingLibrary}
                    >
                      <Icon name={`fas ${loadingLibrary ? "fa-spinner fa-spin" : "fa-sync-alt"}`}
                       />
                      <span>Refresh</span>
                    </SimmButton>
                  </>
                )}
              </div>
            </div>

            <div className="workspace-collection__content">
              {libraryTab === "discover" &&
                !showSearchResults &&
                !showNexusModsResults && (
                  <section className="workspace-collection__section">
                    <div className="workspace-collection__section-header">
                      <h3>Featured</h3>
                      <span>Core tools and recommended downloads</span>
                    </div>
                    <div className="workspace-feature-grid">
                      <SimmButton
                        type="button"
                        variant="ghost"
                        className="workspace-feature-card"
                        onClick={handleDownloadS1APIClick}
                      >
                        <div>
                          <strong>S1API</strong>
                          <p>
                            GitHub release for shared APIs and
                            interoperability.
                          </p>
                        </div>
                        <span>{s1apiActionLabel}</span>
                      </SimmButton>
                      <SimmButton
                        type="button"
                        variant="ghost"
                        className="workspace-feature-card"
                        onClick={handleDownloadMlvscanClick}
                      >
                        <div>
                          <strong>MLVScan</strong>
                          <p>
                            GitHub-hosted library scanning and validation
                            tooling.
                          </p>
                        </div>
                        <span>{mlvscanActionLabel}</span>
                      </SimmButton>
                      <SimmButton
                        type="button"
                        variant="ghost"
                        className="workspace-feature-card"
                        onClick={handleDownloadMeshVaultClick}
                        disabled={!meshVaultFeaturedPackage}
                      >
                        <div>
                          <strong>MeshVault</strong>
                          <p>
                            Thunderstore package that installs its runtime DLLs
                            into Plugins.
                          </p>
                        </div>
                        <span>{meshVaultActionLabel}</span>
                      </SimmButton>
                      <SimmButton
                        type="button"
                        variant="ghost"
                        className="workspace-feature-card"
                        onClick={handleDownloadS1MapiClick}
                        disabled={!s1mapiFeaturedPackage}
                      >
                        <div>
                          <strong>S1MAPI</strong>
                          <p>
                            Thunderstore package for shared Schedule I mapping
                            APIs in UserLibs.
                          </p>
                        </div>
                        <span>{s1mapiActionLabel}</span>
                      </SimmButton>
                      <SimmButton
                        type="button"
                        variant="ghost"
                        className="workspace-feature-card"
                        onClick={handleDownloadSteamNetworkLibClick}
                        disabled={!steamNetworkLibFeaturedPackage}
                      >
                        <div>
                          <strong>SteamNetworkLib</strong>
                          <p>
                            Thunderstore library for shared Steam networking in
                            UserLibs.
                          </p>
                        </div>
                        <span>{steamNetworkLibActionLabel}</span>
                      </SimmButton>
                    </div>
                  </section>
                )}

              {libraryTab === "discover" &&
                (showSearchResults || showNexusModsResults) && (
                  <section className="workspace-collection__section workspace-collection__section--inventory">
                    <div className="workspace-collection__list workspace-collection__list--inventory">
                      <div className="workspace-collection__table-head workspace-collection__table-head--discover" aria-hidden="true">
                        <span>Name</span>
                        <span>Author</span>
                        <span>Source</span>
                        <span>Status</span>
                      </div>
                      {showSearchResults &&
                        searchResults.map((pkg) => {
                          const representative =
                            pkg.packagesByRuntime.IL2CPP ||
                            pkg.packagesByRuntime.Mono;
                          const latestVersion = representative?.versions?.[0];
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
                              className={`workspace-collection__row workspace-collection__row--discover ${isSelected ? "workspace-collection__row--selected" : ""}`}
                              role="button"
                              tabIndex={0}
                              onClick={() => openThunderstoreModView(pkg)}
                              onKeyDown={(event) =>
                                handleCardActivationKeyDown(event, () =>
                                  openThunderstoreModView(pkg),
                                )
                              }
                            >
                              {renderCardIcon(
                                pkg.name,
                                undefined,
                                latestVersion?.icon ||
                                  representative?.icon ||
                                  representative?.icon_url,
                                "inline",
                              )}
                              <div className="workspace-collection__row-body">
                                <div className="workspace-collection__row-title">
                                  {pkg.name}
                                </div>
                                <div className="workspace-collection__row-meta">
                                  {updatedLabel !== "unknown" && (
                                    <span>Updated {updatedLabel}</span>
                                  )}
                                </div>
                                <p className="workspace-collection__row-summary">
                                  {latestVersion?.description ||
                                    "No summary provided."}
                                </p>
                              </div>
                              <div className="workspace-collection__row-cell">
                                <span>{pkg.owner}</span>
                              </div>
                              <div className="workspace-collection__row-cell">
                                <span>Thunderstore</span>
                              </div>
                              <div className="workspace-collection__row-cell workspace-collection__row-cell--status">
                                {downloadedGroup &&
                                isGroupUpdateAvailable(downloadedGroup) ? (
                                  <span className="workspace-collection__status workspace-collection__status--warning">
                                    Update
                                  </span>
                                ) : downloadedGroup ? (
                                  <span className="workspace-collection__status workspace-collection__status--success">
                                    Downloaded
                                  </span>
                                ) : (
                                  <span className="workspace-collection__status workspace-collection__status--muted">
                                    Available
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}

                      {showNexusModsResults &&
                        nexusModsSearchResults.map((mod) => {
                          const updatedLabel = formatInspectorDate(
                            getNexusModUpdatedAt(mod),
                          );
                          const downloadedGroup =
                            findDownloadedGroupForNexusMod(mod.mod_id);
                          const isSelected =
                            activeModView?.kind === "nexusmods" &&
                            activeModView.id === String(mod.mod_id);
                          return (
                            <div
                              key={mod.mod_id}
                              className={`workspace-collection__row workspace-collection__row--discover ${isSelected ? "workspace-collection__row--selected" : ""}`}
                              role="button"
                              tabIndex={0}
                              onClick={() => openNexusModView(mod)}
                              onKeyDown={(event) =>
                                handleCardActivationKeyDown(event, () =>
                                  openNexusModView(mod),
                                )
                              }
                            >
                              {renderCardIcon(
                                mod.name,
                                undefined,
                                mod.picture_url,
                                "inline",
                              )}
                              <div className="workspace-collection__row-body">
                                <div className="workspace-collection__row-title">
                                  {mod.name}
                                </div>
                                <div className="workspace-collection__row-meta">
                                  {updatedLabel !== "unknown" && (
                                    <span>Updated {updatedLabel}</span>
                                  )}
                                </div>
                                <p className="workspace-collection__row-summary">
                                  {mod.summary || "No summary provided."}
                                </p>
                              </div>
                              <div className="workspace-collection__row-cell">
                                <span>{getNexusModAttribution(mod)}</span>
                              </div>
                              <div className="workspace-collection__row-cell">
                                <span>Nexus Mods</span>
                              </div>
                              <div className="workspace-collection__row-cell workspace-collection__row-cell--status">
                                {downloadedGroup &&
                                isGroupUpdateAvailable(downloadedGroup) ? (
                                  <span className="workspace-collection__status workspace-collection__status--warning">
                                    Update
                                  </span>
                                ) : downloadedGroup ? (
                                  <span className="workspace-collection__status workspace-collection__status--success">
                                    Downloaded
                                  </span>
                                ) : (
                                  <span className="workspace-collection__status workspace-collection__status--muted">
                                    Available
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      {showSearchResults && searchResults.length === 0 && (
                        <CollectionEmpty>No Thunderstore mods matched this search.</CollectionEmpty>
                      )}
                      {showNexusModsResults &&
                        nexusModsSearchResults.length === 0 && (
                          <CollectionEmpty>No Nexus Mods matched this search.</CollectionEmpty>
                        )}
                    </div>
                  </section>
              )}

              {(libraryTab === "library" || libraryTab === "updates") && (
                <section className="workspace-collection__section workspace-collection__section--inventory">
                  {loadingLibrary && (
                    <CollectionEmpty>Loading mod library...</CollectionEmpty>
                  )}
                  {!loadingLibrary &&
                    displayedDownloadedGroups.length === 0 && (
                      <CollectionEmpty>
                        {libraryTab === "updates"
                          ? "No downloaded mods currently need updates."
                          : "No downloaded mods match this filter."}
                      </CollectionEmpty>
                  )}
                  {!loadingLibrary && displayedDownloadedGroups.length > 0 && (
                    <div className="workspace-collection__list workspace-collection__list--inventory">
                      <div className="workspace-collection__table-head workspace-collection__table-head--downloaded" aria-hidden="true">
                        <span>Name</span>
                        <span>Source</span>
                        <span>Version</span>
                        <span>Installed</span>
                      </div>
                      {displayedDownloadedGroups.map((group) => {
                        const activeEntry =
                          getActiveEntryForGroup(group) || group.entries[0];
                        const securityBadge =
                          settings?.showSecurityScanBadges !== false
                            ? getSecurityBadgeConfig(activeEntry?.securityScan)
                            : null;
                        const isSelected =
                          activeModView?.kind === "downloaded" &&
                          activeModView.id === group.key;
                        return (
                          <div
                            key={group.key}
                            className={`workspace-collection__row workspace-collection__row--downloaded ${isSelected ? "workspace-collection__row--selected" : ""}`}
                            role="button"
                            tabIndex={0}
                            onClick={() => openDownloadedModView(group)}
                            onKeyDown={(event) =>
                              handleCardActivationKeyDown(event, () =>
                                openDownloadedModView(group),
                              )
                            }
                            onContextMenu={(event) =>
                              openContextMenu(
                                event,
                                downloadedContextMenuItems(group),
                              )
                            }
                          >
                            {renderCardIcon(
                              group.displayName,
                              activeEntry?.iconCachePath,
                              activeEntry?.iconUrl,
                              "inline",
                            )}
                            <div className="workspace-collection__row-body">
                              <div className="workspace-collection__row-title">
                                {group.displayName}
                              </div>
                              <div className="workspace-collection__row-meta">
                                {group.availableRuntimes.map((runtime) => (
                                  <WorkspaceBadge
                                    key={`${group.key}-${runtime}`}
                                  >
                                    {runtime}
                                  </WorkspaceBadge>
                                ))}
                                {isGroupUpdateAvailable(group) && (
                                  <WorkspaceBadge tone="warning">
                                    Update available
                                  </WorkspaceBadge>
                                )}
                                {securityBadge && (
                                  <WorkspaceBadge
                                    className="workspace-pill--security"
                                    style={{
                                      borderColor: securityBadge.border,
                                      background: securityBadge.background,
                                      color: securityBadge.color,
                                    }}
                                  >
                                    {securityBadge.label}
                                  </WorkspaceBadge>
                                )}
                              </div>
                              <p className="workspace-collection__row-summary">
                                {activeEntry?.summary || "No summary provided."}
                              </p>
                            </div>
                            <div className="workspace-collection__row-cell workspace-collection__row-cell--source">
                              <span>
                                {getSourceBadgeLabel(activeEntry?.source)}
                              </span>
                              {group.author ? <small>{group.author}</small> : null}
                            </div>
                            <div className="workspace-collection__row-cell">
                              <span>
                                {formatVersionTag(
                                  getEntryVersionLabel(activeEntry!),
                                )}
                              </span>
                              {group.remoteVersion &&
                              group.remoteVersion !==
                                getEntryVersionLabel(activeEntry!) ? (
                                <small>
                                  Latest {formatVersionTag(group.remoteVersion)}
                                </small>
                              ) : null}
                            </div>
                            <div className="workspace-collection__row-cell">
                              <span>{group.installedIn.length}</span>
                              <small>
                                {group.installedIn.length === 1
                                  ? "environment"
                                  : "environments"}
                              </small>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              )}
            </div>
          </div>

          <aside className="workspace-collection__inspector">
            {!activeModView && (
              <InspectorEmpty>Select a mod to review details and actions.</InspectorEmpty>
            )}

            {selectedDownloadedGroup && selectedDownloadedEntry && (
              <div className="workspace-inspector-card">
                <div className="workspace-inspector-card__header">
                  {renderCardIcon(
                    selectedDownloadedGroup.displayName,
                    selectedDownloadedEntry.iconCachePath,
                    selectedDownloadedEntry.iconUrl,
                    "rail",
                  )}
                  <div>
                    <h3>{selectedDownloadedGroup.displayName}</h3>
                    <div className="workspace-inspector-card__subtle">
                      {getSourceBadgeLabel(selectedDownloadedEntry.source)}
                      {selectedDownloadedGroup.author
                        ? ` • ${selectedDownloadedGroup.author}`
                        : ""}
                      {` • ${selectedDownloadedGroupEntries.length} version${selectedDownloadedGroupEntries.length === 1 ? "" : "s"}`}
                    </div>
                    {settings?.showSecurityScanBadges !== false && (
                      <SecurityScanBadge
                        summary={selectedDownloadedEntry.securityScan}
                      />
                    )}
                  </div>
                </div>
                <p className="workspace-inspector-card__summary">
                  {selectedDownloadedEntry.summary || "No summary provided."}
                </p>
                <div className="workspace-inspector-card__metrics">
                  <div>
                    <span>Installed</span>
                    <strong>
                      {selectedDownloadedGroup.installedIn.length}
                    </strong>
                  </div>
                  <div>
                    <span>Versions</span>
                    <strong>{selectedDownloadedGroupEntries.length}</strong>
                  </div>
                  <div>
                    <span>Selected version</span>
                    <strong>
                      {formatVersionTag(
                        getEntryVersionLabel(selectedDownloadedEntry),
                      )}
                    </strong>
                  </div>
                  <div>
                    <span>Latest</span>
                    <strong>
                      {selectedDownloadedGroup.remoteVersion
                        ? formatVersionTag(
                            selectedDownloadedGroup.remoteVersion,
                          )
                        : "unknown"}
                    </strong>
                  </div>
                </div>
                <div className="workspace-inspector-card__field">
                  <label
                    htmlFor={`mod-library-version-${selectedDownloadedGroup.key}`}
                  >
                    Available versions
                  </label>
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
                      className="workspace-inspector-card__select"
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
                    <SelectContent className="workspace-inspector-card__select-content" align="start">
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
                </div>
                <div className="workspace-inspector-card__actions">
                  {selectedDownloadedEntry.storageId &&
                    selectedDownloadedEntry.securityScan && (
                      <SimmButton
                        type="button"
                        variant="secondary"
                        className="btn btn-secondary"
                        onClick={() =>
                          void openStoredSecurityReport(
                            selectedDownloadedEntry.storageId,
                            `Security Findings - ${selectedDownloadedEntry.displayName}`,
                          )
                        }
                      >
                        Security Report
                      </SimmButton>
                    )}
                  {(() => {
                    const installMoreOnly =
                      selectedDownloadedGroup.installedIn.length > 0;
                    const {
                      installable,
                      runtimeIncompatible,
                      blockedBySiblingVersion,
                      alreadyInstalled,
                    } = getCompatibleInstallSummary(
                      selectedDownloadedEntry,
                      installMoreOnly,
                    );
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
                    return (
                      <SimmButton
                        type="button"
                        className="btn btn-primary"
                        onClick={() =>
                          void promptInstallTargets(
                            selectedDownloadedEntry,
                            `Install ${selectedDownloadedEntry.displayName}`,
                            installMoreOnly,
                          )
                        }
                        disabled={installDisabled}
                        title={installTitle}
                      >
                        {installMoreOnly ? "Install to more…" : "Install…"}
                      </SimmButton>
                    );
                  })()}
                  <SimmButton
                    type="button"
                    variant="secondary"
                    className="btn btn-secondary"
                    onClick={() =>
                      void handleSelectVersion(
                        selectedDownloadedGroup,
                        selectedDownloadedEntry.storageId,
                      )
                    }
                    disabled={
                      selectedDownloadedGroup.installedIn.length === 0 ||
                      selectedDownloadedGroupEntries.length < 2 ||
                      activatingGroup === selectedDownloadedGroup.key
                    }
                  >
                    {activatingGroup === selectedDownloadedGroup.key
                      ? "Activating…"
                      : "Activate selected version"}
                  </SimmButton>
                  <SimmButton
                    type="button"
                    variant="secondary"
                    className="btn btn-secondary"
                    onClick={() =>
                      void handleUpdateAndActivateGroup(selectedDownloadedGroup)
                    }
                    disabled={!isGroupUpdateAvailable(selectedDownloadedGroup)}
                  >
                    Update and activate
                  </SimmButton>
                  <SimmButton
                    type="button"
                    variant="destructive"
                    className="btn btn-danger"
                    onClick={() =>
                      void handleDeleteDownloadedGroup(selectedDownloadedGroup)
                    }
                  >
                    Delete downloaded files
                  </SimmButton>
                </div>
              </div>
            )}

            {selectedThunderstorePackage && (
              <div className="workspace-inspector-card">
                {(() => {
                  const representativePackage =
                    selectedThunderstorePackage.packagesByRuntime.IL2CPP ||
                    selectedThunderstorePackage.packagesByRuntime.Mono;
                  const latestVersion = representativePackage?.versions?.[0];
                  const runtimeLabels = (["IL2CPP", "Mono"] as const).filter(
                    (runtime) =>
                      !!selectedThunderstorePackage.packagesByRuntime[runtime],
                  );
                  const categories = representativePackage?.categories || [];
                  return (
                    <>
                      <div className="workspace-inspector-card__header">
                        {renderCardIcon(
                          selectedThunderstorePackage.name,
                          undefined,
                          latestVersion?.icon ||
                            representativePackage?.icon ||
                            representativePackage?.icon_url,
                          "rail",
                        )}
                        <div>
                          <h3>{selectedThunderstorePackage.name}</h3>
                          <div className="workspace-inspector-card__subtle">
                            Thunderstore • {selectedThunderstorePackage.owner}
                            {downloadedGroupForSelectedThunderstore
                              ? ` • ${downloadedGroupForSelectedThunderstore.installedIn.length} env${downloadedGroupForSelectedThunderstore.installedIn.length === 1 ? "" : "s"}`
                              : ""}
                          </div>
                        </div>
                      </div>
                      <p className="workspace-inspector-card__summary">
                        {latestVersion?.description ||
                          "No description provided for this package."}
                      </p>
                      <div className="workspace-inspector-card__metrics">
                        <div>
                          <span>Latest</span>
                          <strong>
                            {formatVersionTag(latestVersion?.version_number)}
                          </strong>
                        </div>
                        <div>
                          <span>Versions</span>
                          <strong>
                            {representativePackage?.versions?.length || 0}
                          </strong>
                        </div>
                        <div>
                          <span>Downloads</span>
                          <strong>
                            {formatCompactNumber(latestVersion?.downloads)}
                          </strong>
                        </div>
                        <div>
                          <span>Updated</span>
                          <strong>
                            {formatInspectorDate(
                              getThunderstorePackageUpdatedAt(
                                representativePackage,
                              ),
                            )}
                          </strong>
                        </div>
                      </div>
                      <div className="workspace-inspector-card__field">
                        <label>Runtime support</label>
                        <div className="workspace-inspector-card__tags">
                          {runtimeLabels.map((runtime) => (
                            <WorkspaceBadge
                              key={`${selectedThunderstorePackage.key}-${runtime}`}
                            >
                              {runtime}
                            </WorkspaceBadge>
                          ))}
                          {runtimeLabels.length === 0 && (
                            <WorkspaceBadge>
                              Unknown runtime
                            </WorkspaceBadge>
                          )}
                        </div>
                      </div>
                      {categories.length > 0 && (
                        <div className="workspace-inspector-card__field">
                          <label>Categories</label>
                          <div className="workspace-inspector-card__tags">
                            {categories.slice(0, 6).map((category) => (
                              <WorkspaceBadge
                                key={`${selectedThunderstorePackage.key}-${category}`}
                              >
                                {category}
                              </WorkspaceBadge>
                            ))}
                          </div>
                        </div>
                      )}
                      <div className="workspace-inspector-card__field">
                        <label>Status</label>
                        <div className="workspace-inspector-card__tags">
                          <WorkspaceBadge tone="source">
                            Thunderstore
                          </WorkspaceBadge>
                          {downloadedGroupForSelectedThunderstore && (
                            <WorkspaceBadge tone="success">
                              Downloaded
                            </WorkspaceBadge>
                          )}
                          {downloadedGroupForSelectedThunderstore &&
                            isGroupUpdateAvailable(
                              downloadedGroupForSelectedThunderstore,
                            ) && (
                              <WorkspaceBadge tone="warning">
                                Update available
                              </WorkspaceBadge>
                            )}
                          {representativePackage?.is_pinned && (
                            <WorkspaceBadge>Pinned</WorkspaceBadge>
                          )}
                          {representativePackage?.is_deprecated && (
                            <WorkspaceBadge tone="danger">
                              Deprecated
                            </WorkspaceBadge>
                          )}
                        </div>
                      </div>
                    </>
                  );
                })()}
                <div className="workspace-inspector-card__actions">
                  <SimmButton
                    type="button"
                    className="btn btn-primary"
                    onClick={() =>
                      void handleDownloadThunderstore(
                        selectedThunderstorePackage,
                        selectedThunderstoreVersion,
                      )
                    }
                  >
                    Download selected version
                  </SimmButton>
                  {downloadedGroupForSelectedThunderstore &&
                    selectedThunderstoreDownloadedEntry && (
                      <SimmButton
                        type="button"
                        variant="secondary"
                        className="btn btn-secondary"
                        onClick={() =>
                          void promptInstallTargets(
                            selectedThunderstoreDownloadedEntry,
                            `Install ${selectedThunderstoreDownloadedEntry.displayName}`,
                            downloadedGroupForSelectedThunderstore.installedIn
                              .length > 0,
                          )
                        }
                      >
                        {downloadedGroupForSelectedThunderstore.installedIn
                          .length > 0
                          ? "Install library version…"
                          : "Install library version"}
                      </SimmButton>
                    )}
                  {safeExternalUrl(selectedThunderstorePackage.packageUrl) && (
                    <a
                      className="btn btn-secondary"
                      href={
                        safeExternalUrl(selectedThunderstorePackage.packageUrl)!
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open source page
                    </a>
                  )}
                </div>
                <section
                  className="workspace-inspector-card__subsection"
                  aria-labelledby="thunderstore-inspector-versions"
                >
                  <div className="workspace-inspector-card__subsection-header">
                    <div>
                      <h4 id="thunderstore-inspector-versions">
                        Available versions
                      </h4>
                      <p>
                        Pick the package version you want to add to the library.
                      </p>
                    </div>
                    <WorkspaceBadge className="workspace-inspector-card__subsection-count">
                      {selectedThunderstoreVersionOptions.length} available
                    </WorkspaceBadge>
                  </div>
                  <div
                    className="workspace-version-list"
                    role="listbox"
                    aria-label="Thunderstore available versions"
                  >
                    {selectedThunderstoreVersionOptions.map((versionOption) => {
                      const isActive =
                        selectedThunderstoreVersion?.key === versionOption.key;
                      return (
                        <SimmButton
                          key={versionOption.key}
                          type="button"
                          variant="ghost"
                          role="option"
                          aria-selected={isActive}
                          className={`workspace-version-row${isActive ? " workspace-version-row--active" : ""}`}
                          onClick={() =>
                            setSelectedThunderstoreVersionByPackage((prev) => ({
                              ...prev,
                              [selectedThunderstorePackage.key]:
                                versionOption.key,
                            }))
                          }
                        >
                          <div className="workspace-version-row__header">
                            <div className="workspace-version-row__title">
                              {formatVersionTag(versionOption.versionNumber)}
                            </div>
                            <div className="workspace-version-row__badges">
                              {versionOption.runtimes.map((runtime) => (
                                <WorkspaceBadge
                                  key={`${versionOption.key}-${runtime}`}
                                >
                                  {runtime}
                                </WorkspaceBadge>
                              ))}
                            </div>
                          </div>
                          <div className="workspace-version-row__meta">
                            <span>
                              Updated{" "}
                              {formatInspectorDate(versionOption.updatedAt)}
                            </span>
                            <span>
                              {formatCompactNumber(versionOption.downloads)}{" "}
                              downloads
                            </span>
                          </div>
                          {versionOption.description && (
                            <p className="workspace-version-row__summary">
                              {versionOption.description}
                            </p>
                          )}
                        </SimmButton>
                      );
                    })}
                  </div>
                </section>
              </div>
            )}

            {selectedNexusResult && (
              <div className="workspace-inspector-card">
                <div className="workspace-inspector-card__header">
                  {renderCardIcon(
                    selectedNexusResult.name,
                    undefined,
                    selectedNexusResult.picture_url,
                    "rail",
                  )}
                  <div>
                    <h3>{selectedNexusResult.name}</h3>
                    <div className="workspace-inspector-card__subtle">
                      Nexus Mods • {getNexusModAttribution(selectedNexusResult)}
                      {downloadedGroupForSelectedNexus
                        ? ` • ${downloadedGroupForSelectedNexus.installedIn.length} env${downloadedGroupForSelectedNexus.installedIn.length === 1 ? "" : "s"}`
                        : ""}
                    </div>
                  </div>
                </div>
                <p className="workspace-inspector-card__summary">
                  {selectedNexusResult.description ||
                    selectedNexusResult.summary ||
                    "No description provided for this mod."}
                </p>
                <div className="workspace-inspector-card__metrics">
                  <div>
                    <span>Latest</span>
                    <strong>
                      {formatVersionTag(selectedNexusResult.version)}
                    </strong>
                  </div>
                  <div>
                    <span>Endorsements</span>
                    <strong>
                      {formatCompactNumber(
                        selectedNexusResult.endorsement_count,
                      )}
                    </strong>
                  </div>
                  <div>
                    <span>Downloads</span>
                    <strong>
                      {formatCompactNumber(
                        selectedNexusResult.mod_downloads ||
                          selectedNexusResult.unique_downloads,
                      )}
                    </strong>
                  </div>
                  <div>
                    <span>Updated</span>
                    <strong>
                      {formatInspectorDate(
                        getNexusModUpdatedAt(selectedNexusResult),
                      )}
                    </strong>
                  </div>
                </div>
                <div className="workspace-inspector-card__field">
                  <label>Status</label>
                  <div className="workspace-inspector-card__tags">
                    <WorkspaceBadge tone="source">
                      Nexus Mods
                    </WorkspaceBadge>
                    {downloadedGroupForSelectedNexus && (
                      <WorkspaceBadge tone="success">
                        Downloaded
                      </WorkspaceBadge>
                    )}
                    {downloadedGroupForSelectedNexus &&
                      isGroupUpdateAvailable(
                        downloadedGroupForSelectedNexus,
                      ) && (
                        <WorkspaceBadge tone="warning">
                          Update available
                        </WorkspaceBadge>
                      )}
                    {selectedNexusResult.contains_adult_content && (
                      <WorkspaceBadge tone="danger">
                        Adult content
                      </WorkspaceBadge>
                    )}
                    {selectedNexusResult.status && (
                      <WorkspaceBadge>
                        {selectedNexusResult.status}
                      </WorkspaceBadge>
                    )}
                  </div>
                </div>
                <div className="workspace-inspector-card__actions">
                  <SimmButton
                    type="button"
                    className="btn btn-primary"
                    onClick={() =>
                      void handleDownloadNexusMod(
                        selectedNexusResult.mod_id,
                        selectedNexusFile,
                      )
                    }
                    disabled={selectedNexusFiles.length === 0}
                  >
                    Download selected version
                  </SimmButton>
                  {downloadedGroupForSelectedNexus &&
                    selectedNexusDownloadedEntry &&
                    (() => {
                      const installMoreOnly =
                        downloadedGroupForSelectedNexus.installedIn.length > 0;
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
                          variant="secondary"
                          className="btn btn-secondary"
                          onClick={() =>
                            void promptInstallTargets(
                              selectedNexusDownloadedEntry,
                              `Install ${selectedNexusDownloadedEntry.displayName}`,
                              installMoreOnly,
                            )
                          }
                          disabled={installDisabled}
                          title={installTitle}
                        >
                          {installMoreOnly
                            ? "Install library version…"
                            : "Install library version"}
                        </SimmButton>
                      );
                    })()}
                  <a
                    className="btn btn-secondary"
                    href={`https://www.nexusmods.com/schedule1/mods/${selectedNexusResult.mod_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open source page
                  </a>
                </div>
                <section
                  className="workspace-inspector-card__subsection"
                  aria-labelledby="nexus-inspector-versions"
                >
                  <div className="workspace-inspector-card__subsection-header">
                    <div>
                      <h4 id="nexus-inspector-versions">Available versions</h4>
                      <p>
                        Pick the file you want to add to the library before
                        downloading.
                      </p>
                    </div>
                    <WorkspaceBadge className="workspace-inspector-card__subsection-count">
                      {selectedNexusFiles.length} available
                    </WorkspaceBadge>
                  </div>
                  {selectedNexusFiles.length > 0 ? (
                    <div
                      className="workspace-version-list"
                      role="listbox"
                      aria-label="Nexus available versions"
                    >
                      {selectedNexusFiles.map((file) => {
                        const displayKind = getNexusFileDisplayKind(file);
                        const versionLabel =
                          file.version || file.mod_version || "unknown";
                        const isActive =
                          selectedNexusFile?.file_id === file.file_id;
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
                        return (
                          <SimmButton
                            key={file.file_id}
                            type="button"
                            variant="ghost"
                            role="option"
                            aria-selected={isActive}
                            className={`workspace-version-row${isActive ? " workspace-version-row--active" : ""}`}
                            onClick={() =>
                              setSelectedNexusFileByModId((prev) => ({
                                ...prev,
                                [selectedNexusResult.mod_id]: file.file_id,
                              }))
                            }
                          >
                            <div className="workspace-version-row__header">
                              <div className="workspace-version-row__title">
                                {formatVersionTag(versionLabel)}
                              </div>
                              <div className="workspace-version-row__badges">
                                <WorkspaceBadge>
                                  {displayKind}
                                </WorkspaceBadge>
                                {file.is_primary && (
                                  <WorkspaceBadge tone="success">
                                    Primary
                                  </WorkspaceBadge>
                                )}
                                {file.category_name && (
                                  <WorkspaceBadge tone="source">
                                    {file.category_name}
                                  </WorkspaceBadge>
                                )}
                              </div>
                            </div>
                            <div className="workspace-version-row__meta">
                              <span>
                                Uploaded{" "}
                                {formatInspectorDate(
                                  getNexusFileUpdatedAt(file) ||
                                    getNexusModUpdatedAt(selectedNexusResult),
                                )}
                              </span>
                              {detailLabel && <span>{detailLabel}</span>}
                            </div>
                            {summaryLabel && (
                              <p className="workspace-version-row__summary">
                                {summaryLabel}
                              </p>
                            )}
                          </SimmButton>
                        );
                      })}
                    </div>
                  ) : (
                    <InspectorCardEmpty>
                      No downloadable files were returned for this Nexus mod
                      yet.
                    </InspectorCardEmpty>
                  )}
                </section>
              </div>
            )}
          </aside>
        </div>
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
