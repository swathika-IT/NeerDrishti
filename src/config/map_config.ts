/**
 * Basemap configuration (server-side, env-driven).
 *
 * No provider is hard-coded: tile services change their access rules (CARTO now requires a key; OpenStreetMap's own
 * tile servers block application traffic with HTTP 403). Set MAP_TILE_URL to a service you are authorised to use
 * (e.g. MapTiler, Stadia Maps or Thunderforest with YOUR key, or self-hosted tiles). If unset, the app uses the local
 * fallback: district polygons + markers on a plain background. No API key is ever invented or sent to the browser
 * beyond what you put into the URL template yourself.
 */
export interface MapConfig {
  provider: 'none' | 'custom';
  url: string | null;
  attribution: string;
  maxZoom: number;
  subdomains: string;
  warning?: string;
}

const DISCOURAGED = ['tile.openstreetmap.org'];

export function getMapConfig(env: NodeJS.ProcessEnv = process.env): MapConfig {
  const raw = (env.MAP_TILE_URL || '').trim();
  if (!raw) {
    return { provider: 'none', url: null, attribution: '', maxZoom: 14, subdomains: 'abc' };
  }
  let host = '';
  try { host = new URL(raw.replace(/\{[sxyzr]\}/g, 'x')).hostname; } catch {
    return { provider: 'none', url: null, attribution: '', maxZoom: 14, subdomains: 'abc', warning: 'MAP_TILE_URL is not a valid URL; using local fallback.' };
  }
  if (!raw.startsWith('https://')) {
    return { provider: 'none', url: null, attribution: '', maxZoom: 14, subdomains: 'abc', warning: 'MAP_TILE_URL must use https; using local fallback.' };
  }
  const warn = DISCOURAGED.some(h => host.endsWith(h))
    ? 'tile.openstreetmap.org restricts application use and may return HTTP 403. Use an authorised provider.' : undefined;
  return {
    provider: 'custom',
    url: raw,
    attribution: env.MAP_TILE_ATTRIBUTION || 'Map tiles: see provider terms',
    maxZoom: Math.min(19, Math.max(6, parseInt(env.MAP_TILE_MAX_ZOOM || '14', 10) || 14)),
    subdomains: env.MAP_TILE_SUBDOMAINS || 'abc',
    warning: warn,
  };
}

/** CSP img-src origins needed for the configured tiles ({s} subdomains become a wildcard). */
export function tileImgSrcOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const cfg = getMapConfig(env);
  if (cfg.provider !== 'custom' || !cfg.url) return [];
  try {
    const u = new URL(cfg.url.replace(/\{s\}/g, 'wildcardsub').replace(/\{[xyzr]\}/g, '0'));
    const host = u.hostname.replace('wildcardsub', '*');
    return [`https://${host}`];
  } catch { return []; }
}
