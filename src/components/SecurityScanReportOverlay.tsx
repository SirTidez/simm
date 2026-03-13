import { useEffect, useMemo, useState } from 'react';
import type {
  Finding,
  SecurityScanReport,
  SecurityScanSummary,
  Severity,
  ThreatFamily,
} from '../types';

interface SecurityScanReportOverlayProps {
  isOpen: boolean;
  title: string;
  report: SecurityScanReport | null;
  onClose: () => void;
  onConfirm?: () => void;
  confirmLabel?: string;
  busy?: boolean;
}

const severityOrder: Record<Severity, number> = {
  Critical: 4,
  High: 3,
  Medium: 2,
  Low: 1,
};

const filterOptions: Array<Severity | 'All'> = ['All', 'Critical', 'High', 'Medium', 'Low'];

const summaryStyles = {
  verified: {
    label: 'MLVScan Verified',
    tone: '#1d8459',
    border: '#2cc78455',
    glow: 'rgba(44, 199, 132, 0.16)',
    icon: 'fa-shield-check',
  },
  review: {
    label: 'Review Findings',
    tone: '#c9872c',
    border: '#f0a94b55',
    glow: 'rgba(240, 169, 75, 0.16)',
    icon: 'fa-shield-exclamation',
  },
  blocked: {
    label: 'Blocked by Policy',
    tone: '#d15a64',
    border: '#ff7b8655',
    glow: 'rgba(209, 90, 100, 0.16)',
    icon: 'fa-ban',
  },
  unavailable: {
    label: 'Scanner Unavailable',
    tone: '#7fa1c8',
    border: '#7fa1c855',
    glow: 'rgba(127, 161, 200, 0.14)',
    icon: 'fa-circle-question',
  },
} as const;

const severityBadgeStyles: Record<Severity, { bg: string; color: string; border: string }> = {
  Critical: { bg: '#5a1d26', color: '#ffb4be', border: '#ff7b8666' },
  High: { bg: '#5b3420', color: '#ffca93', border: '#ff9d4d66' },
  Medium: { bg: '#57431a', color: '#ffe29b', border: '#f1c75f66' },
  Low: { bg: '#20365e', color: '#a9cbff', border: '#68a1ff66' },
};

