import { useEffect, useMemo, useState } from 'react';
import type {
  Finding,
  SecurityScanReport,
  SecurityScanSummary,
  Severity,
  ThreatFamily,
} from '../types';
import { Dialog } from '@/components/ui/dialog';
import { getSecurityDispositionBadgeConfig } from './securityScanHelpers';
import { Icon } from './Icon';
import { ModThumbnail } from './media/ModThumbnail';
import { useModArtwork } from './media/useModArtwork';
import { SimmButton, SimmDialogContent } from './primitives';

interface SecurityScanReportOverlayProps {
  isOpen: boolean;
  title: string;
  report: SecurityScanReport | null;
  reportOptions?: SecurityScanReportOption[];
  onClose: () => void;
  onConfirm?: () => void;
  confirmLabel?: string;
  busy?: boolean;
}

export interface SecurityScanReportOption {
  key: string;
  label: string;
  description?: string;
  report: SecurityScanReport;
}

export interface SecurityScanReportViewProps {
  title: string;
  report: SecurityScanReport | null;
  reportOptions?: SecurityScanReportOption[];
  onClose?: () => void;
  onConfirm?: () => void;
  confirmLabel?: string;
  busy?: boolean;
  presentation?: 'overlay' | 'page';
  open?: boolean;
}

const severityOrder: Record<Severity, number> = {
  Critical: 4,
  High: 3,
  Medium: 2,
  Low: 1,
};

const filterOptions: Array<Severity | 'All'> = ['All', 'Critical', 'High', 'Medium', 'Low'];
const emptyFindings: Finding[] = [];

type SummaryTone = 'ok' | 'warn' | 'danger' | 'muted';

const summaryStyles: Record<'verified' | 'review' | 'threat' | 'blocked' | 'unavailable', { label: string; tone: SummaryTone }> = {
  verified: { label: 'MLVScan verified', tone: 'ok' },
  review: { label: 'Review findings', tone: 'warn' },
  threat: { label: 'Known threat', tone: 'danger' },
  blocked: { label: 'Blocked by policy', tone: 'danger' },
  unavailable: { label: 'Scanner unavailable', tone: 'muted' },
};

const severityTagClass: Record<Severity, string> = {
  Critical: 'ui-tag ui-tag--danger',
  High: 'ui-tag ui-tag--danger',
  Medium: 'ui-tag ui-tag--warn',
  Low: 'ui-tag',
};

const calloutClass: Record<SummaryTone, string> = {
  ok: 'ui-callout',
  warn: 'ui-callout ui-callout--warn',
  danger: 'ui-callout ui-callout--danger',
  muted: 'ui-callout',
};

const formatTimestamp = (value?: number): string => {
  if (!value) {
    return 'Unknown';
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value * 1000));
};

const formatBytes = (value?: number): string => {
  if (!value || value <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }

  const digits = amount >= 10 || unitIndex === 0 ? 0 : 1;
  return `${amount.toFixed(digits)} ${units[unitIndex]}`;
};

const getFindingKey = (finding: Finding, index: number): string => finding.id || `${finding.ruleId || 'finding'}-${index}`;

const getSummaryStyle = (summary: SecurityScanSummary, blocked: boolean) => {
  if (blocked) {
    return summaryStyles.blocked;
  }

  if (summary.disposition?.classification === 'KnownThreat') {
    return summaryStyles.threat;
  }

  if (summary.disposition?.classification === 'Clean') {
    return summaryStyles.verified;
  }

  if (summary.state === 'verified') {
    return summaryStyles.verified;
  }

  if (summary.state === 'unavailable' || summary.state === 'disabled' || summary.state === 'skipped') {
    return summaryStyles.unavailable;
  }

  return summaryStyles.review;
};

const getThreatFamilyLabel = (families?: ThreatFamily[]): string | null => {
  if (!families || families.length === 0) {
    return null;
  }

  const primary = [...families].sort((a, b) => Number(b.exactHashMatch) - Number(a.exactHashMatch) || b.confidence - a.confidence)[0];
  if (!primary) {
    return null;
  }

  return primary.exactHashMatch
    ? `Exact known malware match: ${primary.displayName}`
    : `Known malware family match: ${primary.displayName}`;
};

