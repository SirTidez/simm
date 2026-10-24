import type { Environment } from '../../types';
import { Icon } from '../Icon';
import type { IconName } from '../icons';
import { SimmButton } from '../primitives';
import {
  environmentGameVersion,
  environmentSourceLabel,
  runtimeLabel,
  runtimeTagClass,
  summarizeEnvironmentStatus,
} from './environmentPresentation';
import { useEnvironmentTabCounts, type EnvironmentTabCounts } from './useEnvironmentTabCounts';

export type EnvironmentWorkspaceTab = 'overview' | 'mods' | 'plugins' | 'userLibs' | 'config' | 'logs';

const TABS: ReadonlyArray<{ id: EnvironmentWorkspaceTab; label: string; icon: IconName }> = [
  { id: 'overview', label: 'Overview', icon: 'hardDrive' },
  { id: 'mods', label: 'Mods', icon: 'puzzlePiece' },
  { id: 'plugins', label: 'Plugins', icon: 'plug' },
  { id: 'userLibs', label: 'UserLibs', icon: 'book' },
  { id: 'config', label: 'Config', icon: 'fileCode' },
  { id: 'logs', label: 'Logs', icon: 'fileLines' },
];

interface TabBadge {
  value: number;
  tone: 'neutral' | 'attention' | 'danger';
  label: string;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * Only counts that say something: what a tab holds, or what needs a look.
 * Overview and Config have no count worth showing.
 */
function tabBadge(tab: EnvironmentWorkspaceTab, counts: EnvironmentTabCounts, modUpdateCount: number): TabBadge | null {
  switch (tab) {
    case 'mods':
      if (modUpdateCount > 0) {
        return { value: modUpdateCount, tone: 'attention', label: plural(modUpdateCount, 'update available', 'updates available') };
      }
      return counts.mods ? { value: counts.mods, tone: 'neutral', label: plural(counts.mods, 'mod installed', 'mods installed') } : null;
    case 'plugins':
      return counts.plugins ? { value: counts.plugins, tone: 'neutral', label: plural(counts.plugins, 'plugin installed', 'plugins installed') } : null;
    case 'userLibs':
      return counts.userLibs ? { value: counts.userLibs, tone: 'neutral', label: plural(counts.userLibs, 'library installed', 'libraries installed') } : null;
    case 'logs':
      return counts.logErrors ? { value: counts.logErrors, tone: 'danger', label: plural(counts.logErrors, 'error in the latest log', 'errors in the latest log') } : null;
    default:
      return null;
  }
}

interface EnvironmentWorkspaceHeaderProps {
  environment: Environment;
  activeTab: EnvironmentWorkspaceTab;
  modUpdateCount: number;
  launching: boolean;
  onSelectTab: (tab: EnvironmentWorkspaceTab) => void;
  onLaunch: () => void;
}

/**
 * Header of the environment workspace: which install this is, its one status,
 * the Play action, and the tabs that hold every per-environment tool.
 */
export function EnvironmentWorkspaceHeader({
  environment,
  activeTab,
  modUpdateCount,
  launching,
  onSelectTab,
  onLaunch,
}: EnvironmentWorkspaceHeaderProps) {
  const status = summarizeEnvironmentStatus(environment, modUpdateCount);
  const gameVersion = environmentGameVersion(environment);
  const playable = environment.status === 'completed';
  const counts = useEnvironmentTabCounts(environment.id, playable);

  return (
    <header className="env-header">
      <div className="env-header__main">
        <div className="env-header__titles">
          <div className="env-header__title-row">
            <h1 className="ui-page-title env-header__title" title={environment.name}>{environment.name}</h1>
            <span className={`ui-status ui-status--${status.tone}`}>{status.label}</span>
          </div>
          <div className="ui-meta env-header__meta">
            <span className={runtimeTagClass(environment.runtime)}>{runtimeLabel(environment.runtime)}</span>
            <span>{environmentSourceLabel(environment)}</span>
            {gameVersion && <span className="ui-num">Game {gameVersion}</span>}
            <span className="ui-num">
              {environment.melonLoaderVersion ? `MelonLoader ${environment.melonLoaderVersion}` : 'No MelonLoader'}
            </span>
          </div>
        </div>
        <SimmButton
          type="button"
          className="env-header__play"
          onClick={onLaunch}
          disabled={!playable || launching}
          aria-label={`Play ${environment.name}`}
        >
          <Icon name={launching ? 'spinner' : 'play'} spin={launching} />
          {launching ? 'Starting…' : 'Play'}
        </SimmButton>
      </div>
      <nav className="ui-tabs-line env-header__tabs" aria-label={`${environment.name} sections`}>
        {TABS.map((tab) => {
          const badge = tabBadge(tab.id, counts, modUpdateCount);
          return (
            <button
              key={tab.id}
              type="button"
              className="ui-tabs-line__tab"
              aria-current={activeTab === tab.id ? 'page' : undefined}
              onClick={() => onSelectTab(tab.id)}
            >
              <Icon name={tab.icon} />
              {tab.label}
              {badge && (
                <span
                  className={`ui-tabs-line__count ui-num${badge.tone === 'neutral' ? '' : ` ui-tabs-line__count--${badge.tone}`}`}
                  aria-label={badge.label}
                  title={badge.label}
                >
                  {badge.value > 99 ? '99+' : badge.value}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </header>
  );
}
