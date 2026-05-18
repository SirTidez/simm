import type { ComponentProps } from 'react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type SimmBadgeProps = ComponentProps<typeof Badge>;

export function SimmBadge({ className, ...props }: SimmBadgeProps) {
  return (
    <Badge
      className={cn('rounded-md px-2 py-0.5 text-[0.72rem]', className)}
      {...props}
    />
  );
}
