import type { HTMLAttributes } from 'react';

interface LiveBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  label?: string;
}

export function LiveBadge({ label = 'LIVE', className = '', ...rest }: LiveBadgeProps) {
  return (
    <span
      {...rest}
      className={`inline-flex items-center gap-1 rounded-[20px] bg-[var(--color-pro)] px-3 py-1 text-xs font-semibold text-white ${className}`.trim()}
    >
      <span className="live-dot" aria-hidden="true">●</span>
      {label}
    </span>
  );
}
