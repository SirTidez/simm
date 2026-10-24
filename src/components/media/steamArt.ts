export type GameArtVariant = 'header' | 'hero';

/** Official store artwork for a Steam app, loaded at runtime from Steam's CDN. */
export function steamArtUrl(appId: string, variant: GameArtVariant): string {
  const file = variant === 'hero' ? 'library_hero.jpg' : 'header.jpg';
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${encodeURIComponent(appId)}/${file}`;
}

