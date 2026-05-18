import { useId } from 'react';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Icon } from './Icon';
import type { IconName } from './icons';
import { SimmButton, SimmDialogContent } from './primitives';

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
    icon: 'circleCheck',
    tone: 'success',
    headline: 'The requested action completed successfully.',
  },
  error: {
    eyebrow: 'Attention Required',
    icon: 'circleExclamation',
    tone: 'danger',
    headline: 'Something needs review before you continue.',
  },
  info: {
    eyebrow: 'Information',
    icon: 'circleInfo',
    tone: 'info',
    headline: 'Review this message before continuing.',
  },
} as const satisfies Record<MessageOverlayProps['type'] extends infer T ? Exclude<T, undefined> : never, {
  eyebrow: string;
  icon: IconName;
  tone: string;
  headline: string;
}>;

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

  if (!isOpen) return null;

  const contentClass = isNested
    ? `app-dialog app-dialog--message app-dialog--nested app-dialog--${config.tone}`
    : `app-dialog app-dialog--message app-dialog--${config.tone}`;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => {
      if (!open) {
        onClose();
      }
    }}>
      <SimmDialogContent
        nested={isNested}
        className={contentClass}
        showCloseButton={false}
        aria-labelledby={titleId}
        aria-describedby={messageId}
      >
        <DialogHeader className="modal-header app-dialog__header">
          <div className="app-dialog__heading">
            <span className="app-dialog__eyebrow">{config.eyebrow}</span>
            <DialogTitle id={titleId}>{title}</DialogTitle>
          </div>
          <SimmButton variant="ghost" size="icon-sm" className="modal-close" onClick={onClose} aria-label="Close message dialog">×</SimmButton>
        </DialogHeader>

        <div className="app-dialog__body">
          <div className={`app-dialog__callout app-dialog__callout--${config.tone}`}>
            <div className="app-dialog__icon" aria-hidden="true">
              <Icon name={config.icon} />
            </div>
            <div className="app-dialog__meta">
              <strong>{config.headline}</strong>
              <DialogDescription id={messageId}>{message}</DialogDescription>
            </div>
          </div>
        </div>

        <DialogFooter className="app-dialog__footer">
          <div className="app-dialog__actions">
            <SimmButton className="btn btn-primary" onClick={onClose} autoFocus>
              OK
            </SimmButton>
          </div>
        </DialogFooter>
      </SimmDialogContent>
    </Dialog>
  );
}
