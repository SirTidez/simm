import type { ComponentProps } from 'react';

import { AlertDialogContent } from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';

type SimmAlertDialogContentProps = ComponentProps<typeof AlertDialogContent> & {
  nested?: boolean;
};

export function SimmAlertDialogContent({
  className,
  overlayClassName,
  nested = false,
  ...props
}: SimmAlertDialogContentProps) {
  return (
    <AlertDialogContent
      overlayClassName={cn('modal-overlay', nested && 'modal-overlay-nested', overlayClassName)}
      className={cn('modal-content simm-dialog-content', nested && 'modal-content-nested', className)}
      {...props}
    />
  );
}
