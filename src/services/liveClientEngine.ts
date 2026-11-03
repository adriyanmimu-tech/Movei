import { ALL_CATEGORIES, INITIAL_FALLBACK_MOVIES } from '../data/categories';
import {
  cleanTimeAgoAndEpisode,
  deduplicateMovieCards,
  getCanonicalTitleKey,
  getItemMinutesAgo,
  normalizeMovieCardItem,
  normalizeMovieCardList,
  sortItemsByHighRating,
  sortItemsByHotAndHype,
  sortItemsByRecentUpload,
} from '../utils/timeAgo';
import type {
  CastMember,
  DirectDownloadButton,
  EpisodeItem,
  GlobalMovieNotification,
  MovieCardItem,
  MovieDetailData,
  MovieDubOption,
  StreamSource,
} from '../types/cinema';
import { prewarmMkvStreamMeta } from './mkvIosClientRemuxer';

const MIRROR_ORIGINS = [
  'https://cmyyhb.movielinkbd.at',
  'https://4yer8f.movielinkbd.at',
];

const CORS_BRIDGES = [
  (targetUrl: string) =>
    `https://allorigins.hexlet.app/raw?url=${encodeURIComponent(targetUrl)}`,
];

interface StaticDbSnapshot {
  generatedAt: number;
  catalogs: Record<string, MovieCardItem[]>;
  details: Record<string, MovieDetailData>;
}

let staticDbPromise: Promise<StaticDbSnapshot | null> | null = null;
let loadedStaticDb: StaticDbSnapshot | null = null;
const staticDbTitleIndex = new Map<string, MovieDetailData>();
const clientCatalogCache = new Map<string, { items: MovieCardItem[]; maxPage: number; ts: number }>();
const clientDetailCache = new Map<string, { detail: MovieDetailData; ts: number }>();
const inFlightDetailPromises = new Map<string, Promise<any>>();
const bgPrefetchControllers = new Set<AbortController>();
let isVideoActivelyStarting = false;

export function setVideoStartupPriority(active: boolean): void {
  isVideoActivelyStarting = active;
  if (active) {
    stopBackgroundWarmVideo();
    for (const ctrl of bgPrefetchControllers) {
      try {
        ctrl.abort();
      } catch {
        // ignore
      }
    }
    bgPrefetchControllers.clear();
  }
}

function normalizeLookupTitleKey(rawTitle: string): string {
  const canon = getCanonicalTitleKey(rawTitle || '');
  if (canon) return canon;
  return (rawTitle || '')
    .replace(/\[.*?\]|\(.*?\)/g, ' ')
    .replace(
      /\b(?:S\d+|Season\s*\d+(?:-\d+)?|Ep(?:isode)?\s*\d+(?:-\d+)?|Complete(?:d)?|Added|Full\s*HD|ORG|Hindi|Bangla|Bengali|Dual|Multi|Audio|The\s*Movie)\b/gi,
      ' '
    )
    .toLowerCase()
    .replace(/[^a-z0-9\u0980-\u09ff]+/g, '')
    .trim();
}

function legacyNormalizeLookupTitleKey(rawTitle: string): string {
  return (rawTitle || '')
    .replace(/\[.*?\]|\(.*?\)/g, ' ')
    .replace(
      /\b(?:S\d+|Season\s*\d+(?:-\d+)?|Ep(?:isode)?\s*\d+(?:-\d+)?|Complete(?:d)?|Added|Full\s*HD|ORG|Hindi|Bangla|Bengali|Dual|Multi|The\s*Movie)\b/gi,
      ' '
    )
    .toLowerCase()
    .replace(/[^a-z0-9\u0980-\u09ff]+/g, '')
    .trim();
}

const loadedShards = new Set<string>();
const inFlightShards = new Map<string, Promise<void>>();

function computeShardHex(str: string): string {
  const s = String(str || '').toLowerCase().trim();
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h & 0x0f).toString(16);
}

function sortEpisodeSourcesFastestFirst(sources?: StreamSource[]): StreamSource[] {
  if (!Array.isArray(sources) || sources.length <= 1) return sources || [];
  const score = (src: StreamSource) => {
    const isEmbed =
      src.type === 'embed' || /abyssplayer\.com|abysscdn\.com|myflix/i.test(`${src.url || ''} ${src.id || ''}`);
    if (isEmbed) return 100;
    const isMovieBox =
      src.id?.startsWith('mb-') || /\/api\/mb-stream|\/api\/mb-ep-stream/i.test(src.url || '');
    if (isMovieBox) {
      const szMatch = (src.name || '').match(/(\d+)\s*MB/i);
      const szMb = szMatch ? parseInt(szMatch[1], 10) : 0;
      const isHeavy = szMb > 350;
      if (src.quality === 720) return 4650;
      if (src.quality === 480) return 4640;
      if (src.quality === 360) return 4620;
      if (src.quality === 1080) return isHeavy ? 4550 : 4630;
      return 4500;
    }
    const isHevc = /\b(hevc|h\.?265|x265|10bit|av1)\b/i.test(`${src.name} ${src.qualityLabel}`);
    const isBestHeavy = /best\s*quality/i.test(src.qualityLabel || '');
    let s = isHevc ? 200 : 1000;
    if (isBestHeavy) s -= 250;
    if (src.quality >= 360 && src.quality <= 576) s += 650;
    else if (src.quality === 720) s += 500;
    else if (src.quality === 1080) s += 350;
    else s += 150;
    return s;
  };
  return [...sources].sort((a, b) => score(b) - score(a));
}

function indexDetailsIntoMemory(detailsMap?: Record<string, MovieDetailData>, isFromLiveApi = false): void {
  if (!detailsMap || !isFromLiveApi) return;
  if (!loadedStaticDb) {
    loadedStaticDb = { generatedAt: Date.now(), catalogs: {}, details: {} };
  }
  for (const [detPath, det] of Object.entries(detailsMap)) {
    if (det?.title && det.episodes?.length) {
      for (const ep of det.episodes) {
        for (const src of ep.sources || []) {
          if (!src.downloadUrl) {
            src.downloadUrl = src.url;
          } else if (src.downloadUrl.startsWith('/api/go?t=')) {
            src.downloadUrl = resolveDirectDownloadUrl(src.downloadUrl);
          }
        }
        ep.sources = sortEpisodeSourcesFastestFirst(ep.sources);
      }
      for (const btn of det.downloadButtons || []) {
        if (btn.url && btn.url.startsWith('/api/go?t=')) {
          btn.url = resolveDirectDownloadUrl(btn.url);
        }
      }
      loadedStaticDb.details[detPath] = det;
      const k1 = normalizeLookupTitleKey(det.title);
      if (k1) staticDbTitleIndex.set(k1, det);
      const kLegacy = legacyNormalizeLookupTitleKey(det.title);
      if (kLegacy) staticDbTitleIndex.set(kLegacy, det);
      const k2 = det.title.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (k2) staticDbTitleIndex.set(k2, det);
    }
  }
}

async function loadShardByHex(_hex: string): Promise<void> {
  // Static shards contain time-limited stream URLs that expire; always resolve streams live via /api/details
  return;
}

export async function loadShardForMovie(rawPath: string, rawTitle: string): Promise<MovieDetailData | null> {
  return getInstantCachedDetail(rawPath, rawTitle);
}

async function loadStaticDb(): Promise<StaticDbSnapshot | null> {
  if (loadedStaticDb && Object.keys(loadedStaticDb.catalogs || {}).length > 0) {
    return loadedStaticDb;
  }
  if (!staticDbPromise) {
    staticDbPromise = (async () => {
      try {
        const res = await fetch('./static-db.json');
        if (!res.ok) return null;
        const parsed = (await res.json()) as StaticDbSnapshot;
        if (!loadedStaticDb) {
          loadedStaticDb = { generatedAt: parsed.generatedAt || Date.now(), catalogs: parsed.catalogs || {}, details: {} };
        } else {
          loadedStaticDb.catalogs = parsed.catalogs || {};
        }
        if (parsed?.details) {
          indexDetailsIntoMemory(parsed.details, false);
        }
        return loadedStaticDb;
      } catch {
        return null;
      }
    })();
  }
  return staticDbPromise;
}

// Preconnect video CDNs on startup without loading heavy static files when running on the live API server!
if (typeof window !== 'undefined') {
  ensurePreconnectOrigin('https://fsldownload.com');
  ensurePreconnectOrigin('https://bcdnxw.hakunaymatata.com');
  if (window.location.hostname.endsWith('github.io')) {
    loadStaticDb().catch(() => {});
  }
}

export function resolveDirectDownloadUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  if (rawUrl.startsWith('/api/go?t=')) {
    try {
      const token = rawUrl.slice('/api/go?t='.length).split('&')[0];
      const base64 = token.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '==='.slice((base64.length + 3) % 4);
      const decoded = decodeURIComponent(escape(window.atob(padded)));
      if (/fifadekho\.com/i.test(decoded)) {
        const isGhPages =
          typeof window !== 'undefined' && window.location.hostname.endsWith('github.io');
        return isGhPages
          ? `${decoded.replace(/\/+$/, '')}?view=links`
          : rawUrl;
      }
      return decoded;
    } catch {
      return rawUrl;
    }
  }
  return rawUrl;
}

