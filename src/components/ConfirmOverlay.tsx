import { type ReactNode, useId, useMemo } from 'react';
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Icon } from './Icon';
import { SimmAlertDialogContent, SimmButton } from './primitives';

interface ConfirmOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  isNested?: boolean;
  tone?: 'neutral' | 'danger';
  bodyContent?: ReactNode;
}

const dangerPattern = /(delete|remove|uninstall|clear|discard|overwrite|purge|erase|destroy)/i;

export function ConfirmOverlay({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  isNested = false,
  tone,
  bodyContent,
}: ConfirmOverlayProps) {
  const titleId = useId();
  const messageId = useId();

  const resolvedTone = useMemo<'neutral' | 'danger'>(() => {
    if (tone) {
      return tone;
    }

    return dangerPattern.test(`${title} ${confirmText} ${message}`) ? 'danger' : 'neutral';
  }, [confirmText, message, title, tone]);

  if (!isOpen) return null;

  const handleConfirm = () => {
    onConfirm();
    onClose();
  };

  const contentClass = isNested
    ? `app-dialog app-dialog--confirm app-dialog--nested app-dialog--${resolvedTone}`
    : `app-dialog app-dialog--confirm app-dialog--${resolvedTone}`;

  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => {
      if (!open) {
        onClose();
      }
    }}>
      <SimmAlertDialogContent
        nested={isNested}
        className={contentClass}
        aria-labelledby={titleId}
        aria-describedby={messageId}
      >
        <AlertDialogHeader className="modal-header app-dialog__header">
          <div className="app-dialog__heading">
            <span className="app-dialog__eyebrow">{resolvedTone === 'danger' ? 'Confirm Action' : 'Confirmation'}</span>
            <AlertDialogTitle id={titleId}>{title}</AlertDialogTitle>
          </div>
          <SimmButton variant="ghost" size="icon-sm" className="modal-close" onClick={onClose} aria-label="Close confirmation dialog">×</SimmButton>
        </AlertDialogHeader>

        <div className="app-dialog__body">
          <div className={`app-dialog__callout app-dialog__callout--${resolvedTone}`}>
            <div className="app-dialog__icon" aria-hidden="true">
              <Icon name={resolvedTone === 'danger' ? 'triangleExclamation' : 'circleQuestion'} />
            </div>
            <div className="app-dialog__meta">
              <strong>{resolvedTone === 'danger' ? 'Review before continuing' : 'Confirm to continue'}</strong>
              <AlertDialogDescription id={messageId}>{message}</AlertDialogDescription>
            </div>
          </div>
          {bodyContent ? <div className="app-dialog__supplement">{bodyContent}</div> : null}
        </div>

        <AlertDialogFooter className="app-dialog__footer">
          <div className="app-dialog__actions">
            <SimmButton className="btn btn-secondary" onClick={onClose} autoFocus={resolvedTone === 'danger'}>
              {cancelText}
            </SimmButton>
            <SimmButton
              className={resolvedTone === 'danger' ? 'btn btn-danger' : 'btn btn-primary'}
              onClick={handleConfirm}
              autoFocus={resolvedTone !== 'danger'}
            >
              {confirmText}
            </SimmButton>
          </div>
        </AlertDialogFooter>
      </SimmAlertDialogContent>
    </AlertDialog>
  );
}
