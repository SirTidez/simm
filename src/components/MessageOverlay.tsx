import { useEffect, useId } from 'react';
import { createPortal } from 'react-dom';

interface MessageOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  message: string;
  type?: 'success' | 'error' | 'info';
  isNested?: boolean;
}

const typeConfig = {
  success: {
    eyebrow: 'Completed',
    icon: 'fas fa-circle-check',
    tone: 'success',
    headline: 'The requested action completed successfully.',
  },
  error: {
    eyebrow: 'Attention Required',
    icon: 'fas fa-circle-exclamation',
    tone: 'danger',
    headline: 'Something needs review before you continue.',
  },
  info: {
    eyebrow: 'Information',
    icon: 'fas fa-circle-info',
    tone: 'info',
    headline: 'Review this message before continuing.',
  },
} as const;

export function MessageOverlay({
  isOpen,
  onClose,
  title,
  message,
  type = 'info',
  isNested = false,
}: MessageOverlayProps) {
  const titleId = useId();
  const messageId = useId();
  const config = typeConfig[type];

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

  const overlayClass = isNested ? 'modal-overlay modal-overlay-nested' : 'modal-overlay';
  const contentClass = isNested
    ? `modal-content modal-content-nested app-dialog app-dialog--message app-dialog--nested app-dialog--${config.tone}`
    : `modal-content app-dialog app-dialog--message app-dialog--${config.tone}`;

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
            <span className="app-dialog__eyebrow">{config.eyebrow}</span>
            <h2 id={titleId}>{title}</h2>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close message dialog">×</button>
        </div>

        <div className="app-dialog__body">
          <div className={`app-dialog__callout app-dialog__callout--${config.tone}`}>
            <div className="app-dialog__icon" aria-hidden="true">
              <i className={config.icon}></i>
            </div>
            <div className="app-dialog__meta">
              <strong>{config.headline}</strong>
              <p id={messageId}>{message}</p>
            </div>
          </div>
        </div>

        <div className="app-dialog__footer">
          <div className="app-dialog__actions">
            <button className="btn btn-primary" onClick={onClose} autoFocus>
              OK
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
