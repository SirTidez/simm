import { cn } from '@/lib/utils';

import { SimmButton, type SimmButtonProps } from './SimmButton';

/**
 * Icon-only SimmButton wrapper. Callers without visible text must provide an
 * accessible name, for example `<SimmIconButton aria-label="Close" />`.
 */
export function SimmIconButton({ className, ...props }: SimmButtonProps) {
  return (
    <SimmButton
      type="button"
      variant="ghost"
      size="icon-sm"
      className={cn('window-control-btn h-7 w-7 px-0', className)}
      {...props}
    />
  );
}
