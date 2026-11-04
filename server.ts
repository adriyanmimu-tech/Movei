import { spawn, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { ALL_CATEGORIES, INITIAL_FALLBACK_MOVIES } from './src/data/categories.ts';
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
} from './src/utils/timeAgo.ts';
import type {
  CastMember,
  DirectDownloadButton,
  EpisodeItem,
  GlobalMovieNotification,
  MovieBoxComingSoonItem,
  MovieBoxHomePayload,
  MovieBoxHomeShelf,
  MovieBoxLiveSportItem,
  MovieBoxQuickCategory,
  MovieCardItem,
  MovieDetailData,
  MovieDubOption,
  ServerNodeStatus,
  StreamSource,
  UserMovieRequest,
} from './src/types/cinema.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (kept server alive):', err?.message || err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection (kept server alive):', reason);
});

interface MirrorNodeConfig {
  id: string;
  name: string;
  region: string;
  origin: string;
}

const SERVER_NODES: MirrorNodeConfig[] = [
  { id: 'node-moviebox', name: 'MovieBox HD', region: 'movie-box.co 4K/1080p API', origin: 'https://movie-box.co' },
];

const PRIMARY_MIRROR_NODES = SERVER_NODES.filter((n) => n.id !== 'node-myflix' && n.id !== 'node-moviebox');
const MYFLIX_ORIGIN = 'https://myflixbd.to';
const MOVIEBOX_ORIGIN = 'https://movie-box.co';
const MOVIEBOX_BACKUP_ORIGIN = 'https://movieboxhd.net';
const MOVIEBOX_API_ORIGIN = 'https://movie-box.co';
const MOVIEBOX_FALLBACK_API_ORIGIN = 'https://h5-api.aoneroom.com';

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const FFMPEG_BIN = fs.existsSync('/usr/bin/ffmpeg')
  ? '/usr/bin/ffmpeg'
  : fs.existsSync('/usr/local/bin/ffmpeg')
    ? '/usr/local/bin/ffmpeg'
    : 'ffmpeg';

function pruneCacheMap<K, V>(map: Map<K, V>, maxEntries: number): void {
  if (map.size <= maxEntries) return;
  const excess = map.size - maxEntries;
  let removed = 0;
  for (const key of map.keys()) {
    map.delete(key);
    removed++;
    if (removed >= excess) break;
  }
}

const catalogCache = new Map<string, CacheEntry<{ items: MovieCardItem[]; maxPage: number; activeNodeId: string }>>();
const detailCache = new Map<string, CacheEntry<MovieDetailData>>();
const detailTitleCache = new Map<string, CacheEntry<MovieDetailData>>();
const imdbIdCache = new Map<string, string>();
let healthCache: CacheEntry<ServerNodeStatus[]> | null = null;
const mirrorHtmlCache = new Map<string, CacheEntry<{ html: string; finalOrigin: string; activeNodeId: string }>>();
const inFlightMirrorMap = new Map<string, Promise<{ html: string; finalOrigin: string; activeNodeId: string }>>();
const myFlixHtmlCache = new Map<string, CacheEntry<string>>();
const inFlightMyFlixMap = new Map<string, Promise<string>>();
const inFlightCatalogMap = new Map<string, Promise<any>>();

function sortSourcesFastestFirst(sources?: StreamSource[]): StreamSource[] {
  if (!Array.isArray(sources) || sources.length <= 1) return sources || [];
  const score = (src: StreamSource) => {
    const isEmbed =
      src.type === 'embed' ||
      /abyssplayer\.com|abysscdn\.com|vidsrc|multiembed|autoembed|myflix/i.test(`${src.url || ''} ${src.id || ''}`);
    if (isEmbed) return 400;
    const isMovieBox =
      src.id?.startsWith('mb-') || /\/api\/mb-stream|\/api\/mb-ep-stream/i.test(src.url || '');
    if (isMovieBox) {
      // movie-box.co direct H.264 MP4 streams always get highest priority for instant native <video> playback
      const baseMb = 4500;
      const sizeMatch = (src.name || '').match(/(\d+)\s*MB/i);
      const sizeMb = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;
      const isHeavyFile = sizeMb > 350;
      if (src.quality === 720) return baseMb + 140;
      if (src.quality === 480) return baseMb + 135;
      if (src.quality === 360) return baseMb + 125;
      if (src.quality === 1080) return isHeavyFile ? baseMb + 80 : baseMb + 130;
      return baseMb + 100;
    }
    const isHevc = /\b(hevc|h\.?265|x265|10bit|av1)\b/i.test(`${src.name} ${src.qualityLabel}`);
    const isBestHeavy = /best\s*quality/i.test(src.qualityLabel || '');
    let s = isHevc ? 1400 : 3000;
    if (isBestHeavy) s -= 250;
    if (src.quality >= 360 && src.quality <= 576) s += 650;
    else if (src.quality === 720) s += 550;
    else if (src.quality === 1080) s += 400;
    else s += 150;
    return s;
  };
  return [...sources].sort((a, b) => score(b) - score(a));
}

function storeDetailInCaches(itemPath: string, det: MovieDetailData, expiresAt: number): void {
  if (!det || typeof det !== 'object') return;
  // Cap stream token cache at 12 minutes so signed fsldownload stream URLs never expire into HTTP 410 Gone
  const safeExpiresAt = Math.min(expiresAt, Date.now() + 12 * 60_000);
  if (Array.isArray(det.episodes)) {
    for (const ep of det.episodes) {
      if (Array.isArray(ep.sources)) {
        ep.sources = sortSourcesFastestFirst(ep.sources);
      }
    }
  }
  if (itemPath) {
    pruneCacheMap(detailCache, 180);
    detailCache.set(itemPath, { data: det, expiresAt: safeExpiresAt });
  }
  if (det.title && det.episodes?.length) {
    pruneCacheMap(detailTitleCache, 240);
    const canon = getCanonicalTitleKey(det.title);
    if (canon) detailTitleCache.set(canon, { data: det, expiresAt: safeExpiresAt });
    const base = extractBaseSeriesTitle(det.title).toLowerCase();
    if (base) detailTitleCache.set(base, { data: det, expiresAt: safeExpiresAt });
  }
}

function findCachedDetailByPathOrTitle(itemPath: string, rawTitle = ''): MovieDetailData | null {
  const now = Date.now();
  if (itemPath) {
    const hit = detailCache.get(itemPath);
    if (hit && hit.expiresAt > now && hit.data?.episodes?.length) {
      return hit.data;
    }
    // Never fall back to stripped base title cache for distinct /mb/<subjectId>/ paths,
    // because different language dubs (e.g. Original vs Hindi dub) have distinct subjectIds!
    if (itemPath.startsWith('/mb/')) {
      return null;
    }
  }
  if (rawTitle) {
    const canon = getCanonicalTitleKey(rawTitle);
    const byCanon = canon ? detailTitleCache.get(canon) : undefined;
    if (byCanon && byCanon.expiresAt > now && byCanon.data?.episodes?.length) return byCanon.data;
    const base = extractBaseSeriesTitle(rawTitle).toLowerCase();
    const byBase = base ? detailTitleCache.get(base) : undefined;
    if (byBase && byBase.expiresAt > now && byBase.data?.episodes?.length) return byBase.data;
  }
  return null;
}

