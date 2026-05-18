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
    <div className="security-report-page">
      <SecurityScanReportView
        title={title}
        report={report}
        reportOptions={reportOptions}
        onClose={onReturn}
        onConfirm={onConfirm ? () => void handleConfirm() : undefined}
        confirmLabel={confirmLabel}
        busy={busy}
        presentation="page"
      />
    </div>
  );
}
