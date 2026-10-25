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
  success: { icon: 'circleCheck', tone: 'success' },
  error: { icon: 'circleExclamation', tone: 'danger' },
  info: { icon: 'circleInfo', tone: 'info' },
} as const satisfies Record<NonNullable<MessageOverlayProps['type']>, { icon: IconName; tone: string }>;

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
          <div className="app-dialog__title-row">
            <span className="app-dialog__tone-icon" aria-hidden="true">
              <Icon name={config.icon} />
            </span>
            <DialogTitle id={titleId}>{title}</DialogTitle>
          </div>
          <SimmButton variant="ghost" size="icon-sm" className="modal-close" onClick={onClose} aria-label="Close message dialog">
            <Icon name="times" />
          </SimmButton>
        </DialogHeader>

        <div className="app-dialog__body">
          <DialogDescription id={messageId} className="app-dialog__message">{message}</DialogDescription>
        </div>

        <DialogFooter className="app-dialog__footer">
          <div className="app-dialog__actions">
            <SimmButton onClick={onClose} autoFocus>
              OK
            </SimmButton>
          </div>
        </DialogFooter>
      </SimmDialogContent>
    </Dialog>
  );
}