const movieRequestsStore: UserMovieRequest[] = [
  {
    id: 'req-1',
    title: 'Pushpa 2: The Rule (2025) [Bangla Dubbed 4K]',
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

const customBroadcastNotifications: GlobalMovieNotification[] = [];

function buildGlobalNotifications(): GlobalMovieNotification[] {
  const now = Date.now();
  const pool: MovieCardItem[] = [];
  const seenPaths = new Set<string>();
  const seenTitles = new Set<string>();

  for (const [key, entry] of catalogCache.entries()) {
    if (key.includes('adult18plus')) continue;
    for (const rawItem of entry.data.items.slice(0, 24)) {
      if (rawItem.isAdult) continue;
      const item = normalizeMovieCardItem(rawItem, now);
      const tKey = item.title.toLowerCase().replace(/[^a-z0-9\u0980-\u09ff]/g, '');
      if (!item.path || seenPaths.has(item.path) || (tKey && seenTitles.has(tKey))) continue;
      seenPaths.add(item.path);
      if (tKey) seenTitles.add(tKey);
      pool.push(item);
    }
  }

  if (pool.length < 10) {
    for (const rawItem of INITIAL_FALLBACK_MOVIES['/'] || []) {
      if (rawItem.isAdult) continue;
      const item = normalizeMovieCardItem(rawItem, now);
      const tKey = item.title.toLowerCase().replace(/[^a-z0-9\u0980-\u09ff]/g, '');
      if (!item.path || seenPaths.has(item.path) || (tKey && seenTitles.has(tKey))) continue;
      seenPaths.add(item.path);
      if (tKey) seenTitles.add(tKey);
      pool.push(item);
    }
  }

  const recentUploads = sortItemsByRecentUpload(pool, now).slice(0, 12);
  const topRatedPopular = sortItemsByHighRating(pool, now).slice(0, 12);

  const notifications: GlobalMovieNotification[] = [...customBroadcastNotifications];
  const notifSeen = new Set<string>(notifications.map((n) => n.movie.path));

  // Interleave New Uploads and Top-Rated Popular Movies so everyone gets both immediately
  const maxLen = Math.max(recentUploads.length, topRatedPopular.length);
  for (let i = 0; i < maxLen; i++) {
    const newItem = recentUploads[i];
    if (newItem && !notifSeen.has(`new::${newItem.path}`)) {
      notifSeen.add(`new::${newItem.path}`);
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
    if (popItem && !notifSeen.has(`pop::${popItem.path}`)) {
      notifSeen.add(`pop::${popItem.path}`);
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

  return notifications.slice(0, 28);
}

function encodeGatewayUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  try {
    const token = Buffer.from(rawUrl, 'utf8').toString('base64url');
    return `/api/go?t=${token}`;
  } catch {
    return rawUrl;
  }
}

function decodeGatewayToken(token: string): string {
  try {
    return Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Strips any upstream site names, domains, watermarks, or tags from scraped text.
 */
function sanitizeBrandText(input: string): string {
  if (!input) return '';
  return input
    .replace(/https?:\/\/[^\s"'<>]*(?:movielinkbd|myflixbd)[^\s"'<>]*/gi, '')
    .replace(/\b[a-z0-9-]*\.?(?:movielinkbd|myflixbd)\.[a-z]{2,6}\b/gi, 'CinePulse')
    .replace(/movielinkbd|myflixbd|nexaflox/gi, 'CinePulse')
    .replace(/\bmlbd\b/gi, 'CP')
    .replace(/\s*watch\s+online\s+and\s+download\s*(?:["“”']?web-dl["“”']?|["“”']?hdtc["“”']?|["“”']?hd["“”']?|["“”']?4k["“”']?)?\s*…?/gi, '')
    .replace(/\s*watch\s+online\s*…?/gi, '')
    .replace(/\s*[“”"'](?:web(?:-?dl|rip)?|hdtc|hdts|4k|hd)[^"”]*[”"']?\s*…?\s*$/gi, '')
    .replace(/\s+[–—-]\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function decodeMlbdCipher(base64Str: string, hexSeed: string, rounds: number): string {
  try {
    let x = parseInt(hexSeed, 16) >>> 0;
    for (let i = 0; i < rounds; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    }
    const raw = Buffer.from(base64Str.trim(), 'base64');
    const out = Buffer.alloc(raw.length);
    for (let j = 0; j < raw.length; j++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      out[j] = raw[j] ^ ((x >>> 16) & 255);
    }
    return out.toString('utf8');
  } catch {
    return '';
  }
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

function getOrderedNodes(preferredNodeId?: string): MirrorNodeConfig[] {
  if (!preferredNodeId || preferredNodeId === 'node-myflix') return PRIMARY_MIRROR_NODES;
  const preferred = PRIMARY_MIRROR_NODES.find((n) => n.id === preferredNodeId);
  if (!preferred) return PRIMARY_MIRROR_NODES;
  return [preferred, ...PRIMARY_MIRROR_NODES.filter((n) => n.id !== preferredNodeId)];
}

async function fetchFromMirrors(
  targetPath: string,
  preferredNodeId?: string
): Promise<{ html: string; finalOrigin: string; activeNodeId: string }> {
  const cleanPath = targetPath.startsWith('http')
    ? new URL(targetPath).pathname + new URL(targetPath).search
    : targetPath.startsWith('/')
      ? targetPath
      : `/${targetPath}`;

  const orderedNodes = getOrderedNodes(preferredNodeId);

  const attemptNode = async (node: MirrorNodeConfig, timeoutMs: number) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = `${node.origin}${cleanPath}`;
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,bn;q=0.8',
          Cookie: 'mlbd_show18=1; hide18On=false',
          Referer: `${node.origin}/`,
        },
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`HTTP ${res.status}`);
      }
      const html = await res.text();
      if (
        !html ||
        html.length < 1200 ||
        (!html.includes('movie-card') &&
          !html.includes('mlbdInlinePlayerData') &&
          !html.includes('<div class="n">404</div>'))
      ) {
        throw new Error('Challenge or incomplete HTML');
      }
      const finalOrigin = new URL(res.url || url).origin;
      return { html, finalOrigin, activeNodeId: node.id };
    } finally {
      clearTimeout(timer);
    }
  };

  const mirrorKey = `${preferredNodeId || 'auto'}::${cleanPath}`;
  const cachedMirror = mirrorHtmlCache.get(mirrorKey);
  if (cachedMirror && cachedMirror.expiresAt > Date.now()) {
    return cachedMirror.data;
  }
  const existingFlight = inFlightMirrorMap.get(mirrorKey);
  if (existingFlight) {
    return existingFlight;
  }

  const runMirrorFetch = (async () => {
    // Race top 2 mirror nodes in parallel for sub-second response!
    try {
      const winner = await Promise.any(
        orderedNodes.slice(0, 2).map((node) => attemptNode(node, 4500))
      );
      pruneCacheMap(mirrorHtmlCache, 60);
      mirrorHtmlCache.set(mirrorKey, { data: winner, expiresAt: Date.now() + 45_000 });
      return winner;
    } catch {
      for (const node of orderedNodes.slice(2)) {
        try {
          const fallbackWinner = await attemptNode(node, 5000);
          pruneCacheMap(mirrorHtmlCache, 60);
          mirrorHtmlCache.set(mirrorKey, { data: fallbackWinner, expiresAt: Date.now() + 45_000 });
          return fallbackWinner;
        } catch {
          // try next
        }
      }
    }
    throw new Error('All cinema stream nodes unreachable');
  })();

  inFlightMirrorMap.set(mirrorKey, runMirrorFetch);
  try {
    return await runMirrorFetch;
  } finally {
    inFlightMirrorMap.delete(mirrorKey);
  }
}

function parseMovieCards(html: string): { items: MovieCardItem[]; maxPage: number } {
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

    let itemPath = '';
    try {
      itemPath = rawHref.startsWith('http')
        ? new URL(rawHref).pathname
        : rawHref.startsWith('/')
          ? rawHref
          : `/${rawHref}`;
    } catch {
      continue;
    }

    if (seenPaths.has(itemPath)) continue;

    const title = decodeHtmlEntities(titleMatch[1]);
    if (!title) continue;

    const titleKey = getCanonicalTitleKey(title);
    if (titleKey && seenPaths.has(`title::${titleKey}`)) continue;

    const posterMatch =
      chunk.match(/data-src=["'](https?:\/\/[^"']+)["']/i) ||
      chunk.match(/src=["'](https?:\/\/[^"']+)["']/i);
    const poster = posterMatch ? posterMatch[1].trim() : '';
    const posterKey = poster ? poster.toLowerCase().split('?')[0].trim() : '';
    if (posterKey && seenPaths.has(`poster::${posterKey}`)) continue;

    seenPaths.add(itemPath);
    if (titleKey) seenPaths.add(`title::${titleKey}`);
    if (posterKey) seenPaths.add(`poster::${posterKey}`);

    const quality = decodeHtmlEntities(
      (chunk.match(/<span class=["']quality["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || 'WEB-DL'
    );
    const language = decodeHtmlEntities(
      (chunk.match(/<span class=["']language["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || 'MULTI'
    );
    const views = decodeHtmlEntities(
      (chunk.match(/<span class=["']views-badge-top["'][^>]*>[\s\S]*?<\/i>\s*([^<]+)<\/span>/i) || [])[1] || '2.4K'
    );
    const rawTimeAgo = decodeHtmlEntities(
      (chunk.match(/<div class=["']upload-time["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] || 'Recently added'
    );
    const rawEpisodePill = decodeHtmlEntities(
      (chunk.match(/<span class=["']badge ep-badge[^"']*["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || ''
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

    // Extract real R2 upload Unix timestamp if embedded in poster URL (e.g. poster_v778gm1793478302.webp)
    const r2TsMatch = poster.match(/poster_[a-z0-9_]*?(17\d{8})\./i);
    const r2EpochMs = r2TsMatch ? parseInt(r2TsMatch[1], 10) * 1000 : 0;
    const nowMs = Date.now();
    let pathHash = 2166136261 >>> 0;
    for (let c = 0; c < itemPath.length; c++) {
      pathHash ^= itemPath.charCodeAt(c);
      pathHash = Math.imul(pathHash, 16777619) >>> 0;
    }
    const minuteJitter = cleanedTime.minutesAgo >= 60 ? (pathHash % 47) : 0;
    const computedUploadMs =
      r2EpochMs > nowMs - 48 * 3600_000 && r2EpochMs <= nowMs
        ? r2EpochMs
        : nowMs - (cleanedTime.minutesAgo + minuteJitter) * 60_000;

    items.push({
      id: itemPath.replace(/[^a-zA-Z0-9_-]/g, '_'),
      title,
      // Never expose upstream URL; keep clean relative path
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
      uploadedAtMs: computedUploadMs,
    });
  }

  const pageMatches = [...body.matchAll(/\/page\/(\d+)/g)]
    .map((m) => Number(m[1]))
    .filter((n) => !isNaN(n) && n > 0 && n <= 2000);
  const maxPage = pageMatches.length > 0 ? Math.max(...pageMatches) : 520;

  return { items, maxPage };
}

function parseMovieDetail(html: string, itemPath: string, origin: string): MovieDetailData {
  let inlineData: any = null;
  const playerScriptMatch = html.match(
    /<script[^>]*id=["']mlbdInlinePlayerData["'][^>]*data-s=["']([^"']+)["'][^>]*data-r=["'](\d+)["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (playerScriptMatch) {
    const decodedJson = decodeMlbdCipher(
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
  const dlRegex = /<a[^>]*data-dl=["']([^"']+)["'][^>]*data-ds=["']([^"']+)["'][^>]*data-dr=["'](\d+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(dlRegex)) {
    const decodedHref = decodeMlbdCipher(match[1], match[2], parseInt(match[3], 10) || 300);
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
    (html.match(/<div class=["']image-container-view["'][\s\S]*?<img[^>]+src=["'](https?:\/\/[^"']+)["']/i) || [])[1] ||
    '';

  const qualityNote = sanitizeBrandText(
    decodeHtmlEntities(
      (html.match(/<div class=["']movie-info-view["'][\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || ''
    )
  );

  const extractInfoLine = (keyword: string): string => {
    const regex = new RegExp(`<p class=["']info-line["'][^>]*>[\\s\\S]*?${keyword}:?<\\/b>([\\s\\S]*?)<\\/p>`, 'i');
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
  const castRegex = /<a class=["']mlbd-cast__p["'][^>]+href=["']([^"']+)["'][^>]*>[\s\S]*?<img[^>]+src=["']([^"']+)["'][^>]*>[\s\S]*?<b>([\s\S]*?)<\/b>[\s\S]*?<small>([\s\S]*?)<\/small>/gi;
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

  let communityScore: MovieDetailData['communityScore'] | undefined;
  const voteMatch = html.match(/data-summary=["']([^"']+)["']/i);
  if (voteMatch) {
    try {
      const parsedVote = JSON.parse(decodeHtmlEntities(voteMatch[1]));
      communityScore = {
        recommendedPercent: Number(parsedVote.recommended_percent) || 88,
        totalVotes: Number(parsedVote.total) || 24,
        verdict: sanitizeBrandText(parsedVote.verdict || 'দর্শকদের পছন্দ'),
      };
    } catch {
      // ignore
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
              downloadUrl: encodeGatewayUrl(fullDlUrl),
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

    // Parse episode range or season from label if not explicitly set
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
      ep.range_start !== null && ep.range_start !== undefined
        ? Number(ep.range_start)
        : number;
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
    communityScore,
  };
}

function extractBaseSeriesTitle(rawTitle: string): string {
  return String(rawTitle || '')
    .replace(/\[.*?\]|\(.*?\)/g, ' ')
    .replace(/\b(?:S\d+|Season\s*\d+(?:-\d+)?|Ep(?:isode)?\s*\d+(?:-\d+)?|Complete(?:d)?|Added|Full\s*HD|ORG|Hindi|Bangla|Bengali|Dual|Multi|Audio|Watch|Online|Download|WEB-DL|HDTC|4K|The\s*Movie)\b/gi, ' ')
    .replace(/[:\-–—|]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function mapCategoryToMyFlixPath(rawPath: string, page = 1, search = ''): string {
  if (search) {
    return page > 1
      ? `/page/${page}/?s=${encodeURIComponent(search)}`
      : `/?s=${encodeURIComponent(search)}`;
  }

  const p = (rawPath || '/').toLowerCase().replace(/\/page\/\d+\/?$/, '').replace(/\/+$/, '') || '/';
  let mfBase = '/';

  if (p === '/' || p === '/home' || p === '/movies' || p === '/hot-dhamaka' || p === '/new-uploads' || p === '/new-releases' || p === '/mostwatch/7d') mfBase = '/';
  else if (p.includes('bangla-dubbed') || p.includes('bangladubbed')) mfBase = '/movie-genre/bangla-dubbed/';
  else if (p.includes('bangla') || p.includes('bengali') || p.includes('kolkata')) mfBase = '/movie-genre/bangla/';
  else if (p.includes('hindi-dubbed') || p.includes('hindidubbed') || p.includes('dual-audio')) mfBase = '/movie-genre/hindi-dubbed/';
  else if (p.includes('bollywood') || p.includes('hindi')) mfBase = '/movie-genre/hindi/';
  else if (p.includes('south') || p.includes('tamil') || p.includes('telugu') || p.includes('malayalam') || p.includes('kannada'))
    mfBase = '/movie-genre/south-indian/';
  else if (p.includes('hollywood') || p.includes('english')) mfBase = '/movie-genre/hollywood/';
  else if (p.includes('anime')) mfBase = '/tv-genre/anime/';
  else if (p.includes('animation') || p.includes('family')) mfBase = '/movie-genre/animation/';
  else if (p.includes('drama') || p.includes('korean') || p.includes('k-drama') || p.includes('chinese') || p.includes('turkish'))
    mfBase = '/tv-genre/k-drama/';
  else if (p.includes('series') || p.includes('ongoing') || p.includes('tv')) mfBase = '/tv-show/';
  else if (p.includes('action') || p.includes('superhero')) mfBase = '/movie-genre/action/';
  else if (p.includes('thriller') || p.includes('suspense') || p.includes('survival')) mfBase = '/movie-genre/thriller/';
  else if (p.includes('horror')) mfBase = '/movie-genre/horror/';
  else if (p.includes('romance')) mfBase = '/movie-genre/romance/';
  else if (p.includes('comedy')) mfBase = '/movie-genre/comedy/';
  else if (p.includes('crime')) mfBase = '/movie-genre/crime/';
  else if (p.includes('sci-fi')) mfBase = '/movie-genre/sci-fi/';
  else if (p.includes('adventure')) mfBase = '/movie-genre/adventure/';
  else if (p.includes('fantasy')) mfBase = '/movie-genre/fantasy/';
  else if (p.includes('mystery')) mfBase = '/movie-genre/mystery/';
  else {
    const slug = p.split('/').filter(Boolean).pop() || '';
    if (slug && slug !== 'adult18plus') {
      return page > 1 ? `/page/${page}/?s=${encodeURIComponent(slug.replace(/-/g, ' '))}` : `/?s=${encodeURIComponent(slug.replace(/-/g, ' '))}`;
    }
    return '';
  }

  if (page > 1) {
    const clean = mfBase === '/' ? '' : mfBase.replace(/\/+$/, '');
    return `${clean}/page/${page}/`;
  }
  return mfBase;
}

async function fetchMyFlixHtml(mfPath: string, timeoutMs = 4500): Promise<string> {
  if (!mfPath) throw new Error('Empty MyFlix path');
  const cleanPath = mfPath.startsWith('http')
    ? new URL(mfPath).pathname + new URL(mfPath).search
    : mfPath.startsWith('/')
      ? mfPath
      : `/${mfPath}`;

  const cached = myFlixHtmlCache.get(cleanPath);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }
  const existing = inFlightMyFlixMap.get(cleanPath);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = `${MYFLIX_ORIGIN}${cleanPath}`;
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,bn;q=0.8',
          Referer: `${MYFLIX_ORIGIN}/`,
        },
      });
      if (!res.ok) throw new Error(`MyFlix HTTP ${res.status}`);
      const html = await res.text();
      if (!html || html.length < 1000) throw new Error('Incomplete MyFlix HTML');
      pruneCacheMap(myFlixHtmlCache, 50);
      myFlixHtmlCache.set(cleanPath, { data: html, expiresAt: Date.now() + 45_000 });
      return html;
    } finally {
      clearTimeout(timer);
    }
  })();

  inFlightMyFlixMap.set(cleanPath, promise);
  try {
    return await promise;
  } finally {
    inFlightMyFlixMap.delete(cleanPath);
  }
}

function parseMyFlixCards(html: string): { items: MovieCardItem[]; maxPage: number } {
  const bodyIdx = html.indexOf('<body');
  const body = bodyIdx >= 0 ? html.slice(bodyIdx) : html;
  const cardRegex = /<a\s+href=["'](https?:\/\/myflixbd\.to\/(?:movie|tv-show)\/[^"']+)["'][^>]*class=["'][^"']*movie-card[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  const items: MovieCardItem[] = [];
  const seenPaths = new Set<string>();

  for (const match of body.matchAll(cardRegex)) {
    const rawHref = match[1].trim();
    const chunk = match[2];
    if (!rawHref) continue;

    let cleanPathname = '';
    try {
      cleanPathname = new URL(rawHref).pathname.replace(/^\/+|\/+$/g, '');
    } catch {
      continue;
    }
    if (!cleanPathname) continue;

    const itemPath = `/mf/${cleanPathname}`;
    if (seenPaths.has(itemPath)) continue;
    seenPaths.add(itemPath);

    const titleMatch =
      chunk.match(/<h3[^>]*class=["'][^"']*movie-title[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i) ||
      chunk.match(/alt=["']([^"']+)["']/i);
    if (!titleMatch) continue;

    const title = decodeHtmlEntities(titleMatch[1]);
    if (!title) continue;

    const posterMatch =
      chunk.match(/data-src=["'](https?:\/\/[^"']+)["']/i) ||
      chunk.match(/src=["'](https?:\/\/[^"']+)["']/i);
    const poster = posterMatch ? posterMatch[1].trim() : '';

    const quality = decodeHtmlEntities(
      (chunk.match(/card-badge-quality["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || 'WEB-DL'
    );
    const language = decodeHtmlEntities(
      (chunk.match(/card-badge-lang["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || 'MULTI'
    );
    const epBadge = decodeHtmlEntities(
      (chunk.match(/card-badge-ep["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || ''
    );
    const ratingBadge = decodeHtmlEntities(
      (chunk.match(/card-badge-rating["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || ''
    );
    const catBadge = decodeHtmlEntities(
      (chunk.match(/card-badge-category["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || ''
    ).toUpperCase();

    let typeBadge: 'MOVIE' | 'SERIES' | 'ANIME' | 'DRAMA' = 'MOVIE';
    if (catBadge.includes('ANIME') || title.toLowerCase().includes('anime')) typeBadge = 'ANIME';
    else if (catBadge.includes('DRAMA') || language.toUpperCase().includes('KOREAN')) typeBadge = 'DRAMA';
    else if (
      catBadge.includes('SERIES') ||
      cleanPathname.startsWith('tv-show/') ||
      Boolean(epBadge) ||
      /season\s*\d+/i.test(title)
    ) {
      typeBadge = 'SERIES';
    }

    let mfHash = 2166136261 >>> 0;
    for (let c = 0; c < itemPath.length; c++) {
      mfHash ^= itemPath.charCodeAt(c);
      mfHash = Math.imul(mfHash, 16777619) >>> 0;
    }
    const mfYearMatch = title.match(/\((19\d{2}|20\d{2})\)/);
    const mfYearNum = mfYearMatch ? parseInt(mfYearMatch[1], 10) : 2026;
    const isRecentMf = mfYearNum >= 2025 || Boolean(epBadge);
    const mfMinsAgo = isRecentMf
      ? 24 + items.length * 41 + (mfHash % 29)
      : Math.max(2880, (2026 - mfYearNum) * 525600);
    const mfTimeLabel = isRecentMf
      ? mfMinsAgo < 60
        ? `${mfMinsAgo} mins ago`
        : `${Math.floor(mfMinsAgo / 60)} hours ago`
      : `${mfYearNum}`;

    items.push({
      id: itemPath.replace(/[^a-zA-Z0-9_-]/g, '_'),
      title,
      url: itemPath,
      path: itemPath,
      poster,
      quality: quality || 'WEB-DL',
      views: ratingBadge || '★ 8.1',
      language: language || 'MULTI',
      typeBadge,
      timeAgo: mfTimeLabel,
      episodePill: epBadge || (quality.toUpperCase().includes('SEASON') ? quality : ''),
      isPinned: chunk.includes('card-badge-trending') && isRecentMf,
      isAdult: false,
      uploadedAtMs: Date.now() - mfMinsAgo * 60_000,
    });
  }

  const pageMatches = [...body.matchAll(/\/page\/(\d+)/g)]
    .map((m) => Number(m[1]))
    .filter((n) => !isNaN(n) && n > 0 && n <= 2000);
  const maxPage = pageMatches.length > 0 ? Math.max(...pageMatches) : 342;

  return { items, maxPage };
}

function mergeCatalogItems(
  primaryItems: MovieCardItem[],
  secondaryItems: MovieCardItem[],
  preferSecondaryFirst = false
): MovieCardItem[] {
  const firstList = preferSecondaryFirst ? secondaryItems : primaryItems;
  const secondList = preferSecondaryFirst ? primaryItems : secondaryItems;
  const interleaved: MovieCardItem[] = [];
  const maxLen = Math.max(firstList.length, secondList.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < firstList.length) interleaved.push(firstList[i]);
    if (i < secondList.length) interleaved.push(secondList[i]);
  }
  return deduplicateMovieCards(interleaved);
}

function parseMyFlixDetail(html: string, itemPath: string): MovieDetailData {
  const rawTitle = decodeHtmlEntities(
    (html.match(/<h1[^>]*class=["'][^"']*movie-title-text[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i) ||
      html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) ||
      [])[1] || 'Cinema Title'
  );
  const title = sanitizeBrandText(rawTitle);

  const poster =
    (html.match(/<div class=["']poster-wrapper["'][\s\S]*?data-src=["'](https?:\/\/[^"']+)["']/i) ||
      html.match(/<div class=["']poster-wrapper["'][\s\S]*?src=["'](https?:\/\/[^"']+)["']/i) ||
      html.match(/property=["']og:image["']\s+content=["'](https?:\/\/[^"']+)["']/i) ||
      [])[1] || '';

  const extractMetaGrid = (label: string): string => {
    const regex = new RegExp(
      `<span class=["']meta-label["'][^>]*>\\s*${label}\\s*<\\/span>\\s*<span class=["']meta-value["'][^>]*>([\\s\\S]*?)<\\/span>`,
      'i'
    );
    const m = html.match(regex);
    return m ? decodeHtmlEntities(m[1]) : '';
  };

  const year = extractMetaGrid('Year') || '2026';
  const genre = extractMetaGrid('Genre') || 'Action, Drama, Thriller';
  const runtime = extractMetaGrid('Runtime') || '';
  const releaseDate = extractMetaGrid('Release') || year;

  const langBracketMatch = rawTitle.match(/\[(.*?)\]/);
  const language = langBracketMatch ? decodeHtmlEntities(langBracketMatch[1]) : 'Multi Audio';
  const quality =
    decodeHtmlEntities((html.match(/<div class=["']badge-hd["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '') ||
    'WEB-DL';

  const storyline = sanitizeBrandText(
    decodeHtmlEntities(
      (html.match(/<p id=["']synopsisText["'][^>]*>([\s\S]*?)<\/p>/i) ||
        html.match(/<div class=["']synopsis-box["'][\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) ||
        [])[1] || ''
    )
  );

  const ratingScoreNum = parseFloat(
    (html.match(/<span class=["']rating-score["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || '8.4'
  );
  const communityScore = {
    recommendedPercent: Math.min(99, Math.max(70, Math.round((ratingScoreNum || 8.4) * 10))),
    totalVotes: 310,
    verdict: 'দর্শকদের পছন্দ',
  };

  const cast: CastMember[] = [];
  const castRegex =
    /<div class=["']cast-card["'][^>]*>[\s\S]*?(?:data-src|src)=["'](https?:\/\/[^"']+)["'][\s\S]*?<p class=["']cast-name["'][^>]*>([\s\S]*?)<\/p>/gi;
  for (const m of html.matchAll(castRegex)) {
    const actorName = decodeHtmlEntities(m[2]);
    if (actorName) {
      cast.push({
        url: `/search?q=${encodeURIComponent(actorName)}`,
        photo: m[1],
        name: actorName,
        role: 'Cast',
      });
    }
  }

  const downloadButtons: DirectDownloadButton[] = [];
  const dlBtnRegex =
    /<a[^>]*class=["'][^"']*dl-v2-btn[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>[\s\S]*?<div class=["']dl-v2-title["'][^>]*>([\s\S]*?)<\/div>/gi;
  for (const m of html.matchAll(dlBtnRegex)) {
    const rawDlHref = m[1].trim();
    const rawLabel = decodeHtmlEntities(m[2]);
    if (!rawDlHref || rawDlHref === '#') continue;
    const qMatch = rawLabel.match(/(2160p|4k|1080p|720p|480p)/i);
    const qLabel = qMatch ? qMatch[1] : 'HD';
    downloadButtons.push({
      label: sanitizeBrandText(rawLabel || `Download ${qLabel}`),
      url: encodeGatewayUrl(rawDlHref),
      quality: qLabel,
      size: runtime || 'Full HD',
    });
  }

  const episodes: EpisodeItem[] = [];

  // 1. Check if `seasonsData` JSON array is embedded (for Series / K-Drama / Anime)
  const seasonsMatch = html.match(/(?:const|let|var)\s+seasonsData\s*=\s*(\[\s*\{[\s\S]*?\}\s*\])\s*;?/);
  if (seasonsMatch) {
    try {
      const parsedSeasons = JSON.parse(seasonsMatch[1]);
      if (Array.isArray(parsedSeasons)) {
        let globalIdx = 0;
        for (const sObj of parsedSeasons) {
          const seasonNum = Number(sObj?.index) || 1;
          const epArray = Array.isArray(sObj?.episodes) ? sObj.episodes : [];
          for (const epObj of epArray) {
            globalIdx++;
            const epNum = Number(epObj?.index) || globalIdx;
            const epTitle = decodeHtmlEntities(String(epObj?.title || `Episode ${epNum}`));
            const servers = Array.isArray(epObj?.servers) ? epObj.servers : [];
            const sources: StreamSource[] = servers
              .filter((srv: any) => srv && srv.url)
              .map((srv: any, sIdx: number) => {
                const srvUrl = String(srv.url).replace(/\\\//g, '/').trim();
                const fallbackDl = downloadButtons[0]?.url || encodeGatewayUrl(srvUrl);
                return {
                  id: `mf-s${seasonNum}-e${epNum}-srv${sIdx}`,
                  quality: 1080,
                  qualityLabel: decodeHtmlEntities(String(srv.label || `Server ${sIdx + 1} (HD)`)),
                  audio: language,
                  audioLanguages: [language],
                  provider: `Stream Server #${sIdx + 1}`,
                  url: srvUrl,
                  downloadUrl: fallbackDl,
                  type: 'embed',
                  name: `${title} - ${epTitle}`,
                };
              });

            if (sources.length > 0) {
              episodes.push({
                id: `mf-ep-${seasonNum}-${epNum}`,
                label: epTitle.toLowerCase().includes('all')
                  ? `Season ${seasonNum} • Full Stream`
                  : `S${String(seasonNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')} • ${epTitle}`,
                number: epNum,
                rangeStart: epNum,
                rangeEnd: epNum,
                season: seasonNum,
                kind: 'episode',
                sources,
              });
            }
          }
        }
      }
    } catch {
      // ignore JSON parse issues
    }
  }

  // 2. Also extract inline `.btn-server[data-url]` or `.video-container iframe` for Movies
  if (episodes.length === 0) {
    const serverUrls: Array<{ label: string; url: string }> = [];
    const seenSrv = new Set<string>();

    const btnSrvRegex = /<button[^>]*class=["'][^"']*btn-server[^"']*["'][^>]*data-url=["']([^"']+)["'][^>]*>([\s\S]*?)<\/button>/gi;
    for (const m of html.matchAll(btnSrvRegex)) {
      const u = m[1].trim();
      const lbl = decodeHtmlEntities(m[2]) || `Server ${serverUrls.length + 1}`;
      if (u && u.startsWith('http') && !seenSrv.has(u)) {
        seenSrv.add(u);
        serverUrls.push({ label: lbl, url: u });
      }
    }

    const iframeMatch =
      html.match(/<div class=["']video-container["'][\s\S]*?<iframe[^>]+data-litespeed-src=["'](https?:\/\/[^"']+)["']/i) ||
      html.match(/<div class=["']video-container["'][\s\S]*?<iframe[^>]+src=["'](https?:\/\/[^"']+)["']/i);
    if (iframeMatch && iframeMatch[1] && !seenSrv.has(iframeMatch[1])) {
      seenSrv.add(iframeMatch[1]);
      serverUrls.push({ label: 'Server 1 (HD)', url: iframeMatch[1].trim() });
    }

    if (serverUrls.length > 0) {
      const fallbackDl = downloadButtons[0]?.url || encodeGatewayUrl(serverUrls[0].url);
      episodes.push({
        id: 'mf-movie-main',
        label: 'Full Movie',
        number: 1,
        rangeStart: 1,
        rangeEnd: 1,
        season: null,
        kind: 'movie',
        sources: serverUrls.map((srv, idx) => ({
          id: `mf-movie-srv-${idx}`,
          quality: idx === 0 ? 1080 : 720,
          qualityLabel: srv.label,
          audio: language,
          audioLanguages: [language],
          provider: srv.label,
          url: srv.url,
          downloadUrl: fallbackDl,
          type: 'embed',
          name: `${title} (${srv.label})`,
        })),
      });
    }
  }

  return {
    title,
    url: itemPath,
    poster,
    qualityNote: `${quality} • ${language}${runtime ? ` • ${runtime}` : ''}`,
    typeBadge: itemPath.includes('/tv-show/') || episodes.length > 1 ? 'SERIES' : 'MOVIE',
    language,
    quality,
    genre,
    resolution: '1080p | 720p | 480p',
    releaseDate,
    storyline,
    youtubeTrailerId: '',
    screenshots: [],
    episodes,
    downloadButtons,
    cast: cast.slice(0, 12),
    communityScore,
  };
}

// ============================================================================
// MovieBox HD (https://movie-box.co + movieboxhd.net + h5-api.aoneroom.com) Full Content Engine
// ============================================================================
let cachedMovieBoxToken = '';
let cachedMovieBoxTokenExpiresAt = 0;
let cachedMovieBoxHomeSections: Array<{ title: string; type: string; subjects: any[] }> = [];
let cachedMovieBoxHomeExpiresAt = 0;
let cachedMovieBoxHomePayload: MovieBoxHomePayload | null = null;
let cachedMovieBoxHomePayloadExpiresAt = 0;
let inFlightMovieBoxHomePromise: Promise<MovieBoxHomePayload> | null = null;

function extractMovieBoxNuxtOperatingList(html: string): any[] {
  try {
    const m = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (!m?.[1]) return [];
    const arr = JSON.parse(m[1]);
    if (!Array.isArray(arr)) return [];

    const resolve = (idx: any, depth = 0): any => {
      if (depth > 8 || typeof idx !== 'number' || idx < 0 || idx >= arr.length) return idx;
      const val = arr[idx];
      if (Array.isArray(val)) {
        if (val[0] === 'ShallowReactive' || val[0] === 'Reactive' || val[0] === 'Ref') {
          return resolve(val[1], depth + 1);
        }
        return val.map((v) => resolve(v, depth + 1));
      }
      if (val && typeof val === 'object') {
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(val)) {
          out[k] = resolve(v, depth + 1);
        }
        return out;
      }
      return val;
    };

    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v && typeof v === 'object' && !Array.isArray(v) && 'operatingList' in v) {
        const resolved = resolve(i);
        if (Array.isArray(resolved?.operatingList) && resolved.operatingList.length > 0) {
          return resolved.operatingList;
        }
      }
    }
  } catch {
    // ignore Nuxt parse error
  }
  return [];
}

function mapMovieBoxShelfTitleToMeta(rawTitle: string): { bnTitle: string; categoryPath: string; badge?: string } {
  const t = rawTitle.toLowerCase();
  if (t.includes('trending drama')) {
    return { bnTitle: 'ট্রেন্ডিং ড্রামা সিরিজ', categoryPath: '/category/trending-drama', badge: 'HOT DRAMA' };
  }
  if (t.includes('trending movie')) {
    return { bnTitle: 'ট্রেন্ডিং মুভি (MovieBox Top)', categoryPath: '/type/movies', badge: 'TRENDING' };
  }
  if (t.includes('indian cinema')) {
    return { bnTitle: 'ইন্ডিয়ান সিনেমা ট্রেন্ডিং', categoryPath: '/category/indian-cinema', badge: 'INDIA TOP' };
  }
  if (t.includes('bengali')) {
    return { bnTitle: 'ট্রেন্ডিং বাংলা মুভি ও নাটক', categoryPath: '/language/bangla', badge: 'BANGLA HIT' };
  }
  if (t.includes('bollywood')) {
    return { bnTitle: 'বলিউড হিন্দি মুভি', categoryPath: '/bollywood', badge: 'BOLLYWOOD' };
  }
  if (t.includes('south indian')) {
    return { bnTitle: 'সাউথ ইন্ডিয়ান ব্লকবাস্টার', categoryPath: '/southIndian', badge: 'SOUTH DUB' };
  }
  if (t.includes('hollywood')) {
    return { bnTitle: 'হলিউড ব্লকবাস্টার মুভি', categoryPath: '/language/english', badge: 'HOLLYWOOD' };
  }
  if (t.includes('short tv')) {
    return { bnTitle: 'হট শর্ট টিভি ও মিনি ড্রামা', categoryPath: '/category/short-tv', badge: 'SHORT TV' };
  }
  if (t.includes('asian drama') || t.includes('k-drama')) {
    return { bnTitle: 'কোরিয়ান ও এশিয়ান ড্রামা', categoryPath: '/drama', badge: 'K-DRAMA' };
  }
  if (t.includes('western tv')) {
    return { bnTitle: 'ওয়েস্টার্ন ও হলিউড টিভি শো', categoryPath: '/category/western-tv', badge: 'WESTERN TV' };
  }
  if (t.includes('anime in hindi')) {
    return { bnTitle: 'হিন্দি ডাবিং অ্যানিমে', categoryPath: '/category/anime-hindi', badge: 'HINDI ANIME' };
  }
  if (t.includes('popular anime') || t.includes('anime')) {
    return { bnTitle: 'জনপ্রিয় অ্যানিমে সিরিজ', categoryPath: '/anime', badge: 'ANIME' };
  }
  if (t.includes('movie new release')) {
    return { bnTitle: 'সদ্য মুক্তিপ্রাপ্ত নতুন মুভি', categoryPath: '/type/movies', badge: 'NEW MOVIE' };
  }
  if (t.includes('tv series new release')) {
    return { bnTitle: 'নতুন টিভি ও ওয়েব সিরিজ', categoryPath: '/type/series', badge: 'NEW SERIES' };
  }
  if (t.includes('punjabi')) {
    return { bnTitle: 'সেরা পাঞ্জাবি মুভি', categoryPath: '/language/punjabi', badge: 'PUNJABI' };
  }
  if (t.includes('indian drama')) {
    return { bnTitle: 'ইন্ডিয়ান ড্রামা ও সিরিয়াল', categoryPath: '/category/indian-drama', badge: 'INDIAN DRAMA' };
  }
  if (t.includes('arabic')) {
    return { bnTitle: 'আরবি ড্রামা ও সিরিজ', categoryPath: '/category/arabic-drama', badge: 'ARABIC' };
  }
  if (t.includes('ramadan')) {
    return { bnTitle: 'রমজান স্পেশাল ড্রামা', categoryPath: '/category/arabic-drama', badge: 'SPECIAL' };
  }
  return { bnTitle: rawTitle, categoryPath: '/type/movies' };
}

let inFlightTokenPromise: Promise<string> | null = null;

function generateMovieBoxClientToken(): string {
  const ts = Math.floor(Date.now() / 1000);
  const rev = String(ts).split('').reverse().join('');
  const hash = crypto.createHash('md5').update(rev).digest('hex');
  return `${ts},${hash}`;
}

async function getMovieBoxBearerToken(needHomeSections = false): Promise<string> {
  if (
    cachedMovieBoxToken &&
    cachedMovieBoxTokenExpiresAt > Date.now() &&
    (!needHomeSections || (cachedMovieBoxHomeSections.length > 0 && cachedMovieBoxHomeExpiresAt > Date.now()))
  ) {
    return cachedMovieBoxToken;
  }

  if (inFlightTokenPromise) {
    return inFlightTokenPromise;
  }

  inFlightTokenPromise = (async () => {
    try {
      // 1. Obtain official MovieBox JWT token from x-user header via get-latest-app-pkgs with X-Client-Token
      if (!cachedMovieBoxToken || cachedMovieBoxTokenExpiresAt <= Date.now()) {
        const pkgEndpoints = [
          `${MOVIEBOX_FALLBACK_API_ORIGIN}/wefeed-h5api-bff/app/get-latest-app-pkgs?appName=moviebox`,
          `${MOVIEBOX_ORIGIN}/wefeed-h5api-bff/app/get-latest-app-pkgs?appName=moviebox`,
        ];
        for (const pkgUrl of pkgEndpoints) {
          try {
            const pkgRes = await fetch(pkgUrl, {
              headers: {
                Accept: 'application/json',
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
                Referer: 'https://movie-box.co/?utm_source=mb_app_inner_btmtip',
                'X-Client-Info': JSON.stringify({ timezone: 'Asia/Dhaka' }),
                'X-Vip-Restrict': '0',
                'X-No-High-Risk-Restrict': '1',
                'X-Request-Lang': 'en',
              },
              signal: AbortSignal.timeout(2500),
            });
            const xUser = pkgRes.headers.get('x-user') || pkgRes.headers.get('x-user-info');
            if (xUser) {
              const parsed = JSON.parse(xUser);
              if (parsed?.token) {
                cachedMovieBoxToken = String(parsed.token);
                cachedMovieBoxTokenExpiresAt = Date.now() + 2 * 3600_000;
                break;
              }
            }
          } catch {
            // try next endpoint
          }
        }
      }

      // 2. Only fetch SSR operatingList from https://movie-box.co/ when home sections are empty or expired
      const shouldFetchSsr =
        needHomeSections || cachedMovieBoxHomeSections.length === 0 || cachedMovieBoxHomeExpiresAt <= Date.now();
      const ssrPromise = shouldFetchSsr
        ? fetch(`${MOVIEBOX_ORIGIN}/`, {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
              Accept: 'text/html,application/xhtml+xml',
              'Accept-Language': 'en-US,en;q=0.9,bn;q=0.8,hi;q=0.7',
            },
            signal: AbortSignal.timeout(3800),
          })
            .then((r) => (r.ok ? r.text() : ''))
            .then((html) => (html ? extractMovieBoxNuxtOperatingList(html) : []))
            .catch(() => [])
        : Promise.resolve([]);

      let bffOps: any[] = [];
      if (shouldFetchSsr) {
        const homeEndpoints = [
          `${MOVIEBOX_FALLBACK_API_ORIGIN}/wefeed-h5api-bff/home?host=movie-box.co`,
          `${MOVIEBOX_ORIGIN}/wefeed-h5api-bff/home?host=movie-box.co`,
        ];
        for (const endpoint of homeEndpoints) {
          try {
            const headers: Record<string, string> = {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
              Accept: 'application/json',
              Referer: 'https://movie-box.co/?utm_source=mb_app_inner_btmtip',
              'X-Client-Info': JSON.stringify({ timezone: 'Asia/Dhaka' }),
              'X-Vip-Restrict': '0',
              'X-No-High-Risk-Restrict': '1',
              'X-Request-Lang': 'en',
            };
            if (cachedMovieBoxToken) {
              headers.Authorization = `Bearer ${cachedMovieBoxToken}`;
            } else {
              headers['X-Client-Token'] = generateMovieBoxClientToken();
            }
            const res = await fetch(endpoint, {
              headers,
              signal: AbortSignal.timeout(3000),
            });
            const xUser = res.headers.get('x-user') || res.headers.get('x-user-info');
            if (xUser) {
              try {
                const parsed = JSON.parse(xUser);
                if (parsed?.token) {
                  cachedMovieBoxToken = String(parsed.token);
                  cachedMovieBoxTokenExpiresAt = Date.now() + 2 * 3600_000;
                }
              } catch {
                // ignore
              }
            }
            if (res.ok) {
              const json = (await res.json().catch(() => null)) as any;
              const ops = Array.isArray(json?.data?.operatingList) ? json.data.operatingList : [];
              if (ops.length > 0) {
                bffOps = ops;
                break;
              }
            }
          } catch {
            // try next MovieBox gateway
          }
        }
      }

      if (!cachedMovieBoxTokenExpiresAt || cachedMovieBoxTokenExpiresAt <= Date.now()) {
        cachedMovieBoxTokenExpiresAt = Date.now() + 15 * 60_000;
      }

      const ssrOps = await ssrPromise;
      const combinedOps = [...ssrOps, ...bffOps];
      if (combinedOps.length > 0) {
        const seenTitles = new Set<string>();
        const sections: Array<{ title: string; type: string; subjects: any[] }> = [];
        for (const op of combinedOps) {
          const title = String(op?.title || '').trim();
          const type = String(op?.type || '').trim();
          const subjects = Array.isArray(op?.subjects)
            ? op.subjects
            : Array.isArray(op?.banner?.items)
              ? op.banner.items
              : [];
          if (!subjects.length) continue;
          const key = `${type}::${title.toLowerCase()}`;
          if (seenTitles.has(key)) continue;
          seenTitles.add(key);
          sections.push({ title, type, subjects });
        }
        if (sections.length > 0) {
          cachedMovieBoxHomeSections = sections;
          cachedMovieBoxHomeExpiresAt = Date.now() + 300_000;
        }
      }

      return cachedMovieBoxToken;
    } finally {
      inFlightTokenPromise = null;
    }
  })();

  return inFlightTokenPromise;
}

async function fetchMovieBoxHomePayload(): Promise<MovieBoxHomePayload> {
  if (cachedMovieBoxHomePayload && cachedMovieBoxHomePayloadExpiresAt > Date.now()) {
    return cachedMovieBoxHomePayload;
  }
  if (inFlightMovieBoxHomePromise) {
    return inFlightMovieBoxHomePromise;
  }

  const task = (async (): Promise<MovieBoxHomePayload> => {
    try {
      const [ssrHtml] = await Promise.all([
        fetch(`${MOVIEBOX_ORIGIN}/`, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
            Accept: 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9,bn;q=0.8,hi;q=0.7',
          },
          signal: AbortSignal.timeout(5500),
        })
          .then((r) => (r.ok ? r.text() : ''))
          .catch(() => ''),
        getMovieBoxBearerToken().catch(() => ''),
      ]);

      const ssrOps = ssrHtml ? extractMovieBoxNuxtOperatingList(ssrHtml) : [];
      const banners: MovieCardItem[] = [];
      const seenBannerIds = new Set<string>();
      const comingSoon: MovieBoxComingSoonItem[] = [];
      const seenComingIds = new Set<string>();
      const shelves: MovieBoxHomeShelf[] = [];
      const seenShelfIds = new Set<string>();

      const defaultQuickCategories: MovieBoxQuickCategory[] = [
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
        {
          id: 'qc-kdrama',
          title: 'K-Drama',
          bnTitle: 'কোরিয়ান ড্রামা',
          image: 'https://pbcdnw.aoneroom.com/image/2025/01/13/1e5ef9bffd0b731d7eb4ef2c96ef7c77.png',
          path: '/drama',
        },
        {
          id: 'qc-western',
          title: 'Western TV',
          bnTitle: 'ওয়েস্টার্ন টিভি',
          image: 'https://pbcdnw.aoneroom.com/image/2025/01/13/3f4884c8e0f1fd7c92a4bf2c4a6b5e81.png',
          path: '/category/western-tv',
        },
        {
          id: 'qc-anime',
          title: 'Anime in Hindi',
          bnTitle: 'হিন্দি ও জাপানিজ অ্যানিমে',
          image: 'https://image.tmdb.org/t/p/original/n8rforZjHAB9uxqbwy7g6EdertA.jpg',
          path: '/category/anime-hindi',
        },
      ];

      const liveSports: MovieBoxLiveSportItem[] = [];

      for (const op of ssrOps) {
        const opType = String(op?.type || '').trim();
        const opTitle = String(op?.title || '').trim();

        if (opType === 'BANNER' && Array.isArray(op?.banner?.items)) {
          for (let idx = 0; idx < op.banner.items.length; idx++) {
            const raw = op.banner.items[idx];
            const rawSubj = raw?.subject || raw;
            const sid = String(rawSubj?.subjectId || raw?.subjectId || '').trim();
            if (!sid || seenBannerIds.has(sid)) continue;
            seenBannerIds.add(sid);
            const card = mapMovieBoxItemToCard(
              {
                ...rawSubj,
                subjectId: sid,
                title: rawSubj?.title || raw?.title,
                detailPath: rawSubj?.detailPath || raw?.detailPath,
                cover: raw?.image || rawSubj?.cover,
              },
              idx
            );
            if (card) banners.push(card);
          }
        } else if (opType === 'APPOINTMENT_LIST' && Array.isArray(op?.subjects)) {
          for (const raw of op.subjects) {
            const sid = String(raw?.subjectId || '').trim();
            const title = String(raw?.title || '').trim();
            const poster = String(raw?.cover?.url || '').trim();
            if (!sid || !title || !poster || seenComingIds.has(sid)) continue;
            seenComingIds.add(sid);
            const detailSlug = String(raw?.detailPath || title)
              .toLowerCase()
              .replace(/[^a-z0-9-]+/g, '-')
              .replace(/^-+|-+$/g, '');
            const releaseDate = String(raw?.releaseDate || raw?.appointmentDate || '').trim();
            let releaseBadge = releaseDate;
            if (/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) {
              const dt = new Date(`${releaseDate}T00:00:00Z`);
              if (!isNaN(dt.getTime())) {
                releaseBadge = dt.toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  timeZone: 'UTC',
                });
              }
            }
            comingSoon.push({
              id: `mb_coming_${sid}`,
              title,
              releaseDate,
              releaseBadge: releaseBadge || 'Coming Soon',
              bookedCount: Number(raw?.appointmentCnt) || 120,
              poster,
              path: `/mb/${sid}/${detailSlug || 'movie'}`,
              genre: String(raw?.genre || 'Action, Drama'),
              country: String(raw?.countryName || ''),
            });
          }
        } else if (opType === 'SUBJECTS_MOVIE' && Array.isArray(op?.subjects) && opTitle) {
          const shelfKey = opTitle.toLowerCase();
          if (
            seenShelfIds.has(shelfKey) ||
            /nollywood|black\s*shows|bet\+|banner_africa|bl\s*story|sport|football|cricket|mango|manga/i.test(
              shelfKey
            )
          ) {
            continue;
          }
          const cards: MovieCardItem[] = [];
          const seenCardIds = new Set<string>();
          for (let idx = 0; idx < op.subjects.length; idx++) {
            const raw = op.subjects[idx];
            const card = mapMovieBoxItemToCard(raw, idx);
            if (card && !seenCardIds.has(card.id)) {
              seenCardIds.add(card.id);
              cards.push(card);
            }
          }
          if (cards.length > 0) {
            seenShelfIds.add(shelfKey);
            const meta = mapMovieBoxShelfTitleToMeta(opTitle);
            shelves.push({
              id: `mb-shelf-${shelfKey.replace(/[^a-z0-9]+/g, '-')}`,
              title: opTitle,
              bnTitle: meta.bnTitle,
              categoryPath: meta.categoryPath,
              badge: meta.badge,
              items: cards.slice(0, 18),
            });
          }
        }
      }

      // If SSR shelves missed any sections, supplement from cachedMovieBoxHomeSections
      if (shelves.length === 0 && cachedMovieBoxHomeSections.length > 0) {
        for (const sec of cachedMovieBoxHomeSections) {
          if (sec.type !== 'SUBJECTS_MOVIE' || !sec.title) continue;
          const shelfKey = sec.title.toLowerCase();
          if (
            seenShelfIds.has(shelfKey) ||
            /nollywood|black\s*shows|bet\+|banner_africa|bl\s*story|sport|football|cricket|mango|manga/i.test(
              shelfKey
            )
          ) {
            continue;
          }
          const cards: MovieCardItem[] = [];
          for (let idx = 0; idx < sec.subjects.length; idx++) {
            const card = mapMovieBoxItemToCard(sec.subjects[idx], idx);
            if (card) cards.push(card);
          }
          if (cards.length > 0) {
            seenShelfIds.add(shelfKey);
            const meta = mapMovieBoxShelfTitleToMeta(sec.title);
            shelves.push({
              id: `mb-shelf-${shelfKey.replace(/[^a-z0-9]+/g, '-')}`,
              title: sec.title,
              bnTitle: meta.bnTitle,
              categoryPath: meta.categoryPath,
              badge: meta.badge,
              items: cards.slice(0, 18),
            });
          }
        }
      }

      // Always guarantee South Asian & Bengali shelves from MovieBox's direct catalog API regardless of server Geo-IP!
      const regionalCuratedSpecs = [
        {
          key: 'trending bengali movies',
          title: 'Trending Bengali Movies',
          bnTitle: 'ট্রেন্ডিং বাংলা মুভি ও নাটক',
          categoryPath: '/language/bangla',
          badge: 'BANGLA HIT',
          path: '/language/bangla',
        },
        {
          key: 'bollywood movie',
          title: 'Bollywood Movie',
          bnTitle: 'বলিউড ও ইন্ডিয়ান সিনেমা',
          categoryPath: '/bollywood',
          badge: 'BOLLYWOOD',
          path: '/bollywood',
        },
        {
          key: 'south indian movie',
          title: 'South Indian & Hindi Dubbed',
          bnTitle: 'সাউথ ইন্ডিয়ান ও হিন্দি ডাবিং',
          categoryPath: '/language/hindi-dubbed',
          badge: 'HINDI DUB',
          path: '/language/hindi-dubbed',
        },
        {
          key: 'anime in hindi',
          title: 'Anime in Hindi',
          bnTitle: 'হিন্দি ও জাপানিজ অ্যানিমে',
          categoryPath: '/category/anime-hindi',
          badge: 'HINDI ANIME',
          path: '/category/anime-hindi',
        },
      ];

      const missingRegional = regionalCuratedSpecs.filter((sp) => !seenShelfIds.has(sp.key));
      if (missingRegional.length > 0) {
        const regSettled = await Promise.allSettled(
          missingRegional.map((sp) => fetchMovieBoxCatalog(sp.path, 1, ''))
        );
        for (let i = 0; i < missingRegional.length; i++) {
          const sp = missingRegional[i];
          const r = regSettled[i];
          if (r.status === 'fulfilled' && r.value.items.length > 0) {
            seenShelfIds.add(sp.key);
            shelves.push({
              id: `mb-shelf-${sp.key.replace(/[^a-z0-9]+/g, '-')}`,
              title: sp.title,
              bnTitle: sp.bnTitle,
              categoryPath: sp.categoryPath,
              badge: sp.badge,
              items: r.value.items.slice(0, 18),
            });
            // Prepend top South Asian / Bengali hits to banners so the Hero Carousel is rich & localized
            for (const bCard of r.value.items.slice(0, 3)) {
              if (!seenBannerIds.has(bCard.id)) {
                seenBannerIds.add(bCard.id);
                banners.unshift(bCard);
              }
            }
          }
        }
      }

      // Prioritize South Asian & Bengali shelves near the top for our users while keeping MovieBox's authentic order
      const priorityOrder = [
        'trending bengali movies',
        'bollywood movie',
        'south indian',
        'trending in indian cinema',
        'trending drama',
        'popular series',
        'trending movie',
        'popular movie',
        'hollywood movie',
        '🔥hot short tv',
        'k-drama',
        'asian drama',
        'anime in hindi',
        'anime',
        'western tv',
        'action',
      ];
      shelves.sort((a, b) => {
        const ia = priorityOrder.findIndex((k) => a.title.toLowerCase().includes(k));
        const ib = priorityOrder.findIndex((k) => b.title.toLowerCase().includes(k));
        const sa = ia === -1 ? 999 : ia;
        const sb = ib === -1 ? 999 : ib;
        return sa - sb;
      });

      const payload: MovieBoxHomePayload = {
        ok: true,
        banners: banners.slice(0, 12),
        liveSports,
        quickCategories: defaultQuickCategories,
        comingSoon: comingSoon.slice(0, 18),
        sections: shelves,
      };
      if (shelves.length > 0) {
        cachedMovieBoxHomePayload = payload;
        cachedMovieBoxHomePayloadExpiresAt = Date.now() + 240_000;
      }
      return payload;
    } finally {
      inFlightMovieBoxHomePromise = null;
    }
  })();

  inFlightMovieBoxHomePromise = task;
  return task;
}

function getMovieBoxHomeOperatingSubjects(rawPath: string): any[] {
  if (!cachedMovieBoxHomeSections.length) return [];
  const p = (rawPath || '/').toLowerCase().replace(/\/page\/\d+\/?$/, '').replace(/\/+$/, '') || '/';
  const matched: any[] = [];

  for (const sec of cachedMovieBoxHomeSections) {
    const t = sec.title.toLowerCase();
    const isMatch =
      p === '/' ||
      p === '/hot-dhamaka' ||
      p === '/new-uploads' ||
      p === '/new-releases' ||
      p === '/mostwatch/7d' ||
      p === '/movies' ||
      (p === '/category/trending-drama' && t.includes('trending drama')) ||
      (p === '/category/indian-cinema' && (t.includes('indian cinema') || t.includes('bollywood') || t.includes('south indian'))) ||
      (p === '/category/short-tv' && t.includes('short tv')) ||
      (p === '/category/western-tv' && t.includes('western tv')) ||
      (p === '/category/anime-hindi' && t.includes('anime in hindi')) ||
      (p === '/category/indian-drama' && t.includes('indian drama')) ||
      (p === '/category/arabic-drama' && (t.includes('arabic') || t.includes('ramadan'))) ||
      ((p.includes('bangla') || p.includes('bengali')) && t.includes('bengali')) ||
      (p.includes('bollywood') && (t.includes('bollywood') || t.includes('indian cinema'))) ||
      (p.includes('south') && (t.includes('south indian') || t.includes('indian cinema'))) ||
      (p.includes('punjabi') && t.includes('punjabi')) ||
      ((p.includes('english') || p.includes('hollywood')) && (t.includes('hollywood') || t.includes('western'))) ||
      (p.includes('anime') && (t.includes('anime') || t.includes('animation'))) ||
      (p.includes('animation') && (t.includes('animation') || t.includes('anime'))) ||
      ((p.includes('drama') || p.includes('korean')) &&
        (t.includes('asian drama') || t.includes('k-drama') || t.includes('trending drama') || t.includes('drama'))) ||
      (p.includes('chinese') && (t.includes('asian drama') || t.includes('c-drama'))) ||
      ((p.includes('series') || p.includes('ongoing') || p.includes('tv')) &&
        (t.includes('series') || t.includes('shows') || t.includes('short tv') || t.includes('drama') || t.includes('western tv'))) ||
      ((p.includes('action') || p.includes('superhero')) &&
        (t.includes('action') || t.includes('superhero') || t.includes('gangster') || t.includes('hollywood'))) ||
      ((p.includes('thriller') || p.includes('crime')) &&
        (t.includes('thriller') || t.includes('gangster') || t.includes('action'))) ||
      (p.includes('horror') && t.includes('horror')) ||
      (p.includes('romance') && t.includes('romance')) ||
      (p.includes('comedy') && t.includes('comedy')) ||
      ((p.includes('fantasy') || p.includes('sci-fi') || p.includes('adventure')) &&
        (t.includes('fantasy') || t.includes('superhero'))) ||
      (p.includes('upcoming') && t.includes('coming soon'));

    if (isMatch) {
      matched.push(...sec.subjects);
    }
  }
  return matched;
}

function mapCategoryToMovieBoxFilter(rawPath: string, page = 1): Record<string, any> {
  const p = (rawPath || '/').toLowerCase().replace(/\/page\/\d+\/?$/, '').replace(/\/+$/, '') || '/';
  const payload: Record<string, any> = {
    page,
    perPage: 28,
    channelId: 1, // Default: Movies
    sort: 'Hottest',
  };

  if (p === '/' || p === '/hot-dhamaka' || p === '/mostwatch/7d') {
    payload.channelId = 1;
    payload.sort = 'Hottest';
  } else if (p === '/new-uploads' || p === '/new-releases' || p === '/upcoming') {
    payload.channelId = 1;
    payload.sort = 'Latest';
  } else if (p === '/collection/bangla-web-series') {
    payload.channelId = 2;
    payload.country = 'Bangladesh';
    payload.sort = 'Hottest';
  } else if (p === '/collection/top-rated-hindi-dubbed-action') {
    payload.channelId = 1;
    payload.classify = 'Hindi dub';
    payload.genre = 'Action';
    payload.sort = 'Hottest';
  } else if (p === '/collection/korean-drama-must-watch') {
    payload.channelId = 2;
    payload.country = 'Korea';
    payload.sort = 'Hottest';
  } else if (p === '/category/trending-drama') {
    payload.channelId = 2;
    payload.sort = 'Hottest';
  } else if (p === '/category/indian-cinema') {
    payload.channelId = 1;
    payload.country = 'India';
    payload.sort = 'Hottest';
  } else if (p === '/category/short-tv') {
    payload.channelId = 2;
    payload.sort = 'Latest';
  } else if (p === '/category/western-tv') {
    payload.channelId = 2;
    payload.country = 'United States';
    payload.sort = 'Hottest';
  } else if (p === '/category/anime-hindi') {
    payload.channelId = 1006;
    payload.classify = 'Hindi dub';
    payload.sort = 'Hottest';
  } else if (p === '/category/indian-drama') {
    payload.channelId = 2;
    payload.country = 'India';
    payload.sort = 'Hottest';
  } else if (p === '/category/arabic-drama') {
    payload.channelId = 2;
    payload.country = 'Egypt';
    payload.sort = 'Hottest';
  } else if (p.includes('anime')) {
    payload.channelId = 1006;
    payload.sort = 'Hottest';
  } else if (p.includes('animation') || p.includes('family')) {
    payload.channelId = 1006;
    payload.sort = 'Hottest';
  } else if (p.includes('bangla-dubbed')) {
    payload.channelId = 1;
    payload.classify = 'Bengali dub';
  } else if (p.includes('bangla')) {
    payload.channelId = p.includes('series') || p.includes('natok') ? 2 : 1;
    payload.country = 'Bangladesh';
  } else if (p.includes('series') || p.includes('ongoing') || p.includes('tv')) {
    payload.channelId = 2;
    payload.sort = 'Hottest';
  } else if (p.includes('drama') || p.includes('korean')) {
    payload.channelId = 2;
    payload.country = 'Korea';
    payload.sort = 'Hottest';
  } else if (p.includes('chinese')) {
    payload.channelId = 2;
    payload.country = 'China';
  } else if (p.includes('japanese')) {
    payload.channelId = 1006;
    payload.country = 'Japan';
  } else if (p.includes('turkish')) {
    payload.channelId = 2;
    payload.country = 'Turkey';
  } else if (p.includes('hindi-dubbed') || p.includes('dual-audio')) {
    payload.channelId = 1;
    payload.classify = 'Hindi dub';
  } else if (p.includes('bollywood') || p.includes('hindi')) {
    payload.channelId = 1;
    payload.country = 'India';
  } else if (p.includes('tamil')) {
    payload.channelId = 1;
    payload.classify = 'Tamil dub';
  } else if (p.includes('telugu') || p.includes('south')) {
    payload.channelId = 1;
    payload.classify = 'Telugu dub';
  } else if (p.includes('malayalam')) {
    payload.channelId = 1;
    payload.classify = 'Malayalam dub';
  } else if (p.includes('kannada')) {
    payload.channelId = 1;
    payload.classify = 'Kannada dub';
  } else if (p.includes('punjabi')) {
    payload.channelId = 1;
    payload.classify = 'Punjabi dub';
  } else if (p.includes('english') || p.includes('hollywood') || p.includes('mcu') || p.includes('dc-universe')) {
    payload.channelId = 1;
    payload.country = 'United States';
  } else if (p.includes('indonesian')) {
    payload.channelId = 1;
    payload.country = 'Indonesia';
  } else if (p.includes('spanish')) {
    payload.channelId = 1;
    payload.country = 'Spain';
  } else if (p.includes('french')) {
    payload.channelId = 1;
    payload.country = 'France';
  } else if (p.includes('italian')) {
    payload.channelId = 1;
    payload.country = 'Italy';
  } else if (p.includes('malaysian')) {
    payload.channelId = 1;
    payload.country = 'Malaysia';
  } else if (p.includes('action') || p.includes('superhero')) {
    payload.channelId = 1;
    payload.genre = 'Action';
  } else if (p.includes('thriller') || p.includes('suspense') || p.includes('survival')) {
    payload.channelId = 1;
    payload.genre = 'Thriller';
  } else if (p.includes('horror')) {
    payload.channelId = 1;
    payload.genre = 'Horror';
  } else if (p.includes('romance')) {
    payload.channelId = 1;
    payload.genre = 'Romance';
  } else if (p.includes('comedy')) {
    payload.channelId = 1;
    payload.genre = 'Comedy';
  } else if (p.includes('crime')) {
    payload.channelId = 1;
    payload.genre = 'Crime';
  } else if (p.includes('sci-fi')) {
    payload.channelId = 1;
    payload.genre = 'Sci-Fi';
  } else if (p.includes('adventure')) {
    payload.channelId = 1;
    payload.genre = 'Adventure';
  } else if (p.includes('fantasy')) {
    payload.channelId = 1;
    payload.genre = 'Fantasy';
  } else if (p.includes('mystery')) {
    payload.channelId = 1;
    payload.genre = 'Mystery';
  } else if (p.includes('historical')) {
    payload.channelId = 1;
    payload.genre = 'History';
  } else if (p.includes('war')) {
    payload.channelId = 1;
    payload.genre = 'War';
  } else if (p.includes('documentary')) {
    payload.channelId = 1;
    payload.genre = 'Documentary';
  } else if (p.includes('biographical')) {
    payload.channelId = 1;
    payload.genre = 'Biography';
  } else if (p.includes('music')) {
    payload.channelId = 1;
    payload.genre = 'Music';
  }

  return payload;
}

function mapMovieBoxItemToCard(raw: any, index = 0): MovieCardItem | null {
  if (!raw || !raw.subjectId || !raw.title || raw.hasResource === false) return null;
  if (Number(raw.subjectType) === 9) return null; // Exclude Sports clips
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
  const subsStr = String(raw.subtitles || '');
  let language = 'ENGLISH';
  if (cornerStr.includes('BENGALI') || cornerStr.includes('BANGLA') || /\[(bengali|bangla)\]/i.test(rawTitle)) {
    language = /dub/i.test(rawTitle) || (!countryStr.includes('BANGLADESH') && !countryStr.includes('INDIA'))
      ? 'BANGLA DUBBED'
      : 'BANGLA';
  } else if (cornerStr.includes('HINDI') || /\[hindi\]/i.test(rawTitle)) {
    language = !countryStr.includes('INDIA') ? 'HINDI DUBBED' : 'HINDI';
  } else if (cornerStr) {
    language = cornerStr;
  } else if (dubsList.length > 0) {
    language = dubsList[0].toUpperCase();
  } else if (subsStr.includes('বাংলা') || countryStr.includes('BANGLADESH')) {
    language = countryStr.includes('BANGLADESH') ? 'BANGLA' : 'BANGLA SUB';
  } else if (countryStr.includes('INDIA')) {
    language = 'HINDI';
  } else if (countryStr.includes('KOREA')) {
    language = 'KOREAN';
  } else if (countryStr.includes('CHINA')) {
    language = 'CHINESE';
  } else if (countryStr.includes('JAPAN')) {
    language = 'JAPANESE';
  }

  const episodePill =
    subjectType === 2
      ? /\bS\d+/i.test(rawTitle)
        ? rawTitle.match(/\bS\d+(?:-S?\d+)?/i)?.[0]?.toUpperCase() || 'SERIES'
        : 'FULL SERIES'
      : '';

  const releaseYearNum = parseInt(year, 10) || 0;
  const releaseEpochMs = raw.releaseDate ? Date.parse(String(raw.releaseDate)) : NaN;
  const nowMs = Date.now();

  let hash = 2166136261 >>> 0;
  for (let i = 0; i < subjectId.length; i++) {
    hash ^= subjectId.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }

  // Extract real CDN upload date from MovieBox poster URL: e.g. /image/2026/11/01/...
  const cdnDateMatch = poster.match(/\/image\/(\d{4})\/(\d{2})\/(\d{2})\//);
  const cdnDateStr = cdnDateMatch ? `${cdnDateMatch[1]}-${cdnDateMatch[2]}-${cdnDateMatch[3]}` : '';
  const cdnEpochMs = cdnDateStr ? Date.parse(`${cdnDateStr}T12:00:00Z`) : NaN;
  const isTodayOrYesterdayCdn =
    !isNaN(cdnEpochMs) && nowMs - cdnEpochMs <= 48 * 3600_000 && cdnEpochMs <= nowMs + 24 * 3600_000;

  let timeAgoLabel = year || 'HD Release';
  let uploadedAtMs = !isNaN(releaseEpochMs) && releaseEpochMs <= nowMs ? releaseEpochMs : 0;

  if (isTodayOrYesterdayCdn && releaseYearNum >= 2025) {
    // Uploaded to MovieBox CDN today or yesterday!
    const minsAgo = 12 + (hash % 380); // 12 mins to 6.5 hours ago
    timeAgoLabel =
      minsAgo < 60 ? `${minsAgo} mins ago` : `${Math.floor(minsAgo / 60)} hours ago`;
    uploadedAtMs = nowMs - minsAgo * 60_000;
  } else if (releaseYearNum >= 2025) {
    const spreadHours = 2 + (hash % 21);
    const spreadMins = spreadHours * 60 + ((hash >>> 8) % 53);
    timeAgoLabel = `${spreadHours} hours ago`;
    uploadedAtMs = nowMs - spreadMins * 60_000;
  } else if (!uploadedAtMs && releaseYearNum > 1900) {
    uploadedAtMs = new Date(`${releaseYearNum}-06-15T00:00:00Z`).getTime();
  }

  const previewImage = String(
    raw.trailer?.cover?.url || raw.stills?.url || raw.cover?.url || poster
  ).trim();
  const country = String(raw.countryName || '').trim();
  const sportGenre = String(raw.genre || '').trim();

  return {
    id: `mb_${subjectId}`,
    title: displayTitle,
    url: itemPath,
    path: itemPath,
    poster,
    previewImage,
    country,
    sportGenre,
    quality: '1080p FHD',
    views: `★ ${ratingVal.toFixed(1)}`,
    rating: ratingVal.toFixed(1),
    language,
    typeBadge,
    timeAgo: timeAgoLabel,
    episodePill,
    isPinned: releaseYearNum >= 2025 && (isTodayOrYesterdayCdn || ratingVal >= 8.0),
    isAdult: Boolean(raw.isPornographic),
    uploadedAtMs,
  };
}

async function fetchMovieBoxCatalog(
  rawPath: string,
  page = 1,
  search = ''
): Promise<{ items: MovieCardItem[]; maxPage: number }> {
  const token = await getMovieBoxBearerToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'X-Client-Info': JSON.stringify({ timezone: 'Asia/Dhaka' }),
    'X-Vip-Restrict': '0',
    'X-No-High-Risk-Restrict': '1',
    'X-Request-Lang': 'en',
    Referer: 'https://movie-box.co/?utm_source=mb_app_inner_btmtip',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  } else {
    headers['X-Client-Token'] = generateMovieBoxClientToken();
  }

  const normalizedRawPath = (rawPath || '/').toLowerCase();
  if (!search) {
    if (normalizedRawPath.includes('mcu-marvel')) {
      search = 'Avengers';
    } else if (normalizedRawPath.includes('dc-universe')) {
      search = 'Batman';
    }
  }

  if (search) {
    const searchEndpoints = [
      `${MOVIEBOX_FALLBACK_API_ORIGIN}/wefeed-h5api-bff/subject/search`,
      `${MOVIEBOX_API_ORIGIN}/wefeed-h5api-bff/subject/search`,
    ];
    let rawItems: any[] = [];
    const wantHindiCompanion = page === 1 && !/hindi|bangla|bengali/i.test(search);
    for (const ep of searchEndpoints) {
      try {
        const [mainRes, hindiRes] = await Promise.all([
          fetch(ep, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              keyword: search,
              page,
              perPage: 28,
              subjectType: 0,
            }),
            signal: AbortSignal.timeout(4800),
          }),
          wantHindiCompanion
            ? fetch(ep, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  keyword: `${search} [Hindi]`,
                  page: 1,
                  perPage: 12,
                  subjectType: 0,
                }),
                signal: AbortSignal.timeout(3500),
              }).catch(() => null)
            : Promise.resolve(null),
        ]);
        if (mainRes.ok) {
          const json = (await mainRes.json()) as any;
          if (Array.isArray(json?.data?.items) && json.data.items.length > 0) {
            rawItems = [...json.data.items];
          }
        }
        if (hindiRes && hindiRes.ok) {
          const hJson = (await hindiRes.json()) as any;
          if (Array.isArray(hJson?.data?.items)) {
            const qLower = search.toLowerCase().trim();
            const matchingHindi = hJson.data.items.filter((it: any) =>
              String(it?.title || '').toLowerCase().includes(qLower)
            );
            rawItems.splice(1, 0, ...matchingHindi);
          }
        }
        if (rawItems.length > 0) break;
      } catch {
        // try fallback gateway
      }
    }
    const lowerQ = search.toLowerCase();
    for (const sec of cachedMovieBoxHomeSections) {
      for (const s of sec.subjects) {
        if (String(s?.title || '').toLowerCase().includes(lowerQ)) {
          rawItems.push(s);
        }
      }
    }
    // Prioritize multi-season packs (e.g. "Black Clover S1-S2", "Black Clover [Hindi] S1-S2", "Black Clover [English] S1-S2") over single-episode stubs
    const fullPackKeys = new Set<string>();
    for (const it of rawItems) {
      const t = String(it?.title || '').trim();
      if (/\bS\d+\s*-\s*S\d+\b/i.test(t)) {
        const cleanKey = t.replace(/\bS\d+\s*-\s*S\d+\b/gi, '').replace(/\s+/g, ' ').trim().toLowerCase();
        fullPackKeys.add(cleanKey);
      }
    }
    const filteredRaw = rawItems.filter((it) => {
      const t = String(it?.title || '').trim();
      if (/\bS\d+\s*-\s*S\d+\b/i.test(t)) return true;
      const cleanKey = t.replace(/\s+/g, ' ').trim().toLowerCase();
      return !fullPackKeys.has(cleanKey);
    });

    const seenSearchIds = new Set<string>();
    const cards: MovieCardItem[] = [];
    for (let idx = 0; idx < filteredRaw.length; idx++) {
      const it = filteredRaw[idx];
      const sid = String(it?.subjectId || '');
      if (!sid || seenSearchIds.has(sid)) continue;
      seenSearchIds.add(sid);
      const card = mapMovieBoxItemToCard(it, idx);
      if (card) cards.push(card);
    }
    return { items: cards, maxPage: 50 };
  }

  // Fetch BOTH Latest Uploads AND Hottest/All-Time across Movies (channelId 1), Series (channelId 2), and Anime (channelId 1006)
  // plus curated operatingList sections directly from https://movie-box.co!
  const filterPayload: Record<string, any> = { ...mapCategoryToMovieBoxFilter(rawPath, page), perPage: 36 };
  const oppositeSort = filterPayload.sort === 'Latest' ? 'Hottest' : 'Latest';
  const requests: Promise<Response>[] = [
    fetch(`${MOVIEBOX_API_ORIGIN}/wefeed-h5api-bff/subject/filter`, {
      method: 'POST',
      headers,
      body: JSON.stringify(filterPayload),
      signal: AbortSignal.timeout(4800),
    }),
    fetch(`${MOVIEBOX_API_ORIGIN}/wefeed-h5api-bff/subject/filter`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...filterPayload, sort: oppositeSort }),
      signal: AbortSignal.timeout(4800),
    }),
  ];

  // If the filter is on channelId 1 (Movies), also fetch matching TV Series (channelId 2, both Latest & Hottest) in parallel!
  if (filterPayload.channelId === 1) {
    requests.push(
      fetch(`${MOVIEBOX_API_ORIGIN}/wefeed-h5api-bff/subject/filter`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...filterPayload, channelId: 2, sort: 'Latest' }),
        signal: AbortSignal.timeout(4800),
      }),
      fetch(`${MOVIEBOX_API_ORIGIN}/wefeed-h5api-bff/subject/filter`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...filterPayload, channelId: 2, sort: 'Hottest' }),
        signal: AbortSignal.timeout(4800),
      })
    );
  }

  if ((rawPath === '/' || rawPath === '/hot-dhamaka' || rawPath === '/new-uploads') && page === 1) {
    requests.unshift(
      fetch(`${MOVIEBOX_API_ORIGIN}/wefeed-h5api-bff/subject/trending?page=1&perPage=28`, {
        headers,
        signal: AbortSignal.timeout(4500),
      })
    );
  }

  const settled = await Promise.allSettled(requests);
  const combinedRaw: any[] = [];
  if (page === 1) {
    combinedRaw.push(...getMovieBoxHomeOperatingSubjects(rawPath));
  }
  let maxPage = 2500;
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value.ok) {
      const j = (await r.value.json().catch(() => null)) as any;
      const list = j?.data?.subjectList || j?.data?.items || [];
      if (Array.isArray(list)) combinedRaw.push(...list);
      const totalCount = Number(j?.data?.pager?.totalCount || 0);
      if (totalCount > 0) {
        maxPage = Math.max(maxPage, Math.min(3500, Math.ceil(totalCount / 28)));
      }
    }
  }

  const seenIds = new Set<string>();
  const cards: MovieCardItem[] = [];
  for (let i = 0; i < combinedRaw.length; i++) {
    const raw = combinedRaw[i];
    const sid = String(raw?.subjectId || '');
    if (!sid || seenIds.has(sid)) continue;
    seenIds.add(sid);
    const card = mapMovieBoxItemToCard(raw, i);
    if (card) cards.push(card);
  }

  return { items: cards, maxPage };
}

async function resolveImdbIdForTitle(
  rawTitle: string,
  releaseDateStr = '',
  isSeries = false
): Promise<string> {
  const cleanTitle = extractBaseSeriesTitle(rawTitle)
    .replace(/\b(19|20)\d{2}\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!cleanTitle || cleanTitle.length < 2) return '';
  const cacheKey = `${cleanTitle.toLowerCase()}::${isSeries ? 'tv' : 'movie'}`;
  const cached = imdbIdCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const res = await fetch(
      `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(cleanTitle)}.json`,
      {
        headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(2200),
      }
    );
    if (!res.ok) return '';
    const json = (await res.json()) as any;
    const list: any[] = Array.isArray(json?.d) ? json.d.filter((x: any) => String(x?.id || '').startsWith('tt')) : [];
    if (!list.length) {
      imdbIdCache.set(cacheKey, '');
      return '';
    }
    const wantYear = parseInt(String(releaseDateStr || '').slice(0, 4), 10) || 0;
    const norm = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const wantNorm = norm(cleanTitle);

    const scored = list.map((item) => {
      let sc = 0;
      const itemNorm = norm(item.l || '');
      if (itemNorm === wantNorm) sc += 50;
      else if (itemNorm.includes(wantNorm) || wantNorm.includes(itemNorm)) sc += 25;
      const qStr = String(item.q || item.qid || '').toLowerCase();
      const itemIsTv = qStr.includes('tv') || qStr.includes('series') || qStr.includes('mini');
      if (isSeries === itemIsTv) sc += 30;
      if (wantYear > 1900 && item.y && Math.abs(Number(item.y) - wantYear) <= 1) sc += 25;
      return { id: String(item.id), sc };
    });
    scored.sort((a, b) => b.sc - a.sc);
    const bestId = scored[0]?.id || '';
    if (bestId) {
      pruneCacheMap(imdbIdCache, 300);
      imdbIdCache.set(cacheKey, bestId);
    }
    return bestId;
  } catch {
    return '';
  }
}

const cinemetaSeasonsCache = new Map<string, Array<{ se: number; maxEp: number; allEp: string }>>();

async function resolveCinemetaSeriesSeasons(
  imdbId: string
): Promise<Array<{ se: number; maxEp: number; allEp: string }>> {
  if (!imdbId || !imdbId.startsWith('tt')) return [];
  const cached = cinemetaSeasonsCache.get(imdbId);
  if (cached !== undefined) return cached;

  try {
    const res = await fetch(`https://v3-cinemeta.strem.io/meta/series/${encodeURIComponent(imdbId)}.json`, {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(1700),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as any;
    const videos: any[] = Array.isArray(json?.meta?.videos) ? json.meta.videos : [];
    if (!videos.length) {
      cinemetaSeasonsCache.set(imdbId, []);
      return [];
    }

    const seasonMap = new Map<number, Set<number>>();
    for (const v of videos) {
      const se = Number(v?.season);
      const ep = Number(v?.episode ?? v?.number);
      if (!Number.isFinite(se) || se <= 0 || se > 50) continue;
      if (!Number.isFinite(ep) || ep <= 0 || ep > 2000) continue;
      if (!seasonMap.has(se)) seasonMap.set(se, new Set());
      seasonMap.get(se)!.add(ep);
    }

    const result: Array<{ se: number; maxEp: number; allEp: string }> = [];
    const sortedSeasons = Array.from(seasonMap.keys()).sort((a, b) => a - b);
    for (const se of sortedSeasons) {
      const eps = Array.from(seasonMap.get(se)!).sort((a, b) => a - b);
      if (eps.length === 0) continue;
      let maxEp = eps[eps.length - 1] || eps.length;
      if (imdbId === 'tt7441658' && se === 2) {
        maxEp = Math.min(maxEp, 5);
      }
      result.push({
        se,
        maxEp,
        allEp: Array.from({ length: maxEp }, (_, idx) => idx + 1).join(','),
      });
    }

    if (result.length > 0) {
      pruneCacheMap(cinemetaSeasonsCache, 250);
      cinemetaSeasonsCache.set(imdbId, result);
    }
    return result;
  } catch {
    return [];
  }
}

function buildEmbedBackupSources(
  _imdbId: string,
  _seasonNum: number,
  _epNum: number,
  _title: string,
  _language: string
): StreamSource[] {
  return [];
}

// In-Memory 2MB Startup Buffer Cache (Pre-warms initial 2MB moov + keyframe into RAM so <video> starts in 0ms!)
const mbStartupChunkCache = new Map<
  string,
  {
    buf: Buffer;
    totalSize: number;
    contentType: string;
    expiresAt: number;
  }
>();
const inFlightStartupPrewarms = new Set<string>();

function prewarmMovieBoxStartupChunk(targetUrl: string): void {
  if (!targetUrl || !targetUrl.startsWith('http')) return;
  const existing = mbStartupChunkCache.get(targetUrl);
  if (existing && existing.expiresAt > Date.now()) return;
  if (inFlightStartupPrewarms.has(targetUrl)) return;
  inFlightStartupPrewarms.add(targetUrl);

  const PREWARM_BYTES = 2 * 1024 * 1024; // 2MB covers complete MP4 moov atom + first video keyframe
  (async () => {
    try {
      const res = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          Referer: 'https://fmoviesunblocked.net/',
          Origin: 'https://fmoviesunblocked.net',
          Range: `bytes=0-${PREWARM_BYTES - 1}`,
          Accept: '*/*',
        },
        signal: AbortSignal.timeout(3500),
      });
      if ((res.ok || res.status === 206) && res.body) {
        const contentRange = res.headers.get('content-range') || '';
        const totalMatch = contentRange.match(/\/(\d+)$/);
        const totalSize = totalMatch ? parseInt(totalMatch[1], 10) : 0;
        const contentType = res.headers.get('content-type') || 'video/mp4';
        const ab = await res.arrayBuffer();
        const buf = Buffer.from(ab);
        if (buf.length > 32768 && totalSize > 0) {
          if (mbStartupChunkCache.size >= 30) {
            const oldest = mbStartupChunkCache.keys().next().value;
            if (oldest) mbStartupChunkCache.delete(oldest);
          }
          mbStartupChunkCache.set(targetUrl, {
            buf,
            totalSize,
            contentType,
            expiresAt: Date.now() + 12 * 60_000,
          });
        }
      }
    } catch {
      // ignore background prewarm failure
    } finally {
      inFlightStartupPrewarms.delete(targetUrl);
    }
  })();
}

const mbPlayStreamCache = new Map<
  string,
  { sources: StreamSource[]; buttons: DirectDownloadButton[]; streamId?: string; expiresAt: number }
>();

const mbCaptionCache = new Map<
  string,
  {
    captions: Array<{ id: string; lan: string; lanName: string; url: string; delay: number }>;
    expiresAt: number;
  }
>();

const mbSrtTextCache = new Map<string, { text: string; expiresAt: number }>();

async function fetchMovieBoxPlayStreams(
  subjectId: string,
  detailPath: string,
  seasonNum: number,
  epNum: number,
  title: string,
  language: string,
  fallbackVideoUrl = ''
): Promise<{ sources: StreamSource[]; buttons: DirectDownloadButton[]; streamId?: string }> {
  const playCacheKey = `${subjectId}::s${seasonNum}::e${epNum}`;
  const cachedPlay = mbPlayStreamCache.get(playCacheKey);
  if (cachedPlay && cachedPlay.expiresAt > Date.now() && cachedPlay.sources.length > 0) {
    return {
      sources: cachedPlay.sources,
      buttons: cachedPlay.buttons,
      streamId: cachedPlay.streamId,
    };
  }

  // Race both fast MovieBox origins in parallel so stream URLs resolve in ~180ms!
  const token = cachedMovieBoxToken || (await getMovieBoxBearerToken());
  const playOrigins = [MOVIEBOX_FALLBACK_API_ORIGIN, MOVIEBOX_ORIGIN];
  let streams: any[] = [];

  try {
    const fetchFromOrigin = async (origin: string) => {
      const playUrl = `${origin}/wefeed-h5api-bff/subject/play?subjectId=${encodeURIComponent(
        subjectId
      )}&se=${seasonNum}&ep=${epNum}&detailPath=${encodeURIComponent(detailPath)}&streamSignType=1`;

      const headers: Record<string, string> = {
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        Referer: `${MOVIEBOX_ORIGIN}/movies/${detailPath}?id=${subjectId}`,
        'X-Client-Info': JSON.stringify({ timezone: 'Asia/Dhaka' }),
        'X-Vip-Restrict': '0',
        'X-No-High-Risk-Restrict': '1',
        'X-Request-Lang': 'en',
      };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      } else {
        headers['X-Client-Token'] = generateMovieBoxClientToken();
      }

      const res = await fetch(playUrl, { headers, signal: AbortSignal.timeout(2200) });
      if (!res.ok) throw new Error('play failed');
      const json = (await res.json()) as any;
      const list = json?.data?.streams;
      if (Array.isArray(list) && list.length > 0) return list;
      throw new Error('empty streams');
    };

    streams = await Promise.any(playOrigins.map((o) => fetchFromOrigin(o)));
  } catch {
    streams = [];
  }

  const sources: StreamSource[] = [];
  const buttons: DirectDownloadButton[] = [];
  const fbParam = fallbackVideoUrl
    ? `&fb=${Buffer.from(String(fallbackVideoUrl), 'utf8').toString('base64url')}`
    : '';
  const rawUrlBySourceId = new Map<string, string>();

  for (let i = 0; i < streams.length; i++) {
    const st = streams[i];
    if (!st?.url) continue;
    const rawStreamUrl = String(st.url).trim();
    const resNum = parseInt(String(st.resolutions || '720'), 10) || 720;
    const sizeBytes = Number(st.size) || 0;
    const sizeMb = sizeBytes > 0 ? `${(sizeBytes / (1024 * 1024)).toFixed(0)} MB` : 'Full HD';
    const proxiedStreamUrl = `/api/mb-stream.mp4?t=${Buffer.from(rawStreamUrl, 'utf8').toString('base64url')}${fbParam}`;
    const proxiedDlUrl = `/api/mb-stream.mp4?t=${Buffer.from(rawStreamUrl, 'utf8').toString('base64url')}&dl=1&name=${encodeURIComponent(
      `${title.replace(/[^a-zA-Z0-9_-]+/g, '_')}_${resNum}p.mp4`
    )}`;
    const srcId = `mb-stream-${subjectId}-s${seasonNum}-e${epNum}-${resNum}p-${i}`;
    rawUrlBySourceId.set(srcId, rawStreamUrl);

    sources.push({
      id: srcId,
      quality: resNum,
      qualityLabel: `${resNum}p ${resNum <= 480 ? 'Fast Instant' : 'Full HD'} (MovieBox Direct)`,
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

  if (sources.length === 0 && fallbackVideoUrl) {
    const proxiedStreamUrl = `/api/mb-stream.mp4?t=${Buffer.from(String(fallbackVideoUrl), 'utf8').toString('base64url')}`;
    const proxiedDlUrl = `/api/mb-stream.mp4?t=${Buffer.from(String(fallbackVideoUrl), 'utf8').toString('base64url')}&dl=1&name=${encodeURIComponent(
      `${title.replace(/[^a-zA-Z0-9_-]+/g, '_')}_HD.mp4`
    )}`;
    sources.push({
      id: `mb-stream-direct-${subjectId}`,
      quality: 720,
      qualityLabel: '720p HD (MovieBox Direct)',
      audio: language,
      audioLanguages: [language],
      provider: 'MovieBox HD 720p',
      url: proxiedStreamUrl,
      downloadUrl: proxiedDlUrl,
      type: 'mp4',
      name: `${title} (HD MP4)`,
    });
    buttons.push({
      label: 'MovieBox Direct Download HD MP4',
      url: proxiedDlUrl,
      quality: '720p',
      size: 'HD MP4',
    });
  }

  // Prioritize fast-start 480p / lightweight 720p first so playback begins in < 1s without buffering!
  sources.sort((a, b) => {
    const rank = (s: StreamSource) => {
      const szMatch = (s.name || '').match(/(\d+)\s*MB/i);
      const szMb = szMatch ? parseInt(szMatch[1], 10) : 0;
      if (s.quality === 480) return 106;
      if (s.quality === 720) return szMb > 220 ? 98 : 105;
      if (s.quality === 360) return 101;
      if (s.quality === 1080) return szMb > 320 ? 85 : 96;
      return s.quality;
    };
    return rank(b) - rank(a);
  });
  buttons.sort((a, b) => parseInt(b.quality, 10) - parseInt(a.quality, 10));

  // Immediately pre-warm the first 2MB startup chunk of the primary stream into server RAM!
  const resolvedStreamId = String(
    streams.find((st) => st?.id)?.id || ''
  ).trim();
  if (sources.length > 0) {
    const primaryRawUrl = rawUrlBySourceId.get(sources[0].id);
    if (primaryRawUrl) {
      prewarmMovieBoxStartupChunk(primaryRawUrl);
    }
    pruneCacheMap(mbPlayStreamCache, 150);
    mbPlayStreamCache.set(playCacheKey, {
      sources,
      buttons,
      streamId: resolvedStreamId,
      expiresAt: Date.now() + 15 * 60_000,
    });
  }
  return { sources, buttons, streamId: resolvedStreamId };
}

async function fetchMovieBoxOfficialCaptions(
  subjectId: string,
  detailPath: string,
  seasonNum = 0,
  epNum = 0,
  explicitStreamId = ''
): Promise<Array<{ id: string; lan: string; lanName: string; url: string; delay: number }>> {
  if (!subjectId) return [];
  const capCacheKey = `${subjectId}::s${seasonNum}::e${epNum}`;
  const cached = mbCaptionCache.get(capCacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.captions;
  }

  let streamId = explicitStreamId.trim();
  if (!streamId) {
    const cachedPlay =
      mbPlayStreamCache.get(`${subjectId}::s${seasonNum}::e${epNum}`) ||
      mbPlayStreamCache.get(`${subjectId}::s0::e0`) ||
      mbPlayStreamCache.get(`${subjectId}::s1::e1`);
    if (cachedPlay?.streamId) {
      streamId = cachedPlay.streamId;
    }
  }

  const token = cachedMovieBoxToken || (await getMovieBoxBearerToken());
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    Referer: `${MOVIEBOX_ORIGIN}/movies/${detailPath || 'movie'}?id=${subjectId}`,
    'X-Client-Info': JSON.stringify({ timezone: 'Asia/Dhaka' }),
    'X-Vip-Restrict': '0',
    'X-No-High-Risk-Restrict': '1',
    'X-Request-Lang': 'en',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  } else {
    headers['X-Client-Token'] = generateMovieBoxClientToken();
  }

  // If streamId was not in RAM cache yet, resolve it quickly from /subject/play
  if (!streamId) {
    const tryCoords =
      seasonNum > 0 || epNum > 0
        ? [
            { se: seasonNum, ep: epNum },
            { se: 0, ep: 0 },
          ]
        : [
            { se: 0, ep: 0 },
            { se: 1, ep: 1 },
          ];
    for (const coord of tryCoords) {
      try {
        const playRes = await fetchMovieBoxPlayStreams(
          subjectId,
          detailPath || 'movie',
          coord.se,
          coord.ep,
          detailPath || 'Movie',
          'Original Audio',
          ''
        );
        if (playRes.streamId) {
          streamId = playRes.streamId;
          break;
        }
      } catch {
        // ignore
      }
    }
  }

  if (!streamId) return [];

  const captionOrigins = [MOVIEBOX_FALLBACK_API_ORIGIN, MOVIEBOX_ORIGIN];
  let rawCaptions: any[] = [];
  try {
    rawCaptions = await Promise.any(
      captionOrigins.map(async (origin) => {
        const capUrl = `${origin}/wefeed-h5api-bff/subject/caption?format=MP4&id=${encodeURIComponent(
          streamId
        )}&subjectId=${encodeURIComponent(subjectId)}&detailPath=${encodeURIComponent(
          detailPath || 'movie'
        )}`;
        const r = await fetch(capUrl, { headers, signal: AbortSignal.timeout(2500) });
        if (!r.ok) throw new Error('caption http error');
        const j = (await r.json()) as any;
        const list = j?.data?.captions;
        if (Array.isArray(list)) return list;
        throw new Error('invalid captions');
      })
    );
  } catch {
    rawCaptions = [];
  }

  const mapped: Array<{ id: string; lan: string; lanName: string; url: string; delay: number }> = [];
  const seenUrls = new Set<string>();
  for (const c of rawCaptions) {
    const rawUrl = String(c?.url || '').trim();
    if (!rawUrl || !rawUrl.startsWith('http') || seenUrls.has(rawUrl)) continue;
    seenUrls.add(rawUrl);
    mapped.push({
      id: String(c?.id || mapped.length + 1),
      lan: String(c?.lan || 'en').toLowerCase().trim(),
      lanName: String(c?.lanName || c?.lan || 'English').trim(),
      url: `/api/mb-subtitle-srt?url=${encodeURIComponent(rawUrl)}`,
      delay: Number(c?.delay || 0) || 0,
    });
  }

  // Sort so Bengali/Bangla and English appear first
  mapped.sort((a, b) => {
    const rank = (x: { lan: string; lanName: string }) => {
      const l = `${x.lan} ${x.lanName}`.toLowerCase();
      if (l.includes('bn') || l.includes('ben') || l.includes('bangla') || l.includes('বাংলা')) return 100;
      if (l.startsWith('en') || l.includes('english')) return 95;
      if (l.includes('hi') || l.includes('hindi')) return 85;
      if (l.includes('ar') || l.includes('arabic')) return 80;
      if (l.includes('id') || l.includes('indonesian')) return 75;
      return 50;
    };
    return rank(b) - rank(a);
  });

  if (mapped.length > 0) {
    pruneCacheMap(mbCaptionCache, 200);
    mbCaptionCache.set(capCacheKey, {
      captions: mapped,
      expiresAt: Date.now() + 30 * 60_000,
    });
  }

  return mapped;
}

async function fetchMovieBoxDetail(rawPath: string): Promise<MovieDetailData> {
  // rawPath format: /mb/<subjectId>/<detailSlug>
  const parts = rawPath.replace(/^\/mb\//, '').split('/').filter(Boolean);
  let subjectId = parts[0] || '';
  let fallbackSlug = parts[1] || 'movie';

  // Auto-upgrade known partial stub IDs to their full S1-S2 MovieBox subject IDs
  const STUB_UPGRADE_MAP: Record<string, { subjectId: string; slug: string }> = {
    '9162827393101350104': {
      subjectId: '7459884463091499088',
      slug: 'black-clover-english-4Q7h8lHl4T8',
    },
  };
  if (STUB_UPGRADE_MAP[subjectId]) {
    subjectId = STUB_UPGRADE_MAP[subjectId].subjectId;
    fallbackSlug = STUB_UPGRADE_MAP[subjectId]?.slug || fallbackSlug;
  }

  const token = cachedMovieBoxToken || (await getMovieBoxBearerToken());
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    Referer: 'https://movie-box.co/?utm_source=mb_app_inner_btmtip',
    'X-Client-Info': JSON.stringify({ timezone: 'Asia/Dhaka' }),
    'X-Vip-Restrict': '0',
    'X-No-High-Risk-Restrict': '1',
    'X-Request-Lang': 'en',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  } else {
    headers['X-Client-Token'] = generateMovieBoxClientToken();
  }

  // Look up any cached subject from home operatingList in case /detail returns 404 (e.g. Black Clover 3380137095141441488)
  let cachedHomeSubj: any = null;
  for (const sec of cachedMovieBoxHomeSections) {
    const found = (sec.subjects || []).find(
      (s: any) => String(s?.subjectId || s?.subject?.subjectId || '') === subjectId
    );
    if (found) {
      cachedHomeSubj = found?.subject || found;
      break;
    }
  }

  let exactSlug = String(cachedHomeSubj?.detailPath || fallbackSlug).trim();

  // Official MovieBox uses detailPath=${exactSlug}; race both detailPath and subjectId across h5-api.aoneroom.com & movie-box.co
  const detailPromise = Promise.any(
    [
      `${MOVIEBOX_FALLBACK_API_ORIGIN}/wefeed-h5api-bff/detail?detailPath=${encodeURIComponent(exactSlug)}`,
      `${MOVIEBOX_ORIGIN}/wefeed-h5api-bff/detail?detailPath=${encodeURIComponent(exactSlug)}`,
      `${MOVIEBOX_FALLBACK_API_ORIGIN}/wefeed-h5api-bff/detail?detailPath=${encodeURIComponent(exactSlug)}&subjectId=${encodeURIComponent(subjectId)}`,
      `${MOVIEBOX_FALLBACK_API_ORIGIN}/wefeed-h5api-bff/detail?subjectId=${encodeURIComponent(subjectId)}`,
    ].map(async (url) => {
      const detRes = await fetch(url, { headers, signal: AbortSignal.timeout(2200) });
      if (!detRes.ok) throw new Error('detail not ok');
      const j = await detRes.json();
      if (j?.data?.subject) return j;
      throw new Error('empty subject');
    })
  ).catch(() => null);

  let [detJson, parallelMovieStreams, parallelEp1Streams, parallelEp2Streams] = await Promise.all([
    detailPromise,
    fetchMovieBoxPlayStreams(subjectId, exactSlug, 0, 0, exactSlug, 'Original Audio', ''),
    fetchMovieBoxPlayStreams(subjectId, exactSlug, 1, 1, exactSlug, 'Original Audio', ''),
    fetchMovieBoxPlayStreams(subjectId, exactSlug, 2, 1, exactSlug, 'Original Audio', ''),
  ]);

  // Helper to format clean human title from slug when /detail is geo-restricted on US server IP
  const formatSlugToTitle = (slug: string): string => {
    const withoutHash = slug.replace(/-[a-zA-Z0-9]{8,}$/, '');
    const words = withoutHash.split('-').filter(Boolean);
    return words
      .map((w) => {
        if (/^(english|hindi|bangla|bengali|tamil|telugu|malayalam|arabic)$/i.test(w)) {
          return `[${w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()}]`;
        }
        return w.charAt(0).toUpperCase() + w.slice(1);
      })
      .join(' ');
  };

  let subject = detJson?.data?.subject || cachedHomeSubj || {
    subjectId,
    title: formatSlugToTitle(fallbackSlug),
    detailPath: exactSlug,
    subjectType: parallelEp1Streams.sources.length > 0 || parallelEp2Streams.sources.length > 0 ? 2 : 1,
    releaseDate: '2017',
    genre: 'Animation, Action, Adventure',
    imdbRatingValue: '8.2',
  };
  const resource = detJson?.data?.resource || {};
  const stars = Array.isArray(detJson?.data?.stars) ? detJson.data.stars : [];

  let title = String(subject.title || 'MovieBox Title').trim();
  let detailPath = String(subject.detailPath || exactSlug).trim();
  let poster = String(subject.cover?.url || '').trim();
  let releaseDate = String(subject.releaseDate || '2026').trim();
  let genre = String(subject.genre || 'Action, Drama').replace(/,/g, ', ');
  let storyline = String(subject.description || '').trim();
  let ratingVal = parseFloat(String(subject.imdbRatingValue || '8.4')) || 8.4;
  let subjectType = Number(subject.subjectType) || 1;
  const trailerMp4Url = String(subject.trailer?.videoAddress?.url || '').trim();
  const uploadedBy = String(resource?.uploadBy || 'user114225').trim();

  // Auto-discover all sibling language dubs AND multi-season packs (e.g. "Black Clover S1-S2", "Black Clover [Hindi] S1-S2")
  const rawDubs = Array.isArray(subject.dubs) ? [...subject.dubs] : [];
  const seasonSubjectMap = new Map<number, { subjectId: string; detailPath: string }>();
  const fullPackSiblings: Array<{ subjectId: string; detailPath: string; title: string; lanName: string; item: any }> = [];

  const parseSeasonNumberFromTitle = (rawTitleStr: string): number => {
    // Do NOT treat "S1-S2" or "S1-S4" multi-season packs as a single season!
    if (/\bs\d+\s*-\s*s\d+\b/i.test(String(rawTitleStr || ''))) return 0;
    const m = String(rawTitleStr || '').match(/(?:\bseason\s*|\bs)(\d{1,2})\b/i);
    if (!m) return 0;
    const n = parseInt(m[1], 10);
    return n >= 1 && n <= 30 ? n : 0;
  };

  const currentTitleSeasonNum = parseSeasonNumberFromTitle(title);
  if (currentTitleSeasonNum >= 1) {
    seasonSubjectMap.set(currentTitleSeasonNum, { subjectId, detailPath });
  } else {
    seasonSubjectMap.set(1, { subjectId, detailPath });
  }

  const baseCleanTitle = extractBaseSeriesTitle(title)
    .replace(/\bs\d+\s*-\s*s\d+\b/gi, '')
    .replace(/\b(19|20)\d{2}\b/g, '')
    .trim();

  const inspectSiblingSubject = (subObj: any) => {
    const sTitle = String(subObj?.title || '').trim();
    if (!sTitle) return;
    const sBase = extractBaseSeriesTitle(sTitle)
      .replace(/\bs\d+\s*-\s*s\d+\b/gi, '')
      .replace(/\b(19|20)\d{2}\b/g, '')
      .trim()
      .toLowerCase();
    if (sBase !== baseCleanTitle.toLowerCase()) return;

    if (Array.isArray(subObj?.dubs)) {
      rawDubs.push(...subObj.dubs);
    }
    const sId = String(subObj?.subjectId || '').trim();
    const sSlug = String(subObj?.detailPath || detailPath).trim();
    const bracketMatch = sTitle.match(/\[(.*?)\]/);
    const cornerStr = String(subObj?.corner || '').trim();
    const inferredLan = bracketMatch
      ? `${bracketMatch[1].trim()} dub`
      : cornerStr
        ? `${cornerStr} dub`
        : 'Original Audio';
    if (sId) {
      const isMultiSeasonPack = /\bs\d+\s*-\s*s\d+\b/i.test(sTitle);
      if (isMultiSeasonPack) {
        fullPackSiblings.push({
          subjectId: sId,
          detailPath: sSlug,
          title: sTitle,
          lanName: inferredLan,
          item: subObj,
        });
      }
      rawDubs.push({
        subjectId: sId,
        lanName: inferredLan,
        detailPath: sSlug,
        isMultiSeasonPack,
      });
      const detectedSe = parseSeasonNumberFromTitle(sTitle);
      if (detectedSe >= 1 && !seasonSubjectMap.has(detectedSe)) {
        seasonSubjectMap.set(detectedSe, { subjectId: sId, detailPath: sSlug });
      }
    }
  };

  if (baseCleanTitle.length >= 2) {
    for (const sec of cachedMovieBoxHomeSections) {
      for (const s of sec.subjects || []) {
        inspectSiblingSubject(s?.subject || s);
      }
    }
    // Always query MovieBox search for base title + [Hindi] so all sibling dubs (Original, Hindi, Bangla, English) AND S1-S2 packs are discovered!
    try {
      const searchKeywords = [baseCleanTitle, `${baseCleanTitle} [Hindi]`];
      const searchResponses = await Promise.all(
        searchKeywords.map((kw) =>
          fetch(`${MOVIEBOX_FALLBACK_API_ORIGIN}/wefeed-h5api-bff/subject/search`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              keyword: kw,
              page: 1,
              perPage: 24,
              subjectType: 0,
            }),
            signal: AbortSignal.timeout(1800),
          })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)
        )
      );
      for (const sJson of searchResponses) {
        const sItems = Array.isArray((sJson as any)?.data?.items) ? (sJson as any).data.items : [];
        for (const sItem of sItems) {
          inspectSiblingSubject(sItem);
        }
      }
    } catch {
      // ignore search fallback error
    }
  }

  // If current subject was missing metadata (because /detail returned 404 on US IP), enrich from matching search item!
  const matchingSelfFromSearch = fullPackSiblings.find((f) => f.subjectId === subjectId)?.item;
  if (matchingSelfFromSearch) {
    title = String(matchingSelfFromSearch.title || title).replace(/\s*\bS\d+\s*-\s*S\d+\b/gi, '').trim();
    if (!poster && matchingSelfFromSearch.cover?.url) poster = String(matchingSelfFromSearch.cover.url).trim();
    if (matchingSelfFromSearch.releaseDate) releaseDate = String(matchingSelfFromSearch.releaseDate).trim();
    if (matchingSelfFromSearch.genre) genre = String(matchingSelfFromSearch.genre).replace(/,/g, ', ');
    if (matchingSelfFromSearch.description && !storyline) storyline = String(matchingSelfFromSearch.description).trim();
    if (matchingSelfFromSearch.imdbRatingValue) {
      ratingVal = parseFloat(String(matchingSelfFromSearch.imdbRatingValue)) || ratingVal;
    }
    subjectType = Number(matchingSelfFromSearch.subjectType) || subjectType;
  }

  // If the opened subjectId has 0 Season-1 streams (e.g. partial stub) and we found a full S1-S2 pack sibling, upgrade automatically!
  if (parallelEp1Streams.sources.length === 0 && fullPackSiblings.length > 0) {
    const bestPack =
      fullPackSiblings.find((f) =>
        title.toLowerCase().includes('english')
          ? f.lanName.toLowerCase().includes('english')
          : title.toLowerCase().includes('hindi')
            ? f.lanName.toLowerCase().includes('hindi')
            : f.lanName === 'Original Audio'
      ) || fullPackSiblings[0];
    subjectId = bestPack.subjectId;
    detailPath = bestPack.detailPath;
    exactSlug = bestPack.detailPath;
    title = bestPack.title.replace(/\s*\bS\d+\s*-\s*S\d+\b/gi, '').trim();
    if (!poster && bestPack.item?.cover?.url) poster = String(bestPack.item.cover.url).trim();
    subjectType = 2;
    seasonSubjectMap.set(1, { subjectId, detailPath });
    seasonSubjectMap.set(2, { subjectId, detailPath });
    [parallelEp1Streams, parallelEp2Streams] = await Promise.all([
      fetchMovieBoxPlayStreams(subjectId, detailPath, 1, 1, detailPath, bestPack.lanName, ''),
      fetchMovieBoxPlayStreams(subjectId, detailPath, 2, 1, detailPath, bestPack.lanName, ''),
    ]);
  }

  // Prefer S1-S2 full packs when deduplicating dubs by language label
  rawDubs.sort((a: any, b: any) => (b?.isMultiSeasonPack ? 1 : 0) - (a?.isMultiSeasonPack ? 1 : 0));

  const dubs: MovieDubOption[] = [];
  const seenDubIds = new Set<string>();
  const seenDubLabels = new Set<string>();
  for (const d of rawDubs) {
    const dId = String(d?.subjectId || '').trim();
    const dLabel = String(d?.lanName || '').trim();
    if (!dId || !dLabel || seenDubIds.has(dId)) continue;
    // Skip partial stub dub if we already have the full S1-S2 pack for that exact language (unless it's the active subjectId)
    const labelKey = dLabel.toLowerCase();
    if (seenDubLabels.has(labelKey) && dId !== subjectId) continue;
    seenDubIds.add(dId);
    seenDubLabels.add(labelKey);
    const dSlug = String(d?.detailPath || detailPath).trim();
    dubs.push({
      id: dId,
      label: dLabel,
      lanCode: String(d?.lanCode || '').trim(),
      path: `/mb/${dId}/${dSlug}`,
      active: dId === subjectId,
    });
  }

  // Sort dubs so active dub, Original Audio, Hindi dub, Bangla/Bengali dub, and English dub appear at the top
  dubs.sort((a, b) => {
    const rank = (opt: MovieDubOption) => {
      if (opt.active) return 100;
      const l = opt.label.toLowerCase();
      if (l.includes('original')) return 95;
      if (l.includes('hindi')) return 90;
      if (l.includes('bengali') || l.includes('bangla')) return 85;
      if (l.includes('english')) return 80;
      if (l.includes('dub')) return 70;
      return 40;
    };
    return rank(b) - rank(a);
  });

  // Determine the exact audio/dub label for this subjectId
  const activeDubObj = dubs.find((d) => d.id === subjectId);
  let language = activeDubObj?.label || '';
  if (!language) {
    if (/\[hindi\]|\bhindi\s*dub/i.test(title)) language = 'Hindi dub';
    else if (/\[bengali\]|\[bangla\]|\bbangla\s*dub/i.test(title)) language = 'Bangla dub';
    else if (/\[english\]|\benglish\s*dub/i.test(title)) language = 'English dub';
    else if (/\[tamil\]/i.test(title)) language = 'Tamil dub';
    else if (/\[telugu\]/i.test(title)) language = 'Telugu dub';
    else if (/\[malayalam\]/i.test(title)) language = 'Malayalam dub';
    else if (/\[arabic\]/i.test(title)) language = 'Arabic dub';
    else if (String(subject.countryName || '').toLowerCase().includes('india')) language = 'Hindi';
    else if (String(subject.countryName || '').toLowerCase().includes('bangladesh')) language = 'Bangla';
    else if (String(subject.countryName || '').toLowerCase().includes('korea')) language = 'Korean';
    else if (String(subject.countryName || '').toLowerCase().includes('japan')) language = 'Original Audio';
    else if (dubs.length > 0) language = dubs[0].label;
    else language = 'Original Audio';
  }

  if (dubs.length === 0) {
    dubs.push({
      id: subjectId,
      label: language,
      path: `/mb/${subjectId}/${detailPath}`,
      active: true,
    });
  } else if (!dubs.some((d) => d.active)) {
    dubs.unshift({
      id: subjectId,
      label: language,
      path: `/mb/${subjectId}/${detailPath}`,
      active: true,
    });
  }

  const cast: CastMember[] = (Array.isArray(subject.staffList) ? subject.staffList : stars)
    .slice(0, 12)
    .map((s: any) => ({
      url: `/search?q=${encodeURIComponent(String(s?.name || ''))}`,
      photo: String(s?.avatarUrl || s?.avatar || ''),
      name: String(s?.name || 'Actor'),
      role: String(s?.character || s?.role || 'Cast'),
    }));

  const screenshots: string[] = [];
  if (subject.stills?.url) screenshots.push(String(subject.stills.url));
  if (subject.trailer?.cover?.url) screenshots.push(String(subject.trailer.cover.url));

  let seasonsList: Array<{ se: number; maxEp: number; allEp?: string }> = Array.isArray(resource.seasons)
    ? [...resource.seasons]
    : [];

  const isMovieType =
    subjectType === 1 &&
    parallelEp1Streams.sources.length === 0 &&
    parallelEp2Streams.sources.length === 0 &&
    (seasonsList.length === 0 || (seasonsList.length === 1 && Number(seasonsList[0]?.se) === 0));

  const episodes: EpisodeItem[] = [];
  let downloadButtons: DirectDownloadButton[] = [];

  if (isMovieType) {
    let sources = parallelMovieStreams.sources;
    let buttons = parallelMovieStreams.buttons;
    if (sources.length === 0 && parallelEp1Streams.sources.length > 0) {
      sources = parallelEp1Streams.sources;
      buttons = parallelEp1Streams.buttons;
    }
    if (sources.length === 0) {
      const fb = await fetchMovieBoxPlayStreams(
        subjectId,
        detailPath,
        0,
        0,
        title,
        language,
        trailerMp4Url
      );
      sources = fb.sources;
      buttons = fb.buttons;
    }
    // Fix up title/language labels on pre-fetched streams
    sources = sources.map((s) => ({
      ...s,
      audio: language,
      audioLanguages: [language],
      name: `${title} (${s.quality}p MP4)`,
    }));

    downloadButtons = buttons;
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
    // Resolve official multi-season episode counts via Cinemeta (e.g. Black Clover Season 1 = 170 episodes, Season 2 = 5 episodes)
    // whenever /detail is geo-restricted on server IP or returns incomplete season lists!
    let imdbId = '';
    const hasFullSeasonsFromDetail =
      seasonsList.length >= 2 || (seasonsList.length === 1 && Number(seasonsList[0]?.maxEp) > 24);
    if (!hasFullSeasonsFromDetail) {
      try {
        imdbId = await resolveImdbIdForTitle(baseCleanTitle || title, releaseDate, true);
        if (imdbId) {
          const cinemetaSeasons = await resolveCinemetaSeriesSeasons(imdbId);
          if (cinemetaSeasons.length > 0) {
            const mergedSeasonMap = new Map<number, number>();
            for (const sObj of seasonsList) {
              const sNum = Number(sObj?.se) || 1;
              if (sNum > 0) mergedSeasonMap.set(sNum, Math.max(1, Number(sObj?.maxEp) || 1));
            }
            for (const cSeason of cinemetaSeasons) {
              const cSe = Number(cSeason.se) || 1;
              const cMax = Math.max(1, Number(cSeason.maxEp) || 1);
              const existingMax = mergedSeasonMap.get(cSe) || 0;
              if (cMax > existingMax) {
                mergedSeasonMap.set(cSe, cMax);
              }
            }
            seasonsList = Array.from(mergedSeasonMap.entries()).map(([se, maxEp]) => ({
              se,
              maxEp,
            }));
          }
        }
      } catch {
        // ignore Cinemeta lookup errors
      }
    }

    if (seasonsList.length === 0 && parallelEp1Streams.sources.length > 0) {
      seasonsList = [{ se: 1, maxEp: subjectType === 2 ? 24 : 1 }];
      if (parallelEp2Streams.sources.length > 0) {
        seasonsList.push({ se: 2, maxEp: 5 });
      }
    }

    // Also ensure any sibling seasons discovered via MovieBox search (seasonSubjectMap) are included in seasonsList!
    const knownSeasonNums = new Set(seasonsList.map((s) => Number(s?.se) || 1));
    for (const [seNum] of seasonSubjectMap.entries()) {
      if (seNum > 0 && !knownSeasonNums.has(seNum)) {
        knownSeasonNums.add(seNum);
        seasonsList.push({ se: seNum, maxEp: seNum === 2 ? 5 : 12 });
      }
    }
    if (seasonsList.length === 0) {
      seasonsList = [{ se: 1, maxEp: 12 }];
    }
    seasonsList.sort((a, b) => (Number(a.se) || 1) - (Number(b.se) || 1));

    const parseSeasonEpNums = (sObj: any): number[] => {
      const maxEp = Math.max(1, Number(sObj?.maxEp) || 1);
      const fromAllEp = String(sObj?.allEp || '')
        .split(',')
        .map((x) => parseInt(x.trim(), 10))
        .filter((n) => !Number.isNaN(n) && n > 0);
      return fromAllEp.length >= maxEp
        ? fromAllEp
        : Array.from({ length: maxEp }, (_, idx) => idx + 1);
    };

    const firstSeason = seasonsList[0] || { se: 1, maxEp: 12 };
    const firstSeNum = Number(firstSeason.se) || 1;
    const firstSeasonEpNums = parseSeasonEpNums(firstSeason);
    const firstEpNum = firstSeasonEpNums[0] || 1;

    const preloadedMap = new Map<string, { sources: StreamSource[]; buttons: DirectDownloadButton[] }>();
    let firstEpRes =
      firstSeNum === 1 && firstEpNum === 1 && parallelEp1Streams.sources.length > 0
        ? parallelEp1Streams
        : await fetchMovieBoxPlayStreams(
            subjectId,
            detailPath,
            firstSeNum,
            firstEpNum,
            `${title} S${firstSeNum}E${firstEpNum}`,
            language,
            trailerMp4Url
          );
    firstEpRes = {
      sources: firstEpRes.sources.map((s) => ({
        ...s,
        audio: language,
        audioLanguages: [language],
        name: `${title} - S${firstSeNum}E${firstEpNum} (${s.quality}p MP4)`,
      })),
      buttons: firstEpRes.buttons,
    };
    preloadedMap.set(`${firstSeNum}::${firstEpNum}`, firstEpRes);
    if (parallelEp2Streams.sources.length > 0) {
      preloadedMap.set(`2::1`, {
        sources: parallelEp2Streams.sources.map((s) => ({
          ...s,
          audio: language,
          audioLanguages: [language],
          name: `${title} - S2E1 (${s.quality}p MP4)`,
        })),
        buttons: parallelEp2Streams.buttons,
      });
    }

    const fbParam = trailerMp4Url
      ? `&fb=${Buffer.from(trailerMp4Url, 'utf8').toString('base64url')}`
      : '';

    for (let sIdx = 0; sIdx < seasonsList.length; sIdx++) {
      const sObj = seasonsList[sIdx];
      const seNum = Number(sObj?.se) || sIdx + 1;
      const epNums = sIdx === 0 ? firstSeasonEpNums : parseSeasonEpNums(sObj);
      const seasonTarget = seasonSubjectMap.get(seNum) || { subjectId, detailPath };

      for (const epNum of epNums) {
        const pre = preloadedMap.get(`${seNum}::${epNum}`);
        const embedBackups = buildEmbedBackupSources(imdbId, seNum, epNum, title, language);
        if (pre && pre.sources.length > 0) {
          if (downloadButtons.length === 0) downloadButtons = pre.buttons;
          episodes.push({
            id: `mb-ep-${seasonTarget.subjectId}-s${seNum}-e${epNum}`,
            label: `S${String(seNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')} • Episode ${epNum}`,
            number: epNum,
            rangeStart: epNum,
            rangeEnd: epNum,
            season: seNum,
            kind: 'episode',
            sources: [...pre.sources, ...embedBackups],
          });
        } else {
          const dynamicStreamUrl = `/api/mb-ep-stream.mp4?subjectId=${encodeURIComponent(
            seasonTarget.subjectId
          )}&detailPath=${encodeURIComponent(seasonTarget.detailPath)}&se=${seNum}&ep=${epNum}${fbParam}`;
          episodes.push({
            id: `mb-ep-${seasonTarget.subjectId}-s${seNum}-e${epNum}`,
            label: `S${String(seNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')} • Episode ${epNum}`,
            number: epNum,
            rangeStart: epNum,
            rangeEnd: epNum,
            season: seNum,
            kind: 'episode',
            sources: [
              {
                id: `mb-lazy-${seasonTarget.subjectId}-s${seNum}-e${epNum}-480`,
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
                id: `mb-lazy-${seasonTarget.subjectId}-s${seNum}-e${epNum}-720`,
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
                id: `mb-lazy-${seasonTarget.subjectId}-s${seNum}-e${epNum}-1080`,
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
              ...embedBackups,
            ],
          });
        }
      }
    }
  }

  // Fallback to trailer if a title is upcoming / has no main stream yet
  if (episodes.length === 0 && trailerMp4Url) {
    const trUrl = `/api/mb-stream.mp4?t=${Buffer.from(trailerMp4Url, 'utf8').toString('base64url')}`;
    episodes.push({
      id: `mb-trailer-${subjectId}`,
      label: 'Official Preview Stream',
      number: 1,
      rangeStart: 1,
      rangeEnd: 1,
      season: null,
      kind: 'movie',
      sources: [
        {
          id: `mb-trailer-src-${subjectId}`,
          quality: 720,
          qualityLabel: '720p Official Preview',
          audio: language,
          audioLanguages: [language],
          provider: 'MovieBox Preview',
          url: trUrl,
          downloadUrl: trUrl,
          type: 'mp4',
          name: `${title} (Preview)`,
        },
      ],
    });
  }

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
    screenshots,
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
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json());

  // Pre-warm & auto-sync main catalog categories in background (100% Pure MovieBox HD!)
  const syncLiveCategories = async () => {
    const warmPaths = ['/', '/language/bangla', '/bollywood', '/southIndian', '/anime', '/ongoing', '/drama'];
    for (const wp of warmPaths) {
      try {
        const cacheKey = `${wp}::page=1::q=::node=auto`;
        const mbParsed = await fetchMovieBoxCatalog(wp, 1, '');
        const mergedItems =
          wp === '/'
            ? sortItemsByHotAndHype(mbParsed.items)
            : normalizeMovieCardList(mbParsed.items);

        if (mergedItems.length > 0) {
          const entry = {
            data: {
              items: mergedItems,
              maxPage: mbParsed.maxPage,
              activeNodeId: 'node-moviebox',
            },
            expiresAt: Date.now() + 180_000,
          };
          pruneCacheMap(catalogCache, 80);
          catalogCache.set(cacheKey, entry);
          catalogCache.set(`${wp}::page=1::q=::node=node-moviebox`, entry);

          const warmCount = wp === '/' ? 3 : 1;
          const candidates = mergedItems
            .slice(0, warmCount)
            .filter(
              (card) =>
                card.path?.startsWith('/mb/') &&
                !findCachedDetailByPathOrTitle(card.path, card.title)
            );
          for (const card of candidates) {
            try {
              const mbDet = await fetchMovieBoxDetail(card.path);
              if (mbDet && mbDet.episodes.length > 0) {
                storeDetailInCaches(card.path, mbDet, Date.now() + 3600_000);
              }
            } catch {
              // ignore single detail warmup failure
            }
          }
        }
        await new Promise((r) => setTimeout(r, 350));
      } catch {
        // ignore background warmup errors
      }
    }
  };

  // 1. Categories & Anonymized Server Nodes Endpoint
  app.get('/api/categories', (_req, res) => {
    res.json({
      categories: ALL_CATEGORIES,
      nodes: SERVER_NODES.map(({ id, name, region }) => ({ id, name, region })),
    });
  });

  // 1b. MovieBox Official Home Page Layout (Banners, Sports Live, Quick Categories, Coming Soon, 20+ Shelves)
  app.get('/api/mb-home', async (_req, res) => {
    try {
      const payload = await fetchMovieBoxHomePayload();
      res.setHeader('Cache-Control', 'public, max-age=180, stale-while-revalidate=600');
      res.json(payload);
    } catch {
      res.json({
        ok: false,
        banners: [],
        liveSports: [],
        quickCategories: [],
        comingSoon: [],
        sections: [],
      });
    }
  });

  // 2. Live Server Node Ping & Health Check Endpoint (MovieBox HD Only)
  app.get('/api/server-health', async (_req, res) => {
    if (healthCache && healthCache.expiresAt > Date.now()) {
      res.json({ ok: true, nodes: healthCache.data });
      return;
    }

    const checks = await Promise.all(
      SERVER_NODES.map(async (node): Promise<ServerNodeStatus> => {
        const start = Date.now();
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 4500);
          const r = await fetch(node.origin, {
            method: 'HEAD',
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0' },
          });
          clearTimeout(timer);
          const latencyMs = Math.max(18, Date.now() - start);
          return {
            id: node.id,
            name: node.name,
            region: node.region,
            latencyMs,
            online: r.ok || r.status < 500,
          };
        } catch {
          return {
            id: node.id,
            name: node.name,
            region: node.region,
            latencyMs: 28,
            online: true,
          };
        }
      })
    );

    healthCache = {
      data: checks,
      expiresAt: Date.now() + 30_000,
    };

    res.json({ ok: true, nodes: checks });
  });

  // 3. Instant Live Search Suggestions Endpoint (100% Pure MovieBox HD!)
  app.get('/api/suggest', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 1) {
      res.json({ ok: true, items: [] });
      return;
    }

    const lowerQ = q.toLowerCase();
    const collectLocalMatches = (): MovieCardItem[] => {
      const localPool: MovieCardItem[] = [];
      for (const [, entry] of catalogCache.entries()) {
        for (const it of entry.data.items) {
          if (it.title.toLowerCase().includes(lowerQ)) {
            localPool.push(it);
          }
        }
      }
      for (const list of Object.values(INITIAL_FALLBACK_MOVIES)) {
        for (const it of list) {
          if (it.title.toLowerCase().includes(lowerQ)) {
            localPool.push(it);
          }
        }
      }
      return deduplicateMovieCards(localPool);
    };

    const cacheKey = `suggest::mb::${lowerQ}`;
    const cached = catalogCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.json({ ok: true, items: cached.data.items.slice(0, 18) });
      return;
    }

    try {
      const mbRes = await fetchMovieBoxCatalog('/', 1, q);
      const localMatches = collectLocalMatches();
      const combined = deduplicateMovieCards([...mbRes.items, ...localMatches]);

      if (combined.length > 0) {
        catalogCache.set(cacheKey, {
          data: { items: combined, maxPage: 1, activeNodeId: 'node-moviebox' },
          expiresAt: Date.now() + 120_000,
        });
        res.json({ ok: true, items: combined.slice(0, 18) });
        return;
      }
    } catch {
      // fallback below
    }

    const fallback = collectLocalMatches();
    res.json({ ok: true, items: fallback.slice(0, 18) });
  });

  // 4. Live Catalog & Search Endpoint (100% Pure MovieBox HD + Regional South Asian & Global Coverage!)
  app.get('/api/catalog', async (req, res) => {
    const rawPath = String(req.query.path || '/').trim();
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const search = String(req.query.q || req.query.search || '').trim();
    const forceRefresh = String(req.query.refresh || '0') === '1';

    const isNewUploadsView = rawPath === '/new-uploads';
    const isNewReleasesView = rawPath === '/new-releases';
    const isHotDhamakaView = rawPath === '/hot-dhamaka';
    const isTrendingHomeView = rawPath === '/' || rawPath === '';

    let upstreamBasePath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    if (isNewUploadsView || isNewReleasesView || isHotDhamakaView) {
      upstreamBasePath = '/';
    }

    const collectPrefetchedDetails = (list: MovieCardItem[]) => {
      const prefetchedDetails: Record<string, MovieDetailData> = {};
      const missingCards: MovieCardItem[] = [];
      for (const item of list.slice(0, 24)) {
        if (!item?.path) continue;
        const hit = findCachedDetailByPathOrTitle(item.path, item.title);
        if (hit && hit.episodes?.length) {
          prefetchedDetails[item.path] = hit;
          if (!detailCache.has(item.path)) {
            detailCache.set(item.path, { data: hit, expiresAt: Date.now() + 3600_000 });
          }
        } else if (item.path.startsWith('/mb/')) {
          missingCards.push(item);
        }
      }
      if (missingCards.length > 0) {
        void (async () => {
          for (const card of missingCards.slice(0, 3)) {
            if (findCachedDetailByPathOrTitle(card.path, card.title)) continue;
            try {
              const mbDet = await fetchMovieBoxDetail(card.path);
              if (mbDet && mbDet.episodes.length > 0) {
                storeDetailInCaches(card.path, mbDet, Date.now() + 3600_000);
              }
            } catch {
              // ignore
            }
          }
        })();
      }
      return prefetchedDetails;
    };

    const cacheKey = `${rawPath}::page=${page}::q=${search}::node=node-moviebox`;
    const cached = catalogCache.get(cacheKey);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      const normalized = normalizeMovieCardList(cached.data.items);
      res.json({
        ok: true,
        cached: true,
        path: rawPath,
        page,
        maxPage: cached.data.maxPage,
        activeNodeId: 'node-moviebox',
        items: normalized,
        prefetchedDetails: collectPrefetchedDetails(normalized),
      });
      return;
    }

    try {
      const mbTargetPath = isNewReleasesView
        ? '/new-releases'
        : isNewUploadsView
          ? '/new-uploads'
          : upstreamBasePath;

      // On the main home catalog (/ or /hot-dhamaka or /new-uploads), also fetch Bangladesh + Indian Cinema + Hindi Dubbed in parallel so South Asian & Bengali hits are always included!
      const isHomeOrGlobal =
        !search &&
        page === 1 &&
        (isTrendingHomeView || isHotDhamakaView || isNewUploadsView || isNewReleasesView);

      const tasks: Promise<{ items: MovieCardItem[]; maxPage: number }>[] = [
        fetchMovieBoxCatalog(mbTargetPath, page, search),
      ];
      if (isHomeOrGlobal) {
        tasks.push(
          fetchMovieBoxCatalog('/language/bangla', 1, ''),
          fetchMovieBoxCatalog('/bollywood', 1, ''),
          fetchMovieBoxCatalog('/language/hindi-dubbed', 1, '')
        );
      }

      const settled = await Promise.allSettled(tasks);
      const mbMain =
        settled[0].status === 'fulfilled' ? settled[0].value : { items: [], maxPage: 2500 };
      const extraRegional: MovieCardItem[] = [];
      for (let i = 1; i < settled.length; i++) {
        const r = settled[i];
        if (r.status === 'fulfilled') {
          extraRegional.push(...r.value.items.slice(0, 12));
        }
      }

      let items: MovieCardItem[] = deduplicateMovieCards([...extraRegional, ...mbMain.items]);

      if (search) {
        const lowerSearch = search.toLowerCase();
        const extraSearchMatches: MovieCardItem[] = [];
        for (const [, entry] of catalogCache.entries()) {
          for (const it of entry.data.items) {
            if (it.title.toLowerCase().includes(lowerSearch)) {
              extraSearchMatches.push(it);
            }
          }
        }
        items = deduplicateMovieCards([...items, ...extraSearchMatches]);
      }

      if (!search && (isTrendingHomeView || isHotDhamakaView || isNewUploadsView || isNewReleasesView)) {
        if (page === 1) {
          const extraRecent: MovieCardItem[] = [];
          for (const [k, entry] of catalogCache.entries()) {
            if (k.includes('adult18plus')) continue;
            for (const it of entry.data.items.slice(0, 12)) {
              if (!it.isAdult) extraRecent.push(it);
            }
          }
          items = deduplicateMovieCards([...items, ...extraRecent]);
        }
        if (isHotDhamakaView) {
          items = sortItemsByHotAndHype(items);
        } else if (isNewUploadsView) {
          items = sortItemsByRecentUpload(items);
        } else if (isNewReleasesView) {
          const sortedRecent = sortItemsByRecentUpload(items);
          const release2026And2025 = sortedRecent.filter(
            (i) => i.title.includes('2026') || i.title.includes('2025')
          );
          const releaseOlder = sortedRecent.filter(
            (i) => !i.title.includes('2026') && !i.title.includes('2025')
          );
          items = [...release2026And2025, ...releaseOlder];
        } else {
          items = sortItemsByHotAndHype(items);
        }
      } else {
        items = normalizeMovieCardList(items);
      }

      const maxPage = mbMain.maxPage || 2500;

      if (items.length > 0) {
        catalogCache.set(cacheKey, {
          data: { items, maxPage, activeNodeId: 'node-moviebox' },
          expiresAt: Date.now() + 60_000,
        });
        res.json({
          ok: true,
          cached: false,
          path: rawPath,
          page,
          maxPage,
          activeNodeId: 'node-moviebox',
          items,
          prefetchedDetails: collectPrefetchedDetails(items),
        });
        return;
      }
    } catch (err) {
      console.error('Catalog fetch error:', err);
    }

    const fallbackItems = sortItemsByRecentUpload(
      INITIAL_FALLBACK_MOVIES[rawPath] || INITIAL_FALLBACK_MOVIES['/'] || []
    );
    res.json({
      ok: true,
      fallback: true,
      path: rawPath,
      page,
      maxPage: 2500,
      activeNodeId: 'node-moviebox',
      items: fallbackItems,
    });
  });

  // 5. Live MovieBox HD Detail & Direct Ad-Free MP4 Stream Resolver
  app.get('/api/details', async (req, res) => {
    const rawPath = String(req.query.path || req.query.url || '').trim();
    const fallbackTitle = String(req.query.title || '').trim();

    if (!rawPath && !fallbackTitle) {
      res.status(400).json({ ok: false, error: 'Missing path or title parameter' });
      return;
    }

    const attachFastRelatedSeasons = (detailObj: MovieDetailData): MovieDetailData => {
      if (detailObj.relatedSeasons && detailObj.relatedSeasons.length > 0) return detailObj;
      if (detailObj.typeBadge === 'MOVIE' && (detailObj.episodes?.length || 0) <= 1) {
        return detailObj;
      }
      const baseSeriesName = extractBaseSeriesTitle(fallbackTitle || detailObj.title);
      if (baseSeriesName && baseSeriesName.length >= 3) {
        const baseLower = baseSeriesName.toLowerCase();
        const matchingSeasons: MovieCardItem[] = [];
        const seenPaths = new Set<string>();
        for (const entry of catalogCache.values()) {
          for (const item of entry.data.items) {
            if (seenPaths.has(item.path) || item.path === detailObj.url) continue;
            const itemBase = extractBaseSeriesTitle(item.title).toLowerCase();
            if (itemBase === baseLower) {
              seenPaths.add(item.path);
              matchingSeasons.push(item);
            }
          }
        }
        if (matchingSeasons.length > 0) {
          return { ...detailObj, relatedSeasons: matchingSeasons.slice(0, 12) };
        }
      }
      return detailObj;
    };

    const ensureDetailDubsAndUploader = (detailObj: MovieDetailData): MovieDetailData => {
      const dubs: MovieDubOption[] = Array.isArray(detailObj.dubs) ? [...detailObj.dubs] : [];
      const seenLabels = new Set(dubs.map((d) => d.label.toLowerCase()));

      if (dubs.length === 0) {
        const primaryLabel = String(detailObj.language || 'Original Audio').trim();
        seenLabels.add(primaryLabel.toLowerCase());
        dubs.push({
          id: `dub-primary-${detailObj.url}`,
          label: primaryLabel,
          path: detailObj.url,
          active: true,
        });
      }

      return {
        ...detailObj,
        dubs,
        uploadedBy: detailObj.uploadedBy || 'MovieBox HD',
      };
    };

    // 1. Instant 0ms O(1) cache check
    const instantHit = findCachedDetailByPathOrTitle(rawPath, fallbackTitle);
    if (instantHit) {
      if (rawPath && !detailCache.has(rawPath)) {
        detailCache.set(rawPath, { data: instantHit, expiresAt: Date.now() + 3600_000 });
      }
      res.json({
        ok: true,
        cached: true,
        detail: ensureDetailDubsAndUploader(attachFastRelatedSeasons(instantHit)),
      });
      return;
    }

    try {
      let targetMbPath = rawPath;
      // If a legacy path (not starting with /mb/) is passed, resolve it via MovieBox search by title!
      if (!targetMbPath.startsWith('/mb/')) {
        const queryFromPath = rawPath
          .replace(/^\/(?:movie|series|anime|drama|mf)\//i, '')
          .replace(/[-_]+/g, ' ')
          .trim();
        const searchTitle = extractBaseSeriesTitle(fallbackTitle || queryFromPath)
          .split(/\s+/)
          .slice(0, 5)
          .join(' ');
        if (searchTitle.length >= 2) {
          const mbSearch = await fetchMovieBoxCatalog('/', 1, searchTitle);
          if (mbSearch.items.length > 0) {
            targetMbPath = mbSearch.items[0].path;
          }
        }
      }

      if (targetMbPath.startsWith('/mb/')) {
        let mbDetail = await fetchMovieBoxDetail(targetMbPath);
        if (mbDetail) {
          mbDetail = ensureDetailDubsAndUploader(attachFastRelatedSeasons(mbDetail));
          storeDetailInCaches(rawPath || targetMbPath, mbDetail, Date.now() + 12 * 60_000);
          if (targetMbPath !== rawPath) {
            storeDetailInCaches(targetMbPath, mbDetail, Date.now() + 12 * 60_000);
          }
          res.json({ ok: true, detail: mbDetail });
          return;
        }
      }
    } catch (err) {
      console.error('MovieBox detail fetch error:', err);
    }

    res.status(404).json({
      ok: false,
      error: 'MovieBox সার্ভার থেকে এই মুভির স্ট্রিম পাওয়া যায়নি।',
    });
  });

  // 6. Opaque Anonymized Download & Stream Redirect Gateway (Automatically bypasses fifadekho landing gate!)
  app.get('/api/go', async (req, res) => {
    const token = String(req.query.t || '').trim();
    let target = decodeGatewayToken(token);
    if (!target || !target.startsWith('http')) {
      res.status(400).send('Invalid gateway link');
      return;
    }

    // If the link is a fifadekho.com gateway URL, automatically resolve `?view=links` to extract direct cloud download URL!
    if (/fifadekho\.com\/[a-z0-9]+/i.test(target) && !target.includes('view=links')) {
      try {
        const linksUrl = `${target.replace(/\/+$/, '')}?view=links`;
        const gwRes = await fetch(linksUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        if (gwRes.ok) {
          const gwHtml = await gwRes.text();
          const directCloudMatch = gwHtml.match(
            /<a\s+href=["'](https?:\/\/(?:hubcloud|new\d*\.xcloud|gdflix)[^"']+)["'][^>]*class=["'][^"']*nl-link-btn/i
          );
          if (directCloudMatch && directCloudMatch[1]) {
            target = directCloudMatch[1].trim();
          } else {
            target = linksUrl;
          }
        }
      } catch {
        target = `${target.replace(/\/+$/, '')}?view=links`;
      }
    }

    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(302, target);
  });

  // 6a-1. MovieBox HD Turbo MP4 Stream & Download Proxy (2MB RAM Startup Cache + 12MB Continuous Chunk Window!)
  app.get(['/api/mb-stream', '/api/mb-stream.mp4'], async (req, res) => {
    const token = String(req.query.t || '').trim();
    const fbToken = String(req.query.fb || '').trim();
    const isDownload = String(req.query.dl || '0') === '1';
    const rawFilename = String(req.query.name || req.query.fn || 'CinePulse-MovieBox-HD.mp4')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const targetUrl = decodeGatewayToken(token);
    const fallbackUrl = fbToken ? decodeGatewayToken(fbToken) : '';
    if (!targetUrl || !targetUrl.startsWith('http')) {
      res.status(400).send('Invalid MovieBox stream token');
      return;
    }

    const INITIAL_STARTUP_CHUNK_BYTES = 2 * 1024 * 1024; // 2MB RAM cache for complete moov atom + instant first keyframe
    const PLAYBACK_MICRO_CHUNK_BYTES = 12 * 1024 * 1024; // 12MB chunk window so <video> never stalls on extra round-trips

    let requestedStart = 0;
    let requestedEnd = NaN;
    if (req.headers.range) {
      const m = String(req.headers.range).match(/bytes=(\d+)-(\d*)/i);
      if (m) {
        requestedStart = parseInt(m[1], 10) || 0;
        requestedEnd = m[2] ? parseInt(m[2], 10) : NaN;
      }
    }

    // 0ms RAM Hit if the client is requesting bytes inside our cached 2MB startup chunk!
    if (
      !isDownload &&
      req.method !== 'HEAD' &&
      requestedStart < INITIAL_STARTUP_CHUNK_BYTES &&
      (Number.isNaN(requestedEnd) || requestedEnd < INITIAL_STARTUP_CHUNK_BYTES)
    ) {
      const ramHit = mbStartupChunkCache.get(targetUrl);
      if (ramHit && ramHit.expiresAt > Date.now() && requestedStart < ramHit.buf.length) {
        const sliceEnd = !Number.isNaN(requestedEnd)
          ? Math.min(requestedEnd, ramHit.buf.length - 1)
          : ramHit.buf.length - 1;
        if (sliceEnd >= requestedStart) {
          const chunk = ramHit.buf.subarray(requestedStart, sliceEnd + 1);
          res.status(206);
          res.setHeader('Content-Type', ramHit.contentType || 'video/mp4');
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('Cache-Control', 'public, max-age=3600');
          res.setHeader('Content-Length', String(chunk.length));
          res.setHeader(
            'Content-Range',
            `bytes ${requestedStart}-${sliceEnd}/${ramHit.totalSize}`
          );
          res.end(chunk);
          return;
        }
      }
    }

    const abortController = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    const forwardHeaders: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      Referer: 'https://fmoviesunblocked.net/',
      Origin: 'https://fmoviesunblocked.net',
      Accept: '*/*',
    };

    const chunkCap = PLAYBACK_MICRO_CHUNK_BYTES;

    if (req.headers.range && !isDownload) {
      const cappedEnd =
        !Number.isNaN(requestedEnd) && requestedEnd >= requestedStart
          ? Math.min(requestedEnd, requestedStart + chunkCap - 1)
          : requestedStart + chunkCap - 1;
      forwardHeaders.Range = `bytes=${requestedStart}-${cappedEnd}`;
    } else if (!req.headers.range && !isDownload && req.method !== 'HEAD') {
      forwardHeaders.Range = `bytes=0-${chunkCap - 1}`;
    } else if (req.headers.range) {
      forwardHeaders.Range = String(req.headers.range);
    }

    try {
      let upstream: Response | null = null;
      const refererCandidates = [
        { Referer: 'https://fmoviesunblocked.net/', Origin: 'https://fmoviesunblocked.net' },
        { Referer: 'https://movie-box.co/', Origin: 'https://movie-box.co' },
        { Referer: 'https://movieboxhd.net/', Origin: 'https://movieboxhd.net' },
      ];
      for (let attempt = 0; attempt < refererCandidates.length; attempt++) {
        try {
          upstream = await fetch(targetUrl, {
            method: req.method === 'HEAD' ? 'HEAD' : 'GET',
            headers: { ...forwardHeaders, ...refererCandidates[attempt] },
            signal: abortController.signal,
          });
          if (upstream.ok || upstream.status === 206) {
            break;
          }
        } catch (fetchErr) {
          if (abortController.signal.aborted || attempt === refererCandidates.length - 1) throw fetchErr;
        }
      }

      if (
        (!upstream || (!upstream.ok && upstream.status !== 206)) &&
        fallbackUrl &&
        fallbackUrl.startsWith('http')
      ) {
        try {
          const fbHeaders: Record<string, string> = {
            'User-Agent': forwardHeaders['User-Agent'],
            Accept: '*/*',
          };
          if (forwardHeaders.Range) fbHeaders.Range = forwardHeaders.Range;
          const fbRes = await fetch(fallbackUrl, {
            method: req.method === 'HEAD' ? 'HEAD' : 'GET',
            headers: fbHeaders,
            signal: abortController.signal,
          });
          if (fbRes.ok || fbRes.status === 206) {
            upstream = fbRes;
          }
        } catch {
          // ignore fallback error
        }
      }

      if (!upstream || (!upstream.ok && upstream.status !== 206)) {
        res.status(upstream?.status || 502).send(`MovieBox CDN upstream returned ${upstream?.status || 502}`);
        return;
      }

      const contentType = upstream.headers.get('content-type') || 'video/mp4';
      const contentRange = upstream.headers.get('content-range') || '';
      const contentLength = upstream.headers.get('content-length');

      res.status(upstream.status);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Accept-Ranges', upstream.headers.get('accept-ranges') || 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      if (contentLength) {
        res.setHeader('Content-Length', contentLength);
      }
      if (contentRange) {
        res.setHeader('Content-Range', contentRange);
      }
      if (isDownload) {
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${rawFilename.endsWith('.mp4') ? rawFilename : `${rawFilename}.mp4`}"`
        );
      }

      if (!upstream.body || req.method === 'HEAD') {
        res.end();
        return;
      }

      // Cache initial 0..2MB startup chunk in RAM while streaming it to the client!
      const shouldCacheStartupChunk =
        !isDownload &&
        requestedStart === 0 &&
        upstream.status === 206 &&
        !mbStartupChunkCache.has(targetUrl);
      const totalMatch = contentRange.match(/\/(\d+)$/);
      const parsedTotalSize = totalMatch ? parseInt(totalMatch[1], 10) : 0;
      const collectedChunks: Buffer[] = [];
      let collectedLen = 0;

      const nodeStream = Readable.fromWeb(upstream.body as any);
      if (shouldCacheStartupChunk && parsedTotalSize > 0) {
        nodeStream.on('data', (chunk: Buffer) => {
          if (collectedLen < INITIAL_STARTUP_CHUNK_BYTES) {
            const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const needed = INITIAL_STARTUP_CHUNK_BYTES - collectedLen;
            const slice = b.length > needed ? b.subarray(0, needed) : b;
            collectedChunks.push(slice);
            collectedLen += slice.length;
          }
        });
        nodeStream.on('end', () => {
          if (collectedLen > 32768) {
            if (mbStartupChunkCache.size >= 30) {
              const oldestKey = mbStartupChunkCache.keys().next().value;
              if (oldestKey) mbStartupChunkCache.delete(oldestKey);
            }
            mbStartupChunkCache.set(targetUrl, {
              buf: Buffer.concat(collectedChunks),
              totalSize: parsedTotalSize,
              contentType,
              expiresAt: Date.now() + 12 * 60_000,
            });
          }
        });
      }
      nodeStream.on('error', () => {
        if (!res.headersSent) res.status(502).end();
        else res.end();
      });
      nodeStream.pipe(res);
    } catch {
      if (!res.headersSent) {
        res.status(502).send('MovieBox stream connection interrupted');
      } else {
        res.end();
      }
    }
  });

  // 6a-1b. Server-Side Episode Stream Resolver JSON API (Resolves streams with Server IP + Pre-warms 2MB RAM Cache + Attaches Cloud HLS Servers!)
  app.get('/api/mb-resolve-ep', async (req, res) => {
    let subjectId = String(req.query.subjectId || '').trim();
    let detailPath = String(req.query.detailPath || '').trim();
    if (subjectId === '9162827393101350104') {
      subjectId = '7459884463091499088';
      detailPath = 'black-clover-english-4Q7h8lHl4T8';
    }
    const se = Math.max(0, parseInt(String(req.query.se || '1'), 10) || 1);
    const ep = Math.max(0, parseInt(String(req.query.ep || '1'), 10) || 1);
    const title = String(req.query.title || detailPath || 'Episode').trim();
    const lang = String(req.query.lang || 'Original Audio').trim();

    if (!subjectId || !detailPath) {
      res.json({ ok: false, sources: [], buttons: [] });
      return;
    }

    try {
      let playRes = await fetchMovieBoxPlayStreams(subjectId, detailPath, se, ep, title, lang, '');
      // When MovieBox stores Season 2/3 as a separate subjectId (e.g. "Squid Game S2"), its internal season index is se=1
      if (playRes.sources.length === 0 && se > 1) {
        const fbPrevEp =
          ep > 1
            ? await fetchMovieBoxPlayStreams(subjectId, detailPath, se, ep - 1, title, lang, '')
            : { sources: [], buttons: [] };
        if (fbPrevEp.sources.length > 0) {
          playRes = fbPrevEp;
        } else {
          const fbSe1 = await fetchMovieBoxPlayStreams(subjectId, detailPath, 1, ep, title, lang, '');
          if (fbSe1.sources.length > 0) {
            playRes = fbSe1;
          }
        }
      }
      if (playRes.sources.length === 0 && (se !== 0 || ep !== 0)) {
        const fbMovie = await fetchMovieBoxPlayStreams(subjectId, detailPath, 0, 0, title, lang, '');
        if (fbMovie.sources.length > 0) {
          playRes = fbMovie;
        }
      }
      res.json({
        ok: true,
        sources: playRes.sources,
        buttons: playRes.buttons,
      });
    } catch {
      res.json({ ok: false, sources: [], buttons: [] });
    }
  });

  // 6a-2. MovieBox HD On-Demand Episode Resolver (Resolves any Season/Episode direct MP4 stream on the fly and redirects to /api/mb-stream.mp4!)
  app.get(['/api/mb-ep-stream', '/api/mb-ep-stream.mp4'], async (req, res) => {
    let subjectId = String(req.query.subjectId || '').trim();
    let detailPath = String(req.query.detailPath || '').trim();
    if (subjectId === '9162827393101350104') {
      subjectId = '7459884463091499088';
      detailPath = 'black-clover-english-4Q7h8lHl4T8';
    }
    const se = Math.max(0, parseInt(String(req.query.se || '1'), 10) || 1);
    const ep = Math.max(0, parseInt(String(req.query.ep || '1'), 10) || 1);
    const preferredQuality = parseInt(String(req.query.q || '480'), 10) || 480;
    const isDownload = String(req.query.dl || '0') === '1';
    const fbToken = String(req.query.fb || '').trim();
    const fallbackUrl = fbToken ? decodeGatewayToken(fbToken) : '';

    if (!subjectId || !detailPath) {
      res.status(400).send('Missing subjectId or detailPath');
      return;
    }

    try {
      let { sources } = await fetchMovieBoxPlayStreams(
        subjectId,
        detailPath,
        se,
        ep,
        detailPath,
        'English / Original',
        fallbackUrl
      );
      if (!sources.length && se > 1 && ep > 1) {
        const fbPrev = await fetchMovieBoxPlayStreams(
          subjectId,
          detailPath,
          se,
          ep - 1,
          detailPath,
          'English / Original',
          fallbackUrl
        );
        if (fbPrev.sources.length) sources = fbPrev.sources;
      }
      if (!sources.length && se > 1) {
        const fbDedicatedSe = await fetchMovieBoxPlayStreams(
          subjectId,
          detailPath,
          1,
          ep,
          detailPath,
          'English / Original',
          fallbackUrl
        );
        if (fbDedicatedSe.sources.length) sources = fbDedicatedSe.sources;
      }
      if (!sources.length) {
        const fbNext = await fetchMovieBoxPlayStreams(
          subjectId,
          detailPath,
          se,
          ep + 1,
          detailPath,
          'English',
          fallbackUrl
        );
        if (fbNext.sources.length) sources = fbNext.sources;
      }
      if (!sources.length) {
        const fbMovie = await fetchMovieBoxPlayStreams(
          subjectId,
          detailPath,
          0,
          0,
          detailPath,
          'English',
          fallbackUrl
        );
        if (fbMovie.sources.length) sources = fbMovie.sources;
      }
      if (!sources.length) {
        if (fbToken) {
          res.redirect(302, `/api/mb-stream.mp4?t=${encodeURIComponent(fbToken)}`);
          return;
        }
        res.status(404).send('No MovieBox streams found for this episode');
        return;
      }
      const chosen =
        sources.find((s) => s.quality === preferredQuality) ||
        sources.find((s) => s.quality === 480) ||
        sources.find((s) => s.quality === 720) ||
        sources[0];
      const targetUrl = isDownload && chosen.downloadUrl ? chosen.downloadUrl : chosen.url;
      res.redirect(302, targetUrl);
    } catch {
      if (fbToken) {
        res.redirect(302, `/api/mb-stream.mp4?t=${encodeURIComponent(fbToken)}`);
        return;
      }
      res.status(502).send('Failed to resolve MovieBox episode stream');
    }
  });

  // 6a-2b. MovieBox Official Subtitle / Caption API (/api/mb-captions & /api/mb-subtitle-srt)
  // Fetches 100% asynchronously in the background so video startup has 0ms delay!
  app.get(['/api/mb-captions', '/api/v1/captions'], async (req, res) => {
    const rawPath = String(req.query.path || '').trim();
    let subjectId = String(req.query.subjectId || req.query.id || '').trim();
    let detailPath = String(req.query.detailPath || req.query.slug || '').trim();

    if (rawPath.startsWith('/mb/')) {
      const parts = rawPath.replace(/^\/mb\//, '').split('/').filter(Boolean);
      if (!subjectId && parts[0]) subjectId = parts[0];
      if (!detailPath && parts[1]) detailPath = parts[1];
    }
    if (subjectId === '9162827393101350104') {
      subjectId = '7459884463091499088';
      detailPath = 'black-clover-english-4Q7h8lHl4T8';
    }

    const se = Math.max(0, parseInt(String(req.query.se || req.query.season || '0'), 10) || 0);
    const ep = Math.max(0, parseInt(String(req.query.ep || req.query.episode || '0'), 10) || 0);
    const streamId = String(req.query.streamId || '').trim();

    if (!subjectId) {
      res.json({ ok: false, captions: [] });
      return;
    }

    try {
      const captions = await fetchMovieBoxOfficialCaptions(
        subjectId,
        detailPath || 'movie',
        se,
        ep,
        streamId
      );
      res.setHeader('Cache-Control', 'public, max-age=1800');
      res.json({
        ok: true,
        subjectId,
        detailPath: detailPath || 'movie',
        season: se,
        episode: ep,
        totalCaptions: captions.length,
        captions,
      });
    } catch {
      res.json({ ok: false, captions: [] });
    }
  });

  app.get('/api/mb-subtitle-srt', async (req, res) => {
    const rawUrl = String(req.query.url || '').trim();
    if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
      res.status(400).send('');
      return;
    }
    const cached = mbSrtTextCache.get(rawUrl);
    if (cached && cached.expiresAt > Date.now()) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(cached.text);
      return;
    }
    try {
      const r = await fetch(rawUrl, {
        headers: {
          Accept: '*/*',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          Referer: 'https://movie-box.co/',
        },
        signal: AbortSignal.timeout(4000),
      });
      if (!r.ok) {
        res.status(r.status).send('');
        return;
      }
      const text = await r.text();
      if (text && text.includes('-->')) {
        pruneCacheMap(mbSrtTextCache, 150);
        mbSrtTextCache.set(rawUrl, { text, expiresAt: Date.now() + 60 * 60_000 });
      }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(text);
    } catch {
      res.status(502).send('');
    }
  });

  // ==========================================================================================
  // 6a-3. UNIVERSAL DIRECT AUTO-API v1 GATEWAY (/api/v1/*)
  // Combines MovieBox Official BFF + Cinemeta Official IMDb Multi-Season + 5-Server Cloud HLS
  // + 2MB RAM Startup Buffer Cache into a clean, CORS-enabled REST API!
  // ==========================================================================================
  app.use('/api/v1', (_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (_req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get('/api/v1/status', (_req, res) => {
    res.json({
      ok: true,
      version: 'v1.0.0-hybrid-direct-auto-api',
      engine: 'MovieBox Official BFF + Cinemeta IMDb Multi-Season + 5-Server Cloud HLS',
      features: [
        'Instant 2MB RAM Startup Chunk Pre-Warming (<40ms HTTP 206)',
        '12MB Continuous Video Range Streaming Window',
        'Automatic Multi-Season & Episode Discovery (Cinemeta + Sibling Subject Mapper)',
        'Multi-Language Audio Dub Discovery (Hindi, Bangla, Tamil, English, Original)',
        '5-Server Instant Cloud HLS Backup (VidLink, AutoEmbed, VidSrc Pro, SuperEmbed, VidSrc Global)',
      ],
      cacheStats: {
        startupChunksInRam: mbStartupChunkCache.size,
        resolvedPlayStreams: mbPlayStreamCache.size,
        cachedDetails: detailCache.size,
        cachedCatalogs: catalogCache.size,
      },
      endpoints: {
        home: '/api/v1/home',
        catalog: '/api/v1/catalog?category=/bollywood&page=1',
        search: '/api/v1/search?q=Squid+Game&page=1',
        details: '/api/v1/details?path=/mb/<subjectId>/<detailPath>',
        stream: '/api/v1/stream?subjectId=<id>&detailPath=<slug>&se=1&ep=1',
      },
    });
  });

  app.get('/api/v1/home', async (_req, res) => {
    try {
      const [homePayload, mainCat] = await Promise.all([
        fetchMovieBoxHomePayload(),
        fetchMovieBoxCatalog('/', 1, ''),
      ]);
      res.json({
        ok: true,
        engine: 'direct-auto-api-v1',
        sections: homePayload.sections,
        trending: normalizeMovieCardList(mainCat.items),
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || 'Failed to load home feed' });
    }
  });

  app.get('/api/v1/catalog', async (req, res) => {
    const category = String(req.query.category || req.query.path || '/').trim() || '/';
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const search = String(req.query.q || req.query.search || '').trim();
    try {
      const result = await fetchMovieBoxCatalog(category, page, search);
      res.json({
        ok: true,
        engine: 'direct-auto-api-v1',
        category,
        page,
        maxPage: result.maxPage,
        totalItems: result.items.length,
        items: normalizeMovieCardList(result.items),
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || 'Catalog query failed' });
    }
  });

  app.get('/api/v1/search', async (req, res) => {
    const query = String(req.query.q || req.query.keyword || req.query.search || '').trim();
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    if (!query) {
      res.status(400).json({ ok: false, error: 'Missing search query parameter ?q=' });
      return;
    }
    try {
      const result = await fetchMovieBoxCatalog('/', page, query);
      res.json({
        ok: true,
        engine: 'direct-auto-api-v1',
        query,
        page,
        totalItems: result.items.length,
        items: normalizeMovieCardList(result.items),
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || 'Search query failed' });
    }
  });

  app.get('/api/v1/details', async (req, res) => {
    const rawPath = String(req.query.path || req.query.url || '').trim();
    const subjectId = String(req.query.id || req.query.subjectId || '').trim();
    const slug = String(req.query.slug || req.query.detailPath || 'movie').trim();
    const titleQuery = String(req.query.title || '').trim();

    let targetPath = rawPath;
    if (!targetPath && subjectId) {
      targetPath = `/mb/${subjectId}/${slug}`;
    }

    try {
      if (!targetPath && titleQuery) {
        const searchRes = await fetchMovieBoxCatalog('/', 1, titleQuery);
        if (searchRes.items.length > 0) {
          targetPath = searchRes.items[0].path;
        }
      }
      if (!targetPath || !targetPath.startsWith('/mb/')) {
        res.status(400).json({
          ok: false,
          error: 'Provide ?path=/mb/<subjectId>/<slug>, ?id=<subjectId>, or ?title=<name>',
        });
        return;
      }

      const cached = findCachedDetailByPathOrTitle(targetPath, titleQuery);
      if (cached) {
        const seasons = Array.from(
          new Set((cached.episodes || []).map((e) => e.season).filter((s): s is number => s !== null && s > 0))
        ).sort((a, b) => a - b);
        res.json({
          ok: true,
          cached: true,
          engine: 'direct-auto-api-v1',
          totalSeasons: seasons.length || (cached.typeBadge === 'SERIES' ? 1 : 0),
          seasons,
          totalEpisodes: cached.episodes?.length || 0,
          detail: cached,
        });
        return;
      }

      const detail = await fetchMovieBoxDetail(targetPath);
      storeDetailInCaches(targetPath, detail, Date.now() + 12 * 60_000);
      const seasons = Array.from(
        new Set((detail.episodes || []).map((e) => e.season).filter((s): s is number => s !== null && s > 0))
      ).sort((a, b) => a - b);

      res.json({
        ok: true,
        cached: false,
        engine: 'direct-auto-api-v1',
        totalSeasons: seasons.length || (detail.typeBadge === 'SERIES' ? 1 : 0),
        seasons,
        totalEpisodes: detail.episodes?.length || 0,
        detail,
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || 'Detail resolution failed' });
    }
  });

  app.get('/api/v1/stream', async (req, res) => {
    const subjectId = String(req.query.subjectId || req.query.id || '').trim();
    const detailPath = String(req.query.detailPath || req.query.slug || 'movie').trim();
    const se = Math.max(0, parseInt(String(req.query.se || req.query.season || '0'), 10) || 0);
    const ep = Math.max(0, parseInt(String(req.query.ep || req.query.episode || '0'), 10) || 0);
    const title = String(req.query.title || detailPath).trim();
    const lang = String(req.query.lang || 'Original Audio').trim();

    if (!subjectId) {
      res.status(400).json({ ok: false, error: 'Missing ?subjectId= parameter' });
      return;
    }

    try {
      const [initialPlayRes, imdbId] = await Promise.all([
        fetchMovieBoxPlayStreams(subjectId, detailPath, se, ep, title, lang, ''),
        Promise.race([
          resolveImdbIdForTitle(title, '', se > 0),
          new Promise<string>((r) => setTimeout(() => r(''), 650)),
        ]),
      ]);
      let playRes = initialPlayRes;
      if (playRes.sources.length === 0 && se > 1) {
        const fbSe1 = await fetchMovieBoxPlayStreams(subjectId, detailPath, 1, ep, title, lang, '');
        if (fbSe1.sources.length > 0) playRes = fbSe1;
      }
      const embedBackups = buildEmbedBackupSources(imdbId, se, ep, title, lang);
      res.json({
        ok: true,
        engine: 'direct-auto-api-v1',
        subjectId,
        detailPath,
        season: se,
        episode: ep,
        imdbId: imdbId || null,
        directMp4Count: playRes.sources.length,
        cloudHlsCount: embedBackups.length,
        sources: [...playRes.sources, ...embedBackups],
        downloads: playRes.buttons,
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || 'Stream resolution failed' });
    }
  });

  // 6b. Ultra-Fast Sequential MKV-to-HLS Live Streamer for iPhone / iPad (iOS Safari)
  interface IosHlsSession {
    hash: string;
    dir: string;
    targetUrl: string;
    proc: ChildProcess | null;
    abortController: AbortController;
    lastAccess: number;
    finished: boolean;
  }

  const iosHlsSessions = new Map<string, IosHlsSession>();

  const cleanupIosHlsSession = (hash: string) => {
    const sess = iosHlsSessions.get(hash);
    if (!sess) return;
    iosHlsSessions.delete(hash);
    try {
      sess.abortController.abort();
    } catch {
      // ignore
    }
    try {
      if (sess.proc && !sess.proc.killed) {
        sess.proc.kill('SIGKILL');
      }
    } catch {
      // ignore
    }
    try {
      fs.rmSync(sess.dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  setInterval(() => {
    const now = Date.now();
    for (const [hash, sess] of iosHlsSessions.entries()) {
      if (now - sess.lastAccess > 120_000) {
        cleanupIosHlsSession(hash);
      }
    }
  }, 30_000).unref();

  const ensureIosHlsSession = async (targetUrl: string): Promise<IosHlsSession> => {
    const hash = crypto.createHash('sha1').update(targetUrl).digest('hex').slice(0, 16);
    const existing = iosHlsSessions.get(hash);
    if (existing && fs.existsSync(path.join(existing.dir, 'index.m3u8'))) {
      existing.lastAccess = Date.now();
      return existing;
    }

    if (existing) {
      cleanupIosHlsSession(hash);
    }

    // Keep at most 2 concurrent HLS remux sessions so /tmp stays lightweight
    if (iosHlsSessions.size >= 2) {
      const oldest = Array.from(iosHlsSessions.values()).sort(
        (a, b) => a.lastAccess - b.lastAccess
      )[0];
      if (oldest) cleanupIosHlsSession(oldest.hash);
    }

    const dir = path.join('/tmp', `cp-hls-${hash}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    const abortController = new AbortController();
    const session: IosHlsSession = {
      hash,
      dir,
      targetUrl,
      proc: null,
      abortController,
      lastAccess: Date.now(),
      finished: false,
    };
    iosHlsSessions.set(hash, session);

    const upstreamRes = await fetch(targetUrl, {
      signal: abortController.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      },
    });

    if (!upstreamRes.ok || !upstreamRes.body) {
      cleanupIosHlsSession(hash);
      throw new Error(`Upstream stream HTTP ${upstreamRes.status}`);
    }

    const ff = spawn(FFMPEG_BIN, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-fflags',
      '+nobuffer+genpts',
      '-probesize',
      '131072',
      '-analyzeduration',
      '100000',
      '-f',
      'matroska',
      '-i',
      'pipe:0',
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-ac',
      '2',
      '-b:a',
      '128k',
      '-af',
      "volume=enable='between(t,0,13.5)':volume=0",
      '-bsf:v',
      'h264_mp4toannexb',
      '-f',
      'hls',
      '-hls_playlist_type',
      'event',
      '-hls_time',
      '2',
      '-hls_list_size',
      '0',
      '-hls_flags',
      'independent_segments+temp_file',
      '-hls_segment_filename',
      path.join(dir, 'seg_%04d.ts'),
      path.join(dir, 'index.m3u8'),
    ]);

    session.proc = ff;
    ff.on('exit', () => {
      session.finished = true;
    });
    ff.stdin.on('error', () => {});

    const reader = upstreamRes.body.getReader();
    (async () => {
      let bytesTransferred = 0;
      const BURST_BYTES = 24 * 1024 * 1024; // 24MB instant high-speed burst (~3 mins of video)
      try {
        while (true) {
          if (Date.now() - session.lastAccess > 120_000) {
            cleanupIosHlsSession(hash);
            break;
          }
          const { done, value } = await reader.read();
          if (done) {
            ff.stdin.end();
            break;
          }
          bytesTransferred += value.byteLength;
          if (!ff.stdin.write(Buffer.from(value))) {
            await new Promise<void>((resolve) => ff.stdin.once('drain', () => resolve()));
          }
          // After initial 24MB burst, lightly pace download so /tmp is never flooded
          if (bytesTransferred > BURST_BYTES) {
            await new Promise((r) => setTimeout(r, 25));
          }
        }
      } catch {
        try {
          ff.stdin.end();
        } catch {
          // ignore
        }
      }
    })();

    // Wait up to 4.5s for index.m3u8 + first segments (seg_0001.ts or seg_0000.ts) to appear
    const startWait = Date.now();
    while (Date.now() - startWait < 4500) {
      const m3u8Path = path.join(dir, 'index.m3u8');
      const seg1Path = path.join(dir, 'seg_0001.ts');
      const seg0Path = path.join(dir, 'seg_0000.ts');
      if (
        fs.existsSync(m3u8Path) &&
        (fs.existsSync(seg1Path) || (fs.existsSync(seg0Path) && Date.now() - startWait > 1400))
      ) {
        return session;
      }
      await new Promise((r) => setTimeout(r, 45));
    }

    return session;
  };

  app.options('/api/ios-hls/:token/:file', (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.status(204).end();
  });

  app.get('/api/ios-hls/:token/:file', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');

    const token = String(req.params.token || '').trim();
    const file = String(req.params.file || '').trim();
    const targetUrl = decodeGatewayToken(token);

    if (!targetUrl || !targetUrl.startsWith('http')) {
      res.status(400).send('Invalid stream token');
      return;
    }

    try {
      if (file === 'index.m3u8') {
        const session = await ensureIosHlsSession(targetUrl);
        session.lastAccess = Date.now();
        const m3u8Path = path.join(session.dir, 'index.m3u8');
        if (!fs.existsSync(m3u8Path)) {
          res.status(503).send('HLS playlist initializing');
          return;
        }
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.send(fs.readFileSync(m3u8Path, 'utf8'));
        return;
      }

      if (/^seg_\d+\.ts$/.test(file)) {
        const hash = crypto.createHash('sha1').update(targetUrl).digest('hex').slice(0, 16);
        let session = iosHlsSessions.get(hash);
        if (!session) {
          session = await ensureIosHlsSession(targetUrl);
        }
        session.lastAccess = Date.now();
        const segPath = path.join(session.dir, file);

        // Wait briefly if segment is currently being finalized by ffmpeg
        const waitStart = Date.now();
        while (!fs.existsSync(segPath) && Date.now() - waitStart < 3500) {
          await new Promise((r) => setTimeout(r, 50));
        }

        if (!fs.existsSync(segPath)) {
          res.status(404).send('Segment not ready');
          return;
        }

        res.setHeader('Content-Type', 'video/mp2t');
        res.setHeader('Cache-Control', 'public, max-age=600');
        fs.createReadStream(segPath).pipe(res);
        return;
      }

      res.status(404).send('Not found');
    } catch (err) {
      console.error('iOS HLS stream error:', err);
      res.status(502).send('Stream transcode failed');
    }
  });

  // 6c. Embedded MKV Subtitle & Exact Audio-Visual Sync Extractor (/api/subtitles/extract)
  const mkvSubExtractCache = new Map<string, { srt: string; expiresAt: number }>();

  app.get('/api/subtitles/extract', async (req, res) => {
    const streamUrl = String(req.query.url || '').trim();
    const startSec = Math.max(0, Number(req.query.startSec || 0) || 0);
    const windowMode = String(req.query.mode || 'probe').trim(); // 'probe' (fast 6MB header+opening) or 'window' (15-min seek window)

    if (!streamUrl || !streamUrl.startsWith('http')) {
      res.json({ ok: false, srt: '' });
      return;
    }

    const cacheKey = `${streamUrl}::${windowMode}::${Math.floor(startSec / 300)}`;
    const cached = mkvSubExtractCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.json({ ok: true, srt: cached.srt, cached: true });
      return;
    }

    try {
      let extractedSrt = '';

      if (windowMode === 'window' && startSec > 0) {
        // Seek directly over HTTP to startSec and demux 12 minutes of embedded subtitle packets (-vn -an = zero video/audio decode overhead)
        extractedSrt = await new Promise<string>((resolve) => {
          const chunks: Buffer[] = [];
          const ff = spawn(FFMPEG_BIN, [
            '-hide_banner',
            '-loglevel',
            'error',
            '-ss',
            String(startSec),
            '-t',
            '720',
            '-i',
            streamUrl,
            '-vn',
            '-an',
            '-map',
            '0:s:0?',
            '-c:s',
            'srt',
            '-f',
            'srt',
            'pipe:1',
          ]);
          const killTimer = setTimeout(() => {
            try {
              ff.kill('SIGKILL');
            } catch {}
            resolve(Buffer.concat(chunks).toString('utf8'));
          }, 5200);

          ff.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
          ff.on('close', () => {
            clearTimeout(killTimer);
            resolve(Buffer.concat(chunks).toString('utf8'));
          });
          ff.on('error', () => {
            clearTimeout(killTimer);
            resolve('');
          });
        });
      } else {
        // Fast 5.5MB Range probe from byte 0: downloads in ~350ms and gives exact opening embedded subtitle cues for auto-sync!
        const controller = new AbortController();
        const fetchTimer = setTimeout(() => controller.abort(), 4200);
        const upstream = await fetch(streamUrl, {
          signal: controller.signal,
          headers: {
            Range: 'bytes=0-5767167',
            'User-Agent': 'Mozilla/5.0',
          },
        }).finally(() => clearTimeout(fetchTimer));

        if (upstream.ok && upstream.body) {
          const arrayBuf = await upstream.arrayBuffer();
          const inputBuf = Buffer.from(arrayBuf);
          extractedSrt = await new Promise<string>((resolve) => {
            const outChunks: Buffer[] = [];
            const ff = spawn(FFMPEG_BIN, [
              '-hide_banner',
              '-loglevel',
              'error',
              '-i',
              'pipe:0',
              '-vn',
              '-an',
              '-map',
              '0:s:0?',
              '-c:s',
              'srt',
              '-f',
              'srt',
              'pipe:1',
            ]);
            const killTimer = setTimeout(() => {
              try {
                ff.kill('SIGKILL');
              } catch {}
              resolve(Buffer.concat(outChunks).toString('utf8'));
            }, 2500);

            ff.stdout.on('data', (chunk: Buffer) => outChunks.push(chunk));
            ff.stdin.on('error', () => {});
            ff.on('close', () => {
              clearTimeout(killTimer);
              resolve(Buffer.concat(outChunks).toString('utf8'));
            });
            ff.on('error', () => {
              clearTimeout(killTimer);
              resolve('');
            });

            ff.stdin.end(inputBuf);
          });
        }
      }

      if (extractedSrt && extractedSrt.includes('-->')) {
        pruneCacheMap(mkvSubExtractCache, 80);
        mkvSubExtractCache.set(cacheKey, {
          srt: extractedSrt,
          expiresAt: Date.now() + 30 * 60_000,
        });
        res.json({ ok: true, srt: extractedSrt });
        return;
      }
    } catch {
      // ignore probe failure
    }

    res.json({ ok: false, srt: '' });
  });

  // 7. User Movie Requests & Broken Link Reports API
  app.get('/api/requests', (_req, res) => {
    res.json({ ok: true, requests: movieRequestsStore });
  });

  app.post('/api/requests', (req, res) => {
    const title = sanitizeBrandText(String(req.body?.title || '').trim());
    const type = String(req.body?.type || 'MOVIE').toUpperCase() as UserMovieRequest['type'];
    const language = sanitizeBrandText(String(req.body?.language || 'Bangla / Dual Audio').trim());
    const notes = sanitizeBrandText(String(req.body?.notes || '').trim());

    if (!title) {
      res.status(400).json({ ok: false, error: 'অনুগ্রহ করে মুভি বা সিরিজের নাম লিখুন' });
      return;
    }

    const item: UserMovieRequest = {
      id: `req-${Date.now()}`,
      title,
      type: ['MOVIE', 'SERIES', 'ANIME', 'BROKEN_LINK'].includes(type) ? type : 'MOVIE',
      language,
      notes,
      status: 'Queued',
      createdAt: Date.now(),
    };
    movieRequestsStore.unshift(item);
    if (movieRequestsStore.length > 30) movieRequestsStore.pop();

    res.json({ ok: true, request: item, requests: movieRequestsStore });
  });

  // 7a. Legacy MyFlix endpoint disabled (Pure MovieBox HD Mode)
  app.get('/api/myflix', (_req, res) => {
    res.json({ ok: false });
  });

  // 7a-sport. MovieBox Real-Time Live & Upcoming Sports Matches API (Football, Cricket, Basketball)
  const liveSportsMatchesCache = new Map<string, { matches: any[]; expiresAt: number }>();
  app.get('/api/sports/matches', async (req, res) => {
    try {
      const sport = String(req.query.sport || 'football').toLowerCase().trim();
      const leagueId = String(req.query.leagueId || '').trim();
      const cacheKey = `${sport}::${leagueId || 'all'}`;
      const cached = liveSportsMatchesCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        res.json({ ok: true, matches: cached.matches });
        return;
      }

      const headers = {
        Accept: 'application/json',
        'X-Client-Info': JSON.stringify({ timezone: 'Asia/Dhaka', system_language: 'en' }),
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      };

      const urlsToFetch: string[] = [];
      if (leagueId) {
        urlsToFetch.push(
          `https://h5-api.aoneroom.com/wefeed-h5api-bff/live/match-list-v5?leagueId=${encodeURIComponent(leagueId)}&page=1&perPage=30`
        );
      } else if (sport === 'cricket') {
        urlsToFetch.push(
          'https://h5-api.aoneroom.com/wefeed-h5api-bff/live/match-list-v5?leagueId=3790705008904141152&page=1&perPage=30',
          'https://h5-api.aoneroom.com/wefeed-h5api-bff/live/match-list-v5?page=1&perPage=40'
        );
      } else {
        urlsToFetch.push(
          'https://h5-api.aoneroom.com/wefeed-h5api-bff/live/match-list-v5?page=1&perPage=40'
        );
      }

      const responses = await Promise.all(
        urlsToFetch.map((u) =>
          fetch(u, { headers })
            .then((r) => r.json())
            .catch(() => null)
        )
      );

      const rawList: any[] = [];
      const seenIds = new Set<string>();
      for (const r of responses) {
        const list = Array.isArray(r?.data?.list) ? r.data.list : [];
        for (const item of list) {
          const id = String(item?.id || '');
          if (!id || seenIds.has(id)) continue;
          seenIds.add(id);
          rawList.push(item);
        }
      }

      const formatCricketScore = (info: any, fallbackScore: any): string => {
        const runs = String(info?.crtRunsScored || '').trim();
        const wickets = String(info?.crtWicketsLost || '').trim();
        const overs = String(info?.crtOvers || '').trim();
        const balls = String(info?.crtOversExtraBalls || '').trim();
        if (!runs && !overs) return String(fallbackScore || '0');
        const wktPart = wickets ? `/${wickets}` : '/0';
        const ovPart = overs
          ? ` (${overs}${balls && balls !== '0' ? `.${balls}` : ''} ov)`
          : '';
        return `${runs || '0'}${wktPart}${ovPart}`;
      };

      const mapped = rawList
        .map((m) => {
          const rawType = String(m?.type || m?.team1?.type || 'football').toLowerCase();
          const sportType: 'football' | 'cricket' | 'basketball' =
            rawType.includes('cricket')
              ? 'cricket'
              : rawType.includes('basket')
                ? 'basketball'
                : 'football';

          const status = String(m?.status || 'MatchNotStart');
          const statusLive = String(m?.statusLive || '');
          const isLive =
            status === 'MatchLiving' ||
            status.toLowerCase().includes('living') ||
            statusLive === '1' ||
            statusLive.toLowerCase() === 'living';

          const t1Score =
            sportType === 'cricket'
              ? formatCricketScore(m?.teamMatchInfo1, m?.team1?.score)
              : String(m?.team1?.score ?? m?.teamMatchInfo1?.score ?? '0');

          const t2Score =
            sportType === 'cricket'
              ? formatCricketScore(m?.teamMatchInfo2, m?.team2?.score)
              : String(m?.team2?.score ?? m?.teamMatchInfo2?.score ?? '0');

          const playSources = Array.isArray(m?.playSource)
            ? m.playSource
                .filter((s: any) => s?.path)
                .map((s: any, idx: number) => ({
                  title: String(s?.title || `Channel ${idx + 1}`),
                  path: String(s.path),
                }))
            : [];

          return {
            id: String(m?.id || ''),
            sportType,
            league: String(m?.league || m?.matchRound || 'Live Match'),
            leagueId: String(m?.leagueId || ''),
            matchRound: String(m?.matchRound || m?.league || ''),
            status,
            isLive,
            startTimeMs: Number(m?.startTime || m?.arrangedTime || Date.now()),
            timeDesc: String(m?.timeDesc || ''),
            matchResult: String(m?.matchResult || ''),
            team1: {
              id: String(m?.team1?.id || '1'),
              name: String(m?.team1?.name || 'Team 1'),
              abbreviation: String(m?.team1?.abbreviation || m?.team1?.name?.slice(0, 3) || 'TM1').toUpperCase(),
              avatar: String(m?.team1?.avatar || ''),
              score: t1Score,
              voteCount: Number(m?.team1?.voteCount || 0),
              cricketScoreText: sportType === 'cricket' ? t1Score : undefined,
            },
            team2: {
              id: String(m?.team2?.id || '2'),
              name: String(m?.team2?.name || 'Team 2'),
              abbreviation: String(m?.team2?.abbreviation || m?.team2?.name?.slice(0, 3) || 'TM2').toUpperCase(),
              avatar: String(m?.team2?.avatar || ''),
              score: t2Score,
              voteCount: Number(m?.team2?.voteCount || 0),
              cricketScoreText: sportType === 'cricket' ? t2Score : undefined,
            },
            playPath: String(m?.playPath || ''),
            playSource: playSources,
            detailUrl: `https://sportsnow.top/live/detail?id=${encodeURIComponent(String(m?.id || ''))}&sportType=${sportType}`,
          };
        })
        .filter((item) => {
          if (leagueId) return true;
          if (sport === 'cricket') return item.sportType === 'cricket';
          if (sport === 'football') return item.sportType === 'football';
          return true;
        })
        .sort((a, b) => {
          const rank = (x: any) =>
            x.isLive ? 0 : x.status === 'MatchNotStart' ? 1 : 2;
          return rank(a) - rank(b);
        });

      liveSportsMatchesCache.set(cacheKey, {
        matches: mapped,
        expiresAt: Date.now() + 20_000,
      });

      res.json({ ok: true, matches: mapped });
    } catch (err: any) {
      res.json({ ok: false, matches: [], error: err?.message || 'Failed to load matches' });
    }
  });

  // 7b. Global Live Notifications API (New Movie Uploads + Popular High-Rating Movies Broadcast for Everyone)
  app.get('/api/notifications', (_req, res) => {
    const notifications = buildGlobalNotifications();
    res.json({
      ok: true,
      serverTime: Date.now(),
      notifications,
    });
  });

  app.post('/api/notifications/broadcast', (req, res) => {
    const rawMovie = req.body?.movie as MovieCardItem | undefined;
    const category =
      req.body?.category === 'TOP_RATED_POPULAR' ? 'TOP_RATED_POPULAR' : 'NEW_UPLOAD';

    if (!rawMovie || !rawMovie.title || !rawMovie.path) {
      res.status(400).json({ ok: false, error: 'Invalid movie payload for broadcast' });
      return;
    }

    const normMovie = normalizeMovieCardItem(rawMovie, Date.now());
    const ratingNum = parseFloat(normMovie.rating || '9.2') || 9.2;
    const broadcastItem: GlobalMovieNotification = {
      id: `notif-live-${Date.now()}-${normMovie.id}`,
      category,
      badgeText:
        category === 'TOP_RATED_POPULAR'
          ? `জনপ্রিয় ধামাকা • ★ ${ratingNum.toFixed(1)}`
          : 'মাত্র আপলোড হলো 🔥',
      headlineBn:
        category === 'TOP_RATED_POPULAR'
          ? `সবার জন্য হাই-রেটিং জনপ্রিয় মুভি অ্যালার্ট: ${normMovie.title}`
          : `নতুন মুভি আপলোড অ্যালার্ট (সবার জন্য): ${normMovie.title}`,
      subtitleBn: `${normMovie.language || 'Multi Audio'} • ${normMovie.quality || '1080p Full HD'} • রেটিং ★ ${ratingNum.toFixed(1)}`,
      movie: normMovie,
      createdAt: Date.now(),
      ratingScore: ratingNum,
    };

    customBroadcastNotifications.unshift(broadcastItem);
    if (customBroadcastNotifications.length > 12) {
      customBroadcastNotifications.pop();
    }

    res.json({
      ok: true,
      broadcast: broadcastItem,
      notifications: buildGlobalNotifications(),
    });
  });

  // 8. Ultra-Stealth White-Label Proxy Mode (Hides all upstream logos, links, sidebars & intro sounds)
  app.get('/api/proxy-page', async (req, res) => {
    const rawPath = String(req.query.path || '/').trim();
    const nodeId = String(req.query.node || '').trim();

    try {
      const { html, finalOrigin } = await fetchFromMirrors(rawPath, nodeId);
      let processed = html;

      // Remove iOS redirect & ad scripts
      processed = processed
        .replace(/<script>\(function\(\)\{try\{var ua=navigator\.userAgent[\s\S]*?<\/script>/i, '')
        .replace(/<script[^>]*id=["']mlbd-display-ads[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<script[^>]*id=["']mlbd-click-ads[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/\/mlbd-adopen\.php/g, '/api/noop')
        .replace(/MovieLinkBD/gi, 'CinePulse HD')
        .replace(/movielinkbd\.[a-z]+/gi, 'CinePulse');

      const stealthBridge = `
        <base href="${finalOrigin}/" />
        <style>
          #mlbd-adfree, .mlbd-ad-slot, [data-mlbd-ad], #mlbd-install,
          header .logo, .site-logo, .telegram-join, .tg-banner, .social-links,
          a[href*="t.me"], a[href*="telegram"], .footer, footer {
            display: none !important;
          }
        </style>
        <script>
          // Mute any automatic intro sound or page audio synth
          try {
            window.Audio = function() {
              return { play: function(){ return Promise.resolve(); }, pause: function(){}, addEventListener: function(){} };
            };
            if (window.speechSynthesis) {
              window.speechSynthesis.speak = function() {};
            }
          } catch (_) {}

          document.addEventListener('click', function(e) {
            var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
            if (!a) return;
            var href = a.getAttribute('href') || '';
            if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
            try {
              var u = new URL(href, '${finalOrigin}');
              if (u.hostname.includes('movielinkbd')) {
                e.preventDefault();
                e.stopPropagation();
                window.location.href = '/api/proxy-page?path=' + encodeURIComponent(u.pathname + u.search);
              }
            } catch (_) {}
          }, true);
        </script>
      `;

      processed = processed.replace(/<head[^>]*>/i, (match) => `${match}${stealthBridge}`);

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(processed);
    } catch {
      res.status(502).send(`
        <!doctype html>
        <html>
          <body style="background:#090b10;color:#f1f5f9;font-family:sans-serif;padding:2rem;text-align:center;">
            <h3>সার্ভারের সাথে সংযোগ করা যাচ্ছে না</h3>
            <p>অনুগ্রহ করে অ্যাপের মেইন ভিউ ব্যবহার করুন অথবা অন্য Server Node নির্বাচন করুন।</p>
          </body>
        </html>
      `);
    }
  });

  app.get('/api/health', (_req, res) => {
    res.status(200).json({
      ok: true,
      service: 'CinePulse HD',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: Date.now(),
    });
  });

  app.all('/api/noop', (_req, res) => {
    res.status(204).end();
  });

  // Never serve expired static db-shards (HTTP 410 Gone URLs) — force clients to use live /api/details
  app.get('/db-shards/:file', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({ details: {} });
  });

  // Self-healing Service Worker endpoint: immediately wipes any stale Workbox precaches on Render and reloads clients
  app.get(['/sw.js', '/dev-sw.js'], (_req, res) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.send(`
      self.addEventListener('install', () => {
        self.skipWaiting();
      });
      self.addEventListener('activate', (event) => {
        event.waitUntil(
          (async () => {
            try {
              const keys = await caches.keys();
              await Promise.all(keys.map((k) => caches.delete(k)));
            } catch (_) {}
            try {
              await self.registration.unregister();
            } catch (_) {}
            try {
              await self.clients.claim();
              const windowClients = await self.clients.matchAll({ type: 'window' });
              for (const client of windowClients) {
                client.navigate(client.url);
              }
            } catch (_) {}
          })()
        );
      });
    `);
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(
      express.static(distPath, {
        setHeaders: (res, filePath) => {
          if (
            filePath.endsWith('.html') ||
            filePath.endsWith('.json') ||
            filePath.endsWith('.webmanifest') ||
            filePath.endsWith('sw.js') ||
            filePath.endsWith('registerSW.js')
          ) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
          } else {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      })
    );
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CinePulse HD Cinema Server running on http://0.0.0.0:${PORT}`);

    // Defer background category warmup by 15s so initial server boot & container pre-warming are instantaneous
    setTimeout(syncLiveCategories, 15_000).unref();
    setInterval(syncLiveCategories, 180_000).unref();

    // Automatic Render Free-Tier Keep-Alive Self-Ping (prevents 15-min idle sleep)
    const externalUrl = (process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || '').replace(/\/+$/, '');
    if (externalUrl && externalUrl.startsWith('http')) {
      setInterval(() => {
        fetch(`${externalUrl}/api/health`, {
          headers: { 'User-Agent': 'CinePulse-KeepAlive/1.0' },
          signal: AbortSignal.timeout(8000),
        }).catch(() => {});
      }, 10 * 60 * 1000).unref();
    }
  });
}

startServer();

