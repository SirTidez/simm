import type {
  SecurityScanSummary,
  ThreatDisposition,
  ThreatDispositionClassification,
} from '../types';

/**
 * Presentation of one security scan result. `tone` maps to the foundation
 * status vocabulary (`.ui-tag--*` / `.ui-status--*`); `exception` is false for
 * the default "Safe" result, which surfaces should not decorate with a chip.
 * `background` / `border` / `color` stay for callers that still style inline;
 * they resolve to theme tokens.
 */
export interface SecurityBadgeConfig {
  label: string;
  icon: string;
  tone: 'ok' | 'warn' | 'danger' | 'muted';
  exception: boolean;
  background: string;
  border: string;
  color: string;
}

const toneColors: Record<SecurityBadgeConfig['tone'], Pick<SecurityBadgeConfig, 'background' | 'border' | 'color'>> = {
  ok: {
    background: 'transparent',
    border: 'color-mix(in srgb, var(--simm-ok) 50%, transparent)',
    color: 'var(--simm-ok-text)',
  },
  warn: {
    background: 'var(--simm-warn-soft)',
    border: 'color-mix(in srgb, var(--simm-warn) 55%, transparent)',
    color: 'var(--simm-warn-text)',
  },
  danger: {
    background: 'var(--simm-danger-soft)',
    border: 'color-mix(in srgb, var(--simm-danger) 55%, transparent)',
    color: 'var(--simm-danger-text)',
  },
  muted: {
    background: 'transparent',
    border: 'var(--simm-line-strong)',
    color: 'var(--simm-text-2)',
  },
};

const buildConfig = (
  label: string,
  icon: string,
  tone: SecurityBadgeConfig['tone'],
  exception: boolean,
): SecurityBadgeConfig => ({ label, icon, tone, exception, ...toneColors[tone] });

const dispositionBadgeConfigs: Record<ThreatDispositionClassification, SecurityBadgeConfig> = {
  Clean: buildConfig('Safe', 'fa-shield-check', 'ok', false),
  Suspicious: buildConfig('Potentially malicious', 'fa-shield-exclamation', 'warn', true),
  KnownThreat: buildConfig('Known threat', 'fa-ban', 'danger', true),
};

export const getSecurityDispositionBadgeConfig = (
  disposition?: ThreatDisposition | null,
): SecurityBadgeConfig | null => {
  if (!disposition) {
    return null;
  }

  return dispositionBadgeConfigs[disposition.classification] || null;
};

export const getSecurityBadgeConfig = (
  summary?: SecurityScanSummary,
): SecurityBadgeConfig | null => {
  if (!summary) {
    return null;
  }

  const dispositionConfig = getSecurityDispositionBadgeConfig(summary.disposition);
  if (dispositionConfig) {
    return dispositionConfig;
  }

  if (summary.state === 'verified') {
    return buildConfig('Safe', 'fa-shield-check', 'ok', false);
  }

  if (summary.state === 'review') {
    const severityLabel = summary.highestSeverity
      ? `${summary.highestSeverity} risk`
      : 'Needs review';
    return buildConfig(severityLabel, 'fa-shield-exclamation', 'warn', true);
  }

  if (summary.state === 'unavailable') {
    return buildConfig('Scan unavailable', 'fa-circle-question', 'muted', true);
  }

  if (summary.state === 'skipped') {
    return buildConfig('Scan not applicable', 'fa-file-circle-question', 'muted', false);
  }

  return null;
};
