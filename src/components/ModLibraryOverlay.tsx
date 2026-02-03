import { useEffect, useMemo, useState } from 'react';
import { ApiService } from '../services/api';
import { ConfirmOverlay } from './ConfirmOverlay';
import { useEnvironmentStore } from '../stores/environmentStore';
import type { Environment, ModLibraryEntry, ModLibraryResult, NexusMod, NexusModFile } from '../types';

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
  }>;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

const LAST_ENV_KEY = 'simm:lastEnvId';

export function ModLibraryOverlay({ isOpen, onClose }: Props) {
  const { environments, refreshEnvironments } = useEnvironmentStore();
  const [library, setLibrary] = useState<ModLibraryResult | null>(null);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [selectedEnvIds, setSelectedEnvIds] = useState<string[]>([]);
  const [showEnvDropdown, setShowEnvDropdown] = useState(false);
  const [selectedModIds, setSelectedModIds] = useState<Set<string>>(new Set());
  const [confirmOverlay, setConfirmOverlay] = useState<{ isOpen: boolean; title: string; message: string; onConfirm: () => void }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });

  const [searchSource, setSearchSource] = useState<'thunderstore' | 'nexusmods'>('thunderstore');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ThunderstorePackage[]>([]);
  const [searching, setSearching] = useState(false);
  const [showSearchResults, setShowSearchResults] = useState(false);
  const [nexusModsSearchQuery, setNexusModsSearchQuery] = useState('');
  const [nexusModsSearchResults, setNexusModsSearchResults] = useState<NexusMod[]>([]);
  const [searchingNexusMods, setSearchingNexusMods] = useState(false);
  const [showNexusModsResults, setShowNexusModsResults] = useState(false);
  const [nexusModsFiles, setNexusModsFiles] = useState<Map<number, NexusModFile[]>>(new Map());
  const [installing, setInstalling] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [safeguardByEnv, setSafeguardByEnv] = useState<Record<string, boolean>>({});
  const [s1apiStatusByEnv, setS1apiStatusByEnv] = useState<Record<string, { installed: boolean; enabled: boolean; version?: string }>>({});
  const [mlvscanStatusByEnv, setMlvscanStatusByEnv] = useState<Record<string, { installed: boolean; enabled: boolean; version?: string }>>({});
  const [s1apiLatestRelease, setS1apiLatestRelease] = useState<{
    tag_name: string;
    name: string;
    published_at: string;
    prerelease: boolean;
    download_url: string | null;
  } | null>(null);
  const [mlvscanLatestRelease, setMlvscanLatestRelease] = useState<{
    tag_name: string;
    name: string;
    published_at: string;
    prerelease: boolean;
    download_url: string | null;
  } | null>(null);
  const [s1apiReleases, setS1apiReleases] = useState<Array<{
    tag_name: string;
    name: string;
    published_at: string;
    prerelease: boolean;
    download_url: string | null;
    body?: string;
  }>>([]);
  const [mlvscanReleases, setMlvscanReleases] = useState<Array<{
    tag_name: string;
    name: string;
    published_at: string;
    prerelease: boolean;
    download_url: string | null;
    body?: string;
  }>>([]);
  const [loadingS1APIReleases, setLoadingS1APIReleases] = useState(false);
  const [loadingMlvscanReleases, setLoadingMlvscanReleases] = useState(false);
  const [showS1APIVersionSelector, setShowS1APIVersionSelector] = useState(false);
  const [showMlvscanVersionSelector, setShowMlvscanVersionSelector] = useState(false);
  const [selectedS1APIVersion, setSelectedS1APIVersion] = useState('');
  const [selectedMlvscanVersion, setSelectedMlvscanVersion] = useState('');
  const [installingS1API, setInstallingS1API] = useState(false);
  const [installingMlvscan, setInstallingMlvscan] = useState(false);
  const [removingS1API, setRemovingS1API] = useState(false);
  const [removingMlvscan, setRemovingMlvscan] = useState(false);

  const availableEnvs = useMemo(
    () => environments.filter(env => env.status === 'completed'),
    [environments]
  );

  const primaryEnv: Environment | undefined = useMemo(() => {
    if (selectedEnvIds.length === 0) return availableEnvs[0];
    return availableEnvs.find(env => env.id === selectedEnvIds[0]);
  }, [availableEnvs, selectedEnvIds]);

  const resolvedEnvIds = useMemo(() => {
    if (selectedEnvIds.length > 0) return selectedEnvIds;
    if (primaryEnv) return [primaryEnv.id];
    return [];
  }, [selectedEnvIds, primaryEnv]);

  const envNameById = useMemo(() => {
    return Object.fromEntries(availableEnvs.map(env => [env.id, env.name]));
  }, [availableEnvs]);

  const selectedEnvNames = useMemo(() => {
    return selectedEnvIds
      .map(id => availableEnvs.find(env => env.id === id)?.name)
      .filter(Boolean)
      .join(', ');
  }, [availableEnvs, selectedEnvIds]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    refreshEnvironments();
    const lastEnvId = localStorage.getItem(LAST_ENV_KEY);
    if (lastEnvId && availableEnvs.some(env => env.id === lastEnvId)) {
      setSelectedEnvIds([lastEnvId]);
    } else if (availableEnvs.length > 0) {
      setSelectedEnvIds([availableEnvs[0].id]);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const loadLibrary = async () => {
      setLoadingLibrary(true);
      try {
        const data = await ApiService.getModLibrary();
        setLibrary(data);
      } catch (err) {
        console.error('Failed to load mod library:', err);
        setLibrary({ downloaded: [] });
      } finally {
        setLoadingLibrary(false);
      }
    };
    loadLibrary();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const stored = localStorage.getItem('simm:modLibrarySafeguard');
    let parsed: Record<string, boolean> = {};
    if (stored) {
      try {
        parsed = JSON.parse(stored) as Record<string, boolean>;
      } catch (err) {
        console.warn('Failed to parse mod library safeguard settings:', err);
      }
    }

    setSafeguardByEnv(prev => {
      const next = { ...parsed, ...prev };
      availableEnvs.forEach(env => {
        if (next[env.id] === undefined) {
          next[env.id] = true;
        }
      });
      localStorage.setItem('simm:modLibrarySafeguard', JSON.stringify(next));
      return next;
    });
  }, [isOpen, availableEnvs]);

  useEffect(() => {
    if (!isOpen) return;
    const loadLatestReleases = async () => {
      try {
        const [s1apiLatest, mlvscanLatest] = await Promise.all([
          ApiService.getS1APILatestRelease(primaryEnv?.id ?? ''),
          ApiService.getMLVScanLatestRelease(primaryEnv?.id ?? '')
        ]);
        setS1apiLatestRelease(s1apiLatest);
        setMlvscanLatestRelease(mlvscanLatest);
      } catch (err) {
        console.warn('Failed to load S1API/MLVScan latest releases:', err);
      }
    };
    loadLatestReleases();
  }, [isOpen, primaryEnv?.id]);

  useEffect(() => {
    if (!isOpen) return;
    if (resolvedEnvIds.length === 0) {
      setS1apiStatusByEnv({});
      setMlvscanStatusByEnv({});
      return;
    }

    const loadStatuses = async () => {
      try {
        const [s1apiEntries, mlvscanEntries] = await Promise.all([
          Promise.all(resolvedEnvIds.map(async envId => {
            try {
              const status = await ApiService.getS1APIStatus(envId);
              return [envId, status] as const;
            } catch (err) {
              console.warn(`Failed to load S1API status for ${envId}:`, err);
              return [envId, { installed: false, enabled: false }] as const;
            }
          })),
          Promise.all(resolvedEnvIds.map(async envId => {
            try {
              const status = await ApiService.getMLVScanStatus(envId);
              return [envId, status] as const;
            } catch (err) {
              console.warn(`Failed to load MLVScan status for ${envId}:`, err);
              return [envId, { installed: false, enabled: false }] as const;
            }
          }))
        ]);

        setS1apiStatusByEnv(Object.fromEntries(s1apiEntries));
        setMlvscanStatusByEnv(Object.fromEntries(mlvscanEntries));
      } catch (err) {
        console.warn('Failed to load S1API/MLVScan statuses:', err);
      }
    };

    loadStatuses();
  }, [isOpen, resolvedEnvIds]);

  const toggleEnvSelection = (envId: string) => {
    setSelectedEnvIds(prev => {
      if (prev.includes(envId)) {
        return prev.filter(id => id !== envId);
      }
      return [...prev, envId];
    });
    localStorage.setItem(LAST_ENV_KEY, envId);
  };

  const setSafeguardForEnv = (envId: string, enabled: boolean) => {
    setSafeguardByEnv(prev => {
      const next = { ...prev, [envId]: enabled };
      localStorage.setItem('simm:modLibrarySafeguard', JSON.stringify(next));
      return next;
    });
  };

  const isSafeguardEnabled = (envId: string) => {
    return safeguardByEnv[envId] !== false;
  };

  const isDeleteBlocked = (entry: ModLibraryEntry) => {
    return resolvedEnvIds.some(envId => isSafeguardEnabled(envId) && entry.installedIn.includes(envId));
  };

  const toggleModSelection = (storageId: string) => {
    setSelectedModIds(prev => {
      const next = new Set(prev);
      if (next.has(storageId)) {
        next.delete(storageId);
      } else {
        next.add(storageId);
      }
      return next;
    });
  };

  const filterModsForRuntime = (packages: ThunderstorePackage[], runtime: 'IL2CPP' | 'Mono', query: string) => {
    const searchLower = query.toLowerCase().trim();
    return packages.filter(pkg => {
      const name = (pkg.name || '').toLowerCase();
      const fullName = (pkg.full_name || '').toLowerCase();
      const categories = (pkg.categories || []).map(c => c.toLowerCase());

      const targetRuntime = runtime.toLowerCase();
      const mentionsTargetRuntime = name.includes(targetRuntime) || fullName.includes(targetRuntime) || categories.some(c => c.includes(targetRuntime));
      const noRuntimeSpecified = !name.includes('il2cpp') && !name.includes('mono') && !fullName.includes('il2cpp') && !fullName.includes('mono') && !categories.some(c => c.includes('il2cpp') || c.includes('mono'));
      if (!mentionsTargetRuntime && !noRuntimeSpecified) {
        return false;
      }

      if (searchLower) {
        const matchesSearch =
          name.includes(searchLower) ||
          fullName.includes(searchLower) ||
          (pkg.versions?.[0]?.description || '').toLowerCase().includes(searchLower) ||
          (pkg.owner || '').toLowerCase().includes(searchLower);
        if (!matchesSearch) {
          return false;
        }
      }

      return true;
    });
  };

  const handleSearch = async () => {
    if (!searchQuery.trim() || !primaryEnv) return;
    setSearching(true);
    setShowSearchResults(false);
    try {
      const result = await ApiService.searchThunderstore('schedule-i', searchQuery.trim(), primaryEnv.runtime);
      const filtered = filterModsForRuntime(result.packages || [], primaryEnv.runtime, searchQuery.trim());
      setSearchResults(filtered);
      setShowSearchResults(true);
    } catch (err) {
      console.error('Error searching Thunderstore:', err);
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  const handleSearchNexusMods = async () => {
    if (!nexusModsSearchQuery.trim() || !primaryEnv) return;
    setSearchingNexusMods(true);
    setShowNexusModsResults(false);
    try {
      const result = await ApiService.searchNexusMods('schedule1', nexusModsSearchQuery.trim());
      setNexusModsSearchResults(result.mods || []);
      setShowNexusModsResults(true);
    } catch (err) {
      console.error('Error searching NexusMods:', err);
      setNexusModsSearchResults([]);
    } finally {
      setSearchingNexusMods(false);
    }
  };

  const handleLoadNexusModFiles = async (modId: number) => {
    try {
      const files = await ApiService.getNexusModsModFiles('schedule1', modId);
      setNexusModsFiles(prev => {
        const next = new Map(prev);
        next.set(modId, files);
        return next;
      });
    } catch (err) {
      console.warn('Failed to load Nexus mod files:', err);
    }
  };

  const resolveSelectedEnvs = () => {
    return resolvedEnvIds;
  };

  const loadS1APIReleases = async () => {
    setLoadingS1APIReleases(true);
    try {
      const releases = await ApiService.getS1APIReleases(primaryEnv?.id ?? '');
      setS1apiReleases(releases);
      if (releases.length > 0) {
        setSelectedS1APIVersion(releases[0].tag_name);
      }
    } catch (err) {
      console.error('Failed to load S1API releases:', err);
    } finally {
      setLoadingS1APIReleases(false);
    }
  };

  const loadMlvscanReleases = async () => {
    setLoadingMlvscanReleases(true);
    try {
      const releases = await ApiService.getMLVScanReleases(primaryEnv?.id ?? '');
      setMlvscanReleases(releases);
      if (releases.length > 0) {
        setSelectedMlvscanVersion(releases[0].tag_name);
      }
    } catch (err) {
      console.error('Failed to load MLVScan releases:', err);
    } finally {
      setLoadingMlvscanReleases(false);
    }
  };

  const handleInstallS1APIClick = () => {
    if (resolveSelectedEnvs().length === 0) {
      return;
    }
    loadS1APIReleases();
    setShowS1APIVersionSelector(true);
  };

  const handleInstallMlvscanClick = () => {
    if (resolveSelectedEnvs().length === 0) {
      return;
    }
    loadMlvscanReleases();
    setShowMlvscanVersionSelector(true);
  };

  const handleS1APIVersionSelected = async () => {
    if (!selectedS1APIVersion) {
      return;
    }
    const envIds = resolveSelectedEnvs();
    if (envIds.length === 0) return;
    setShowS1APIVersionSelector(false);
    setInstallingS1API(true);
    try {
      for (const envId of envIds) {
        await ApiService.installS1API(envId, selectedS1APIVersion);
      }
      const updated = await ApiService.getModLibrary();
      setLibrary(updated);
      const [s1apiEntries, mlvscanEntries] = await Promise.all([
        Promise.all(envIds.map(async envId => {
          try {
            const status = await ApiService.getS1APIStatus(envId);
            return [envId, status] as const;
          } catch {
            return [envId, { installed: false, enabled: false }] as const;
          }
        })),
        Promise.all(envIds.map(async envId => {
          try {
            const status = await ApiService.getMLVScanStatus(envId);
            return [envId, status] as const;
          } catch {
            return [envId, { installed: false, enabled: false }] as const;
          }
        }))
      ]);
      setS1apiStatusByEnv(Object.fromEntries(s1apiEntries));
      setMlvscanStatusByEnv(Object.fromEntries(mlvscanEntries));
    } catch (err) {
      console.error('Failed to install S1API:', err);
    } finally {
      setInstallingS1API(false);
      setSelectedS1APIVersion('');
    }
  };

  const handleMlvscanVersionSelected = async () => {
    if (!selectedMlvscanVersion) {
      return;
    }
    const envIds = resolveSelectedEnvs();
    if (envIds.length === 0) return;
    setShowMlvscanVersionSelector(false);
    setInstallingMlvscan(true);
    try {
      for (const envId of envIds) {
        await ApiService.installMLVScan(envId, selectedMlvscanVersion);
      }
      const updated = await ApiService.getModLibrary();
      setLibrary(updated);
      const [s1apiEntries, mlvscanEntries] = await Promise.all([
        Promise.all(envIds.map(async envId => {
          try {
            const status = await ApiService.getS1APIStatus(envId);
            return [envId, status] as const;
          } catch {
            return [envId, { installed: false, enabled: false }] as const;
          }
        })),
        Promise.all(envIds.map(async envId => {
          try {
            const status = await ApiService.getMLVScanStatus(envId);
            return [envId, status] as const;
          } catch {
            return [envId, { installed: false, enabled: false }] as const;
          }
        }))
      ]);
      setS1apiStatusByEnv(Object.fromEntries(s1apiEntries));
      setMlvscanStatusByEnv(Object.fromEntries(mlvscanEntries));
    } catch (err) {
      console.error('Failed to install MLVScan:', err);
    } finally {
      setInstallingMlvscan(false);
      setSelectedMlvscanVersion('');
    }
  };

  const handleRemoveS1API = () => {
    const envIds = resolveSelectedEnvs();
    if (envIds.length === 0) return;
    setConfirmOverlay({
      isOpen: true,
      title: 'Remove S1API',
      message: 'Remove S1API from the selected environments? Downloaded files will remain in the library.',
      onConfirm: async () => {
        setConfirmOverlay({ isOpen: false, title: '', message: '', onConfirm: () => {} });
        setRemovingS1API(true);
        try {
          for (const envId of envIds) {
            await ApiService.uninstallS1API(envId);
          }
          const updated = await ApiService.getModLibrary();
          setLibrary(updated);
          const s1apiEntries = await Promise.all(envIds.map(async envId => {
            try {
              const status = await ApiService.getS1APIStatus(envId);
              return [envId, status] as const;
            } catch {
              return [envId, { installed: false, enabled: false }] as const;
            }
          }));
          setS1apiStatusByEnv(Object.fromEntries(s1apiEntries));
        } catch (err) {
          console.error('Failed to remove S1API:', err);
        } finally {
          setRemovingS1API(false);
        }
      }
    });
  };

  const handleRemoveMlvscan = () => {
    const envIds = resolveSelectedEnvs();
    if (envIds.length === 0) return;
    setConfirmOverlay({
      isOpen: true,
      title: 'Remove MLVScan',
      message: 'Remove MLVScan from the selected environments? Downloaded files will remain in the library.',
      onConfirm: async () => {
        setConfirmOverlay({ isOpen: false, title: '', message: '', onConfirm: () => {} });
        setRemovingMlvscan(true);
        try {
          for (const envId of envIds) {
            await ApiService.uninstallMLVScan(envId);
          }
          const updated = await ApiService.getModLibrary();
          setLibrary(updated);
          const mlvscanEntries = await Promise.all(envIds.map(async envId => {
            try {
              const status = await ApiService.getMLVScanStatus(envId);
              return [envId, status] as const;
            } catch {
              return [envId, { installed: false, enabled: false }] as const;
            }
          }));
          setMlvscanStatusByEnv(Object.fromEntries(mlvscanEntries));
        } catch (err) {
          console.error('Failed to remove MLVScan:', err);
        } finally {
          setRemovingMlvscan(false);
        }
      }
    });
  };

  const confirmIfAlreadyInstalled = (entry: ModLibraryEntry, envIds: string[], onConfirm: () => void) => {
    const alreadyInstalled = envIds.some(envId => entry.installedIn.includes(envId));
    if (!alreadyInstalled) {
      onConfirm();
      return;
    }
    setConfirmOverlay({
      isOpen: true,
      title: 'Already Installed',
      message: 'This mod is already installed in one or more selected environments. Do you want to continue?',
      onConfirm: () => {
        setConfirmOverlay({ isOpen: false, title: '', message: '', onConfirm: () => {} });
        onConfirm();
      },
    });
  };

  const handleInstallDownloaded = async (entry: ModLibraryEntry) => {
    const envIds = resolveSelectedEnvs();
    if (envIds.length === 0) return;
    confirmIfAlreadyInstalled(entry, envIds, async () => {
      setInstalling(entry.storageId);
      try {
        await ApiService.installDownloadedMod(entry.storageId, envIds);
        const updated = await ApiService.getModLibrary();
        setLibrary(updated);
      } catch (err) {
        console.error('Failed to install downloaded mod:', err);
      } finally {
        setInstalling(null);
      }
    });
  };

  const handleBulkInstall = async () => {
    const envIds = resolveSelectedEnvs();
    if (!library || envIds.length === 0 || selectedModIds.size === 0) return;
    const selectedEntries = library.downloaded.filter(entry => selectedModIds.has(entry.storageId));
    const alreadyInstalled = selectedEntries.some(entry => envIds.some(envId => entry.installedIn.includes(envId)));
    const runInstall = async () => {
      setInstalling('bulk');
      try {
        for (const entry of selectedEntries) {
          await ApiService.installDownloadedMod(entry.storageId, envIds);
        }
        const updated = await ApiService.getModLibrary();
        setLibrary(updated);
        setSelectedModIds(new Set());
      } catch (err) {
        console.error('Failed to bulk install mods:', err);
      } finally {
        setInstalling(null);
      }
    };

    if (!alreadyInstalled) {
      runInstall();
      return;
    }

    setConfirmOverlay({
      isOpen: true,
      title: 'Already Installed',
      message: 'Some selected mods are already installed in one or more selected environments. Do you want to continue?',
      onConfirm: () => {
        setConfirmOverlay({ isOpen: false, title: '', message: '', onConfirm: () => {} });
        runInstall();
      },
    });
  };

  const handleRemoveDownloaded = async (entry: ModLibraryEntry) => {
    const envIds = resolveSelectedEnvs();
    const selectedTargets = envIds.filter(envId => entry.installedIn.includes(envId));
    if (selectedTargets.length === 0) {
      return;
    }

    setConfirmOverlay({
      isOpen: true,
      title: 'Remove Mod',
      message: 'Remove this mod from the selected environments? Downloaded files will remain in the library.',
      onConfirm: async () => {
        setConfirmOverlay({ isOpen: false, title: '', message: '', onConfirm: () => {} });
        setRemoving(entry.storageId);
        try {
          await ApiService.uninstallDownloadedMod(entry.storageId, selectedTargets);
          const updated = await ApiService.getModLibrary();
          setLibrary(updated);
        } catch (err) {
          console.error('Failed to remove downloaded mod:', err);
        } finally {
          setRemoving(null);
        }
      },
    });
  };

  const handleBulkRemove = async () => {
    if (!library || selectedModIds.size === 0) return;
    const envIds = resolveSelectedEnvs();
    const selectedEntries = library.downloaded.filter(entry => selectedModIds.has(entry.storageId));
    const targets = selectedEntries.filter(entry => envIds.some(envId => entry.installedIn.includes(envId)));
    if (targets.length === 0) return;

    setConfirmOverlay({
      isOpen: true,
      title: 'Remove Mods',
      message: 'Remove selected mods from the selected environments? Downloaded files will remain in the library.',
      onConfirm: async () => {
        setConfirmOverlay({ isOpen: false, title: '', message: '', onConfirm: () => {} });
        setRemoving('bulk');
        try {
          for (const entry of targets) {
            const envTargets = envIds.filter(envId => entry.installedIn.includes(envId));
            if (envTargets.length > 0) {
              await ApiService.uninstallDownloadedMod(entry.storageId, envTargets);
            }
          }
          const updated = await ApiService.getModLibrary();
          setLibrary(updated);
          setSelectedModIds(new Set());
        } catch (err) {
          console.error('Failed to bulk remove mods:', err);
        } finally {
          setRemoving(null);
        }
      },
    });
  };

  const handleDeleteDownloaded = async (entry: ModLibraryEntry) => {
    if (isDeleteBlocked(entry)) {
      setConfirmOverlay({
        isOpen: true,
        title: 'Safeguard Enabled',
        message: 'This mod is installed in one or more selected environments with safeguard enabled. Disable safeguard for those environments to delete downloaded files.',
        onConfirm: () => {
          setConfirmOverlay({ isOpen: false, title: '', message: '', onConfirm: () => {} });
        },
      });
      return;
    }
    setConfirmOverlay({
      isOpen: true,
      title: 'Delete Downloaded Files',
      message: entry.installedIn.length
        ? 'This will remove the mod from all environments and delete the downloaded files. Continue?'
        : 'Delete the downloaded files from the library? This cannot be undone.',
      onConfirm: async () => {
        setConfirmOverlay({ isOpen: false, title: '', message: '', onConfirm: () => {} });
        setDeleting(entry.storageId);
        try {
          await ApiService.deleteDownloadedMod(entry.storageId);
          const updated = await ApiService.getModLibrary();
          setLibrary(updated);
          setSelectedModIds(prev => {
            const next = new Set(prev);
            next.delete(entry.storageId);
            return next;
          });
        } catch (err) {
          console.error('Failed to delete downloaded mod files:', err);
        } finally {
          setDeleting(null);
        }
      },
    });
  };

  const handleBulkDelete = async () => {
    if (!library || selectedModIds.size === 0) return;
    const selectedEntries = library.downloaded.filter(entry => selectedModIds.has(entry.storageId));
    if (selectedEntries.some(isDeleteBlocked)) {
      setConfirmOverlay({
        isOpen: true,
        title: 'Safeguard Enabled',
        message: 'Some selected mods are installed in selected environments with safeguard enabled. Disable safeguard for those environments to delete downloaded files.',
        onConfirm: () => {
          setConfirmOverlay({ isOpen: false, title: '', message: '', onConfirm: () => {} });
        },
      });
      return;
    }
    setConfirmOverlay({
      isOpen: true,
      title: 'Delete Downloaded Files',
      message: selectedEntries.some(entry => entry.installedIn.length > 0)
        ? 'Some selected mods are installed in environments. This will remove them from those environments and delete the downloaded files. Continue?'
        : 'Delete selected downloaded files from the library? This cannot be undone.',
      onConfirm: async () => {
        setConfirmOverlay({ isOpen: false, title: '', message: '', onConfirm: () => {} });
        setDeleting('bulk');
        try {
          for (const entry of selectedEntries) {
            await ApiService.deleteDownloadedMod(entry.storageId);
          }
          const updated = await ApiService.getModLibrary();
          setLibrary(updated);
          setSelectedModIds(new Set());
        } catch (err) {
          console.error('Failed to bulk delete downloaded mods:', err);
        } finally {
          setDeleting(null);
        }
      },
    });
  };

  const handleInstallThunderstore = async (pkg: ThunderstorePackage) => {
    const envIds = resolveSelectedEnvs();
    if (!primaryEnv || envIds.length === 0) return;
    setInstalling(pkg.uuid4);
    try {
      for (const envId of envIds) {
        await ApiService.installThunderstoreMod(envId, pkg.uuid4);
      }
      const updated = await ApiService.getModLibrary();
      setLibrary(updated);
      setShowSearchResults(false);
      setSearchQuery('');
    } catch (err) {
      console.error('Failed to install Thunderstore mod:', err);
    } finally {
      setInstalling(null);
    }
  };

  const handleInstallNexusMod = async (modId: number, fileId?: number) => {
    const envIds = resolveSelectedEnvs();
    if (!primaryEnv || envIds.length === 0 || !fileId) return;
    setInstalling(`nexus-${modId}`);
    try {
      for (const envId of envIds) {
        await ApiService.installNexusModsMod(envId, modId, fileId);
      }
      const updated = await ApiService.getModLibrary();
      setLibrary(updated);
      setShowNexusModsResults(false);
      setNexusModsSearchQuery('');
    } catch (err) {
      console.error('Failed to install Nexus mod:', err);
    } finally {
      setInstalling(null);
    }
  };

  const selectedEnvCount = resolvedEnvIds.length;
  const s1apiStatuses = resolvedEnvIds.map(envId => s1apiStatusByEnv[envId]).filter(Boolean);
  const s1apiInstalledCount = s1apiStatuses.filter(status => status.installed).length;
  const s1apiVersions = Array.from(new Set(s1apiStatuses.map(status => status.version).filter(Boolean)));
  const s1apiUpdateAvailable = s1apiLatestRelease
    ? s1apiStatuses.some(status => status.installed && status.version && status.version !== s1apiLatestRelease.tag_name)
    : false;

  const mlvscanStatuses = resolvedEnvIds.map(envId => mlvscanStatusByEnv[envId]).filter(Boolean);
  const mlvscanInstalledCount = mlvscanStatuses.filter(status => status.installed).length;
  const mlvscanVersions = Array.from(new Set(mlvscanStatuses.map(status => status.version).filter(Boolean)));
  const mlvscanUpdateAvailable = mlvscanLatestRelease
    ? mlvscanStatuses.some(status => status.installed && status.version && status.version !== mlvscanLatestRelease.tag_name)
    : false;
  const mlvscanInstalledEnvIds = resolvedEnvIds.filter(envId => mlvscanStatusByEnv[envId]?.installed);
  const s1apiActionLabel = s1apiUpdateAvailable ? 'Update' : s1apiInstalledCount > 0 ? 'Reinstall' : 'Install';
  const mlvscanActionLabel = mlvscanUpdateAvailable ? 'Update' : mlvscanInstalledCount > 0 ? 'Reinstall' : 'Install';

  if (!isOpen) return null;

  return (
    <>
      <ConfirmOverlay
        isOpen={confirmOverlay.isOpen}
        onClose={() => setConfirmOverlay({ isOpen: false, title: '', message: '', onConfirm: () => {} })}
        onConfirm={confirmOverlay.onConfirm}
        title={confirmOverlay.title}
        message={confirmOverlay.message}
        isNested
      />
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-content mods-overlay" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <h2>Mod Library</h2>
            <button className="modal-close" onClick={onClose}>×</button>
          </div>

          <div className="mods-content">
          <div style={{ padding: '17px 1.25rem 1rem', borderBottom: '1px solid #3a3a3a' }}>
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '1rem' }}>
              <div style={{ position: 'relative' }}>
                <button className="btn btn-secondary" onClick={() => setShowEnvDropdown(prev => !prev)}>
                  <i className="fas fa-layer-group" style={{ marginRight: '0.5rem' }}></i>
                  {selectedEnvNames || 'Select environments'}
                </button>
                {showEnvDropdown && (
                  <div style={{
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    marginTop: '0.5rem',
                    backgroundColor: '#1f1f1f',
                    border: '1px solid #3a3a3a',
                    borderRadius: '6px',
                    padding: '0.5rem',
                    minWidth: '260px',
                    zIndex: 20,
                  }}>
                    {availableEnvs.map(env => (
                      <div key={env.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', padding: '0.35rem 0' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <input
                            type="checkbox"
                            checked={selectedEnvIds.includes(env.id)}
                            onChange={() => toggleEnvSelection(env.id)}
                          />
                          <span>{env.name}</span>
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#888', fontSize: '0.75rem' }}>
                          <input
                            type="checkbox"
                            checked={isSafeguardEnabled(env.id)}
                            onChange={e => setSafeguardForEnv(env.id, e.target.checked)}
                          />
                          Safeguard
                        </label>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <span style={{ color: '#888', fontSize: '0.85rem' }}>
                {primaryEnv ? `Runtime: ${primaryEnv.runtime}` : 'Select an environment'}
              </span>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
              <button
                onClick={() => {
                  setSearchSource('thunderstore');
                  setShowSearchResults(false);
                  setShowNexusModsResults(false);
                }}
                className="btn"
                style={{
                  flex: 1,
                  backgroundColor: searchSource === 'thunderstore' ? '#4a90e2' : '#2a2a2a',
                  color: searchSource === 'thunderstore' ? '#fff' : '#888',
                  border: `1px solid ${searchSource === 'thunderstore' ? '#4a90e2' : '#3a3a3a'}`,
                  padding: '0.5rem',
                  fontSize: '0.875rem'
                }}
              >
                <i className="fas fa-cloud-download-alt" style={{ marginRight: '0.5rem' }}></i>
                Thunderstore
              </button>
              <button
                onClick={() => {
                  setSearchSource('nexusmods');
                  setShowSearchResults(false);
                  setShowNexusModsResults(false);
                }}
                className="btn"
                style={{
                  flex: 1,
                  backgroundColor: searchSource === 'nexusmods' ? '#ea4335' : '#2a2a2a',
                  color: searchSource === 'nexusmods' ? '#fff' : '#888',
                  border: `1px solid ${searchSource === 'nexusmods' ? '#ea4335' : '#3a3a3a'}`,
                  padding: '0.5rem',
                  fontSize: '0.875rem'
                }}
              >
                <i className="fas fa-download" style={{ marginRight: '0.5rem' }}></i>
                NexusMods
              </button>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <div style={{ flex: 1, position: 'relative' }}>
                <input
                  type="text"
                  placeholder={searchSource === 'thunderstore'
                    ? 'Search Thunderstore mods...'
                    : 'Search NexusMods mods...'}
                  value={searchSource === 'thunderstore' ? searchQuery : nexusModsSearchQuery}
                  onChange={e => {
                    if (searchSource === 'thunderstore') {
                      setSearchQuery(e.target.value);
                    } else {
                      setNexusModsSearchQuery(e.target.value);
                    }
                  }}
                  style={{
                    width: '100%',
                    padding: '0.5rem 2.5rem 0.5rem 0.75rem',
                    backgroundColor: '#1a1a1a',
                    border: '1px solid #3a3a3a',
                    borderRadius: '4px',
                    color: '#fff',
                    fontSize: '0.875rem'
                  }}
                />
                <i
                  className="fas fa-search"
                  style={{
                    position: 'absolute',
                    right: '0.75rem',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    color: '#888',
                    cursor: 'pointer'
                  }}
                  onClick={searchSource === 'thunderstore' ? handleSearch : handleSearchNexusMods}
                ></i>
              </div>
              <button
                onClick={searchSource === 'thunderstore' ? handleSearch : handleSearchNexusMods}
                className="btn btn-primary"
                disabled={(searchSource === 'thunderstore' ? searching : searchingNexusMods) ||
                         (searchSource === 'thunderstore' ? !searchQuery.trim() : !nexusModsSearchQuery.trim())}
                style={{ whiteSpace: 'nowrap' }}
              >
                {(searchSource === 'thunderstore' ? searching : searchingNexusMods) ? (
                  <>
                    <i className="fas fa-spinner fa-spin" style={{ marginRight: '0.5rem' }}></i>
                    Searching...
                  </>
                ) : (
                  <>
                    <i className="fas fa-search" style={{ marginRight: '0.5rem' }}></i>
                    Search
                  </>
                )}
              </button>
            </div>
          </div>

          <div style={{ padding: '0 1.25rem 1rem', borderBottom: '1px solid #3a3a3a' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <h3 style={{ margin: 0 }}>Featured Downloads</h3>
              {selectedEnvCount === 0 && (
                <span style={{ color: '#888', fontSize: '0.8rem' }}>Select environments to install</span>
              )}
            </div>
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              <div
                className="mod-card"
                style={{
                  padding: '0.75rem',
                  backgroundColor: '#2a2a2a',
                  borderRadius: '6px',
                  border: '1px solid #3a3a3a',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '1rem'
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
                    <strong style={{ fontSize: '1rem' }}>S1API</strong>
                    <span style={{
                      fontSize: '0.7rem',
                      padding: '0.2rem 0.45rem',
                      borderRadius: '4px',
                      backgroundColor: s1apiInstalledCount > 0 ? '#4a90e220' : '#88820',
                      color: s1apiInstalledCount > 0 ? '#4a90e2' : '#888',
                      border: `1px solid ${s1apiInstalledCount > 0 ? '#4a90e240' : '#88840'}`
                    }}>
                      {selectedEnvCount === 0
                        ? 'Select Envs'
                        : s1apiInstalledCount > 0
                          ? `Installed ${s1apiInstalledCount}/${selectedEnvCount}`
                          : 'Not Installed'}
                    </span>
                    {s1apiUpdateAvailable && s1apiLatestRelease && (
                      <span style={{
                        fontSize: '0.7rem',
                        padding: '0.2rem 0.45rem',
                        borderRadius: '4px',
                        backgroundColor: '#ffd70020',
                        color: '#ffd700',
                        border: '1px solid #ffd70040'
                      }}>
                        Update Available
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', fontSize: '0.8rem', color: '#888' }}>
                    <span>
                      <i className="fab fa-github" style={{ marginRight: '0.35rem', color: '#6e5494' }}></i>
                      GitHub Release
                    </span>
                    {s1apiVersions.length > 0 && (
                      <span>
                        <i className="fas fa-tag" style={{ marginRight: '0.35rem' }}></i>
                        {s1apiVersions.length === 1 ? `Version: ${s1apiVersions[0]}` : 'Multiple versions'}
                      </span>
                    )}
                    {s1apiLatestRelease && (
                      <span>
                        <i className="fas fa-cloud" style={{ marginRight: '0.35rem' }}></i>
                        Latest: {s1apiLatestRelease.tag_name}
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    className="btn btn-primary btn-small"
                    onClick={handleInstallS1APIClick}
                    disabled={installingS1API || selectedEnvCount === 0}
                    title="Download and install S1API"
                  >
                    {installingS1API ? (
                      <i className="fas fa-spinner fa-spin"></i>
                    ) : (
                      <>
                        <i className="fas fa-download"></i>
                        <span style={{ marginLeft: '0.5rem' }}>{s1apiActionLabel}</span>
                      </>
                    )}
                  </button>
                  <button
                    className="btn btn-danger btn-small"
                    onClick={handleRemoveS1API}
                    disabled={removingS1API || selectedEnvCount === 0 || s1apiInstalledCount === 0}
                    title="Remove S1API from selected environments"
                  >
                    {removingS1API ? (
                      <i className="fas fa-spinner fa-spin"></i>
                    ) : (
                      <>
                        <i className="fas fa-trash"></i>
                        <span style={{ marginLeft: '0.5rem' }}>Delete Files</span>
                      </>
                    )}
                  </button>
                  <a
                    href="https://github.com/ifBars/S1API"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-secondary btn-small"
                    style={{ textDecoration: 'none', textAlign: 'center' }}
                    title="View on GitHub"
                  >
                    <i className="fab fa-github"></i>
                    <span style={{ marginLeft: '0.5rem' }}>View</span>
                  </a>
                </div>
              </div>

              <div
                className="mod-card"
                style={{
                  padding: '0.75rem',
                  backgroundColor: '#2a2a2a',
                  borderRadius: '6px',
                  border: '1px solid #3a3a3a',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '1rem'
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
                    <strong style={{ fontSize: '1rem' }}>
                      <i className="fas fa-shield-alt" style={{ color: '#4a90e2', marginRight: '0.35rem' }}></i>
                      MLVScan
                    </strong>
                    <span style={{
                      fontSize: '0.7rem',
                      padding: '0.2rem 0.45rem',
                      borderRadius: '4px',
                      backgroundColor: mlvscanInstalledCount > 0 ? '#4a90e220' : '#88820',
                      color: mlvscanInstalledCount > 0 ? '#4a90e2' : '#888',
                      border: `1px solid ${mlvscanInstalledCount > 0 ? '#4a90e240' : '#88840'}`
                    }}>
                      {selectedEnvCount === 0
                        ? 'Select Envs'
                        : mlvscanInstalledCount > 0
                          ? `Installed ${mlvscanInstalledCount}/${selectedEnvCount}`
                          : 'Not Installed'}
                    </span>
                    {mlvscanUpdateAvailable && mlvscanLatestRelease && (
                      <span style={{
                        fontSize: '0.7rem',
                        padding: '0.2rem 0.45rem',
                        borderRadius: '4px',
                        backgroundColor: '#ffd70020',
                        color: '#ffd700',
                        border: '1px solid #ffd70040'
                      }}>
                        Update Available
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', fontSize: '0.8rem', color: '#888' }}>
                    <span>
                      <i className="fab fa-github" style={{ marginRight: '0.35rem', color: '#6e5494' }}></i>
                      GitHub Release
                    </span>
                    {mlvscanVersions.length > 0 && (
                      <span>
                        <i className="fas fa-tag" style={{ marginRight: '0.35rem' }}></i>
                        {mlvscanVersions.length === 1 ? `Version: ${mlvscanVersions[0]}` : 'Multiple versions'}
                      </span>
                    )}
                    {mlvscanLatestRelease && (
                      <span>
                        <i className="fas fa-cloud" style={{ marginRight: '0.35rem' }}></i>
                        Latest: {mlvscanLatestRelease.tag_name}
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    className="btn btn-primary btn-small"
                    onClick={handleInstallMlvscanClick}
                    disabled={installingMlvscan || selectedEnvCount === 0}
                    title="Download and install MLVScan"
                  >
                    {installingMlvscan ? (
                      <i className="fas fa-spinner fa-spin"></i>
                    ) : (
                      <>
                        <i className="fas fa-download"></i>
                        <span style={{ marginLeft: '0.5rem' }}>{mlvscanActionLabel}</span>
                      </>
                    )}
                  </button>
                  <button
                    className="btn btn-danger btn-small"
                    onClick={handleRemoveMlvscan}
                    disabled={removingMlvscan || selectedEnvCount === 0 || mlvscanInstalledCount === 0}
                    title="Remove MLVScan from selected environments"
                  >
                    {removingMlvscan ? (
                      <i className="fas fa-spinner fa-spin"></i>
                    ) : (
                      <>
                        <i className="fas fa-trash"></i>
                        <span style={{ marginLeft: '0.5rem' }}>Delete Files</span>
                      </>
                    )}
                  </button>
                  <a
                    href="https://github.com/ifBars/MLVScan"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-secondary btn-small"
                    style={{ textDecoration: 'none', textAlign: 'center' }}
                    title="View on GitHub"
                  >
                    <i className="fab fa-github"></i>
                    <span style={{ marginLeft: '0.5rem' }}>View</span>
                  </a>
                </div>
              </div>
            </div>
          </div>

          {(showSearchResults || showNexusModsResults) && (
            <div style={{ padding: '0 1.25rem 1rem' }}>
              {showSearchResults && searchResults.length > 0 && (
                <div style={{ display: 'grid', gap: '0.75rem' }}>
                  {searchResults.map(pkg => (
                    <div key={pkg.uuid4} className="mod-card" style={{ padding: '0.75rem', backgroundColor: '#2a2a2a', borderRadius: '6px', border: '1px solid #3a3a3a' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
                        <div>
                          <strong>{pkg.name}</strong>
                          <div style={{ fontSize: '0.8rem', color: '#888' }}>{pkg.owner}</div>
                        </div>
                        <button
                          className="btn btn-primary btn-small"
                          disabled={installing === pkg.uuid4}
                          onClick={() => handleInstallThunderstore(pkg)}
                        >
                          {installing === pkg.uuid4 ? 'Installing...' : 'Install'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {showNexusModsResults && nexusModsSearchResults.length > 0 && (
                <div style={{ display: 'grid', gap: '0.75rem' }}>
                  {nexusModsSearchResults.map(mod => {
                    const files = nexusModsFiles.get(mod.mod_id) || [];
                    if (!nexusModsFiles.has(mod.mod_id)) {
                      handleLoadNexusModFiles(mod.mod_id);
                    }
                    const primary = files.find(f => f.is_primary) || files[0];
                    return (
                      <div key={mod.mod_id} className="mod-card" style={{ padding: '0.75rem', backgroundColor: '#2a2a2a', borderRadius: '6px', border: '1px solid #3a3a3a' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
                          <div>
                            <strong>{mod.name}</strong>
                            <div style={{ fontSize: '0.8rem', color: '#888' }}>{mod.author}</div>
                          </div>
                          <button
                            className="btn btn-primary btn-small"
                            disabled={installing === `nexus-${mod.mod_id}` || !primary}
                            onClick={() => handleInstallNexusMod(mod.mod_id, primary?.file_id)}
                          >
                            {installing === `nexus-${mod.mod_id}` ? 'Installing...' : 'Install'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <div style={{ padding: '0.75rem 1.25rem 1rem', borderTop: '1px solid #3a3a3a' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <h3 style={{ margin: 0 }}>Downloaded Mods</h3>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  className="btn btn-primary btn-small"
                  disabled={selectedModIds.size === 0 || installing === 'bulk'}
                  onClick={handleBulkInstall}
                >
                  {installing === 'bulk' ? 'Installing...' : 'Install Selected'}
                </button>
                <button
                  className="btn btn-secondary btn-small"
                  disabled={selectedModIds.size === 0 || removing === 'bulk'}
                  onClick={handleBulkRemove}
                >
                  {removing === 'bulk' ? 'Removing...' : 'Remove Selected'}
                </button>
                <button
                  className="btn btn-danger btn-small"
                  disabled={selectedModIds.size === 0 || deleting === 'bulk'}
                  onClick={handleBulkDelete}
                >
                  {deleting === 'bulk' ? 'Deleting...' : 'Delete Files'}
                </button>
              </div>
            </div>
            <div style={{ display: 'grid', gap: '0.75rem', marginBottom: '0.75rem' }}>
              <div key="downloaded-mlvscan" className="mod-card" style={{ padding: '0.75rem', backgroundColor: '#2a2a2a', borderRadius: '6px', border: '1px solid #3a3a3a' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <strong>MLVScan</strong>
                      <span style={{
                        fontSize: '0.7rem',
                        padding: '0.15rem 0.4rem',
                        borderRadius: '4px',
                        backgroundColor: '#28a745',
                        color: '#fff'
                      }}>
                        Managed
                      </span>
                      <span style={{
                        fontSize: '0.7rem',
                        padding: '0.15rem 0.4rem',
                        borderRadius: '4px',
                        backgroundColor: '#4a90e220',
                        color: '#4a90e2',
                        border: '1px solid #4a90e240'
                      }}>
                        Plugin
                      </span>
                    </div>
                    <div style={{ fontSize: '0.8rem', color: '#888', marginTop: '0.35rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <span>Installed in: {mlvscanInstalledCount}/{selectedEnvCount} env(s)</span>
                      {mlvscanInstalledEnvIds.map(envId => (
                        <span
                          key={`mlvscan-${envId}`}
                          style={{
                            fontSize: '0.7rem',
                            padding: '0.15rem 0.4rem',
                            borderRadius: '999px',
                            backgroundColor: '#1f2a38',
                            color: '#9cc2e6',
                            border: '1px solid #2f4763'
                          }}
                          title={envNameById[envId] || envId}
                        >
                          {envNameById[envId] || envId}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      className="btn btn-secondary btn-small"
                      onClick={handleInstallMlvscanClick}
                      disabled={installingMlvscan || selectedEnvCount === 0}
                    >
                      {installingMlvscan ? 'Installing...' : 'Install'}
                    </button>
                    <button
                      className="btn btn-secondary btn-small"
                      onClick={handleRemoveMlvscan}
                      disabled={removingMlvscan || selectedEnvCount === 0 || mlvscanInstalledCount === 0}
                      title={mlvscanInstalledCount === 0 ? 'Not installed in any environment' : 'Remove from selected environments'}
                    >
                      {removingMlvscan ? 'Removing...' : 'Remove'}
                    </button>
                    <button
                      className="btn btn-danger btn-small"
                      onClick={handleRemoveMlvscan}
                      disabled={removingMlvscan || selectedEnvCount === 0 || mlvscanInstalledCount === 0}
                    >
                      {removingMlvscan ? 'Deleting...' : 'Delete Files'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
            {loadingLibrary && <div style={{ color: '#888' }}>Loading mod library...</div>}
            {!loadingLibrary && library?.downloaded.length === 0 && (
              <div style={{ color: '#888' }}>No downloaded mods yet.</div>
            )}
            {!loadingLibrary && library?.downloaded.length ? (
              <div style={{ display: 'grid', gap: '0.75rem' }}>
                {library.downloaded.map(entry => (
                  <div key={entry.storageId} className="mod-card" style={{ padding: '0.75rem', backgroundColor: '#2a2a2a', borderRadius: '6px', border: '1px solid #3a3a3a' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <input
                          type="checkbox"
                          checked={selectedModIds.has(entry.storageId)}
                          onChange={() => toggleModSelection(entry.storageId)}
                        />
                        <strong>{entry.displayName}</strong>
                        <span style={{
                          fontSize: '0.7rem',
                          padding: '0.15rem 0.4rem',
                          borderRadius: '4px',
                          backgroundColor: entry.managed ? '#28a745' : '#6c757d',
                          color: '#fff'
                        }}>
                          {entry.managed ? 'Managed' : 'External'}
                        </span>
                      </label>
                      <button
                        className="btn btn-secondary btn-small"
                        disabled={installing === entry.storageId}
                        onClick={() => handleInstallDownloaded(entry)}
                      >
                        {installing === entry.storageId ? 'Installing...' : 'Install'}
                      </button>
                      <button
                        className="btn btn-secondary btn-small"
                        disabled={removing === entry.storageId || entry.installedIn.length === 0}
                        onClick={() => handleRemoveDownloaded(entry)}
                        title={entry.installedIn.length === 0 ? 'Not installed in any environment' : 'Remove from selected environments'}
                      >
                        {removing === entry.storageId ? 'Removing...' : 'Remove'}
                      </button>
                      <button
                        className="btn btn-danger btn-small"
                        disabled={deleting === entry.storageId || isDeleteBlocked(entry)}
                        onClick={() => handleDeleteDownloaded(entry)}
                        title={isDeleteBlocked(entry)
                          ? 'Safeguard enabled for selected environments'
                          : 'Delete downloaded files from library'}
                      >
                        {deleting === entry.storageId ? 'Deleting...' : 'Delete Files'}
                      </button>
                    </div>
                    <div style={{ fontSize: '0.8rem', color: '#888', marginTop: '0.35rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <span>Installed in: {entry.installedIn.length ? entry.installedIn.length : '0'} env(s)</span>
                      {entry.installedIn.map(envId => (
                        <span
                          key={`${entry.storageId}-${envId}`}
                          style={{
                            fontSize: '0.7rem',
                            padding: '0.15rem 0.4rem',
                            borderRadius: '999px',
                            backgroundColor: '#1f2a38',
                            color: '#9cc2e6',
                            border: '1px solid #2f4763'
                          }}
                          title={envNameById[envId] || envId}
                        >
                          {envNameById[envId] || envId}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          </div>
        </div>
      </div>
      {showS1APIVersionSelector && (
        <div className="modal-overlay modal-overlay-nested" onClick={(e) => {
          if (e.target === e.currentTarget) {
            setShowS1APIVersionSelector(false);
            setSelectedS1APIVersion('');
          }
        }}>
          <div
            className="modal-content modal-content-nested"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '600px', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
          >
            <div className="modal-header">
              <h2>Select S1API Version</h2>
              <button className="modal-close" onClick={() => {
                setShowS1APIVersionSelector(false);
                setSelectedS1APIVersion('');
              }}>×</button>
            </div>

            <div style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem', overflow: 'hidden' }}>
              <p style={{ margin: 0, color: '#ccc', fontSize: '0.9rem', lineHeight: '1.5' }}>
                S1API is very game version specific, so it's important to select the version that matches your game version. If you're not sure which version to choose, we recommend checking the changelog for each release to see which game version it supports.
              </p>

              {loadingS1APIReleases ? (
                <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
                  <i className="fas fa-spinner fa-spin" style={{ fontSize: '2rem', marginBottom: '1rem' }}></i>
                  <p>Loading releases...</p>
                </div>
              ) : s1apiReleases.length === 0 ? (
                <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
                  <p>No releases found</p>
                </div>
              ) : (
                <>
                  <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                    <div style={{ display: 'grid', gap: '0.5rem' }}>
                      {s1apiReleases.map((release) => (
                        <label
                          key={release.tag_name}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            padding: '0.75rem',
                            backgroundColor: selectedS1APIVersion === release.tag_name ? '#3a3a3a' : '#2a2a2a',
                            border: '1px solid',
                            borderColor: selectedS1APIVersion === release.tag_name ? '#4a90e2' : '#3a3a3a',
                            borderRadius: '6px',
                            cursor: 'pointer',
                            transition: 'all 0.2s'
                          }}
                          onMouseEnter={(e) => {
                            if (selectedS1APIVersion !== release.tag_name) {
                              e.currentTarget.style.backgroundColor = '#333';
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (selectedS1APIVersion !== release.tag_name) {
                              e.currentTarget.style.backgroundColor = '#2a2a2a';
                            }
                          }}
                        >
                          <input
                            type="radio"
                            name="s1apiVersion"
                            value={release.tag_name}
                            checked={selectedS1APIVersion === release.tag_name}
                            onChange={(e) => setSelectedS1APIVersion(e.target.value)}
                            style={{ marginRight: '0.75rem', cursor: 'pointer' }}
                          />
                          <div style={{ flex: 1 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                              <strong style={{ color: '#fff' }}>{release.tag_name}</strong>
                              {release.prerelease && (
                                <span style={{
                                  fontSize: '0.7rem',
                                  padding: '0.15rem 0.4rem',
                                  backgroundColor: '#ffd70020',
                                  color: '#ffd700',
                                  borderRadius: '4px',
                                  border: '1px solid #ffd70040'
                                }}>
                                  Beta
                                </span>
                              )}
                            </div>
                            {release.name && (
                              <div style={{ fontSize: '0.85rem', color: '#aaa', marginBottom: '0.25rem' }}>
                                {release.name}
                              </div>
                            )}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                              <div style={{ fontSize: '0.75rem', color: '#888' }}>
                                Published: {new Date(release.published_at).toLocaleDateString()}
                              </div>
                              <a
                                href={`https://github.com/ifBars/S1API/releases/tag/${release.tag_name}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                style={{
                                  fontSize: '0.75rem',
                                  color: '#4a90e2',
                                  textDecoration: 'none',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '0.25rem',
                                  transition: 'color 0.2s'
                                }}
                                onMouseEnter={(e) => {
                                  e.currentTarget.style.color = '#6ba3f5';
                                  e.currentTarget.style.textDecoration = 'underline';
                                }}
                                onMouseLeave={(e) => {
                                  e.currentTarget.style.color = '#4a90e2';
                                  e.currentTarget.style.textDecoration = 'none';
                                }}
                                title="View release page and changelog"
                              >
                                <i className="fas fa-external-link-alt" style={{ fontSize: '0.7rem' }}></i>
                                View Release & Changelog
                              </a>
                            </div>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                    <button
                      className="btn btn-secondary"
                      onClick={() => {
                        setShowS1APIVersionSelector(false);
                        setSelectedS1APIVersion('');
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      className="btn btn-primary"
                      onClick={handleS1APIVersionSelected}
                      disabled={!selectedS1APIVersion || installingS1API}
                    >
                      {installingS1API ? (
                        <>
                          <i className="fas fa-spinner fa-spin" style={{ marginRight: '0.5rem' }}></i>
                          Installing...
                        </>
                      ) : (
                        <>
                          <i className="fas fa-download" style={{ marginRight: '0.5rem' }}></i>
                          Install
                        </>
                      )}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {showMlvscanVersionSelector && (
        <div className="modal-overlay modal-overlay-nested" onClick={(e) => {
          if (e.target === e.currentTarget) {
            setShowMlvscanVersionSelector(false);
            setSelectedMlvscanVersion('');
          }
        }}>
          <div
            className="modal-content modal-content-nested"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '600px', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
          >
            <div className="modal-header">
              <h2>Select MLVScan Version</h2>
              <button className="modal-close" onClick={() => {
                setShowMlvscanVersionSelector(false);
                setSelectedMlvscanVersion('');
              }}>×</button>
            </div>

            <div style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem', overflow: 'hidden' }}>
              <p style={{ margin: 0, color: '#ccc', fontSize: '0.9rem', lineHeight: '1.5' }}>
                MLVScan is a security-focused MelonLoader plugin that protects your game by scanning mods for malicious patterns before they execute.
              </p>

              {loadingMlvscanReleases ? (
                <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
                  <i className="fas fa-spinner fa-spin" style={{ fontSize: '2rem', marginBottom: '1rem' }}></i>
                  <p>Loading releases...</p>
                </div>
              ) : mlvscanReleases.length === 0 ? (
                <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
                  <p>No releases found</p>
                </div>
              ) : (
                <>
                  <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                    <div style={{ display: 'grid', gap: '0.5rem' }}>
                      {mlvscanReleases.map((release) => (
                        <label
                          key={release.tag_name}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            padding: '0.75rem',
                            backgroundColor: selectedMlvscanVersion === release.tag_name ? '#3a3a3a' : '#2a2a2a',
                            border: '1px solid',
                            borderColor: selectedMlvscanVersion === release.tag_name ? '#4a90e2' : '#3a3a3a',
                            borderRadius: '6px',
                            cursor: 'pointer',
                            transition: 'all 0.2s'
                          }}
                          onMouseEnter={(e) => {
                            if (selectedMlvscanVersion !== release.tag_name) {
                              e.currentTarget.style.backgroundColor = '#333';
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (selectedMlvscanVersion !== release.tag_name) {
                              e.currentTarget.style.backgroundColor = '#2a2a2a';
                            }
                          }}
                        >
                          <input
                            type="radio"
                            name="mlvscanVersion"
                            value={release.tag_name}
                            checked={selectedMlvscanVersion === release.tag_name}
                            onChange={(e) => setSelectedMlvscanVersion(e.target.value)}
                            style={{ marginRight: '0.75rem', cursor: 'pointer' }}
                          />
                          <div style={{ flex: 1 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                              <strong style={{ color: '#fff' }}>{release.tag_name}</strong>
                              {release.prerelease && (
                                <span style={{
                                  fontSize: '0.7rem',
                                  padding: '0.15rem 0.4rem',
                                  backgroundColor: '#ffd70020',
                                  color: '#ffd700',
                                  borderRadius: '4px',
                                  border: '1px solid #ffd70040'
                                }}>
                                  Beta
                                </span>
                              )}
                            </div>
                            {release.name && (
                              <div style={{ fontSize: '0.85rem', color: '#aaa', marginBottom: '0.25rem' }}>
                                {release.name}
                              </div>
                            )}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                              <div style={{ fontSize: '0.75rem', color: '#888' }}>
                                Published: {new Date(release.published_at).toLocaleDateString()}
                              </div>
                              <a
                                href={`https://github.com/ifBars/MLVScan/releases/tag/${release.tag_name}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                style={{
                                  fontSize: '0.75rem',
                                  color: '#4a90e2',
                                  textDecoration: 'none',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '0.25rem',
                                  transition: 'color 0.2s'
                                }}
                                onMouseEnter={(e) => {
                                  e.currentTarget.style.color = '#6ba3f5';
                                  e.currentTarget.style.textDecoration = 'underline';
                                }}
                                onMouseLeave={(e) => {
                                  e.currentTarget.style.color = '#4a90e2';
                                  e.currentTarget.style.textDecoration = 'none';
                                }}
                                title="View release page and changelog"
                              >
                                <i className="fas fa-external-link-alt" style={{ fontSize: '0.7rem' }}></i>
                                View Release & Changelog
                              </a>
                            </div>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                    <button
                      className="btn btn-secondary"
                      onClick={() => {
                        setShowMlvscanVersionSelector(false);
                        setSelectedMlvscanVersion('');
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      className="btn btn-primary"
                      onClick={handleMlvscanVersionSelected}
                      disabled={!selectedMlvscanVersion || installingMlvscan}
                    >
                      {installingMlvscan ? (
                        <>
                          <i className="fas fa-spinner fa-spin" style={{ marginRight: '0.5rem' }}></i>
                          Installing...
                        </>
                      ) : (
                        <>
                          <i className="fas fa-download" style={{ marginRight: '0.5rem' }}></i>
                          Install
                        </>
                      )}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