function sanitizeBrandText(input: string): string {
  if (!input) return '';
  return String(input)
    .replace(/https?:\/\/[^\s"'<>]*(?:movielinkbd|myflixbd)[^\s"'<>]*/gi, '')
    .replace(/\b[a-z0-9-]*\.?(?:movielinkbd|myflixbd)\.[a-z]{2,6}\b/gi, 'CinePulse')
    .replace(/movielinkbd|myflixbd|nexaflox/gi, 'CinePulse')
    .replace(/movie\s*link\s*bd/gi, 'CinePulse')
    .replace(/\bmlbd\b/gi, 'CP')
    .replace(/\s*watch\s+online\s+and\s+download\s*(?:["“”']?web-dl["“”']?|["“”']?hdtc["“”']?|["“”']?hd["“”']?|["“”']?4k["“”']?)?\s*…?/gi, '')
    .replace(/\s*watch\s+online\s*…?/gi, '')
    .replace(/\s*[“”"'](?:web(?:-?dl|rip)?|hdtc|hdts|4k|hd)[^"”]*[”"']?\s*…?\s*$/gi, '')
    .replace(/\s+[–—-]\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function decodeHtmlEntities(str: string): string {
  const cleaned = (str || '')
    .replace(/&ndash;|&#8211;/g, '–')
    .replace(/&mdash;|&#8212;/g, '—')
    .replace(/&#039;|&#8217;/g, "'")
    .replace(/&quot;|&#8220;|&#8221;/g, '"')
    .replace(/&amp;|&#038;/g, '&')
    .replace(/&bull;|&#8226;/g, '•')
    .replace(/&#8230;|&hellip;/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .trim();
  return sanitizeBrandText(cleaned);
}

/**
 * Browser-native implementation of the stream & download cipher decoder.
 */
function decodeMlbdCipherBrowser(base64Str: string, hexSeed: string, rounds: number): string {
  try {
    let x = parseInt(hexSeed, 16) >>> 0;
    for (let i = 0; i < rounds; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    }
    const cleanB64 = base64Str.trim().replace(/\s+/g, '');
    const binary = window.atob(cleanB64);
    const out = new Uint8Array(binary.length);
    for (let j = 0; j < binary.length; j++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      out[j] = binary.charCodeAt(j) ^ ((x >>> 16) & 255);
    }
    return new TextDecoder('utf-8').decode(out);
  } catch {
    return '';
  }
}

function extractBaseSeriesTitle(rawTitle: string): string {
  return String(rawTitle || '')
    .replace(/\[.*?\]|\(.*?\)/g, ' ')
    .replace(
      /\b(?:S\d+|Season\s*\d+(?:-\d+)?|Ep(?:isode)?\s*\d+(?:-\d+)?|Complete(?:d)?|Added|Full\s*HD|ORG|Hindi|Bangla|Bengali|Dual|Multi|The\s*Movie)\b/gi,
      ' '
    )
    .replace(/[:\-–—|]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const warmedStreamUrls = new Set<string>();
const preconnectedOrigins = new Set<string>();
let warmVideoEl: HTMLVideoElement | null = null;
let hasPrimedHardwareDecoder = false;

function isAppleSafariDevice(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isIOS =
    /iPhone|iPad|iPod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /Safari/i.test(ua) && !/Chrome|Chromium|Edg|OPR|Android/i.test(ua);
  return isIOS || isSafari;
}

function ensurePreconnectOrigin(streamUrl: string): void {
  if (typeof document === 'undefined') return;
  try {
    const origin = new URL(streamUrl).origin;
    if (!origin || preconnectedOrigins.has(origin)) return;
    preconnectedOrigins.add(origin);

    const dnsLink = document.createElement('link');
    dnsLink.rel = 'dns-prefetch';
    dnsLink.href = origin;
    document.head.appendChild(dnsLink);

    // 1. Non-CORS preconnect for native <video src="..."> socket pool on Android/Chrome
    const mediaLink = document.createElement('link');
    mediaLink.rel = 'preconnect';
    mediaLink.href = origin;
    document.head.appendChild(mediaLink);

    // 2. Anonymous CORS preconnect for fetch() / iOS remuxer socket pool
    const corsLink = document.createElement('link');
    corsLink.rel = 'preconnect';
    corsLink.href = origin;
    corsLink.crossOrigin = 'anonymous';
    document.head.appendChild(corsLink);

    // Immediately warm the no-cors TLS/HTTP2 socket to the video CDN
    fetch(origin, { mode: 'no-cors', priority: 'high' as any }).catch(() => {});
  } catch {
    // ignore
  }
}

/**
 * Warms DNS, TCP, and TLS handshakes to the video CDN origin AND initializes the browser's
 * hardware video decoder once on page boot so the 1st movie click starts as fast as the 2nd+ click.
 */
export function warmStreamConnection(streamUrl?: string, primeMediaDecoder = false): void {
  if (!streamUrl || typeof window === 'undefined') return;
  if (!streamUrl.startsWith('http')) return;
  ensurePreconnectOrigin(streamUrl);
  if (!isVideoActivelyStarting && primeMediaDecoder && !warmedStreamUrls.has(streamUrl)) {
    warmedStreamUrls.add(streamUrl);
    if (isAppleSafariDevice()) {
      prewarmMkvStreamMeta(streamUrl);
    } else if (!hasPrimedHardwareDecoder && typeof document !== 'undefined') {
      // One-time background hardware video decoder & <video> media socket warmup on Android/Desktop
      // before the user clicks their 1st movie! Stops automatically as soon as metadata is ready.
      hasPrimedHardwareDecoder = true;
      try {
        const v = document.createElement('video');
        v.muted = true;
        v.playsInline = true;
        v.preload = 'metadata';
        v.style.position = 'fixed';
        v.style.width = '1px';
        v.style.height = '1px';
        v.style.opacity = '0';
        v.style.pointerEvents = 'none';
        v.style.left = '-9999px';
        warmVideoEl = v;
        const cleanupWarm = () => {
          stopBackgroundWarmVideo();
        };
        v.addEventListener('loadedmetadata', cleanupWarm, { once: true });
        v.addEventListener('error', cleanupWarm, { once: true });
        v.src = streamUrl;
        v.load();
        window.setTimeout(cleanupWarm, 1100);
      } catch {
        // ignore
      }
    }
  }
}

export function stopBackgroundWarmVideo(): void {
  if (warmVideoEl) {
    try {
      warmVideoEl.pause();
      warmVideoEl.removeAttribute('src');
      warmVideoEl.load();
      warmVideoEl.remove();
    } catch {
      // ignore
    }
    warmVideoEl = null;
  }
}

function warmDetailFirstStream(detail?: MovieDetailData | null, primeMediaDecoder = false): void {
  const firstEp = detail?.episodes?.[0];
  if (!firstEp?.sources?.length) return;
  const isNonHevc = (s: StreamSource) =>
    !/\b(hevc|h\.?265|x265|10bit|av1)\b/i.test(`${s.name} ${s.qualityLabel}`) &&
    !/best\s*quality/i.test(s.qualityLabel || '');
  // Always pre-warm the fastest starting 480p or 720p H.264 stream first!
  const bestFast =
    firstEp.sources.find((s) => isNonHevc(s) && s.quality >= 360 && s.quality <= 576) ||
    firstEp.sources.find((s) => isNonHevc(s) && s.quality === 720) ||
    firstEp.sources.find((s) => isNonHevc(s)) ||
    firstEp.sources[0];
  if (bestFast?.url && bestFast.type !== 'embed') {
    warmStreamConnection(bestFast.url, primeMediaDecoder);
  }
}

/**
 * Synchronous 0ms detail lookup from in-memory cache or pre-loaded static-db.json
 * so clicking a movie opens the video player immediately without any loading spinner!
 */
export function getInstantCachedDetail(rawPath: string, rawTitle = ''): MovieDetailData | null {
  const pathKey = (rawPath || '').trim();
  if (!pathKey && !rawTitle) return null;

  const mem = clientDetailCache.get(pathKey);
  // Only use in-memory detail cache if fetched within the last 12 minutes so stream tokens never expire
  if (mem && Date.now() - mem.ts < 12 * 60_000 && mem.detail?.episodes?.length) {
    return mem.detail;
  }

  if (loadedStaticDb?.details?.[pathKey]?.episodes?.length) {
    return loadedStaticDb.details[pathKey];
  }

  // Never fall back to stripped title lookup for distinct /mb/<subjectId>/ paths,
  // because different language dubs (e.g. Original vs Hindi dub) have distinct subjectIds!
  if (pathKey.startsWith('/mb/')) {
    return null;
  }

  if (rawTitle) {
    const k1 = normalizeLookupTitleKey(rawTitle);
    const byK1 = k1 ? staticDbTitleIndex.get(k1) : undefined;
    if (byK1 && byK1.episodes?.length) return byK1;
  }

  return null;
}

/**
 * Pre-loads the static shard OR live /api/details on hover/touchstart and preconnects
 * the video CDN origin so clicking Play opens and starts playing in 0ms on the very first click!
 */
export function prefetchMovieDetails(
  rawPath: string,
  rawTitle = '',
  nodeId = 'node-alpha',
  primeMediaDecoder = false
): void {
  if (isVideoActivelyStarting) return;
  const pathKey = (rawPath || '').trim();
  if (!pathKey && !rawTitle) return;

  const existing = getInstantCachedDetail(pathKey, rawTitle);
  if (existing) {
    if (primeMediaDecoder) warmDetailFirstStream(existing, false);
    return;
  }

  if (!pathKey || inFlightDetailPromises.has(pathKey) || bgPrefetchControllers.size >= 2) return;
  const ctrl = new AbortController();
  bgPrefetchControllers.add(ctrl);
  const params = new URLSearchParams({
    path: pathKey,
    title: rawTitle,
    node: nodeId,
  });
  const p = fetch(`/api/details?${params.toString()}`, { signal: ctrl.signal })
    .then((r) => (r.ok ? r.json() : null))
    .then((json) => {
      if (json?.ok && json?.detail?.episodes?.length) {
        for (const ep of json.detail.episodes || []) {
          for (const src of ep.sources || []) {
            if (src.downloadUrl) src.downloadUrl = resolveDirectDownloadUrl(src.downloadUrl);
          }
        }
        clientDetailCache.set(pathKey, { detail: json.detail, ts: Date.now() });
        indexDetailsIntoMemory({ [pathKey]: json.detail }, true);
      }
      return json;
    })
    .catch(() => null)
    .finally(() => {
      bgPrefetchControllers.delete(ctrl);
      inFlightDetailPromises.delete(pathKey);
    });
  inFlightDetailPromises.set(pathKey, p);
}

function scheduleBackgroundCatalogDetailWarmup(items: MovieCardItem[], nodeId: string): void {
  if (typeof window === 'undefined' || !items?.length) return;
  // Gently pre-warm only the top 2 visible items after 800ms so background requests never clog the browser's 6-connection pool!
  items.slice(0, 2).forEach((item, idx) => {
    window.setTimeout(() => {
      if (!isVideoActivelyStarting && item?.path) {
        prefetchMovieDetails(item.path, item.title, nodeId, false);
      }
    }, 800 + idx * 450);
  });
}

const NODE_ORIGIN_MAP: Record<string, string> = {
  'node-alpha': 'https://cmyyhb.movielinkbd.at',
  'node-beta': 'https://4yer8f.movielinkbd.at',
  'node-gamma': 'https://cmyyhb.movielinkbd.at',
  'node-delta': 'https://4yer8f.movielinkbd.at',
};

async function fetchMirrorHtmlClientSide(
  relativePath: string,
  preferredNodeId = 'node-alpha',
  bustCache = false
): Promise<{ html: string; finalOrigin: string }> {
  let cleanPath = relativePath.startsWith('http')
    ? new URL(relativePath).pathname + new URL(relativePath).search
    : relativePath.startsWith('/')
      ? relativePath
      : `/${relativePath}`;

  if (bustCache) {
    const sep = cleanPath.includes('?') ? '&' : '?';
    cleanPath = `${cleanPath}${sep}_live=${Math.floor(Date.now() / 30000)}`;
  }

  const preferredOrigin = NODE_ORIGIN_MAP[preferredNodeId] || MIRROR_ORIGINS[0];
  const orderedOrigins = [
    preferredOrigin,
    ...MIRROR_ORIGINS.filter((o) => o !== preferredOrigin),
  ];

  // Try primary origin first without flooding duplicate CORS bridge requests, with a generous 10s timeout for 370KB HTML pages
  for (const origin of orderedOrigins) {
    const targetUrl = `${origin}${cleanPath}`;
    const url = CORS_BRIDGES[0](targetUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error('Bad status');
      const html = await res.text();
      if (
        html &&
        html.length > 800 &&
        (html.includes('movie-card') || html.includes('mlbdInlinePlayerData'))
      ) {
        return { html, finalOrigin: origin };
      }
    } catch {
      // try backup origin
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('Client mirror bridges unreachable');
}

function parseClientCatalogHtml(html: string): { items: MovieCardItem[]; maxPage: number } {
  const bodyIdx = html.indexOf('<body');
  const body = bodyIdx >= 0 ? html.slice(bodyIdx) : html;
  const blocks = body.split(/<div class="movie-card"/i).slice(1);
  const items: MovieCardItem[] = [];
  const seenPaths = new Set<string>();

  for (const block of blocks) {
    const chunk = block.slice(0, 3200);
    if (chunk.includes("'+esc(") || chunk.includes('${')) continue;

    const titleMatch =
      chunk.match(/class=["']title["'][^>]*>([\s\S]*?)<\/a>/i) ||
      chunk.match(/alt=["']([^"']+)["']/i);
    const hrefMatch = chunk.match(/<a[^>]+href=["']([^"']+)["']/i);
    if (!titleMatch || !hrefMatch) continue;

    const rawHref = hrefMatch[1].trim();
    if (!rawHref || rawHref.includes("'+") || rawHref === '#') continue;

    const itemPath = rawHref.startsWith('http')
      ? new URL(rawHref).pathname
      : rawHref.startsWith('/')
        ? rawHref
        : `/${rawHref}`;

    if (seenPaths.has(itemPath)) continue;
    seenPaths.add(itemPath);

    const title = decodeHtmlEntities(titleMatch[1]);
    if (!title) continue;

    const posterMatch =
      chunk.match(/data-src=["'](https?:\/\/[^"']+)["']/i) ||
      chunk.match(/src=["'](https?:\/\/[^"']+)["']/i);
    const poster = posterMatch ? posterMatch[1].trim() : '';

    const quality = decodeHtmlEntities(
      (chunk.match(/<span class=["']quality["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || 'WEB-DL'
    );
    const language = decodeHtmlEntities(
      (chunk.match(/<span class=["']language["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || 'MULTI'
    );
    const views = decodeHtmlEntities(
      (chunk.match(/<span class=["']views-badge-top["'][^>]*>[\s\S]*?<\/i>\s*([^<]+)<\/span>/i) ||
        [])[1] || '2.4K'
    );
    const rawTimeAgo = decodeHtmlEntities(
      (chunk.match(/<div class=["']upload-time["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] ||
        'Recently added'
    );
    const rawEpisodePill = decodeHtmlEntities(
      (chunk.match(/<span class=["']badge ep-badge[^"']*["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] ||
        ''
    );
    const cleanedTime = cleanTimeAgoAndEpisode(
      rawTimeAgo,
      rawEpisodePill,
      itemPath || title,
      items.length
    );

    const isPinned = chunk.includes('pin-badge') || chunk.includes('data-pin="1"');
    const isAdult =
      chunk.includes('data-18="1"') ||
      itemPath.includes('18plus') ||
      cleanedTime.episodePill.toUpperCase().includes('18+');

    let typeBadge: 'MOVIE' | 'SERIES' | 'ANIME' | 'DRAMA' = 'MOVIE';
    if (itemPath.includes('/anime/')) typeBadge = 'ANIME';
    else if (itemPath.includes('/drama/')) typeBadge = 'DRAMA';
    else if (itemPath.includes('/series/') || Boolean(cleanedTime.episodePill)) typeBadge = 'SERIES';

    items.push({
      id: itemPath.replace(/[^a-zA-Z0-9_-]/g, '_'),
      title,
      url: itemPath,
      path: itemPath,
      poster,
      quality: quality || 'HD',
      views: views || '1.9K',
      language: language || 'MULTI',
      typeBadge,
      timeAgo: cleanedTime.timeAgo,
      episodePill: cleanedTime.episodePill,
      isPinned,
      isAdult,
      uploadedAtMs: Date.now() - cleanedTime.minutesAgo * 60_000,
    });
  }

  const pageMatches = [...body.matchAll(/\/page\/(\d+)/g)]
    .map((m) => Number(m[1]))
    .filter((n) => !isNaN(n) && n > 0 && n <= 2000);
  const maxPage = pageMatches.length > 0 ? Math.max(...pageMatches) : 520;

  return { items, maxPage };
}

function parseClientDetailHtml(html: string, itemPath: string, origin: string): MovieDetailData {
  let inlineData: any = null;
  const playerScriptMatch = html.match(
    /<script[^>]*id=["']mlbdInlinePlayerData["'][^>]*data-s=["']([^"']+)["'][^>]*data-r=["'](\d+)["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (playerScriptMatch) {
    const decodedJson = decodeMlbdCipherBrowser(
      playerScriptMatch[3],
      playerScriptMatch[1],
      parseInt(playerScriptMatch[2], 10) || 600
    );
    try {
      inlineData = JSON.parse(decodedJson);
    } catch {
      inlineData = null;
    }
  }

  const downloadButtons: DirectDownloadButton[] = [];
  const dlRegex =
    /<a[^>]*data-dl=["']([^"']+)["'][^>]*data-ds=["']([^"']+)["'][^>]*data-dr=["'](\d+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(dlRegex)) {
    const decodedHref = decodeMlbdCipherBrowser(
      match[1],
      match[2],
      parseInt(match[3], 10) || 300
    );
    const label = decodeHtmlEntities(match[4]);
    if (decodedHref) {
      const fullDlUrl = decodedHref.startsWith('http')
        ? decodedHref
        : `${origin}${decodedHref.startsWith('/') ? '' : '/'}${decodedHref}`;
      const bracketMatch = label.match(/\[(.*?)\]/);
      const parts = bracketMatch ? bracketMatch[1].split('•').map((s) => s.trim()) : [];
      downloadButtons.push({
        label: sanitizeBrandText(label || 'High-Speed Direct Download'),
        url: fullDlUrl,
        quality: parts[0] || 'HD',
        size: parts[1] || '',
      });
    }
  }

  const rawTitle =
    inlineData?.title ||
    decodeHtmlEntities((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || 'Cinema Title');
  const title = sanitizeBrandText(rawTitle);

  const poster =
    inlineData?.poster ||
    (html.match(
      /<div class=["']image-container-view["'][\s\S]*?<img[^>]+src=["'](https?:\/\/[^"']+)["']/i
    ) || [])[1] ||
    '';

  const qualityNote = sanitizeBrandText(
    decodeHtmlEntities(
      (html.match(/<div class=["']movie-info-view["'][\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1] ||
        '1080p Full HD Stream'
    )
  );

  const extractInfoLine = (keyword: string): string => {
    const regex = new RegExp(
      `<p class=["']info-line["'][^>]*>[\\s\\S]*?${keyword}:?<\\/b>([\\s\\S]*?)<\\/p>`,
      'i'
    );
    const m = html.match(regex);
    return m ? decodeHtmlEntities(m[1]) : '';
  };

  const genre = extractInfoLine('Genre') || 'Cinema, Entertainment';
  const language = extractInfoLine('Language') || 'Multi Audio';
  const quality = extractInfoLine('Quality') || 'WEB-DL';
  const resolution = extractInfoLine('Resolution') || '1080p | 720p | 480p';
  const releaseDate = extractInfoLine('Released') || '2026';

  const storyline = sanitizeBrandText(
    decodeHtmlEntities(
      (html.match(/<p class=["']story-text["'][^>]*>([\s\S]*?)<\/p>/i) || [])[1] ||
        (html.match(/<meta name=["']description["'] content=["']([^"']+)["']/i) || [])[1] ||
        ''
    )
  );

  const trailerMatch = html.match(/data-mlbd-trailer=["']([a-zA-Z0-9_-]{6,20})["']/i);
  const youtubeTrailerId = trailerMatch ? trailerMatch[1] : '';

  const cast: CastMember[] = [];
  const castRegex =
    /<a class=["']mlbd-cast__p["'][^>]+href=["']([^"']+)["'][^>]*>[\s\S]*?<img[^>]+src=["']([^"']+)["'][^>]*>[\s\S]*?<b>([\s\S]*?)<\/b>[\s\S]*?<small>([\s\S]*?)<\/small>/gi;
  for (const m of html.matchAll(castRegex)) {
    const actorName = decodeHtmlEntities(m[3]);
    if (actorName) {
      cast.push({
        url: `/search?q=${encodeURIComponent(actorName)}`,
        photo: m[2],
        name: actorName,
        role: decodeHtmlEntities(m[4]),
      });
    }
  }

  const inferStreamQuality = (s: any): number => {
    const combined = `${s?.quality_label || ''} ${s?.name || ''}`.toLowerCase();
    if (/\b(2160p|4k)\b/.test(combined)) return 2160;
    if (/\b(1080p|full\s*hd)\b/.test(combined)) return 1080;
    if (/\b(480p|360p)\b/.test(combined)) return 480;
    if (/\b720p\b/.test(combined)) return 720;
    const q = Number(s?.quality);
    if (q === 480 || q === 720 || q === 1080 || q === 2160) return q;
    if (/best\s*quality/i.test(combined)) return 1080;
    return 720;
  };

  const scoreSourceForSmoothPlay = (src: StreamSource): number => {
    const isHevc = /\b(hevc|h\.?265|x265|10bit)\b/i.test(`${src.name} ${src.qualityLabel}`);
    const isBestHeavy = /best\s*quality/i.test(src.qualityLabel || '');
    let score = isHevc ? 200 : 1000;
    if (isBestHeavy) score -= 250;
    if (/\.(mp4|m4v|m3u8)(\?|$)/i.test(src.url)) score += 90;
    if (/r2\.dev|workers\.dev|cloudflare|fsldownload|pixeldrain/i.test(src.url)) score += 50;
    if (src.quality >= 360 && src.quality <= 576) score += 650;
    else if (src.quality === 720) score += 500;
    else if (src.quality === 1080) score += 350;
    else if (src.quality === 2160) score += 150;
    else score += 200;
    return score;
  };

  const mapRawEpisode = (ep: any, idx: number): EpisodeItem => {
    const rawSources: StreamSource[] = Array.isArray(ep.sources)
      ? ep.sources
          .filter((s: any) => s && (s.url || s.download_url))
          .map((s: any, sIdx: number) => {
            const rawUrl = String(s.url || '');
            const rawStreamUrl = rawUrl.startsWith('http')
              ? rawUrl
              : rawUrl
                ? `${origin}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`
                : '';
            const rawDlUrl = String(s.download_url || s.url || '');
            const fullDlUrl = rawDlUrl.startsWith('http')
              ? rawDlUrl
              : rawDlUrl
                ? `${origin}${rawDlUrl.startsWith('/') ? '' : '/'}${rawDlUrl}`
                : '';
            const realQuality = inferStreamQuality(s);
            return {
              id: String(s.id || `src-${idx}-${realQuality}-${sIdx}`),
              quality: realQuality,
              qualityLabel: s.quality_label || `${realQuality}p`,
              audio: sanitizeBrandText(String(s.audio || 'Multi Audio')),
              audioLanguages: Array.isArray(s.audio_languages)
                ? s.audio_languages.map((a: any) => sanitizeBrandText(String(a)))
                : [sanitizeBrandText(String(s.audio || 'Original'))],
              provider: `Cloud Stream #${sIdx + 1}`,
              url: rawStreamUrl,
              downloadUrl: fullDlUrl,
              type: String(s.type || 'mkv').toLowerCase(),
              name: sanitizeBrandText(String(s.name || `${title} - ${realQuality}p`)),
              screenshot: s.screenshot || undefined,
            };
          })
      : [];

    const sources = [...rawSources].sort(
      (a, b) => scoreSourceForSmoothPlay(b) - scoreSourceForSmoothPlay(a)
    );

    const rawLabel = sanitizeBrandText(
      String(ep.label || (ep.number ? `Episode ${ep.number}` : 'Full Movie'))
    );

    const rangeMatch = rawLabel.match(/(?:ep(?:isode)?|e)\s*0*(\d{1,4})\s*[-–—]\s*0*(\d{1,4})/i);
    const singleEpMatch =
      rawLabel.match(/s\d+\s*e0*(\d{1,4})/i) ||
      rawLabel.match(/(?:ep(?:isode)?|e)\s*0*(\d{1,4})/i);
    const seasonMatch = rawLabel.match(/\bs(?:eason)?\s*0*(\d{1,2})\b/i);

    const parsedStart = rangeMatch
      ? Number(rangeMatch[1])
      : singleEpMatch
        ? Number(singleEpMatch[1])
        : null;
    const parsedEnd = rangeMatch ? Number(rangeMatch[2]) : parsedStart;

    const number =
      ep.number !== null && ep.number !== undefined
        ? Number(ep.number)
        : ep.range_start !== null && ep.range_start !== undefined
          ? Number(ep.range_start)
          : parsedStart;

    const rangeStart =
      ep.range_start !== null && ep.range_start !== undefined ? Number(ep.range_start) : number;
    const rangeEnd =
      ep.range_end !== null && ep.range_end !== undefined
        ? Number(ep.range_end)
        : parsedEnd ?? rangeStart;

    const season =
      ep.season !== null && ep.season !== undefined
        ? Number(ep.season)
        : seasonMatch
          ? Number(seasonMatch[1])
          : null;

    return {
      id: String(ep.id || `ep-${idx + 1}`),
      label: rawLabel,
      number,
      rangeStart,
      rangeEnd,
      season,
      kind: String(ep.kind || (number !== null ? 'episode' : 'movie')),
      sources,
    };
  };

  const episodes: EpisodeItem[] = Array.isArray(inlineData?.episodes)
    ? inlineData.episodes
        .map((ep: any, idx: number) => mapRawEpisode(ep, idx))
        .filter((ep: EpisodeItem) => ep.sources.length > 0)
        .sort((a: EpisodeItem, b: EpisodeItem) => {
          const sA = a.season ?? 0;
          const sB = b.season ?? 0;
          if (sA !== sB && a.season !== null && b.season !== null) return sA - sB;
          const nA = a.rangeStart ?? a.number ?? 999999;
          const nB = b.rangeStart ?? b.number ?? 999999;
          if (nA !== nB) return nA - nB;
          return (a.rangeEnd ?? nA) - (b.rangeEnd ?? nB);
        })
    : [];

  const screenshots: string[] = Array.isArray(inlineData?.screenshots)
    ? inlineData.screenshots.map((s: any) => s?.url).filter(Boolean)
    : [];

  return {
    title,
    url: itemPath,
    poster,
    qualityNote,
    typeBadge: inlineData?.content_type === 'series' || episodes.length > 1 ? 'SERIES' : 'MOVIE',
    language,
    quality,
    genre,
    resolution,
    releaseDate,
    storyline,
    youtubeTrailerId,
    screenshots,
    episodes,
    downloadButtons,
    cast: cast.slice(0, 12),
    communityScore: {
      recommendedPercent: 92,
      totalVotes: 420,
      verdict: 'Massive Hit',
    },
  };
}

/**
 * Universal API Fetcher:
 * - On Node.js server (AI Studio / Cloud Run / Render), uses `/api/...`
 * - On Static GitHub Pages (`*.github.io`), uses Instant Pre-Built Snapshot (`./static-db.json`)
 *   + Live Browser Cipher Decryptor (`allorigins.hexlet.app` + `decodeMlbdCipherBrowser`)
 */
// ============================================================================
// Direct Browser-Side MovieBox BFF Engine (Uses User's Local Bangladesh/India Geo-IP!)
// ============================================================================
const BROWSER_MB_API = 'https://h5-api.aoneroom.com';
let browserMbToken = '';
let browserMbTokenExp = 0;
let browserMbTokenPromise: Promise<string> | null = null;

function md5Browser(input: string): string {
  function rl(n: number, c: number) {
    return (n << c) | (n >>> (32 - c));
  }
  function cmn(q: number, a: number, b: number, x: number, s: number, t: number) {
    return (rl((a + q + x + t) | 0, s) + b) | 0;
  }
  function ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return cmn((b & c) | (~b & d), a, b, x, s, t);
  }
  function gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return cmn((b & d) | (c & ~d), a, b, x, s, t);
  }
  function hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return cmn(b ^ c ^ d, a, b, x, s, t);
  }
  function ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return cmn(c ^ (b | ~d), a, b, x, s, t);
  }
  const utf8 = unescape(encodeURIComponent(input));
  const n = utf8.length;
  const words = new Int32Array((((n + 8) >>> 6) + 1) * 16);
  for (let i = 0; i < n; i++) {
    words[i >> 2] |= utf8.charCodeAt(i) << ((i % 4) * 8);
  }
  words[n >> 2] |= 0x80 << ((n % 4) * 8);
  words[words.length - 2] = n * 8;

  let a = 1732584193;
  let b = -271733879;
  let c = -1732584194;
  let d = 271733878;

  for (let i = 0; i < words.length; i += 16) {
    const oa = a;
    const ob = b;
    const oc = c;
    const od = d;
    a = ff(a, b, c, d, words[i + 0], 7, -680876936);
    d = ff(d, a, b, c, words[i + 1], 12, -389564586);
    c = ff(c, d, a, b, words[i + 2], 17, 606105819);
    b = ff(b, c, d, a, words[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, words[i + 4], 7, -176418897);
    d = ff(d, a, b, c, words[i + 5], 12, 1200080426);
    c = ff(c, d, a, b, words[i + 6], 17, -1473231341);
    b = ff(b, c, d, a, words[i + 7], 22, -45705983);
    a = ff(a, b, c, d, words[i + 8], 7, 1770035416);
    d = ff(d, a, b, c, words[i + 9], 12, -1958414417);
    c = ff(c, d, a, b, words[i + 10], 17, -42063);
    b = ff(b, c, d, a, words[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, words[i + 12], 7, 1804603682);
    d = ff(d, a, b, c, words[i + 13], 12, -40341101);
    c = ff(c, d, a, b, words[i + 14], 17, -1502002290);
    b = ff(b, c, d, a, words[i + 15], 22, 1236535329);

    a = gg(a, b, c, d, words[i + 1], 5, -165796510);
    d = gg(d, a, b, c, words[i + 6], 9, -1069501632);
    c = gg(c, d, a, b, words[i + 11], 14, 643717713);
    b = gg(b, c, d, a, words[i + 0], 20, -373897302);
    a = gg(a, b, c, d, words[i + 5], 5, -701558691);
    d = gg(d, a, b, c, words[i + 10], 9, 38016083);
    c = gg(c, d, a, b, words[i + 15], 14, -660478335);
    b = gg(b, c, d, a, words[i + 4], 20, -405537848);
    a = gg(a, b, c, d, words[i + 9], 5, 568446438);
    d = gg(d, a, b, c, words[i + 14], 9, -1019803690);
    c = gg(c, d, a, b, words[i + 3], 14, -187363961);
    b = gg(b, c, d, a, words[i + 8], 20, 1163531501);
    a = gg(a, b, c, d, words[i + 13], 5, -1444681467);
    d = gg(d, a, b, c, words[i + 2], 9, -51403784);
    c = gg(c, d, a, b, words[i + 7], 14, 1735328473);
    b = gg(b, c, d, a, words[i + 12], 20, -1926607734);

    a = hh(a, b, c, d, words[i + 5], 4, -378558);
    d = hh(d, a, b, c, words[i + 8], 11, -2022574463);
    c = hh(c, d, a, b, words[i + 11], 16, 1839030562);
    b = hh(b, c, d, a, words[i + 14], 23, -35309556);
    a = hh(a, b, c, d, words[i + 1], 4, -1530992060);
    d = hh(d, a, b, c, words[i + 4], 11, 1272893353);
    c = hh(c, d, a, b, words[i + 7], 16, -155497632);
    b = hh(b, c, d, a, words[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, words[i + 13], 4, 681279174);
    d = hh(d, a, b, c, words[i + 0], 11, -358537222);
    c = hh(c, d, a, b, words[i + 3], 16, -722521979);
    b = hh(b, c, d, a, words[i + 6], 23, 76029189);
    a = hh(a, b, c, d, words[i + 9], 4, -640364487);
    d = hh(d, a, b, c, words[i + 12], 11, -421815835);
    c = hh(c, d, a, b, words[i + 15], 16, 530742520);
    b = hh(b, c, d, a, words[i + 2], 23, -995338651);

    a = ii(a, b, c, d, words[i + 0], 6, -198630844);
    d = ii(d, a, b, c, words[i + 7], 10, 1126891415);
    c = ii(c, d, a, b, words[i + 14], 15, -1416354905);
    b = ii(b, c, d, a, words[i + 5], 21, -57434055);
    a = ii(a, b, c, d, words[i + 12], 6, 1700485571);
    d = ii(d, a, b, c, words[i + 3], 10, -1894986606);
    c = ii(c, d, a, b, words[i + 10], 15, -1051523);
    b = ii(b, c, d, a, words[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, words[i + 8], 6, 1873313359);
    d = ii(d, a, b, c, words[i + 15], 10, -30611744);
    c = ii(c, d, a, b, words[i + 6], 15, -1560198380);
    b = ii(b, c, d, a, words[i + 13], 21, 1309151649);
    a = ii(a, b, c, d, words[i + 4], 6, -145523070);
    d = ii(d, a, b, c, words[i + 11], 10, -1120210379);
    c = ii(c, d, a, b, words[i + 2], 15, 718787259);
    b = ii(b, c, d, a, words[i + 9], 21, -343485551);

    a = (a + oa) | 0;
    b = (b + ob) | 0;
    c = (c + oc) | 0;
    d = (d + od) | 0;
  }

  const hex = '0123456789abcdef';
  const out = [a, b, c, d];
  let str = '';
  for (let i = 0; i < 4; i++) {
    const v = out[i];
    for (let j = 0; j < 4; j++) {
      const byte = (v >>> (j * 8)) & 0xff;
      str += hex.charAt((byte >>> 4) & 0x0f) + hex.charAt(byte & 0x0f);
    }
  }
  return str;
}

function generateBrowserMovieBoxClientToken(): string {
  const ts = Math.floor(Date.now() / 1000);
  const rev = String(ts).split('').reverse().join('');
  return `${ts},${md5Browser(rev)}`;
}

function encodeBrowserBase64Url(str: string): string {
  try {
    const b64 = window.btoa(unescape(encodeURIComponent(str)));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch {
    return '';
  }
}

async function getBrowserMovieBoxBearerToken(): Promise<string> {
  if (browserMbToken && browserMbTokenExp > Date.now()) {
    return browserMbToken;
  }
  if (browserMbTokenPromise) {
    return browserMbTokenPromise;
  }
  browserMbTokenPromise = (async () => {
    try {
      const res = await fetch(
        `${BROWSER_MB_API}/wefeed-h5api-bff/app/get-latest-app-pkgs?appName=moviebox`,
        {
          headers: {
            Accept: 'application/json',
            'X-Client-Info': JSON.stringify({ timezone: 'Asia/Dhaka' }),
            'X-Client-Token': generateBrowserMovieBoxClientToken(),
            'X-Vip-Restrict': '1',
            'X-No-High-Risk-Restrict': '0',
            'X-Request-Lang': 'en',
          },
        }
      );
      const xUser = res.headers.get('x-user') || res.headers.get('x-user-info');
      if (xUser) {
        const parsed = JSON.parse(xUser);
        if (parsed?.token) {
          browserMbToken = String(parsed.token);
          browserMbTokenExp = Date.now() + 2 * 3600_000;
        }
      }
      return browserMbToken;
    } catch {
      return browserMbToken;
    } finally {
      browserMbTokenPromise = null;
    }
  })();
  return browserMbTokenPromise;
}

function mapBrowserMovieBoxItemToCard(raw: any): MovieCardItem | null {
  if (!raw || !raw.subjectId || !raw.title || raw.hasResource === false) return null;
  if (Number(raw.subjectType) === 9) return null;
  const subjectId = String(raw.subjectId).trim();
  const detailSlug = raw.detailPath
    ? String(raw.detailPath).trim()
    : String(raw.title)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '');
  const itemPath = `/mb/${subjectId}/${detailSlug || 'movie'}`;
  const rawTitle = String(raw.title).trim();
  const year = raw.releaseDate ? String(raw.releaseDate).split('-')[0] : '';
  const hasYearInTitle = /\b(19|20)\d{2}\b/.test(rawTitle);
  const displayTitle = year && !hasYearInTitle ? `${rawTitle} (${year})` : rawTitle;
  const poster = String(raw.cover?.url || raw.stills?.url || '').trim();
  if (!poster) return null;

  const ratingVal = parseFloat(String(raw.imdbRatingValue || raw.imdbRate || '8.2')) || 8.2;
  const subjectType = Number(raw.subjectType) || 1;
  const genreStr = String(raw.genre || '').toUpperCase();
  const countryStr = String(raw.countryName || '').toUpperCase();
  const cornerStr = String(raw.corner || '').trim().toUpperCase();

  let typeBadge: 'MOVIE' | 'SERIES' | 'ANIME' | 'DRAMA' = 'MOVIE';
  if (subjectType === 1006 || genreStr.includes('ANIMATION') || countryStr === 'JAPAN') {
    typeBadge = subjectType === 2 ? 'ANIME' : 'MOVIE';
  } else if (subjectType === 2) {
    if (countryStr.includes('KOREA') || countryStr.includes('CHINA') || countryStr.includes('TURKEY')) {
      typeBadge = 'DRAMA';
    } else {
      typeBadge = 'SERIES';
    }
  }

  const dubsList = Array.isArray(raw.dubs)
    ? raw.dubs.map((d: any) => String(d?.lanName || d || '')).filter(Boolean)
    : [];
  let language = 'ENGLISH';
  if (cornerStr.includes('BENGALI') || cornerStr.includes('BANGLA') || /\[(bengali|bangla)\]/i.test(rawTitle)) {
    language = 'BANGLA DUBBED';
  } else if (cornerStr.includes('HINDI') || /\[hindi\]/i.test(rawTitle)) {
    language = !countryStr.includes('INDIA') ? 'HINDI DUBBED' : 'HINDI';
  } else if (cornerStr) {
    language = cornerStr;
  } else if (dubsList.length > 0) {
    language = dubsList[0].toUpperCase();
  } else if (countryStr.includes('BANGLADESH')) {
    language = 'BANGLA';
  } else if (countryStr.includes('INDIA')) {
    language = 'HINDI';
  } else if (countryStr.includes('KOREA')) {
    language = 'KOREAN';
  } else if (countryStr.includes('JAPAN')) {
    language = 'JAPANESE';
  }

  return {
    id: `mb_${subjectId}`,
    title: displayTitle,
    url: itemPath,
    path: itemPath,
    poster,
    quality: '1080p FHD',
    views: `★ ${ratingVal.toFixed(1)}`,
    rating: ratingVal.toFixed(1),
    language,
    typeBadge,
    timeAgo: year || 'HD Release',
    episodePill: subjectType === 2 ? 'FULL SERIES' : '',
    isPinned: false,
    isAdult: Boolean(raw.isPornographic),
    uploadedAtMs: Date.now() - 3600_000,
  };
}

async function fetchBrowserMovieBoxSearch(query: string, page = 1): Promise<MovieCardItem[]> {
  if (typeof window === 'undefined' || !query.trim()) return [];
  try {
    const token = await getBrowserMovieBoxBearerToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Client-Info': JSON.stringify({ timezone: 'Asia/Dhaka' }),
      'X-Client-Token': generateBrowserMovieBoxClientToken(),
      'X-Vip-Restrict': '1',
      'X-No-High-Risk-Restrict': '0',
      'X-Request-Lang': 'en',
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`${BROWSER_MB_API}/wefeed-h5api-bff/subject/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        keyword: query.trim(),
        page,
        perPage: 28,
        subjectType: 0,
      }),
    });
    if (!res.ok) return [];
    const json = await res.json();
    const rawItems: any[] = Array.isArray(json?.data?.items) ? json.data.items : [];
    const cards: MovieCardItem[] = [];
    const seen = new Set<string>();
    for (const it of rawItems) {
      const sid = String(it?.subjectId || '');
      if (!sid || seen.has(sid)) continue;
      seen.add(sid);
      const card = mapBrowserMovieBoxItemToCard(it);
      if (card) cards.push(card);
    }
    return cards;
  } catch {
    return [];
  }
}

export async function resolveBrowserMovieBoxEpisodeSources(
  subjectId: string,
  detailPath: string,
  seasonNum: number,
  epNum: number,
  title: string,
  language: string
): Promise<{ sources: StreamSource[]; buttons: DirectDownloadButton[] }> {
  if (typeof window === 'undefined' || !subjectId) return { sources: [], buttons: [] };
  try {
    const token = await getBrowserMovieBoxBearerToken();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Client-Info': JSON.stringify({ timezone: 'Asia/Dhaka' }),
      'X-Client-Token': generateBrowserMovieBoxClientToken(),
      'X-Vip-Restrict': '1',
      'X-No-High-Risk-Restrict': '0',
      'X-Request-Lang': 'en',
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const playUrl = `${BROWSER_MB_API}/wefeed-h5api-bff/subject/play?subjectId=${encodeURIComponent(
      subjectId
    )}&se=${seasonNum}&ep=${epNum}&detailPath=${encodeURIComponent(detailPath)}&streamSignType=1`;
    const res = await fetch(playUrl, { headers });
    if (!res.ok) return { sources: [], buttons: [] };
    const json = await res.json();
    const streams: any[] = Array.isArray(json?.data?.streams) ? json.data.streams : [];

    const sources: StreamSource[] = [];
    const buttons: DirectDownloadButton[] = [];
    for (let i = 0; i < streams.length; i++) {
      const st = streams[i];
      if (!st?.url) continue;
      const resNum = parseInt(String(st.resolutions || '720'), 10) || 720;
      const sizeBytes = Number(st.size) || 0;
      const sizeMb = sizeBytes > 0 ? `${(sizeBytes / (1024 * 1024)).toFixed(0)} MB` : 'Full HD';
      const b64Token = encodeBrowserBase64Url(String(st.url));
      const proxiedStreamUrl = `/api/mb-stream.mp4?t=${b64Token}`;
      const proxiedDlUrl = `/api/mb-stream.mp4?t=${b64Token}&dl=1&name=${encodeURIComponent(
        `${title.replace(/[^a-zA-Z0-9_-]+/g, '_')}_${resNum}p.mp4`
      )}`;
      sources.push({
        id: `mb-browser-${subjectId}-s${seasonNum}-e${epNum}-${resNum}p-${i}`,
        quality: resNum,
        qualityLabel: `${resNum}p Full HD (MovieBox Direct)`,
        audio: language,
        audioLanguages: [language],
        provider: `MovieBox HD ${resNum}p`,
        url: proxiedStreamUrl,
        downloadUrl: proxiedDlUrl,
        type: 'mp4',
        name: `${title} (${resNum}p MP4 • ${sizeMb})`,
      });
      buttons.push({
        label: `MovieBox Direct Download ${resNum}p MP4 (${sizeMb})`,
        url: proxiedDlUrl,
        quality: `${resNum}p`,
        size: sizeMb,
      });
    }
    sources.sort((a, b) => {
      const rank = (s: StreamSource) => {
        if (s.quality === 720) return 100;
        if (s.quality === 480) return 99;
        if (s.quality === 360) return 95;
        if (s.quality === 1080) return 94;
        return s.quality;
      };
      return rank(b) - rank(a);
    });
    return { sources, buttons };
  } catch {
    return { sources: [], buttons: [] };
  }
}

async function fetchBrowserMovieBoxDetail(rawPath: string): Promise<MovieDetailData | null> {
  if (typeof window === 'undefined' || !rawPath.startsWith('/mb/')) return null;
  const parts = rawPath.replace(/^\/mb\//, '').split('/').filter(Boolean);
  const subjectId = parts[0] || '';
  const exactSlug = parts[1] || 'movie';
  if (!subjectId) return null;

  try {
    const token = await getBrowserMovieBoxBearerToken();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Client-Info': JSON.stringify({ timezone: 'Asia/Dhaka' }),
      'X-Client-Token': generateBrowserMovieBoxClientToken(),
      'X-Vip-Restrict': '1',
      'X-No-High-Risk-Restrict': '0',
      'X-Request-Lang': 'en',
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const detPromise = fetch(
      `${BROWSER_MB_API}/wefeed-h5api-bff/detail?detailPath=${encodeURIComponent(exactSlug)}&subjectId=${encodeURIComponent(subjectId)}`,
      { headers }
    )
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

    const [detJson, moviePlay, ep1Play] = await Promise.all([
      detPromise,
      resolveBrowserMovieBoxEpisodeSources(subjectId, exactSlug, 0, 0, exactSlug, 'Original Audio'),
      resolveBrowserMovieBoxEpisodeSources(subjectId, exactSlug, 1, 1, exactSlug, 'Original Audio'),
    ]);

    const subject = detJson?.data?.subject;
    if (!subject) return null;

    const resource = detJson?.data?.resource || {};
    const stars = Array.isArray(detJson?.data?.stars) ? detJson.data.stars : [];
    const title = String(subject.title || 'MovieBox Title').trim();
    const detailPath = String(subject.detailPath || exactSlug).trim();
    const poster = String(subject.cover?.url || '').trim();
    const releaseDate = String(subject.releaseDate || '2026').trim();
    const genre = String(subject.genre || 'Action, Drama').replace(/,/g, ', ');
    const storyline = String(subject.description || '').trim();
    const ratingVal = parseFloat(String(subject.imdbRatingValue || '8.4')) || 8.4;
    const subjectType = Number(subject.subjectType) || 1;
    const uploadedBy = String(resource?.uploadBy || 'MarieNo Ess').trim();

    const rawDubs: any[] = Array.isArray(subject.dubs) ? [...subject.dubs] : [];
    if (rawDubs.length <= 1) {
      // Also query browser search for base title to discover all regional dubs (e.g. [Hindi], [English], [Malayalam])
      const baseCleanTitle = extractBaseSeriesTitle(title)
        .replace(/\b(19|20)\d{2}\b/g, '')
        .trim();
      if (baseCleanTitle.length >= 2) {
        try {
          const sRes = await fetch(`${BROWSER_MB_API}/wefeed-h5api-bff/subject/search`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              keyword: baseCleanTitle,
              page: 1,
              perPage: 15,
              subjectType: 0,
            }),
          });
          if (sRes.ok) {
            const sJson = await sRes.json();
            const sItems: any[] = Array.isArray(sJson?.data?.items) ? sJson.data.items : [];
            const baseKey = baseCleanTitle.toLowerCase();
            for (const sItem of sItems) {
              const sTitle = String(sItem?.title || '').trim();
              const sBase = extractBaseSeriesTitle(sTitle)
                .replace(/\b(19|20)\d{2}\b/g, '')
                .trim()
                .toLowerCase();
              if (sBase === baseKey) {
                if (Array.isArray(sItem?.dubs)) rawDubs.push(...sItem.dubs);
                const sId = String(sItem?.subjectId || '').trim();
                const sSlug = String(sItem?.detailPath || detailPath).trim();
                const bracketMatch = sTitle.match(/\[(.*?)\]/);
                const cornerStr = String(sItem?.corner || '').trim();
                const inferredLan = bracketMatch
                  ? `${bracketMatch[1].trim()} dub`
                  : cornerStr
                    ? `${cornerStr} dub`
                    : 'Original Audio';
                if (sId) rawDubs.push({ subjectId: sId, lanName: inferredLan, detailPath: sSlug });
              }
            }
          }
        } catch {
          // ignore
        }
      }
    }

    const dubs: MovieDubOption[] = [];
    const seenDubIds = new Set<string>();
    for (const d of rawDubs) {
      const dId = String(d?.subjectId || '').trim();
      const dLabel = String(d?.lanName || '').trim();
      if (!dId || !dLabel || seenDubIds.has(dId)) continue;
      seenDubIds.add(dId);
      const dSlug = String(d?.detailPath || detailPath).trim();
      dubs.push({
        id: dId,
        label: dLabel,
        lanCode: String(d?.lanCode || '').trim(),
        path: `/mb/${dId}/${dSlug}`,
        active: dId === subjectId,
      });
    }

    dubs.sort((a, b) => {
      const rank = (opt: MovieDubOption) => {
        if (opt.active) return 100;
        const l = opt.label.toLowerCase();
        if (l.includes('hindi')) return 90;
        if (l.includes('bengali') || l.includes('bangla')) return 85;
        if (l.includes('original') || l.includes('english')) return 80;
        if (l.includes('dub')) return 70;
        return 40;
      };
      return rank(b) - rank(a);
    });

    const activeDubObj = dubs.find((d) => d.id === subjectId);
    let language = activeDubObj?.label || '';
    if (!language) {
      if (/\[hindi\]|\bhindi\s*dub/i.test(title)) language = 'Hindi dub';
      else if (/\[bengali\]|\[bangla\]|\bbangla\s*dub/i.test(title)) language = 'Bangla dub';
      else if (/\[tamil\]/i.test(title)) language = 'Tamil dub';
      else if (/\[telugu\]/i.test(title)) language = 'Telugu dub';
      else if (/\[malayalam\]/i.test(title)) language = 'Malayalam dub';
      else if (dubs.length > 0) language = dubs[0].label;
      else language = 'Original Audio';
    }

    if (dubs.length === 0) {
      dubs.push({ id: subjectId, label: language, path: rawPath, active: true });
    } else if (!dubs.some((d) => d.active)) {
      dubs.unshift({ id: subjectId, label: language, path: rawPath, active: true });
    }

    const seasonsList = Array.isArray(resource.seasons) ? resource.seasons : [];
    const isMovieType =
      (subjectType === 1 && ep1Play.sources.length === 0) ||
      seasonsList.length === 0 ||
      (seasonsList.length === 1 && Number(seasonsList[0]?.se) === 0);

    const episodes: EpisodeItem[] = [];
    let downloadButtons: DirectDownloadButton[] = [];

    if (isMovieType) {
      const sources = (moviePlay.sources.length > 0 ? moviePlay.sources : ep1Play.sources).map(
        (s) => ({
          ...s,
          audio: language,
          audioLanguages: [language],
          name: `${title} (${s.quality}p MP4)`,
        })
      );
      downloadButtons = moviePlay.buttons.length > 0 ? moviePlay.buttons : ep1Play.buttons;
      if (sources.length > 0) {
        episodes.push({
          id: `mb-movie-${subjectId}`,
          label: 'Full Movie (MovieBox HD)',
          number: 1,
          rangeStart: 1,
          rangeEnd: 1,
          season: null,
          kind: 'movie',
          sources,
        });
      }
    } else {
      const parseSeasonEpNums = (sObj: any): number[] => {
        const maxEp = Math.max(1, Number(sObj?.maxEp) || 1);
        const fromAllEp = String(sObj?.allEp || '')
          .split(',')
          .map((x) => parseInt(x.trim(), 10))
          .filter((n) => !Number.isNaN(n) && n > 0);
        return fromAllEp.length > 0
          ? fromAllEp
          : Array.from({ length: maxEp }, (_, idx) => idx + 1);
      };

      for (let sIdx = 0; sIdx < seasonsList.length; sIdx++) {
        const sObj = seasonsList[sIdx];
        const seNum = Number(sObj?.se) || sIdx + 1;
        const epNums = parseSeasonEpNums(sObj);

        for (const epNum of epNums) {
          if (seNum === 1 && epNum === 1 && ep1Play.sources.length > 0) {
            if (downloadButtons.length === 0) downloadButtons = ep1Play.buttons;
            episodes.push({
              id: `mb-ep-${subjectId}-s${seNum}-e${epNum}`,
              label: `S${String(seNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')} • Episode ${epNum}`,
              number: epNum,
              rangeStart: epNum,
              rangeEnd: epNum,
              season: seNum,
              kind: 'episode',
              sources: ep1Play.sources.map((s) => ({
                ...s,
                audio: language,
                audioLanguages: [language],
                name: `${title} - S${seNum}E${epNum} (${s.quality}p MP4)`,
              })),
            });
          } else {
            const dynamicStreamUrl = `/api/mb-ep-stream.mp4?subjectId=${encodeURIComponent(
              subjectId
            )}&detailPath=${encodeURIComponent(detailPath)}&se=${seNum}&ep=${epNum}`;
            episodes.push({
              id: `mb-ep-${subjectId}-s${seNum}-e${epNum}`,
              label: `S${String(seNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')} • Episode ${epNum}`,
              number: epNum,
              rangeStart: epNum,
              rangeEnd: epNum,
              season: seNum,
              kind: 'episode',
              sources: [
                {
                  id: `mb-lazy-${subjectId}-s${seNum}-e${epNum}-720`,
                  quality: 720,
                  qualityLabel: '720p HD (MovieBox Direct)',
                  audio: language,
                  audioLanguages: [language],
                  provider: 'MovieBox HD 720p',
                  url: `${dynamicStreamUrl}&q=720`,
                  downloadUrl: `${dynamicStreamUrl}&q=720&dl=1`,
                  type: 'mp4',
                  name: `${title} - S${seNum}E${epNum} (720p)`,
                },
                {
                  id: `mb-lazy-${subjectId}-s${seNum}-e${epNum}-480`,
                  quality: 480,
                  qualityLabel: '480p Fast (MovieBox Direct)',
                  audio: language,
                  audioLanguages: [language],
                  provider: 'MovieBox HD 480p',
                  url: `${dynamicStreamUrl}&q=480`,
                  downloadUrl: `${dynamicStreamUrl}&q=480&dl=1`,
                  type: 'mp4',
                  name: `${title} - S${seNum}E${epNum} (480p)`,
                },
                {
                  id: `mb-lazy-${subjectId}-s${seNum}-e${epNum}-1080`,
                  quality: 1080,
                  qualityLabel: '1080p Full HD (MovieBox Direct)',
                  audio: language,
                  audioLanguages: [language],
                  provider: 'MovieBox HD 1080p',
                  url: `${dynamicStreamUrl}&q=1080`,
                  downloadUrl: `${dynamicStreamUrl}&q=1080&dl=1`,
                  type: 'mp4',
                  name: `${title} - S${seNum}E${epNum} (1080p)`,
                },
              ],
            });
          }
        }
      }
    }

    const cast: CastMember[] = (Array.isArray(subject.staffList) ? subject.staffList : stars)
      .slice(0, 12)
      .map((s: any) => ({
        url: `/search?q=${encodeURIComponent(String(s?.name || ''))}`,
        photo: String(s?.avatarUrl || s?.avatar || ''),
        name: String(s?.name || 'Actor'),
        role: String(s?.character || s?.role || 'Cast'),
      }));

    return {
      title,
      url: rawPath,
      poster,
      qualityNote: `1080p / 720p / 480p • ${language}`,
      typeBadge: subjectType === 2 ? 'SERIES' : 'MOVIE',
      language,
      quality: '1080p FHD',
      genre,
      resolution: '1080p | 720p | 480p | 360p',
      releaseDate,
      storyline,
      youtubeTrailerId: '',
      screenshots: subject.stills?.url ? [String(subject.stills.url)] : [],
      episodes,
      downloadButtons,
      cast,
      dubs,
      uploadedBy,
      communityScore: {
        recommendedPercent: Math.min(99, Math.max(75, Math.round(ratingVal * 10))),
        totalVotes: Number(subject.imdbRatingCount) || 1420,
        verdict: 'MovieBox HD Verified',
      },
    };
  } catch {
    return null;
  }
}

export async function universalApiFetch(endpoint: string, init?: RequestInit): Promise<any> {
  const parsedUrl = new URL(endpoint, 'https://cinepulse.local');
  const pathname = parsedUrl.pathname;

  const isGitHubPages =
    typeof window !== 'undefined' && window.location.hostname.endsWith('github.io');

  // 0. Instant 0ms local memory / static-db / shard check for /api/details before any network fetch!
  if (pathname === '/api/details' && parsedUrl.searchParams.get('enrich') !== '1') {
    const rawPath = (parsedUrl.searchParams.get('path') || '').trim();
    const rawTitle = (parsedUrl.searchParams.get('title') || '').trim();
    const instant = getInstantCachedDetail(rawPath, rawTitle);
    if (instant && instant.episodes && instant.episodes.length > 0) {
      return { ok: true, cached: true, detail: instant };
    }
    const shardHit = await loadShardForMovie(rawPath, rawTitle);
    if (shardHit && shardHit.episodes && shardHit.episodes.length > 0) {
      return { ok: true, cached: true, detail: shardHit };
    }
    const existingPromise = rawPath ? inFlightDetailPromises.get(rawPath) : undefined;
    if (existingPromise) {
      const joined = await existingPromise;
      if (joined?.ok && joined?.detail) {
        return joined;
      }
    }
  }

  // 0b. Instant 0ms catalog check from pre-loaded static-db.json (for static GitHub Pages!)
  if (isGitHubPages && pathname === '/api/catalog' && parsedUrl.searchParams.get('refresh') !== '1') {
    const rawPath = parsedUrl.searchParams.get('path') || '/';
    const page = Math.max(1, parseInt(parsedUrl.searchParams.get('page') || '1', 10));
    const search = (parsedUrl.searchParams.get('q') || '').trim();
    const nodeId = parsedUrl.searchParams.get('node') || 'node-moviebox';
    if (!search && loadedStaticDb?.catalogs) {
      const cleanBase = rawPath === '/' ? '' : rawPath.replace(/\/+$/, '');
      const pageKey = page > 1 ? `${cleanBase}/page/${page}` : rawPath;
      const snap = loadedStaticDb.catalogs[pageKey];
      if (snap && snap.length > 0) {
        const sorted =
          rawPath === '/hot-dhamaka' || rawPath === '/'
            ? sortItemsByHotAndHype(snap)
            : rawPath === '/new-uploads' || rawPath === '/new-releases'
              ? sortItemsByRecentUpload(snap)
              : normalizeMovieCardList(snap);
        scheduleBackgroundCatalogDetailWarmup(sorted, nodeId);
        return {
          ok: true,
          cached: true,
          items: sorted,
          page,
          maxPage: 520,
          activeNodeId: nodeId,
        };
      }
    }
  }

  // 1. Unified Server API + Direct Browser MovieBox Geo-IP Engine in Parallel!
  if (!isGitHubPages) {
    const searchQ = (parsedUrl.searchParams.get('q') || '').trim();
    const pageNum = Math.max(1, parseInt(parsedUrl.searchParams.get('page') || '1', 10) || 1);

    if (pathname === '/api/catalog' && parsedUrl.searchParams.get('refresh') !== '1') {
      const cKey = `api::${parsedUrl.searchParams.get('path') || '/'}::p=${parsedUrl.searchParams.get('page') || '1'}::q=${searchQ}::n=${parsedUrl.searchParams.get('node') || 'auto'}`;
      const cHit = clientCatalogCache.get(cKey);
      if (cHit && Date.now() - cHit.ts < 60_000 && cHit.items.length > 0) {
        return {
          ok: true,
          cached: true,
          items: cHit.items,
          page: pageNum,
          maxPage: cHit.maxPage,
          activeNodeId: parsedUrl.searchParams.get('node') || 'node-moviebox',
        };
      }
    }

    // Launch direct browser-side MovieBox search or detail fetch in parallel so user's local Bangladesh/India Geo-IP unlocks all Hindi/Bangla dubs and seasons!
    const browserSearchPromise =
      (pathname === '/api/catalog' || pathname === '/api/suggest') && searchQ.length >= 2
        ? fetchBrowserMovieBoxSearch(searchQ, pageNum)
        : Promise.resolve([] as MovieCardItem[]);

    const detailRawPath =
      pathname === '/api/details' ? (parsedUrl.searchParams.get('path') || '').trim() : '';
    const browserDetailPromise =
      detailRawPath.startsWith('/mb/')
        ? fetchBrowserMovieBoxDetail(detailRawPath)
        : Promise.resolve(null);

    try {
      const [res, browserSearchItems, browserDetail] = await Promise.all([
        fetch(endpoint, init),
        browserSearchPromise,
        browserDetailPromise,
      ]);
      const contentType = res.headers.get('content-type') || '';
      if (res.ok && contentType.includes('application/json')) {
        const json = await res.json();
        if (pathname === '/api/suggest' && browserSearchItems.length > 0) {
          const mergedSuggest = deduplicateMovieCards([
            ...browserSearchItems,
            ...(Array.isArray(json?.items) ? json.items : []),
          ]).slice(0, 18);
          return { ...json, ok: true, items: mergedSuggest, suggestions: mergedSuggest };
        }
        // Merge browser-side local Geo-IP detail (seasons, dubs, uploadBy) with server detail!
        if (json?.detail) {
          if (browserDetail) {
            // Merge dubs from both browser (local Geo-IP) and server
            const mergedDubsMap = new Map<string, MovieDubOption>();
            for (const d of [...(browserDetail.dubs || []), ...(json.detail.dubs || [])]) {
              if (d?.id && !mergedDubsMap.has(d.id)) {
                mergedDubsMap.set(d.id, d);
              }
            }
            const mergedDubs = Array.from(mergedDubsMap.values());
            if (mergedDubs.length > 0) {
              json.detail.dubs = mergedDubs;
            }
            if (browserDetail.episodes.length > (json.detail.episodes?.length || 0)) {
              json.detail.episodes = browserDetail.episodes;
            }
            if (browserDetail.uploadedBy && browserDetail.uploadedBy !== 'MarieNo Ess') {
              json.detail.uploadedBy = browserDetail.uploadedBy;
            }
            if (browserDetail.poster) json.detail.poster = browserDetail.poster;
            if (browserDetail.storyline) json.detail.storyline = browserDetail.storyline;
            if (browserDetail.title && browserDetail.title !== 'MovieBox Title') {
              json.detail.title = browserDetail.title;
            }
            if (browserDetail.language) json.detail.language = browserDetail.language;
          }
          for (const ep of json.detail.episodes || []) {
            for (const src of ep.sources || []) {
              if (src.downloadUrl) src.downloadUrl = resolveDirectDownloadUrl(src.downloadUrl);
            }
          }
          for (const btn of json.detail.downloadButtons || []) {
            if (btn.url) btn.url = resolveDirectDownloadUrl(btn.url);
          }
          if (json.detail.url) {
            clientDetailCache.set(json.detail.url, { detail: json.detail, ts: Date.now() });
            indexDetailsIntoMemory({ [json.detail.url]: json.detail }, true);
          }
          warmDetailFirstStream(json.detail);
        } else if (pathname === '/api/catalog' && Array.isArray(json?.items)) {
          if (browserSearchItems.length > 0) {
            json.items = deduplicateMovieCards([...browserSearchItems, ...json.items]);
          }
          if (json.items.length > 0) {
            const cKey = `api::${parsedUrl.searchParams.get('path') || '/'}::p=${parsedUrl.searchParams.get('page') || '1'}::q=${searchQ}::n=${parsedUrl.searchParams.get('node') || 'auto'}`;
            clientCatalogCache.set(cKey, {
              items: json.items,
              maxPage: Number(json.maxPage) || 2500,
              ts: Date.now(),
            });
            if (json.prefetchedDetails && typeof json.prefetchedDetails === 'object') {
              indexDetailsIntoMemory(json.prefetchedDetails, true);
              for (const [detPath, detVal] of Object.entries(json.prefetchedDetails)) {
                if (detVal && (detVal as MovieDetailData).episodes?.length) {
                  clientDetailCache.set(detPath, {
                    detail: detVal as MovieDetailData,
                    ts: Date.now(),
                  });
                }
              }
            }
            scheduleBackgroundCatalogDetailWarmup(
              json.items,
              parsedUrl.searchParams.get('node') || 'node-moviebox'
            );
          }
        }
        return json;
      }
      if (browserDetail && browserDetail.episodes.length > 0) {
        clientDetailCache.set(detailRawPath, { detail: browserDetail, ts: Date.now() });
        return { ok: true, detail: browserDetail };
      }
    } catch {
      // fallback to client engine
    }
  }

  // 2. Built-in Serverless Browser Mirror & Snapshot Engine (100% standalone on GitHub Pages)
  const staticDb = await loadStaticDb();

  if (pathname === '/api/categories') {
    return {
      categories: ALL_CATEGORIES,
      nodes: [
        { id: 'node-moviebox', name: 'MovieBox HD', region: 'Global 4K/1080p Hub' },
      ],
    };
  }

  if (pathname === '/api/server-health') {
    return {
      ok: true,
      nodes: [
        { id: 'node-moviebox', name: 'MovieBox HD', region: 'Global 4K/1080p Hub', latencyMs: 24, online: true },
      ],
    };
  }

  if (pathname === '/api/suggest') {
    const q = (parsedUrl.searchParams.get('q') || '').trim();
    if (q.length < 1) return { ok: true, items: [], suggestions: [] };

    const lower = q.toLowerCase();
    const pool: MovieCardItem[] = [];
    const seen = new Set<string>();
    const allLists = [
      ...Array.from(clientCatalogCache.values()).map((c) => c.items),
      ...Object.values(staticDb?.catalogs || {}),
      ...Object.values(INITIAL_FALLBACK_MOVIES),
    ];
    for (const list of allLists) {
      for (const item of list) {
        if (!seen.has(item.path) && item.title.toLowerCase().includes(lower)) {
          seen.add(item.path);
          pool.push(item);
        }
      }
    }

    const interleaveSites = (itemsList: MovieCardItem[]): MovieCardItem[] => {
      const mb = itemsList.filter((i) => i.path?.startsWith('/mb/'));
      const mf = itemsList.filter((i) => i.path?.startsWith('/mf/'));
      const mlbd = itemsList.filter(
        (i) => !i.path?.startsWith('/mb/') && !i.path?.startsWith('/mf/')
      );
      const out: MovieCardItem[] = [];
      const maxLen = Math.max(mb.length, mlbd.length, mf.length);
      for (let i = 0; i < maxLen; i++) {
        if (i < mb.length) out.push(mb[i]);
        if (i < mlbd.length) out.push(mlbd[i]);
        if (i < mf.length) out.push(mf[i]);
      }
      return deduplicateMovieCards(out);
    };

    const nodeId = parsedUrl.searchParams.get('node') || 'node-alpha';
    try {
      const { html } = await fetchMirrorHtmlClientSide(`/search?q=${encodeURIComponent(q)}`, nodeId);
      const { items } = parseClientCatalogHtml(html);
      const merged = interleaveSites([...items, ...pool]).slice(0, 16);
      return { ok: true, items: merged, suggestions: merged };
    } catch {
      const top = interleaveSites(pool).slice(0, 16);
      return { ok: true, items: top, suggestions: top };
    }
  }

  if (pathname === '/api/catalog') {
    const rawPath = parsedUrl.searchParams.get('path') || '/';
    const page = Math.max(1, parseInt(parsedUrl.searchParams.get('page') || '1', 10));
    const search = (parsedUrl.searchParams.get('q') || '').trim();
    const nodeId = parsedUrl.searchParams.get('node') || 'node-alpha';
    const forceRefresh = parsedUrl.searchParams.get('refresh') === '1';

    const isNewUploadsView = rawPath === '/new-uploads';
    const isNewReleasesView = rawPath === '/new-releases';
    const isHotDhamakaView = rawPath === '/hot-dhamaka';
    const isTrendingHomeView = rawPath === '/' || rawPath === '';

    let upstreamBase = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    if (isNewUploadsView || isNewReleasesView || isHotDhamakaView) {
      upstreamBase = '/';
    }

    let targetPath = upstreamBase;
    if (search) {
      targetPath = `/search?q=${encodeURIComponent(search)}`;
    } else if (page > 1) {
      const cleanBase = upstreamBase === '/' ? '' : upstreamBase.replace(/\/+$/, '');
      targetPath = `${cleanBase}/page/${page}`;
    }

    const cacheKey = `${rawPath}::p=${page}::q=${search}`;
    const memCached = clientCatalogCache.get(cacheKey);
    if (!forceRefresh && memCached && Date.now() - memCached.ts < 30_000) {
      scheduleBackgroundCatalogDetailWarmup(memCached.items, nodeId);
      return {
        ok: true,
        items: normalizeMovieCardList(memCached.items),
        page,
        maxPage: memCached.maxPage,
        activeNodeId: nodeId,
      };
    }

    // Helper to merge freshly scraped live items at the top of the pre-built snapshot
    // so 1-minute-old upstream uploads appear immediately on GitHub Pages without losing catalog depth!
    const mergeLiveWithSnapshot = (
      liveItems: MovieCardItem[],
      baseSnapshot?: MovieCardItem[]
    ): MovieCardItem[] => {
      if (!baseSnapshot || baseSnapshot.length === 0) return deduplicateMovieCards(liveItems);
      return deduplicateMovieCards([...liveItems, ...baseSnapshot]);
    };

    // Return pre-built snapshot immediately if available (including /page/2, /page/3, and all 42+ categories),
    // and refresh in background so initial load is < 50ms!
    const snapshotList = !search
      ? (page === 1 ? staticDb?.catalogs?.[rawPath] : undefined) ||
        staticDb?.catalogs?.[targetPath] ||
        (page === 1 ? staticDb?.catalogs?.[upstreamBase] : undefined)
      : undefined;
    if (snapshotList && snapshotList.length > 0 && !forceRefresh) {
      const finalizedSnapshot = isHotDhamakaView
        ? sortItemsByHotAndHype(snapshotList)
        : isNewUploadsView || isNewReleasesView
          ? sortItemsByRecentUpload(snapshotList)
          : isTrendingHomeView
            ? sortItemsByHotAndHype(snapshotList)
            : normalizeMovieCardList(snapshotList);
      scheduleBackgroundCatalogDetailWarmup(finalizedSnapshot, nodeId);
      // Trigger non-blocking live mirror refresh with cache-busting
      fetchMirrorHtmlClientSide(targetPath, nodeId, true)
        .then(({ html }) => {
          const parsed = parseClientCatalogHtml(html);
          if (parsed.items.length > 0) {
            const mergedRaw = mergeLiveWithSnapshot(parsed.items, snapshotList);
            const listToStore = isHotDhamakaView || isTrendingHomeView
              ? sortItemsByHotAndHype(mergedRaw)
              : isNewUploadsView || isNewReleasesView
                ? sortItemsByRecentUpload(mergedRaw)
                : normalizeMovieCardList(mergedRaw);
            clientCatalogCache.set(cacheKey, {
              items: listToStore,
              maxPage: parsed.maxPage,
              ts: Date.now(),
            });
          }
        })
        .catch(() => {});

      return {
        ok: true,
        items: finalizedSnapshot,
        page,
        maxPage: 520,
        activeNodeId: nodeId,
      };
    }

    const collectLocalSearchMatches = (query: string): MovieCardItem[] => {
      const lower = query.toLowerCase();
      const matched: MovieCardItem[] = [];
      const seen = new Set<string>();
      for (const list of [
        ...Array.from(clientCatalogCache.values()).map((c) => c.items),
        ...Object.values(staticDb?.catalogs || {}),
        ...Object.values(INITIAL_FALLBACK_MOVIES),
      ]) {
        for (const item of list) {
          if (!seen.has(item.path) && item.title.toLowerCase().includes(lower)) {
            seen.add(item.path);
            matched.push(item);
          }
        }
      }
      return matched;
    };

    try {
      const { html } = await fetchMirrorHtmlClientSide(targetPath, nodeId, true);
      const { items: rawLiveItems, maxPage } = parseClientCatalogHtml(html);
      const localSearchMatches = search ? collectLocalSearchMatches(search) : [];
      const rawItems = search
        ? deduplicateMovieCards([...rawLiveItems, ...localSearchMatches])
        : mergeLiveWithSnapshot(rawLiveItems, snapshotList);
      let items = isHotDhamakaView || isTrendingHomeView
        ? sortItemsByHotAndHype(rawItems)
        : isNewUploadsView || isNewReleasesView
          ? sortItemsByRecentUpload(rawItems)
          : normalizeMovieCardList(rawItems);
      if (isNewReleasesView) {
        const filtered = items.filter((i) => i.title.includes('2026') || i.title.includes('2025'));
        if (filtered.length >= 6) items = filtered;
      }
      if (items.length > 0) {
        clientCatalogCache.set(cacheKey, { items, maxPage, ts: Date.now() });
        scheduleBackgroundCatalogDetailWarmup(items, nodeId);
        return { ok: true, items, page, maxPage, activeNodeId: nodeId };
      }
    } catch {
      // fallback
    }

    if (search) {
      const matched = collectLocalSearchMatches(search);
      const normMatched = normalizeMovieCardList(deduplicateMovieCards(matched));
      return { ok: true, items: normMatched, page: 1, maxPage: 1, activeNodeId: nodeId };
    }

    const fallbackList = sortItemsByRecentUpload(
      snapshotList || INITIAL_FALLBACK_MOVIES[rawPath] || INITIAL_FALLBACK_MOVIES['/'] || []
    );
    return { ok: true, items: fallbackList, page: 1, maxPage: 520, activeNodeId: nodeId };
  }

  if (pathname === '/api/details') {
    const rawPath = (parsedUrl.searchParams.get('path') || '').trim();
    const rawTitle = (parsedUrl.searchParams.get('title') || '').trim();
    const nodeId = parsedUrl.searchParams.get('node') || 'node-alpha';

    const attachRelatedSeasons = (detailObj: MovieDetailData): MovieDetailData => {
      if (detailObj.relatedSeasons && detailObj.relatedSeasons.length > 0) return detailObj;
      const baseSeriesName = extractBaseSeriesTitle(rawTitle || detailObj.title);
      if (baseSeriesName && baseSeriesName.length >= 3) {
        const baseLower = baseSeriesName.toLowerCase();
        const allKnownItems = Object.values(staticDb?.catalogs || {}).flat();
        const matchingSeasons = allKnownItems.filter((item) => {
          const itemBase = extractBaseSeriesTitle(item.title).toLowerCase();
          return (
            item.path !== detailObj.url &&
            (itemBase === baseLower ||
              item.title.toLowerCase().startsWith(baseLower) ||
              baseLower.startsWith(itemBase))
          );
        });
        if (matchingSeasons.length > 0) {
          const uniqueSeasons: MovieCardItem[] = [];
          const seenS = new Set<string>();
          for (const s of matchingSeasons) {
            if (!seenS.has(s.path)) {
              seenS.add(s.path);
              uniqueSeasons.push(s);
            }
          }
          return { ...detailObj, relatedSeasons: uniqueSeasons.slice(0, 12) };
        }
      }
      return detailObj;
    };

    const isLiveEnrich = parsedUrl.searchParams.get('enrich') === '1';

    // 1. Check in-memory decrypted cache first (unless live enrich is requested)
    const cachedDetail = clientDetailCache.get(rawPath);
    if (!isLiveEnrich && cachedDetail && Date.now() - cachedDetail.ts < 60_000) {
      return { ok: true, detail: attachRelatedSeasons(cachedDetail.detail) };
    }

    // 2. Live fetch & cipher decrypt in browser (with cache-busting when isLiveEnrich is true)
    try {
      let { html, finalOrigin } = await fetchMirrorHtmlClientSide(
        rawPath || '/',
        nodeId,
        isLiveEnrich
      );
      if (!html.includes('mlbdInlinePlayerData') && rawTitle) {
        const cleanQuery = extractBaseSeriesTitle(rawTitle)
          .split(/\s+/)
          .slice(0, 4)
          .join(' ');
        if (cleanQuery) {
          const searchRes = await fetchMirrorHtmlClientSide(
            `/search?q=${encodeURIComponent(cleanQuery)}`,
            nodeId
          );
          const { items } = parseClientCatalogHtml(searchRes.html);
          if (items.length > 0) {
            const resolved = await fetchMirrorHtmlClientSide(items[0].path, nodeId);
            html = resolved.html;
            finalOrigin = resolved.finalOrigin;
          }
        }
      }

      const detail = parseClientDetailHtml(html, rawPath, finalOrigin);

      // Multi-season & related episodes discovery from staticDb or live search
      const baseSeriesName = extractBaseSeriesTitle(rawTitle || detail.title);
      if (baseSeriesName && baseSeriesName.length >= 3) {
        const baseLower = baseSeriesName.toLowerCase();
        const allKnownItems = Object.values(staticDb?.catalogs || {}).flat();
        const matchingSeasons = allKnownItems.filter((item) => {
          const itemBase = extractBaseSeriesTitle(item.title).toLowerCase();
          return (
            item.path !== rawPath &&
            (itemBase === baseLower ||
              item.title.toLowerCase().startsWith(baseLower) ||
              baseLower.startsWith(itemBase))
          );
        });
        if (matchingSeasons.length > 0) {
          const uniqueSeasons: MovieCardItem[] = [];
          const seenS = new Set<string>();
          for (const s of matchingSeasons) {
            if (!seenS.has(s.path)) {
              seenS.add(s.path);
              uniqueSeasons.push(s);
            }
          }
          detail.relatedSeasons = uniqueSeasons.slice(0, 12);
        }
      }

      if (detail.episodes.length > 0 || detail.downloadButtons.length > 0) {
        clientDetailCache.set(rawPath, { detail, ts: Date.now() });
        return { ok: true, detail };
      }
    } catch {
      // fallback below
    }

    // 4. Fallback: check staticDb by fuzzy title words (never return an unrelated movie!)
    const instantFallback = getInstantCachedDetail(rawPath, rawTitle);
    if (instantFallback && instantFallback.episodes?.length) {
      return { ok: true, detail: attachRelatedSeasons(instantFallback) };
    }

    return { ok: false, error: 'Unable to load stream metadata' };
  }

  if (pathname === '/api/mb-home') {
    const staticDb = await loadStaticDb();
    const homeItems = staticDb?.catalogs?.['/'] || INITIAL_FALLBACK_MOVIES['/'] || [];
    return {
      ok: true,
      banners: homeItems.slice(0, 8),
      liveSports: [
        {
          id: 'sport-football-live',
          title: 'Football Live',
          bnTitle: 'ফুটবল লাইভ ম্যাচ (MovieBox Sports)',
          subtitle: 'UEFA Champions League • Premier League • LaLiga • FIFA Live',
          sportType: 'football',
          liveUrl: 'https://sportsnow.top/live?tab=live&sportType=football',
          categoryPath: '/fifa',
          badge: 'LIVE MATCH',
          accentColor: '#00e68a',
        },
        {
          id: 'sport-basketball-live',
          title: 'Basketball Live',
          bnTitle: 'বাস্কেটবল ও NBA লাইভ ম্যাচ',
          subtitle: 'NBA Playoffs • EuroLeague • FIBA Live Score & Stream',
          sportType: 'basketball',
          liveUrl: 'https://sportsnow.top/live?tab=live&sportType=basketball',
          categoryPath: '/category/sports',
          badge: 'NBA LIVE',
          accentColor: '#f59e0b',
        },
        {
          id: 'sport-wwe-wrestling',
          title: 'WWE & Combat Sports',
          bnTitle: 'ডব্লিউডব্লিউই রেসলিং ও ফাইট শো',
          subtitle: 'WrestleMania • RAW • SmackDown • Royal Rumble Full HD',
          sportType: 'wwe',
          liveUrl: 'https://sportsnow.top/live?tab=live&sportType=football',
          categoryPath: '/category/wwe',
          badge: 'WWE HD',
          accentColor: '#ef4444',
        },
      ],
      quickCategories: [
        {
          id: 'qc-hollywood',
          title: 'Hollywood',
          bnTitle: 'হলিউড মুভি',
          image: 'https://pbcdnw.aoneroom.com/image/2025/01/13/683063a45b61be3be1f9d7ef9b2d3072.png',
          path: '/language/english',
        },
        {
          id: 'qc-bollywood',
          title: 'Bollywood',
          bnTitle: 'বলিউড হিন্দি',
          image: 'https://pbcdnw.aoneroom.com/image/2025/01/13/95be398605ce21b60efbe7e7a5bf9fc2.png',
          path: '/bollywood',
        },
        {
          id: 'qc-bengali',
          title: 'Bengali Movies',
          bnTitle: 'বাংলা মুভি ও নাটক',
          image: 'https://pub-69b6234af505413bbeac2bbc8039195c.r2.dev/poster_4g8viv1792499980.jpg',
          path: '/language/bangla',
        },
        {
          id: 'qc-south',
          title: 'South Indian',
          bnTitle: 'সাউথ ইন্ডিয়ান',
          image: 'https://pub-69b6234af505413bbeac2bbc8039195c.r2.dev/poster_06g5z71792073020.jpg',
          path: '/southIndian',
        },
      ],
      comingSoon: [],
      sections: [],
    };
  }

  if (pathname === '/api/requests') {
    const STORAGE_KEY = 'cp_local_movie_requests_v1';
    const defaultReqs = [
      {
        id: 'req-1',
        title: 'Pushpa 2: The Rule [Bangla Dubbed 4K]',
        type: 'MOVIE',
        language: 'Bangla Dubbed',
        notes: 'Full HD 1080p Dual Audio version',
        status: 'Processing',
        createdAt: Date.now() - 3600_000 * 5,
      },
      {
        id: 'req-2',
        title: 'Solo Leveling Season 2 [Hindi + Japanese Dual Audio]',
        type: 'ANIME',
        language: 'Dual Audio',
        notes: 'All episodes 1080p WEB-DL',
        status: 'Queued',
        createdAt: Date.now() - 3600_000 * 2,
      },
    ];

    let savedReqs = defaultReqs;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) savedReqs = parsed;
      }
    } catch {
      // ignore
    }

    if (init?.method === 'POST' && init.body) {
      try {
        const bodyObj = JSON.parse(String(init.body));
        const newReq = {
          id: `req-${Date.now()}`,
          title: sanitizeBrandText(String(bodyObj.title || '')),
          type: bodyObj.type || 'MOVIE',
          language: sanitizeBrandText(String(bodyObj.language || 'Bangla / Dual Audio')),
          notes: sanitizeBrandText(String(bodyObj.notes || '')),
          status: 'Queued',
          createdAt: Date.now(),
        };
        const updated = [newReq, ...savedReqs].slice(0, 25);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
        return { ok: true, request: newReq, requests: updated };
      } catch {
        // ignore
      }
    }

    return { ok: true, requests: savedReqs };
  }

  if (pathname === '/api/notifications' || pathname === '/api/notifications/broadcast') {
    const now = Date.now();
    const staticDb = await loadStaticDb();
    const pool: MovieCardItem[] = [];
    const seenPaths = new Set<string>();

    for (const entry of clientCatalogCache.values()) {
      for (const rawItem of entry.items.slice(0, 20)) {
        if (rawItem.isAdult || seenPaths.has(rawItem.path)) continue;
        seenPaths.add(rawItem.path);
        pool.push(normalizeMovieCardItem(rawItem, now));
      }
    }
    if (staticDb?.catalogs) {
      for (const [catKey, list] of Object.entries(staticDb.catalogs)) {
        if (catKey.includes('adult18plus') || !Array.isArray(list)) continue;
        for (const rawItem of list.slice(0, 20)) {
          if (rawItem.isAdult || seenPaths.has(rawItem.path)) continue;
          seenPaths.add(rawItem.path);
          pool.push(normalizeMovieCardItem(rawItem, now));
        }
      }
    }
    if (pool.length < 10) {
      for (const rawItem of INITIAL_FALLBACK_MOVIES['/'] || []) {
        if (rawItem.isAdult || seenPaths.has(rawItem.path)) continue;
        seenPaths.add(rawItem.path);
        pool.push(normalizeMovieCardItem(rawItem, now));
      }
    }

    const recentUploads = sortItemsByRecentUpload(pool, now).slice(0, 12);
    const topRatedPopular = sortItemsByHighRating(pool, now).slice(0, 12);
    const notifications: GlobalMovieNotification[] = [];
    const maxLen = Math.max(recentUploads.length, topRatedPopular.length);

    for (let i = 0; i < maxLen; i++) {
      const newItem = recentUploads[i];
      if (newItem) {
        const mins = getItemMinutesAgo(newItem, i, now);
        const ratingNum = parseFloat(newItem.rating || '8.7') || 8.7;
        const isEp = Boolean(newItem.episodePill);
        notifications.push({
          id: `notif-new-${newItem.id}`,
          category: 'NEW_UPLOAD',
          badgeText: isEp ? `নতুন এপিসোড • ${newItem.episodePill}` : 'নতুন মুভি আপলোড 🔥',
          headlineBn: isEp
            ? `নতুন এপিসোড আপলোড হয়েছে: ${newItem.title}`
            : `নতুন মুভি আপলোড হয়েছে: ${newItem.title}`,
          subtitleBn: `${newItem.language || 'Multi Audio'} • ${newItem.quality || '1080p HD'} • রেটিং ★ ${ratingNum.toFixed(1)} • ${newItem.timeAgo}`,
          movie: newItem,
          createdAt: Math.max(now - mins * 60_000, now - 24 * 3600_000),
          ratingScore: ratingNum,
        });
      }
      const popItem = topRatedPopular[i];
      if (popItem) {
        const ratingNum = Math.max(8.4, parseFloat(popItem.rating || '9.1') || 9.1);
        notifications.push({
          id: `notif-pop-${popItem.id}`,
          category: 'TOP_RATED_POPULAR',
          badgeText: `জনপ্রিয় • রেটিং ★ ${ratingNum.toFixed(1)}`,
          headlineBn: `সবার পছন্দের জনপ্রিয় ও হাই-রেটিং মুভি: ${popItem.title}`,
          subtitleBn: `রেটিং ★ ${ratingNum.toFixed(1)}/10 • ${popItem.views || '250K+'} ভিউ • ${popItem.language || 'Dual Audio'} • ${popItem.quality || 'Full HD'}`,
          movie: popItem,
          createdAt: now - (i + 1) * 180_000,
          ratingScore: ratingNum,
        });
      }
    }

    return {
      ok: true,
      serverTime: now,
      notifications: notifications.slice(0, 28),
    };
  }

  if (pathname === '/api/myflix') {
    return { ok: false };
  }

  return { ok: true, requests: [] };
}

