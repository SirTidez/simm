import { useState } from 'react';

import { cn } from '@/lib/utils';

import { resolveImageSource } from '../modCardHelpers';

export type ModThumbnailSize = 16 | 20 | 24 | 32 | 40 | 48 | 64 | 96;

export interface ModArtwork {
  iconUrl?: string | null;
  iconCachePath?: string | null;
}

interface ModThumbnailProps extends ModArtwork {
  /** Used for the fallback initial; the image itself is decorative. */
  name: string;
  size?: ModThumbnailSize;
  className?: string;
}

/**
 * The one way a mod's artwork appears in SIMM: the cached icon first, then the
 * remote icon, then a neutral tile with the mod's initial. Always decorative
 * (the mod name is next to it), so it carries no accessible name.
 */
export function ModThumbnail({ iconUrl, iconCachePath, name, size = 32, className }: ModThumbnailProps) {
  const candidates = [resolveImageSource(iconCachePath ?? undefined), resolveImageSource(iconUrl ?? undefined)]
    .filter((source): source is string => Boolean(source));
  const [failed, setFailed] = useState<string[]>([]);
  const source = candidates.find((candidate) => !failed.includes(candidate));
  const initial = name.trim().charAt(0).toUpperCase() || '?';

  return (
    <span
      className={cn('ui-thumb', source ? 'ui-thumb--image' : 'ui-thumb--fallback', className)}
      style={{ '--ui-thumb-size': `${size}px` } as React.CSSProperties}
      aria-hidden="true"
    >
      {source ? (
        <img
          src={source}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed((current) => [...current, source])}
        />
      ) : (
        initial
      )}
    </span>
  );
}

interface ThumbnailStackProps {
  items: Array<ModArtwork & { name: string; key?: string }>;
  max?: number;
  size?: ModThumbnailSize;
  className?: string;
}

/** A compact, overlapping row of mod thumbnails ("+n" for the rest). */
export function ThumbnailStack({ items, max = 4, size = 24, className }: ThumbnailStackProps) {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  return (
    <span className={cn('ui-thumb-stack', className)} aria-hidden="true">
      {shown.map(({ key, ...item }, index) => (
        <ModThumbnail key={key ?? `${item.name}-${index}`} {...item} size={size} />
      ))}
      {rest > 0 && (
        <span className="ui-thumb ui-thumb--more" style={{ '--ui-thumb-size': `${size}px` } as React.CSSProperties}>
          +{rest}
        </span>
      )}
    </span>
  );
}
