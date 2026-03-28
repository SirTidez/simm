import { useEffect, useRef, useState } from 'react';
import type { SecurityScanReport } from '../types';
import {
  SecurityScanReportView,
  type SecurityScanReportOption,
} from './SecurityScanReportOverlay';

export interface SecurityReportWorkspaceRequest {
  title: string;
  report: SecurityScanReport;
  reportOptions?: SecurityScanReportOption[];
  confirmLabel?: string;
  onConfirm?: (() => Promise<void>) | null;
  onDismiss?: (() => void) | null;
}

interface SecurityScanReportPageProps extends SecurityReportWorkspaceRequest {
  onReturn: () => void;
}

export function SecurityScanReportPage({
  title,
  report,
  reportOptions,
  confirmLabel = 'Continue Anyway',
  onConfirm,
  onDismiss,
  onReturn,
}: SecurityScanReportPageProps) {
  const [busy, setBusy] = useState(false);
  const resolvedRef = useRef(false);

  useEffect(() => {
    return () => {
      if (!resolvedRef.current) {
        onDismiss?.();
      }
    };
  }, [onDismiss]);

  const handleConfirm = async () => {
    if (!onConfirm || busy) {
      return;
    }

    setBusy(true);
    try {
      await onConfirm();
      resolvedRef.current = true;
      onReturn();
    } catch (error) {
      console.error('Security report confirmation failed:', error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mods-overlay security-report-page workspace-collection-shell">
      <div className="modal-header">
        <div>
          <h2>Security Findings</h2>
          <p
            style={{
              margin: '0.3rem 0 0',
              color: '#8fa7c5',
              lineHeight: 1.5,
            }}
          >
            Review all scanned files and use the sidebar Back button to return to the previous workspace.
          </p>
        </div>
      </div>
      <div className="workspace-collection">
        <div className="workspace-collection__main" style={{ padding: '1rem', minHeight: 0 }}>
          <SecurityScanReportView
            title={title}
            report={report}
            reportOptions={reportOptions}
            onConfirm={onConfirm ? () => void handleConfirm() : undefined}
            confirmLabel={confirmLabel}
            busy={busy}
            presentation="page"
          />
        </div>
      </div>
    </div>
  );
}
