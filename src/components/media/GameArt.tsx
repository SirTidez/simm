import { useState } from 'react';

import { cn } from '@/lib/utils';

import { steamArtUrl, type GameArtVariant } from './steamArt';

interface GameArtProps {
  appId: string;
  variant?: GameArtVariant;
  className?: string;
}

/**
 * The game's own artwork. Purely decorative and optional: offline or when the
 * CDN refuses, the element removes itself and the layout keeps working.
 */
export function GameArt({ appId, variant = 'header', className }: GameArtProps) {
  const [failed, setFailed] = useState(false);
  if (!appId || failed) return null;
  return (
    <span className={cn('ui-game-art', `ui-game-art--${variant}`, className)} aria-hidden="true">
      <img src={steamArtUrl(appId, variant)} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />
    </span>
  );
}
