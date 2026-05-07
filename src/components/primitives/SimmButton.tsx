import type { ComponentProps } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type SimmButtonProps = ComponentProps<typeof Button>;

export function SimmButton({ className, ...props }: SimmButtonProps) {
  return (
    <Button
      className={cn('h-8 rounded-md px-3 text-sm', className)}
      {...props}
    />
  );
}