function getReportSubjectName(title: string): string | null {
  const match = /^Security Findings\s*[-–—]\s*(.+)$/i.exec(title.trim());
  if (!match) return null;
  const name = match[1].replace(/\s*\((?:IL2CPP|Mono)\)$/i, '').trim();
  // Generic flows ("Nexus Download") name no single mod.
  if (!name || /^nexus (?:download|update|manual download)$/i.test(name)) return null;
  return name;
}

export function SecurityScanReportView({
  title,
  report,
  reportOptions,
  onClose,
  onConfirm,
  confirmLabel = 'Continue Anyway',
  busy = false,
  presentation = 'overlay',
  open = true,
}: SecurityScanReportViewProps) {
  const normalizedReportOptions = useMemo<SecurityScanReportOption[]>(() => {
    if (Array.isArray(reportOptions) && reportOptions.length > 0) {
      return reportOptions;
    }
    if (!report) {
      return [];
    }
    return [
      {
        key: 'default',
        label: 'Scan report',
        report,
      },
    ];
  }, [report, reportOptions]);
  const [activeReportIndex, setActiveReportIndex] = useState(0);
  const [activeFileIndex, setActiveFileIndex] = useState(0);
  const [activeSeverity, setActiveSeverity] = useState<Severity | 'All'>('All');
  const [selectedFindingKey, setSelectedFindingKey] = useState<string | null>(null);
  const lookupArtwork = useModArtwork();

  useEffect(() => {
    if (open) {
      setActiveReportIndex(0);
      setActiveFileIndex(0);
      setActiveSeverity('All');
      setSelectedFindingKey(null);
    }
  }, [open]);

  useEffect(() => {
    setActiveReportIndex(0);
  }, [report, reportOptions]);

  useEffect(() => {
    setActiveFileIndex(0);
    setActiveSeverity('All');
    setSelectedFindingKey(null);
  }, [activeReportIndex, report, reportOptions]);

  const activeReportOption = normalizedReportOptions[activeReportIndex] || normalizedReportOptions[0] || null;
  const activeReport = activeReportOption?.report || report || null;
  const files = activeReport?.files || [];
  const activeFile = files[activeFileIndex] || files[0] || null;
  const activeResult = activeFile?.result || null;
  const findings = activeResult?.findings ?? emptyFindings;
  const families = activeResult?.threatFamilies || [];

  const filteredFindings = useMemo(() => {
    const sorted = [...findings].sort((a, b) => {
      const severityDelta = severityOrder[b.severity] - severityOrder[a.severity];
      if (severityDelta !== 0) {
        return severityDelta;
      }
      return (a.description || '').localeCompare(b.description || '');
    });

    if (activeSeverity === 'All') {
      return sorted;
    }

    return sorted.filter((finding) => finding.severity === activeSeverity);
  }, [activeSeverity, findings]);

  const selectedFinding = useMemo(() => {
    if (filteredFindings.length === 0) {
      return null;
    }

    const availableKey = filteredFindings.find((finding, index) => getFindingKey(finding, index) === selectedFindingKey);
    return availableKey || filteredFindings[0];
  }, [filteredFindings, selectedFindingKey]);

  useEffect(() => {
    if (!selectedFinding && filteredFindings.length > 0) {
      setSelectedFindingKey(getFindingKey(filteredFindings[0], 0));
    }
  }, [filteredFindings, selectedFinding]);

  if (!activeReport) {
    return null;
  }

  const summaryStyle = getSummaryStyle(activeReport.summary, activeReport.policy.blocked);
  const threatFamilyLabel = getThreatFamilyLabel(families);
  const summaryDisposition = activeReport.summary.disposition;
  const activeDisposition = activeResult?.disposition || summaryDisposition;
  const activeDispositionBadge = getSecurityDispositionBadgeConfig(activeDisposition);

  const showCloseActions = presentation === 'overlay' && !!onClose;
  const showReturnActions = presentation === 'page' && !!onClose;
  const totalFindings = activeReport.summary.totalFindings;
  const threatMatches = activeReport.summary.threatFamilyCount;
  const verdictHeadline = summaryDisposition?.headline;
  const verdictBody = summaryDisposition?.summary || activeReport.summary.statusMessage || 'MLVScan completed this scan.';
  const selectedFindingIndex = selectedFinding ? filteredFindings.indexOf(selectedFinding) : -1;
  const selectedKey = selectedFinding ? getFindingKey(selectedFinding, selectedFindingIndex) : null;

  // Titles read "Security Findings - <mod>": the mod gets its library artwork in the header.
  const subjectName = getReportSubjectName(title);
  const subjectArtwork = subjectName
    ? lookupArtwork(subjectName) ?? files.map((file) => lookupArtwork(file.fileName)).find(Boolean) ?? null
    : null;

  const shellContent = (
    <>
      <header className="security-report__header">
        {showReturnActions && (
          <div className="security-report__nav">
            <SimmButton type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              <Icon name="arrowLeft" />
              Back
            </SimmButton>
          </div>
        )}
        <div className="security-report__title-row">
          {subjectName && (
            <ModThumbnail
              name={subjectName}
              iconUrl={subjectArtwork?.iconUrl}
              iconCachePath={subjectArtwork?.iconCachePath}
              size={48}
            />
          )}
          <div className="security-report__titles">
            <h2 className="security-report__title">{title}</h2>
            <span className={`ui-status ui-status--${summaryStyle.tone}`}>{summaryStyle.label}</span>
          </div>
          {showReturnActions && onConfirm && (
            <SimmButton type="button" onClick={onConfirm} disabled={busy}>
              {busy ? 'Working…' : confirmLabel}
            </SimmButton>
          )}
          {showCloseActions && (
            <SimmButton variant="ghost" size="icon-sm" className="modal-close" aria-label="Close security report" onClick={onClose} disabled={busy}><Icon name="times" /></SimmButton>
          )}
        </div>
      </header>

      <div className="security-report__body">
        <div className="security-report__main">
          {normalizedReportOptions.length > 1 && (
            <section className="security-report__section">
              <h3 className="ui-section-title">Stored reports</h3>
              <div className="security-report__choices" role="group" aria-label="Stored reports">
                {normalizedReportOptions.map((option, index) => {
                  const optionStyle = getSummaryStyle(option.report.summary, option.report.policy.blocked);
                  const isActive = index === activeReportIndex;
                  return (
                    <button
                      key={option.key}
                      type="button"
                      className="security-report__choice"
                      aria-pressed={isActive}
                      onClick={() => setActiveReportIndex(index)}
                    >
                      <span className="security-report__choice-name">{option.label}</span>
                      <span className={`ui-status ui-status--${optionStyle.tone}`}>{optionStyle.label}</span>
                      {option.description && (
                        <span className="security-report__choice-meta">{option.description}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {files.length > 1 && (
            <section className="security-report__section">
              <h3 className="ui-section-title">Scanned files</h3>
              <div className="security-report__choices" role="group" aria-label="Scanned files">
                {files.map((file, index) => (
                  <button
                    key={`${file.fileName}-${index}`}
                    type="button"
                    className="security-report__choice"
                    aria-pressed={index === activeFileIndex}
                    onClick={() => setActiveFileIndex(index)}
                  >
                    <span className="security-report__choice-name">{file.fileName}</span>
                    <span className="security-report__choice-meta ui-mono ui-truncate">{file.displayPath}</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          <div className={`${calloutClass[summaryStyle.tone]} security-report__verdict`}>
            <div className="security-report__verdict-copy">
              {verdictHeadline && <strong>{verdictHeadline}</strong>}
              <span>{verdictBody}</span>
              {threatFamilyLabel && <span className="security-report__threat">{threatFamilyLabel}</span>}
              <span className="ui-meta security-report__counts">
                <span>{totalFindings} finding{totalFindings === 1 ? '' : 's'}</span>
                <span>{threatMatches} threat match{threatMatches === 1 ? '' : 'es'}</span>
                {activeReport.summary.highestSeverity && (
                  <span>Highest severity: {activeReport.summary.highestSeverity}</span>
                )}
              </span>
            </div>
          </div>

          <section className="security-report__section">
            <div className="security-report__section-header">
              <h3 className="ui-section-title">Findings</h3>
              <div className="security-report__filters" role="group" aria-label="Filter findings by severity">
                {filterOptions.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className="security-report__filter"
                    aria-pressed={activeSeverity === option}
                    onClick={() => setActiveSeverity(option)}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
            {findings.length === 0 ? (
              <p className="security-report__empty">
                No suspicious patterns detected. This file did not trigger any active MLVScan rules.
              </p>
            ) : filteredFindings.length === 0 ? (
              <p className="security-report__empty">No findings match this severity.</p>
            ) : (
              <div className="security-report__findings" role="listbox" aria-label="Findings">
                {filteredFindings.map((finding, index) => {
                  const key = getFindingKey(finding, index);
                  const isActive = selectedKey === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      className="security-report__finding"
                      onClick={() => setSelectedFindingKey(key)}
                    >
                      <span className={severityTagClass[finding.severity]}>{finding.severity}</span>
                      <span className="security-report__finding-copy">
                        <span className="security-report__finding-title">{finding.description}</span>
                        <span className="security-report__finding-location ui-mono">{finding.location || activeFile?.displayPath}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {selectedFinding && (
            <section className="security-report__section" aria-label="Evidence">
              <h3 className="ui-section-title">Evidence</h3>
              <div className="ui-meta">
                <span className={severityTagClass[selectedFinding.severity]}>{selectedFinding.severity}</span>
                {selectedFinding.ruleId && <span>Rule <span className="ui-mono">{selectedFinding.ruleId}</span></span>}
                {typeof selectedFinding.riskScore === 'number' && <span>Risk score {selectedFinding.riskScore}</span>}
              </div>
              <p className="security-report__evidence-title">{selectedFinding.description}</p>
              {selectedFinding.location && (
                <p className="security-report__evidence-location ui-mono">{selectedFinding.location}</p>
              )}
              {selectedFinding.codeSnippet && (
                <pre className="security-report__snippet">{selectedFinding.codeSnippet}</pre>
              )}
            </section>
          )}
        </div>

        <aside className="security-report__aside" aria-label="File details">
          <h3 className="ui-section-title">File</h3>
          <dl className="ui-kv">
            <dt>Name</dt>
            <dd>{activeFile?.fileName || 'Unknown'}</dd>
            <dt>Size</dt>
            <dd>{formatBytes(activeResult?.input?.sizeBytes)}</dd>
            <dt>Scanned</dt>
            <dd>{formatTimestamp(activeReport.summary.scannedAt)}</dd>
            {activeDispositionBadge && (
              <>
                <dt>Disposition</dt>
                <dd><span className={`ui-status ui-status--${activeDispositionBadge.tone}`}>{activeDispositionBadge.label}</span></dd>
              </>
            )}
            <dt>SHA256</dt>
            <dd className="ui-mono security-report__hash">
              {activeFile?.sha256Hash || activeResult?.input?.sha256Hash || 'Unavailable'}
            </dd>
          </dl>
        </aside>
      </div>

      {(showCloseActions || (presentation === 'overlay' && onConfirm)) && (
        <div className="app-dialog__footer security-report__footer">
          {showCloseActions && (
            <SimmButton type="button" variant="outline" onClick={onClose} disabled={busy}>
              Close
            </SimmButton>
          )}
          {onConfirm && (
            <SimmButton type="button" onClick={onConfirm} disabled={busy}>
              {busy ? 'Working…' : confirmLabel}
            </SimmButton>
          )}
        </div>
      )}
    </>
  );

  if (presentation === 'overlay') {
    return (
      <Dialog open={open} onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) {
          onClose?.();
        }
      }}>
        <SimmDialogContent
          nested
          showCloseButton={false}
          className="app-dialog security-report security-report--overlay"
        >
          {shellContent}
        </SimmDialogContent>
      </Dialog>
    );
  }

  return (
    <div className="security-report security-report--page">
      {shellContent}
    </div>
  );
}

export function SecurityScanReportOverlay({
  isOpen,
  title,
  report,
  reportOptions,
  onClose,
  onConfirm,
  confirmLabel = 'Continue Anyway',
  busy = false,
}: SecurityScanReportOverlayProps) {
  return (
    <SecurityScanReportView
      title={title}
      report={report}
      reportOptions={reportOptions}
      onClose={onClose}
      onConfirm={onConfirm}
      confirmLabel={confirmLabel}
      busy={busy}
      presentation="overlay"
      open={isOpen}
    />
  );
}
