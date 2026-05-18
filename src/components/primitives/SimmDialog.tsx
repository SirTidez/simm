import type { ComponentProps } from 'react';

import { DialogContent } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

type SimmDialogContentProps = ComponentProps<typeof DialogContent> & {
  nested?: boolean;
};

export function SimmDialogContent({
  className,
  overlayClassName,
  nested = false,
  ...props
}: SimmDialogContentProps) {
  return (
    <DialogContent
      overlayClassName={cn('modal-overlay', nested && 'modal-overlay-nested', overlayClassName)}
      className={cn('modal-content simm-dialog-content', nested && 'modal-content-nested', className)}
      {...props}
    />
  );
}
