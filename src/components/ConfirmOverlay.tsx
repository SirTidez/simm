import { type ReactNode, useEffect, useId, useMemo } from 'react';
import { createPortal } from 'react-dom';

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

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleConfirm = () => {
    onConfirm();
    onClose();
  };

  const overlayClass = isNested ? 'modal-overlay modal-overlay-nested' : 'modal-overlay';
  const contentClass = isNested
    ? `modal-content modal-content-nested app-dialog app-dialog--confirm app-dialog--nested app-dialog--${resolvedTone}`
    : `modal-content app-dialog app-dialog--confirm app-dialog--${resolvedTone}`;

  const dialogElement = (
    <div className={overlayClass} onClick={onClose}>
      <div
        className={contentClass}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
      >
        <div className="modal-header app-dialog__header">
          <div className="app-dialog__heading">
            <span className="app-dialog__eyebrow">{resolvedTone === 'danger' ? 'Confirm Action' : 'Confirmation'}</span>
            <h2 id={titleId}>{title}</h2>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close confirmation dialog">×</button>
        </div>

        <div className="app-dialog__body">
          <div className={`app-dialog__callout app-dialog__callout--${resolvedTone}`}>
            <div className="app-dialog__icon" aria-hidden="true">
              <i className={resolvedTone === 'danger' ? 'fas fa-triangle-exclamation' : 'fas fa-circle-question'}></i>
            </div>
            <div className="app-dialog__meta">
              <strong>{resolvedTone === 'danger' ? 'Review before continuing' : 'Confirm to continue'}</strong>
              <p id={messageId}>{message}</p>
            </div>
          </div>
          {bodyContent ? <div className="app-dialog__supplement">{bodyContent}</div> : null}
        </div>

        <div className="app-dialog__footer">
          <div className="app-dialog__actions">
            <button className="btn btn-secondary" onClick={onClose} autoFocus={resolvedTone === 'danger'}>
              {cancelText}
            </button>
            <button
              className={resolvedTone === 'danger' ? 'btn btn-danger' : 'btn btn-primary'}
              onClick={handleConfirm}
              autoFocus={resolvedTone !== 'danger'}
            >
              {confirmText}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined' || !document.body) {
    return dialogElement;
  }

  return createPortal(dialogElement, document.body);
}