const formatTimestamp = (value?: number): string => {
  if (!value) {
    return 'Unknown';
  }

  return new Date(value * 1000).toLocaleString();
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

export function SecurityScanReportOverlay({
  isOpen,
  title,
  report,
  onClose,
  onConfirm,
  confirmLabel = 'Continue Anyway',
  busy = false,
}: SecurityScanReportOverlayProps) {
  const [activeFileIndex, setActiveFileIndex] = useState(0);
  const [activeSeverity, setActiveSeverity] = useState<Severity | 'All'>('All');
  const [selectedFindingKey, setSelectedFindingKey] = useState<string | null>(null);

  useEffect(() => {
    setActiveFileIndex(0);
    setActiveSeverity('All');
    setSelectedFindingKey(null);
  }, [report]);

  const files = report?.files || [];
  const activeFile = files[activeFileIndex] || files[0] || null;
  const activeResult = activeFile?.result || null;
  const findings = activeResult?.findings || [];
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

  if (!isOpen || !report) {
    return null;
  }

  const summaryStyle = getSummaryStyle(report.summary, report.policy.blocked);
  const threatFamilyLabel = getThreatFamilyLabel(families);
  const topFindings = findings.slice(0, 3);

  return (
    <div className="modal-overlay modal-overlay-nested" onClick={onClose}>
      <div
        className="modal-content modal-content-nested"
        onClick={(event) => event.stopPropagation()}
        style={{
          maxWidth: '1240px',
          width: 'min(1240px, calc(100vw - 2rem))',
          maxHeight: 'calc(100vh - 2rem)',
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
          overflow: 'hidden',
          border: '1px solid #324158',
          borderRadius: '16px',
          background: 'linear-gradient(180deg, rgba(18, 24, 36, 0.98) 0%, rgba(11, 16, 25, 0.98) 100%)',
          boxShadow: '0 28px 80px rgba(0, 0, 0, 0.5)',
        }}
      >
        <div className="modal-header" style={{ borderBottom: '1px solid #2c3a50', padding: '1rem 1.25rem' }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <span>{title}</span>
            <span
              style={{
                fontSize: '0.74rem',
                letterSpacing: '0.03em',
                textTransform: 'uppercase',
                color: summaryStyle.tone,
                background: summaryStyle.glow,
                border: `1px solid ${summaryStyle.border}`,
                borderRadius: '999px',
                padding: '0.18rem 0.62rem',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
              }}
            >
              <i className={`fas ${summaryStyle.icon}`}></i>
              {summaryStyle.label}
            </span>
          </h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div style={{ padding: '1rem 1.25rem 1.25rem', overflowY: 'auto', display: 'grid', gap: '1rem' }}>
          {files.length > 1 && (
            <div style={{ display: 'grid', gap: '0.55rem' }}>
              {files.map((file, index) => (
                <button
                  key={`${file.fileName}-${index}`}
                  type="button"
                  onClick={() => setActiveFileIndex(index)}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    borderRadius: '10px',
                    border: index === activeFileIndex ? '1px solid #3fa6ff66' : '1px solid #2f3d53',
                    background: index === activeFileIndex ? 'rgba(35, 74, 114, 0.45)' : 'rgba(23, 31, 46, 0.8)',
                    color: '#d7e4f6',
                    padding: '0.75rem 0.95rem',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.7rem',
                  }}
                >
                  <span style={{ width: '10px', height: '10px', borderRadius: '999px', background: summaryStyle.tone, flexShrink: 0 }}></span>
                  <span style={{ minWidth: 0, display: 'grid', gap: '0.15rem' }}>
                    <strong style={{ color: '#eef5ff', fontSize: '0.9rem' }}>{file.fileName}</strong>
                    <span style={{ color: '#8ea7c6', fontSize: '0.78rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.displayPath}</span>
                  </span>
                </button>
              ))}
            </div>
          )}

          <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'minmax(0, 1.5fr) minmax(320px, 0.95fr)' }}>
            <section className="mod-card" style={{ padding: '1rem', border: `1px solid ${summaryStyle.border}`, background: `linear-gradient(180deg, ${summaryStyle.glow} 0%, rgba(17, 23, 34, 0.86) 100%)` }}>
              <div style={{ display: 'grid', gap: '0.55rem' }}>
                <h3 style={{ margin: 0, fontSize: '1.35rem', color: '#edf5ff' }}>{summaryStyle.label}</h3>
                <p style={{ margin: 0, color: '#b9c9de', lineHeight: 1.55 }}>{report.summary.statusMessage || 'MLVScan completed this scan.'}</p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.45rem' }}>
                  <span style={{ padding: '0.24rem 0.55rem', borderRadius: '999px', border: '1px solid #3a4a63', background: 'rgba(20, 29, 43, 0.8)', color: '#d0ddf0', fontSize: '0.74rem' }}>
                    {report.summary.totalFindings} finding{report.summary.totalFindings === 1 ? '' : 's'}
                  </span>
                  <span style={{ padding: '0.24rem 0.55rem', borderRadius: '999px', border: '1px solid #3a4a63', background: 'rgba(20, 29, 43, 0.8)', color: '#d0ddf0', fontSize: '0.74rem' }}>
                    {report.summary.threatFamilyCount} threat match{report.summary.threatFamilyCount === 1 ? '' : 'es'}
                  </span>
                  {report.summary.highestSeverity && (
                    <span style={{ padding: '0.24rem 0.55rem', borderRadius: '999px', fontSize: '0.74rem', ...severityBadgeStyles[report.summary.highestSeverity] }}>
                      Highest: {report.summary.highestSeverity}
                    </span>
                  )}
                </div>
                {threatFamilyLabel && (
                  <div style={{ padding: '0.8rem 0.9rem', borderRadius: '12px', border: '1px solid #d67a2f55', background: 'rgba(95, 53, 19, 0.36)', color: '#ffd7ab' }}>
                    <strong style={{ display: 'block', marginBottom: '0.2rem' }}>Threat intelligence</strong>
                    <span>{threatFamilyLabel}</span>
                  </div>
                )}
              </div>
            </section>

            <section className="mod-card" style={{ padding: '1rem', display: 'grid', gap: '0.7rem' }}>
              <div>
                <h3 style={{ margin: 0, color: '#edf5ff' }}>File details</h3>
                <p style={{ margin: '0.35rem 0 0', color: '#8fa7c5', lineHeight: 1.5 }}>Verify the exact file and scan metadata before installing.</p>
              </div>
              <div style={{ display: 'grid', gap: '0.6rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
                  <span style={{ color: '#8ea7c6' }}>File</span>
                  <strong style={{ textAlign: 'right', color: '#edf5ff', wordBreak: 'break-word' }}>{activeFile?.fileName || 'Unknown'}</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
                  <span style={{ color: '#8ea7c6' }}>Size</span>
                  <strong style={{ color: '#edf5ff' }}>{formatBytes(activeResult?.input?.sizeBytes)}</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
                  <span style={{ color: '#8ea7c6' }}>Scanned</span>
                  <strong style={{ color: '#edf5ff', textAlign: 'right' }}>{formatTimestamp(report.summary.scannedAt)}</strong>
                </div>
                <div style={{ display: 'grid', gap: '0.35rem' }}>
                  <span style={{ color: '#8ea7c6' }}>SHA256</span>
                  <div style={{ borderRadius: '10px', border: '1px solid #324158', background: 'rgba(16, 22, 33, 0.88)', padding: '0.75rem', color: '#dce9fb', fontFamily: 'monospace', fontSize: '0.73rem', wordBreak: 'break-all' }}>
                    {activeFile?.sha256Hash || activeResult?.input?.sha256Hash || 'Unavailable'}
                  </div>
                </div>
              </div>
            </section>
          </div>

          <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 1.3fr)' }}>
            <section className="mod-card" style={{ padding: '1rem', display: 'grid', gap: '0.8rem' }}>
              <div>
                <h3 style={{ margin: 0, color: '#edf5ff' }}>What it means</h3>
                <p style={{ margin: '0.35rem 0 0', color: '#8fa7c5', lineHeight: 1.5 }}>Key behaviors MLVScan detected in this download.</p>
              </div>
              <div style={{ display: 'grid', gap: '0.75rem' }}>
                {topFindings.length === 0 ? (
                  <div style={{ display: 'flex', gap: '0.7rem', alignItems: 'flex-start', color: '#bbd8c8' }}>
                    <span style={{ width: '10px', height: '10px', marginTop: '0.45rem', borderRadius: '999px', background: '#2cc784', flexShrink: 0 }}></span>
                    <div>
                      <strong style={{ display: 'block', color: '#ebfff4' }}>No suspicious patterns detected.</strong>
                      <span style={{ color: '#a7c7b5' }}>This file did not trigger any active MLVScan rules.</span>
                    </div>
                  </div>
                ) : (
                  topFindings.map((finding, index) => (
                    <div key={getFindingKey(finding, index)} style={{ display: 'flex', gap: '0.7rem', alignItems: 'flex-start' }}>
                      <span
                        style={{
                          width: '10px',
                          height: '10px',
                          marginTop: '0.45rem',
                          borderRadius: '999px',
                          background: severityBadgeStyles[finding.severity].color,
                          flexShrink: 0,
                        }}
                      ></span>
                      <div style={{ minWidth: 0 }}>
                        <strong style={{ display: 'block', color: '#edf5ff', lineHeight: 1.4 }}>{finding.description}</strong>
                        <span style={{ color: '#8fa7c5', fontSize: '0.82rem' }}>{finding.location || activeFile?.displayPath}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="mod-card" style={{ padding: '1rem', display: 'grid', gap: '0.8rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <h3 style={{ margin: 0, color: '#edf5ff' }}>Findings</h3>
                <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                  {filterOptions.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setActiveSeverity(option)}
                      style={{
                        borderRadius: '8px',
                        border: activeSeverity === option ? '1px solid #5f789d' : '1px solid #324158',
                        background: activeSeverity === option ? 'rgba(53, 72, 99, 0.72)' : 'rgba(18, 24, 36, 0.82)',
                        color: activeSeverity === option ? '#eef6ff' : '#9bb2ce',
                        padding: '0.28rem 0.62rem',
                        fontSize: '0.76rem',
                        cursor: 'pointer',
                      }}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ display: 'grid', gap: '0.7rem', maxHeight: '380px', overflowY: 'auto', paddingRight: '0.2rem' }}>
                {filteredFindings.length === 0 ? (
                  <div style={{ borderRadius: '10px', border: '1px dashed #33445a', padding: '1rem', color: '#8fa7c5' }}>
                    No findings match the current filter.
                  </div>
                ) : (
                  filteredFindings.map((finding, index) => {
                    const key = getFindingKey(finding, index);
                    const isActive = selectedFinding ? getFindingKey(selectedFinding, filteredFindings.indexOf(selectedFinding)) === key : index === 0;
                    const badge = severityBadgeStyles[finding.severity];
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setSelectedFindingKey(key)}
                        style={{
                          textAlign: 'left',
                          borderRadius: '12px',
                          border: isActive ? '1px solid #3db4a255' : '1px solid #324158',
                          background: isActive ? 'rgba(30, 73, 66, 0.5)' : 'rgba(18, 24, 36, 0.86)',
                          padding: '0.9rem',
                          cursor: 'pointer',
                          display: 'grid',
                          gap: '0.45rem',
                        }}
                      >
                        <span style={{ alignSelf: 'start', justifySelf: 'start', borderRadius: '8px', padding: '0.18rem 0.45rem', fontSize: '0.73rem', ...badge }}>
                          {finding.severity}
                        </span>
                        <strong style={{ color: '#edf5ff', lineHeight: 1.45 }}>{finding.description}</strong>
                        <span style={{ color: '#8fa7c5', fontSize: '0.82rem' }}>{finding.location || activeFile?.displayPath}</span>
                      </button>
                    );
                  })
                )}
              </div>
            </section>
          </div>

          <section className="mod-card" style={{ padding: '1rem', display: 'grid', gap: '0.8rem' }}>
            <div>
              <h3 style={{ margin: 0, color: '#edf5ff' }}>Evidence</h3>
              <p style={{ margin: '0.35rem 0 0', color: '#8fa7c5', lineHeight: 1.5 }}>Use this context to understand why MLVScan flagged the selected finding.</p>
            </div>

            {selectedFinding ? (
              <div style={{ display: 'grid', gap: '0.8rem', gridTemplateColumns: 'minmax(0, 1fr)' }}>
                <div style={{ borderRadius: '12px', border: '1px solid #324158', background: 'rgba(21, 28, 42, 0.9)', padding: '0.95rem', display: 'grid', gap: '0.5rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', flexWrap: 'wrap' }}>
                    <span style={{ borderRadius: '8px', padding: '0.18rem 0.45rem', fontSize: '0.73rem', ...severityBadgeStyles[selectedFinding.severity] }}>
                      {selectedFinding.severity}
                    </span>
                    {selectedFinding.ruleId && (
                      <span style={{ color: '#9fb6d2', fontSize: '0.8rem' }}>Rule {selectedFinding.ruleId}</span>
                    )}
                    {typeof selectedFinding.riskScore === 'number' && (
                      <span style={{ color: '#9fb6d2', fontSize: '0.8rem' }}>Risk score {selectedFinding.riskScore}</span>
                    )}
                  </div>
                  <strong style={{ color: '#edf5ff', lineHeight: 1.45 }}>{selectedFinding.description}</strong>
                  {selectedFinding.location && (
                    <div style={{ color: '#8fa7c5', fontSize: '0.82rem' }}>{selectedFinding.location}</div>
                  )}
                </div>

                {selectedFinding.codeSnippet && (
                  <div>
                    <div style={{ color: '#8ea7c6', fontSize: '0.74rem', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Code snippet</div>
                    <pre style={{ margin: 0, borderRadius: '12px', border: '1px solid #2f3d53', background: '#0f141f', color: '#dce9fb', padding: '0.95rem', overflowX: 'auto', fontSize: '0.8rem', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{selectedFinding.codeSnippet}</pre>
                  </div>
                )}

                {selectedFinding.developerGuidance && (
                  <div style={{ borderRadius: '12px', border: '1px solid #33506f', background: 'rgba(28, 46, 65, 0.45)', padding: '0.95rem', display: 'grid', gap: '0.45rem' }}>
                    <div style={{ color: '#9fd4ff', fontSize: '0.74rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Developer guidance</div>
                    <strong style={{ color: '#edf5ff' }}>{selectedFinding.developerGuidance.remediation}</strong>
                    {selectedFinding.developerGuidance.documentationUrl && (
                      <a href={selectedFinding.developerGuidance.documentationUrl} target="_blank" rel="noreferrer" style={{ color: '#87c8ff', textDecoration: 'none', fontSize: '0.85rem' }}>
                        Open documentation
                      </a>
                    )}
                    {selectedFinding.developerGuidance.alternativeApis && selectedFinding.developerGuidance.alternativeApis.length > 0 && (
                      <div style={{ color: '#b6cce6', fontSize: '0.82rem' }}>
                        Suggested APIs: {selectedFinding.developerGuidance.alternativeApis.join(', ')}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ borderRadius: '12px', border: '1px dashed #33445a', padding: '1rem', color: '#8fa7c5' }}>
                No finding selected.
              </div>
            )}
          </section>
        </div>

        <div style={{ padding: '0.95rem 1.25rem 1.15rem', borderTop: '1px solid #2c3a50', display: 'flex', justifyContent: 'flex-end', gap: '0.6rem', flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
          {onConfirm && (
            <button className="btn btn-primary" onClick={onConfirm} disabled={busy}>
              {busy ? 'Working...' : confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
