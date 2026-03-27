import type {
  SecurityScanSummary,
  ThreatDisposition,
  ThreatDispositionClassification,
} from '../types';

export interface SecurityBadgeConfig {
  label: string;
  icon: string;
  background: string;
  border: string;
  color: string;
}

const dispositionBadgeConfigs: Record<ThreatDispositionClassification, SecurityBadgeConfig> = {
  Clean: {
    label: 'Safe',
    icon: 'fa-shield-check',
    background: 'rgba(31, 105, 72, 0.24)',
    border: '#3cc79055',
    color: '#bdf3d8',
  },
  Suspicious: {
    label: 'Potentially Malicious',
    icon: 'fa-shield-exclamation',
    background: 'rgba(104, 72, 27, 0.28)',
    border: '#f0b35e55',
    color: '#ffd9aa',
  },
  KnownThreat: {
    label: 'Known Threat',
    icon: 'fa-ban',
    background: 'rgba(103, 34, 43, 0.28)',
    border: '#ff7b8655',
    color: '#ffccd1',
  },
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
    return {
      label: 'Safe',
      icon: 'fa-shield-check',
      background: 'rgba(31, 105, 72, 0.24)',
      border: '#3cc79055',
      color: '#bdf3d8',
    };
  }

  if (summary.state === 'review') {
    const severityLabel = summary.highestSeverity
      ? `${summary.highestSeverity} Risk`
      : 'Needs Review';
    return {
      label: severityLabel,
      icon: 'fa-shield-exclamation',
      background: 'rgba(104, 72, 27, 0.28)',
      border: '#f0b35e55',
      color: '#ffd9aa',
    };
  }

  if (summary.state === 'unavailable') {
    return {
      label: 'Scan Unavailable',
      icon: 'fa-circle-question',
      background: 'rgba(48, 67, 96, 0.32)',
      border: '#7fa1c855',
      color: '#d2e3fa',
    };
  }

  if (summary.state === 'skipped') {
    return {
      label: 'Scan Not Applicable',
      icon: 'fa-file-circle-question',
      background: 'rgba(48, 67, 96, 0.24)',
      border: '#7fa1c833',
      color: '#c7d8ef',
    };
  }

  return null;
};
