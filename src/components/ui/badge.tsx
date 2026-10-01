import * as React from 'react';

import { cn } from '@/lib/utils';

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm border border-border bg-card px-1.5 py-0.5 font-mono text-[11px] leading-none text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
