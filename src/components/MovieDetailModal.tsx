import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Crown,
  Download,
  FastForward,
  FileText,
  Film,
  Flame,
  HelpCircle,
  Layers,
  ListPlus,
  ListVideo,
  Loader2,
  Lock,
  Maximize,
  Maximize2,
  Minimize,
  Minimize2,
  Monitor,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  RotateCw,
  Search,
  Settings,
  Share2,
  Smartphone,
  Sparkles,
  Star,
  Subtitles,
  Sun,
  Tv,
  Unlock,
  Volume2,
  VolumeX,
  Wifi,
  X,
} from 'lucide-react';
import { normalizeMovieCardItem } from '../utils/timeAgo';
import type {
  EpisodeItem,
  MovieCardItem,
  MovieDetailData,
  StreamSource,
  WatchlistFolder,
  WatchProgressItem,
} from '../types/cinema';
import {
  getInstantCachedDetail,
  loadShardForMovie,
  prefetchMovieDetails,
  resolveBrowserMovieBoxEpisodeSources,
  setVideoStartupPriority,
  stopBackgroundWarmVideo,
  universalApiFetch,
  warmStreamConnection,
} from '../services/liveClientEngine';
import Hls from 'hls.js';
import { IosMkvStreamController } from '../services/mkvIosClientRemuxer';
import {
  buildVttFromCues,
  ensureBanglaTranslationAroundTime,
  fetchOrGenerateAutoBanglaSubtitles,
  findActiveCueTextAtTime,
  loadSubtitleTrackByUrl,
  parseSrtOrVttToCues,
  translateLinesToBangla,
  type AvailableSubtitleTrack,
  type SubtitleCue,
} from '../services/autoBanglaSubtitleEngine';

interface MovieDetailModalProps {
  movie: MovieCardItem | null;
  relatedMovies: MovieCardItem[];
  activeNodeId: string;
  savedProgress?: WatchProgressItem;
  isMiniPlayer?: boolean;
  onToggleMiniPlayer?: (mini: boolean) => void;
  onClose: () => void;
  onSelectMovie: (movie: MovieCardItem) => void;
  isInWatchlist: boolean;
  currentFolder?: WatchlistFolder;
  onToggleWatchlist: (movie: MovieCardItem, folder?: WatchlistFolder) => void;
  onRecordWatchProgress: (
    movie: MovieCardItem,
    episode?: EpisodeItem,
    episodeIdx?: number,
    source?: StreamSource,
    seconds?: number,
    duration?: number
  ) => void;
  onSearchByActor: (actorName: string) => void;
  onOpenReportModal: (prefillTitle: string) => void;
}

const INTRO_SKIP_STORAGE_KEY = 'cp_intro_skip_sec_v3';
const AUTO_NEXT_STORAGE_KEY = 'cp_auto_next_ep_v1';
const BRIGHTNESS_STORAGE_KEY = 'cp_player_brightness_v1';
const AUTO_NET_STORAGE_KEY = 'cp_auto_net_quality_v1';
const SOUND_BOOST_STORAGE_KEY = 'cp_sound_boost_vol_v1';

interface WebAudioBoosterNodeChain {
  ctx: AudioContext;
  gainNode: GainNode;
  vocalFilter: BiquadFilterNode;
  compressor: DynamicsCompressorNode;
}

const videoAudioBoosterMap = new WeakMap<HTMLMediaElement, WebAudioBoosterNodeChain>();

/**
 * Applies up to 400% (4.0x) Ultra Sound Boost + Vocal Clarity EQ + Anti-Clipping Compressor
 * via Web Audio API when volumePercent > 100.
 */
function syncVideoAudioBooster(videoEl: HTMLVideoElement, volumePercent: number, muted: boolean): void {
  try {
    if (muted || volumePercent <= 0) {
      videoEl.volume = 0;
      videoEl.muted = true;
      const existing = videoAudioBoosterMap.get(videoEl);
      if (existing) {
        existing.gainNode.gain.value = 1;
        existing.vocalFilter.gain.value = 0;
      }
      return;
    }

    videoEl.muted = false;

    if (volumePercent <= 100) {
      videoEl.volume = Math.max(0, Math.min(1, volumePercent / 100));
      const existing = videoAudioBoosterMap.get(videoEl);
      if (existing) {
        existing.gainNode.gain.value = 1;
        existing.vocalFilter.gain.value = 0;
        if (existing.ctx.state === 'suspended') {
          existing.ctx.resume().catch(() => {});
        }
      }
      return;
    }

    // volumePercent > 100 (101% .. 400% Ultra Sound Boost)
    videoEl.volume = 1;

    let chain = videoAudioBoosterMap.get(videoEl);
    if (!chain) {
      // Only attach Web Audio MediaElementSource on same-origin (/api/stream) or blob: streams
      // so cross-origin streams without CORS headers are never silenced
      const currentSrc = videoEl.currentSrc || videoEl.src || '';
      const isSameOriginOrBlob =
        !currentSrc ||
        currentSrc.startsWith('blob:') ||
        currentSrc.startsWith('data:') ||
        currentSrc.startsWith('/') ||
        currentSrc.includes('/api/stream') ||
        (typeof window !== 'undefined' && currentSrc.startsWith(window.location.origin));

      if (!isSameOriginOrBlob) {
        return;
      }

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;

      const ctx: AudioContext = new AudioCtx();
      const source = ctx.createMediaElementSource(videoEl);

      // Vocal Clarity Presence Boost around 2.2kHz so dialogue is crystal clear when boosted
      const vocalFilter = ctx.createBiquadFilter();
      vocalFilter.type = 'peaking';
      vocalFilter.frequency.value = 2200;
      vocalFilter.Q.value = 1.0;
      vocalFilter.gain.value = 0;

      // Main Amplifier Gain Node (1.0x up to 4.0x)
      const gainNode = ctx.createGain();
      gainNode.gain.value = 1;

      // Dynamics Compressor / Limiter so 200%–400% loud explosions never crackle or clip
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -10;
      compressor.knee.value = 16;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.15;

      source.connect(vocalFilter);
      vocalFilter.connect(gainNode);
      gainNode.connect(compressor);
      compressor.connect(ctx.destination);

      chain = { ctx, gainNode, vocalFilter, compressor };
      videoAudioBoosterMap.set(videoEl, chain);
    }

    if (chain.ctx.state === 'suspended') {
      chain.ctx.resume().catch(() => {});
    }

    const boostMultiplier = Math.max(1, Math.min(4, volumePercent / 100));
    chain.gainNode.gain.value = boostMultiplier;
    // Add up to +6dB vocal dialogue clarity as boost increases from 100% to 400%
    chain.vocalFilter.gain.value = Math.min(6, ((boostMultiplier - 1) / 3) * 6);
  } catch {
    // Fallback if browser restricts Web Audio API on this element
    try {
      videoEl.volume = Math.max(0, Math.min(1, volumePercent / 100));
    } catch {
      // ignore
    }
  }
}

function formatSeconds(sec: number): string {
  if (!sec || sec < 0 || !isFinite(sec)) return '00:00';
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(s).padStart(s < 10 ? 2 : 2, '0')}`;
}

function formatEpisodeTileBadge(ep: EpisodeItem, fallbackIdx: number): string {
  if (ep.id === 'movie-special' || ep.number === 0) return 'Movie';
  const start = ep.rangeStart ?? ep.number;
  const end = ep.rangeEnd ?? ep.number;
  if (start !== null && start !== undefined) {
    const startPad = String(start).padStart(2, '0');
    if (end !== null && end !== undefined && end > start) {
      const endPad = String(end).padStart(2, '0');
      return `${startPad}-${endPad}`;
    }
    return startPad;
  }
  return String(fallbackIdx + 1).padStart(2, '0');
}

function detectIdealQualityForNetwork(): { targetQuality: number; netLabel: string } {
  try {
    const nav = navigator as any;
    const conn = nav.connection || nav.mozConnection || nav.webkitConnection;
    if (conn) {
      const eff = String(conn.effectiveType || '').toLowerCase();
      const down = Number(conn.downlink || 0);
      const saveData = Boolean(conn.saveData);
      if (saveData || eff === '2g' || eff === 'slow-2g' || eff === '3g' || (down > 0 && down < 4)) {
        return {
          targetQuality: 480,
          netLabel: down > 0 ? `Instant Start (${down}Mbps) · 480p` : 'Instant Start · 480p',
        };
      }
      if (down >= 12) {
        return { targetQuality: 1080, netLabel: `Turbo Auto (${down}Mbps) · 480p→1080p` };
      }
      if (down > 0) {
        return { targetQuality: 720, netLabel: `Turbo Auto (${down}Mbps) · 480p→720p` };
      }
    }
  } catch {
    // ignore
  }
  return { targetQuality: 720, netLabel: 'Turbo Auto · 480p→HD' };
}

/**
 * Instant-Start Source Selector:
 * When opening any movie or episode in Auto mode, ALWAYS pick the lowest bitrate H.264 stream
 * (480p / 360p, or lightweight 720p WEB-DL) first so the video starts playing in < 0.2s without buffering!
 * Once playing smoothly with healthy buffer, the Standby Preloader upgrades to 720p/1080p seamlessly.
 */
function pickBestSourceIndexForNet(sources: StreamSource[], autoNet: boolean): number {
  if (!sources || sources.length === 0) return 0;

  const isDirectStream = (s: StreamSource) =>
    s.type !== 'embed' && !/abyssplayer\.com|abysscdn\.com|vidsrc|\/embed\//i.test(s.url || '');
  const isNativeMp4Stream = (s: StreamSource) =>
    isDirectStream(s) &&
    (s.type === 'mp4' ||
      /\/api\/mb-stream|\/api\/mb-ep-stream|\.(mp4|m4v)(\?|$)/i.test(s.url || ''));
  const isLightweightH264 = (s: StreamSource) =>
    isDirectStream(s) &&
    !/\b(hevc|h\.?265|x265|10bit|av1)\b/i.test(`${s.name} ${s.qualityLabel}`) &&
    !/best\s*quality/i.test(s.qualityLabel || '');
  const isAnyDirectH264 = (s: StreamSource) =>
    isDirectStream(s) && !/\b(hevc|h\.?265|x265|10bit|av1)\b/i.test(`${s.name} ${s.qualityLabel}`);

  // 0. Always prefer Native H.264 MP4 (movie-box.co Direct MP4) first so iOS/Android play natively in 0.2s without MKV remuxing!
  if (autoNet) {
    const mp4Fast = sources.findIndex(
      (s) => isNativeMp4Stream(s) && (s.quality === 720 || (s.quality >= 360 && s.quality <= 576))
    );
    if (mp4Fast !== -1) return mp4Fast;
  }
  const anyNativeMp4 = sources.findIndex((s) => isNativeMp4Stream(s));
  if (anyNativeMp4 !== -1) return anyNativeMp4;

  if (!autoNet) {
    const firstH264 = sources.findIndex((s) => isLightweightH264(s));
    if (firstH264 !== -1) return firstH264;
    const fallbackH264 = sources.findIndex((s) => isAnyDirectH264(s));
    if (fallbackH264 !== -1) return fallbackH264;
    const anyDirect = sources.findIndex((s) => isDirectStream(s));
    return anyDirect !== -1 ? anyDirect : 0;
  }

  // 1. Prefer 480p (360p..576p) H.264 first
  const h480 = sources.findIndex(
    (s) => isLightweightH264(s) && s.quality >= 360 && s.quality <= 576
  );
  if (h480 !== -1) return h480;

  // 2. Fallback to lightweight 720p H.264
  const h720 = sources.findIndex((s) => isLightweightH264(s) && s.quality === 720);
  if (h720 !== -1) return h720;

  // 3. Fallback to any lightweight H.264 stream
  const anyLightH264 = sources.findIndex((s) => isLightweightH264(s));
  if (anyLightH264 !== -1) return anyLightH264;

  // 4. Fallback to any direct stream
  const anyDirectH264 = sources.findIndex((s) => isAnyDirectH264(s));
  if (anyDirectH264 !== -1) return anyDirectH264;
  const anyDirect = sources.findIndex((s) => isDirectStream(s));
  return anyDirect !== -1 ? anyDirect : 0;
}

/**
 * Finds the next step-up H.264 resolution (e.g. 480p -> 720p -> 1080p) for progressive smooth upgrade.
 */
function pickNextUpgradeSourceIndex(
  sources: StreamSource[],
  currentQuality: number,
  maxTargetQuality: number,
  failedIndices: number[]
): number {
  if (!sources || sources.length <= 1 || currentQuality >= maxTargetQuality) return -1;
  const isLightweightH264 = (s: StreamSource) =>
    !/\b(hevc|h\.?265|x265|10bit|av1)\b/i.test(`${s.name} ${s.qualityLabel}`) &&
    !/best\s*quality/i.test(s.qualityLabel || '') &&
    s.type !== 'embed';

  // Step 1: If currently <= 576p (480p), look for 720p first
  if (currentQuality <= 576 && maxTargetQuality >= 720) {
    const idx720 = sources.findIndex(
      (s, idx) => !failedIndices.includes(idx) && isLightweightH264(s) && s.quality === 720
    );
    if (idx720 !== -1) return idx720;
  }

  // Step 2: If currently <= 720p and network supports 1080p, look for 1080p
  if (currentQuality <= 720 && maxTargetQuality >= 1080) {
    const idx1080 = sources.findIndex(
      (s, idx) => !failedIndices.includes(idx) && isLightweightH264(s) && s.quality === 1080
    );
    if (idx1080 !== -1) return idx1080;
  }

  return -1;
}

function convertSrtToVtt(srtContent: string): string {
  const normalized = srtContent
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  if (normalized.trim().startsWith('WEBVTT')) {
    return normalized;
  }
  return `WEBVTT\n\n${normalized}`;
}

function toGatewayAbsoluteUrl(downloadOrStreamUrl: string): string {
  if (!downloadOrStreamUrl) return '';
  if (downloadOrStreamUrl.startsWith('/api/go')) {
    return `${window.location.origin}${downloadOrStreamUrl}`;
  }
  return downloadOrStreamUrl;
}

function isAppleWebKitDevice(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isIOS =
    /iPhone|iPad|iPod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /Safari/i.test(ua) && !/Chrome|Chromium|Edg|OPR|Android/i.test(ua);
  return isIOS || isSafari;
}

export const MovieDetailModal: React.FC<MovieDetailModalProps> = ({
  movie,
  relatedMovies,
  activeNodeId,
  savedProgress,
  isMiniPlayer = false,
  onToggleMiniPlayer,
  onClose,
  onSelectMovie,
  isInWatchlist,
  currentFolder = 'favorites',
  onToggleWatchlist,
  onRecordWatchProgress,
  onSearchByActor,
  onOpenReportModal,
}) => {
  // Synchronous 0ms detail lookup on Render #1 so <video> mounts immediately inside the user's tap gesture!
  const instantDetailOnRender = useMemo(() => {
    if (!movie) return null;
    return getInstantCachedDetail(movie.path || movie.url, movie.title);
  }, [movie?.path, movie?.url, movie?.title]);

  const [detail, setDetail] = useState<MovieDetailData | null>(() => instantDetailOnRender);
  const [loading, setLoading] = useState(() => !instantDetailOnRender);
  const [error, setError] = useState<string | null>(null);

  const [selectedEpIdx, setSelectedEpIdx] = useState(() => {
    const eps = instantDetailOnRender?.episodes || [];
    return savedProgress?.episodeIdx !== undefined && eps[savedProgress.episodeIdx]
      ? savedProgress.episodeIdx
      : 0;
  });
  const [selectedSourceIdx, setSelectedSourceIdx] = useState(() => {
    const eps = instantDetailOnRender?.episodes || [];
    const initEp =
      savedProgress?.episodeIdx !== undefined && eps[savedProgress.episodeIdx]
        ? eps[savedProgress.episodeIdx]
        : eps[0];
    return pickBestSourceIndexForNet(initEp?.sources || [], true);
  });
  const [selectedSeasonFilter, setSelectedSeasonFilter] = useState<number | 'all'>('all');
  const [episodeSearchQuery, setEpisodeSearchQuery] = useState('');
  const [episodeSortOrder, setEpisodeSortOrder] = useState<'asc' | 'desc'>('asc');
  const [failedSourceIndices, setFailedSourceIndices] = useState<number[]>([]);
  const [showAllEpisodesModal, setShowAllEpisodesModal] = useState(false);
  const [showDownloadSheet, setShowDownloadSheet] = useState(false);
  const [bottomTab, setBottomTab] = useState<'forYou' | 'infoCast' | 'reviews'>('forYou');

  // MovieBox Audience Reviews & Star Rating State (100% Ad-Free Local Persistence)
  const [userRatingStars, setUserRatingStars] = useState<number>(5);
  const [userReviewName, setUserReviewName] = useState<string>('');
  const [userReviewText, setUserReviewText] = useState<string>('');
  const [customReviewsMap, setCustomReviewsMap] = useState<
    Record<string, Array<{ id: string; author: string; stars: number; text: string; date: string }>>
  >(() => {
    try {
      const raw = localStorage.getItem('cp_moviebox_reviews_v1');
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });

  // Network-Adaptive Quality Mode (ON by default)
  const [autoNetQuality, setAutoNetQuality] = useState<boolean>(() => {
    try {
      return localStorage.getItem(AUTO_NET_STORAGE_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const [netStatusLabel, setNetStatusLabel] = useState<string>(() => {
    return detectIdealQualityForNetwork().netLabel;
  });
  const [showQualityMenu, setShowQualityMenu] = useState<boolean>(false);
  const [showAudioServerMenu, setShowAudioServerMenu] = useState<boolean>(false);
  const [showSleepMenu, setShowSleepMenu] = useState<boolean>(false);
  const [sleepTimerMode, setSleepTimerMode] = useState<number | 'end_of_ep' | null>(null);
  const [sleepRemainingSec, setSleepRemainingSec] = useState<number | null>(null);
  const [seekRipple, setSeekRipple] = useState<{
    side: 'left' | 'right';
    delta: number;
    id: number;
  } | null>(null);
  const [scrubPreview, setScrubPreview] = useState<{ sec: number; percent: number } | null>(null);
  const [nextEpPrewarmed, setNextEpPrewarmed] = useState<boolean>(false);

  const [playerMode, setPlayerMode] = useState<'stream' | 'trailer'>('stream');
  const [videoError, setVideoError] = useState(false);
  // Use native continuous <video> streaming on Android/Desktop for zero segment transitions,
  // and Client-Side MP4 Remuxer on iPhone/iPad Safari (or as automatic fallback if native stream errors).
  const [useHlsBridge, setUseHlsBridge] = useState<boolean>(() => isAppleWebKitDevice());
  const [iosBlobUrl, setIosBlobUrl] = useState<string>('');
  const [iosSegmentStartSec, setIosSegmentStartSec] = useState<number>(0);
  const [iosCurrentSegIndex, setIosCurrentSegIndex] = useState<number>(0);
  const iosControllerRef = useRef<IosMkvStreamController | null>(null);
  const iosTransitioningRef = useRef<boolean>(false);
  const hlsInstanceRef = useRef<Hls | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [hasStartedPlayback, setHasStartedPlayback] = useState(false);
  const [standbyUpgradeIdx, setStandbyUpgradeIdx] = useState<number | null>(null);
  const [isBuffering, setIsBuffering] = useState(false);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [isHold2x, setIsHold2x] = useState(false);
  const [videoFit, setVideoFit] = useState<'contain' | 'cover' | 'fill'>('contain');
  const [isScreenLocked, setIsScreenLocked] = useState(false);
  const [showOverlayControls, setShowOverlayControls] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isLandscapeMode, setIsLandscapeMode] = useState(false);
  const [isViewportPortrait, setIsViewportPortrait] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerHeight >= window.innerWidth : true
  );
  const [viewportDims, setViewportDims] = useState<{ width: number; height: number }>(() => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 390,
    height: typeof window !== 'undefined' ? window.innerHeight : 844,
  }));

  // MovieBox Screen Brightness (20% to 160%) & Volume (0% to 100%)
  const [brightness, setBrightness] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(BRIGHTNESS_STORAGE_KEY));
      return saved >= 20 && saved <= 160 ? saved : 100;
    } catch {
      return 100;
    }
  });
  const [showBrightnessPanel, setShowBrightnessPanel] = useState(false);
  const [volume, setVolume] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(SOUND_BOOST_STORAGE_KEY));
      if (!Number.isNaN(saved) && saved >= 10 && saved <= 400) {
        return Math.round(saved);
      }
    } catch {
      // ignore
    }
    return 100;
  });
  const [showSoundBoostBar, setShowSoundBoostBar] = useState<boolean>(false);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [autoMutedForiOS, setAutoMutedForiOS] = useState<boolean>(false);

  // Gesture HUD Indicator (Brightness / Volume / Seek feedback)
  const [hudNotice, setHudNotice] = useState<{
    type: 'brightness' | 'volume' | 'seek' | 'toast';
    label: string;
    percent?: number;
  } | null>(null);

  const [copiedShare, setCopiedShare] = useState(false);
  const [copiedBatch, setCopiedBatch] = useState(false);

  // Automatically mute the 0s..13.5s upstream voice-tag window ("this video downloaded from...")
  const [introSkipSec, setIntroSkipSec] = useState<number>(13.5);

  // Auto-Play Next Episode
  const [autoNextEp, setAutoNextEp] = useState<boolean>(() => {
    try {
      return localStorage.getItem(AUTO_NEXT_STORAGE_KEY) !== '0';
    } catch {
      return true;
    }
  });

  const [resumedBannerSec, setResumedBannerSec] = useState<number | null>(null);

  // Auto Bangla Subtitle & Custom Subtitle (.SRT / .VTT) State (OFF by default so video starts with zero delay!)
  const [autoBanglaSubEnabled, setAutoBanglaSubEnabled] = useState<boolean>(false);
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([]);
  const [loadingAutoSub, setLoadingAutoSub] = useState<boolean>(false);
  const [subFontSize, setSubFontSize] = useState<'sm' | 'md' | 'lg'>('sm');
  const [subtitleUrl, setSubtitleUrl] = useState<string | null>(null);
  const [subtitleName, setSubtitleName] = useState<string>('');
  const [availableSubTracks, setAvailableSubTracks] = useState<AvailableSubtitleTrack[]>([]);
  const [activeSubTrackIdx, setActiveSubTrackIdx] = useState<number>(0);
  const [subOffsetSec, setSubOffsetSec] = useState<number>(0);
  const [showSubSyncPanel, setShowSubSyncPanel] = useState<boolean>(false);
  const [customSubSearchQuery, setCustomSubSearchQuery] = useState<string>('');
  const [activeBanglaCueText, setActiveBanglaCueText] = useState<string>('');
  const lastRenderedSubTextRef = useRef<string>('');
  const subtitleInputRef = useRef<HTMLInputElement | null>(null);

  const modalContainerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const preloadVideoRef = useRef<HTMLVideoElement | null>(null);
  const playerStageRef = useRef<HTMLDivElement | null>(null);
  const scrubberRef = useRef<HTMLDivElement | null>(null);
  const isScrubbingRef = useRef<boolean>(false);
  const scrubTargetSecRef = useRef<number>(0);
  const lastTouchSeekTimeRef = useRef<number>(0);
  const isSeekingRef = useRef<boolean>(false);
  const seekReqIdRef = useRef<number>(0);
  const iosSegmentStartSecRef = useRef<number>(0);
  const iosCurrentSegIndexRef = useRef<number>(0);
  const overlayTimerRef = useRef<number | null>(null);
  const hudTimerRef = useRef<number | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const rippleTimerRef = useRef<number | null>(null);
  const prewarmedNextEpIdxRef = useRef<number | null>(null);
  const stallDownshiftTimerRef = useRef<number | null>(null);
  const startupWatchdogTimerRef = useRef<number | null>(null);
  const standbyTimeoutRef = useRef<number | null>(null);
  const smoothPlaySecondsRef = useRef<number>(0);
  const hasStalledInSessionRef = useRef<boolean>(false);
  const hasTriedBridgeFallbackRef = useRef<boolean>(false);
  const hasUserManualServerRef = useRef<boolean>(false);
  const lastTapRef = useRef<{ time: number; side: 'left' | 'right' | 'center' }>({
    time: 0,
    side: 'center',
  });
  const touchGestureRef = useRef<{
    active: boolean;
    side: 'left' | 'right';
    startX: number;
    startY: number;
    startVal: number;
    moved: boolean;
  } | null>(null);
  const lastRecordedSecondRef = useRef<number>(-1);
  const pendingResumeSecRef = useRef<number | null>(null);
  const hasAppliedIntroSkipRef = useRef<boolean>(false);
  const pendingOsPipRef = useRef<boolean>(false);
  const embedIframeRef = useRef<HTMLIFrameElement | null>(null);
  const [isPortraitFullscreen, setIsPortraitFullscreen] = useState<boolean>(false);
  const [isOsPipActive, setIsOsPipActive] = useState<boolean>(false);

  // Floating Mini-Player Position & Resizable Width State
  const [miniWidth, setMiniWidth] = useState<number>(250);
  const [miniPos, setMiniPos] = useState<{ x: number; y: number } | null>(null);
  const lastMiniTapTimeRef = useRef<number>(0);
  const manualLandscapeLockRef = useRef<boolean>(false);
  const autoTiltLandscapeRef = useRef<boolean>(false);
  const wasViewportLandscapeRef = useRef<boolean>(false);
  const tiltDebounceRef = useRef<number | null>(null);
  const [selectedQualityPref, setSelectedQualityPref] = useState<'auto' | number>('auto');
  const [showSeparateQualityBar, setShowSeparateQualityBar] = useState<boolean>(false);
  const miniDragRef = useRef<{
    mode: 'move' | 'resize' | 'pinch';
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    origWidth: number;
    initialPinchDist: number;
    moved: boolean;
  } | null>(null);

  const triggerHud = (
    type: 'brightness' | 'volume' | 'seek' | 'toast',
    label: string,
    percent?: number,
    timeoutMs = 1100
  ) => {
    setHudNotice({ type, label, percent });
    if (hudTimerRef.current) window.clearTimeout(hudTimerRef.current);
    hudTimerRef.current = window.setTimeout(() => {
      setHudNotice(null);
    }, timeoutMs);
  };

  const resetOverlayAutoHide = () => {
    setShowOverlayControls(true);
    if (overlayTimerRef.current) window.clearTimeout(overlayTimerRef.current);
    overlayTimerRef.current = window.setTimeout(() => {
      if (
        videoRef.current &&
        !videoRef.current.paused &&
        !isScrubbing &&
        !showBrightnessPanel &&
        !showQualityMenu &&
        !showAudioServerMenu &&
        !showSleepMenu
      ) {
        setShowOverlayControls(false);
      }
    }, 3600);
  };

  // Sleep Timer Countdown Effect
  useEffect(() => {
    if (typeof sleepTimerMode !== 'number' || sleepRemainingSec === null) return;
    if (sleepRemainingSec <= 0) {
      if (videoRef.current && !videoRef.current.paused) {
        videoRef.current.pause();
      }
      setSleepTimerMode(null);
      setSleepRemainingSec(null);
      triggerHud('toast', '🌙 স্লিপ টাইমার শেষ হয়েছে — ভিডিও পজ করা হয়েছে', undefined, 3200);
      return;
    }
    const timer = window.setInterval(() => {
      setSleepRemainingSec((prev) => (prev !== null && prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [sleepTimerMode, sleepRemainingSec]);

  useEffect(() => {
    try {
      localStorage.setItem(BRIGHTNESS_STORAGE_KEY, String(brightness));
    } catch {
      // ignore
    }
  }, [brightness]);

  useEffect(() => {
    try {
      localStorage.setItem(AUTO_NET_STORAGE_KEY, autoNetQuality ? '1' : '0');
    } catch {
      // ignore
    }
  }, [autoNetQuality]);

  useEffect(() => {
    try {
      localStorage.setItem(INTRO_SKIP_STORAGE_KEY, String(introSkipSec));
    } catch {
      // ignore
    }
  }, [introSkipSec]);

  useEffect(() => {
    try {
      localStorage.setItem(AUTO_NEXT_STORAGE_KEY, autoNextEp ? '1' : '0');
    } catch {
      // ignore
    }
  }, [autoNextEp]);

  useEffect(() => {
    try {
      localStorage.setItem('cp_auto_bangla_sub_v1', autoBanglaSubEnabled ? '1' : '0');
    } catch {
      // ignore
    }
  }, [autoBanglaSubEnabled]);

  useEffect(() => {
    const updateOrientation = () => {
      const w = window.innerWidth || 390;
      const h = window.innerHeight || 844;
      const isPortraitNow = h >= w;
      setIsViewportPortrait(isPortraitNow);
      setViewportDims({ width: w, height: h });

      // Detect phone rotation to landscape via viewport ratio, screen.orientation, or window.orientation
      const scrAngle =
        typeof (window.screen?.orientation as any)?.angle === 'number'
          ? (window.screen.orientation as any).angle
          : typeof (window as any).orientation === 'number'
            ? (window as any).orientation
            : 0;
      const scrType = String((window.screen?.orientation as any)?.type || '');
      const isMobileLike = Math.min(w, h) <= 960 || 'ontouchstart' in window;
      const isNowLandscape =
        isMobileLike &&
        (w > h * 1.05 ||
          scrType.startsWith('landscape') ||
          scrAngle === 90 ||
          scrAngle === -90 ||
          scrAngle === 270);

      if (isNowLandscape && !wasViewportLandscapeRef.current) {
        wasViewportLandscapeRef.current = true;
        setIsPortraitFullscreen(false);
        setIsLandscapeMode(true);
        setIsFullscreen(true);
      } else if (!isNowLandscape && wasViewportLandscapeRef.current) {
        wasViewportLandscapeRef.current = false;
        if (!manualLandscapeLockRef.current) {
          setIsLandscapeMode(false);
          setIsFullscreen(false);
        }
      }
    };

    // Physical Phone Tilt Sensor (Gyroscope / Accelerometer) — Auto-enters Landscape even when phone OS Auto-Rotate is OFF
    const onDeviceOrientation = (e: DeviceOrientationEvent) => {
      const gamma = typeof e.gamma === 'number' ? e.gamma : 0; // Left/Right tilt (-90 to 90)
      const beta = typeof e.beta === 'number' ? e.beta : 0; // Front/Back tilt (-180 to 180)
      if (gamma === 0 && beta === 0) return;

      // Tilted sideways horizontally (phone held in landscape position)
      const isTiltedSideways = Math.abs(gamma) >= 48 && Math.abs(beta) <= 45;
      // Held upright vertically (phone held in portrait position)
      const isHeldUpright = Math.abs(beta) >= 48 && Math.abs(gamma) <= 25;

      if (isTiltedSideways && !autoTiltLandscapeRef.current) {
        if (tiltDebounceRef.current) window.clearTimeout(tiltDebounceRef.current);
        tiltDebounceRef.current = window.setTimeout(() => {
          autoTiltLandscapeRef.current = true;
          setIsPortraitFullscreen(false);
          setIsLandscapeMode(true);
          setIsFullscreen(true);
        }, 300);
      } else if (isHeldUpright && autoTiltLandscapeRef.current && !manualLandscapeLockRef.current) {
        if (tiltDebounceRef.current) window.clearTimeout(tiltDebounceRef.current);
        tiltDebounceRef.current = window.setTimeout(() => {
          autoTiltLandscapeRef.current = false;
          if (!wasViewportLandscapeRef.current) {
            setIsLandscapeMode(false);
            setIsFullscreen(false);
          }
        }, 300);
      }
    };

    const onFsChange = () => {
      const fsActive = Boolean(
        document.fullscreenElement || (document as any).webkitFullscreenElement
      );
      setIsFullscreen(fsActive);
      if (!fsActive && !wasViewportLandscapeRef.current && !autoTiltLandscapeRef.current) {
        setIsLandscapeMode(false);
      }
      updateOrientation();
    };

    const mql = window.matchMedia ? window.matchMedia('(orientation: landscape)') : null;
    const onMqlChange = () => updateOrientation();

    window.addEventListener('resize', updateOrientation);
    window.addEventListener('orientationchange', updateOrientation);
    window.addEventListener('deviceorientation', onDeviceOrientation, true);
    if (window.screen?.orientation) {
      window.screen.orientation.addEventListener?.('change', updateOrientation);
    }
    if (mql?.addEventListener) {
      mql.addEventListener('change', onMqlChange);
    }
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);

    // Run once on mount in case phone is already held in landscape
    updateOrientation();

    return () => {
      if (tiltDebounceRef.current) window.clearTimeout(tiltDebounceRef.current);
      window.removeEventListener('resize', updateOrientation);
      window.removeEventListener('orientationchange', updateOrientation);
      window.removeEventListener('deviceorientation', onDeviceOrientation, true);
      if (window.screen?.orientation) {
        window.screen.orientation.removeEventListener?.('change', updateOrientation);
      }
      if (mql?.removeEventListener) {
        mql.removeEventListener('change', onMqlChange);
      }
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
    };
  }, []);

  // Automatically dismiss "Resumed at ..." banner after 1.2 seconds so it never stays stuck
  useEffect(() => {
    if (resumedBannerSec === null) return;
    const timer = window.setTimeout(() => {
      setResumedBannerSec(null);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [resumedBannerSec]);

  const releaseActiveVideoSockets = () => {
    stopBackgroundWarmVideo();
    if (hlsInstanceRef.current) {
      try {
        hlsInstanceRef.current.destroy();
      } catch {
        // ignore
      }
      hlsInstanceRef.current = null;
    }
    if (iosControllerRef.current) {
      try {
        iosControllerRef.current.destroy();
      } catch {
        // ignore
      }
      iosControllerRef.current = null;
    }
    if (videoRef.current) {
      try {
        videoRef.current.pause();
        videoRef.current.removeAttribute('src');
        videoRef.current.load();
      } catch {
        // ignore
      }
    }
    if (preloadVideoRef.current) {
      try {
        preloadVideoRef.current.pause();
        preloadVideoRef.current.removeAttribute('src');
        preloadVideoRef.current.load();
      } catch {
        // ignore
      }
    }
  };

  useEffect(() => {
    return () => {
      setVideoStartupPriority(false);
      releaseActiveVideoSockets();
      if (subtitleUrl) {
        URL.revokeObjectURL(subtitleUrl);
      }
      if (overlayTimerRef.current) window.clearTimeout(overlayTimerRef.current);
      if (hudTimerRef.current) window.clearTimeout(hudTimerRef.current);
      if (holdTimerRef.current) window.clearTimeout(holdTimerRef.current);
      if (stallDownshiftTimerRef.current) window.clearTimeout(stallDownshiftTimerRef.current);
      if (startupWatchdogTimerRef.current) window.clearTimeout(startupWatchdogTimerRef.current);
      if (standbyTimeoutRef.current) window.clearTimeout(standbyTimeoutRef.current);
    };
  }, [subtitleUrl]);

  // Prioritize 100% of network bandwidth for video startup until playback is smoothly underway
  useEffect(() => {
    if (!movie) {
      setVideoStartupPriority(false);
      return;
    }
    const starting = loading || (!hasStartedPlayback && !videoError);
    setVideoStartupPriority(starting);
  }, [movie, loading, hasStartedPlayback, videoError]);

  useEffect(() => {
    if (!movie) return;
    let cancelled = false;
    // Immediately abort any previous movie's open <video> stream so 100% of browser sockets are free for the new click!
    releaseActiveVideoSockets();
    setVideoStartupPriority(true);
    setError(null);
    setSelectedSeasonFilter('all');
    setEpisodeSearchQuery('');
    setEpisodeSortOrder('asc');
    setFailedSourceIndices([]);
    setUseHlsBridge(isAppleWebKitDevice());
    setPlayerMode('stream');
    setVideoError(false);
    setHasStartedPlayback(false);
    setStandbyUpgradeIdx(null);
    setResumedBannerSec(null);
    setShowDownloadSheet(false);
    setShowAllEpisodesModal(false);
    setCurrentTime(0);
    setBufferedEnd(0);
    setDuration(0);
    setAutoMutedForiOS(false);
    smoothPlaySecondsRef.current = 0;
    hasStalledInSessionRef.current = false;
    hasTriedBridgeFallbackRef.current = false;
    hasUserManualServerRef.current = false;
    hasAppliedIntroSkipRef.current = false;
    pendingResumeSecRef.current = null;
    if (modalContainerRef.current) {
      modalContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }

    const applyResolvedDetail = (resolved: MovieDetailData, isAlreadyMountedInstant = false) => {
      stopBackgroundWarmVideo();
      const eps: EpisodeItem[] = resolved.episodes || [];
      const initEpIdx =
        savedProgress?.episodeIdx !== undefined && eps[savedProgress.episodeIdx]
          ? savedProgress.episodeIdx
          : 0;
      if (!isAlreadyMountedInstant) {
        setDetail(resolved);
        setSelectedEpIdx(initEpIdx);
        setSelectedSourceIdx(0);
      }
    };

    const scheduleBackgroundEnrich = (resolvedDetail?: MovieDetailData) => {
      return window.setTimeout(() => {
        if (cancelled) return;
        const params = new URLSearchParams({
          path: movie.path || movie.url,
          title: movie.title,
          node: activeNodeId,
          enrich: '1',
        });
        universalApiFetch(`/api/details?${params.toString()}`)
          .then((data) => {
            if (!cancelled && data?.ok && data?.detail) {
              setDetail((prev) => {
                if (!prev || !prev.episodes?.length) return data.detail;
                const next = { ...prev };
                if ((data.detail.dubs?.length || 0) > (prev.dubs?.length || 0)) {
                  next.dubs = data.detail.dubs;
                }
                if ((data.detail.episodes?.length || 0) > prev.episodes.length) {
                  next.episodes = data.detail.episodes;
                }
                if (data.detail.uploadedBy && data.detail.uploadedBy !== 'MarieNo Ess') {
                  next.uploadedBy = data.detail.uploadedBy;
                }
                return next;
              });
            }
          })
          .catch(() => {});
      }, 350);
    };

    // 1. Synchronous 0ms Instant Check (from static-db.json or prefetched cache):
    // Mount the <video> player immediately on frame 1 with zero extra re-renders!
    const instantCached = getInstantCachedDetail(movie.path || movie.url, movie.title);
    if (instantCached && instantCached.episodes && instantCached.episodes.length > 0) {
      setLoading(false);
      applyResolvedDetail(instantCached, detail === instantCached);
      const enrichTimer = scheduleBackgroundEnrich(instantCached);
      return () => {
        cancelled = true;
        if (enrichTimer) window.clearTimeout(enrichTimer);
      };
    }

    let enrichTimer: number | null = null;
    const fetchDetail = async () => {
      try {
        // 2. Fast local shard lookup (~5ms) before showing loading state or making a network trip!
        const shardHit = await loadShardForMovie(movie.path || movie.url, movie.title);
        if (cancelled) return;
        if (shardHit && shardHit.episodes && shardHit.episodes.length > 0) {
          setLoading(false);
          applyResolvedDetail(shardHit);
          enrichTimer = scheduleBackgroundEnrich(shardHit);
          return;
        }

        setLoading(true);
        setDetail(null);
        setSelectedEpIdx(savedProgress?.episodeIdx || 0);
        setSelectedSourceIdx(0);

        const params = new URLSearchParams({
          path: movie.path || movie.url,
          title: movie.title,
          node: activeNodeId,
        });
        const data = await universalApiFetch(`/api/details?${params.toString()}`);
        if (!cancelled) {
          if (data && data.ok && data.detail) {
            applyResolvedDetail(data.detail);
          } else {
            setError('এই মুভিটির বিস্তারিত তথ্য লোড করা যায়নি।');
          }
        }
      } catch {
        if (!cancelled) {
          setError('সার্ভারের সাথে সংযোগ বিচ্ছিন্ন হয়েছে।');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    fetchDetail();
    return () => {
      cancelled = true;
      if (enrichTimer) window.clearTimeout(enrichTimer);
    };
  }, [movie?.path, movie?.url, activeNodeId]);

  const [myflixData, setMyflixData] = useState<{
    embedServers?: Array<{ label: string; url: string }>;
    seasonsData?: Array<{
      index?: number;
      episodes?: Array<{
        index?: number;
        title?: string;
        servers?: Array<{ label?: string; url?: string }>;
      }>;
    }>;
    year?: string;
    genre?: string;
    runtime?: string;
    director?: string;
    release?: string;
    rating?: string;
    screenshots?: string[];
    cast?: Array<{ name: string; role: string; photo: string }>;
    downloads?: Array<{ label: string; url: string }>;
  } | null>(null);
  const [showSeasonDropdown, setShowSeasonDropdown] = useState(false);
  const [showDubDropdown, setShowDubDropdown] = useState(false);
  const [showAllScreenshots, setShowAllScreenshots] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const castScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setMyflixData(null);
    setShowSeasonDropdown(false);
    setShowDubDropdown(false);
    setShowAllScreenshots(false);
    setLightboxImage(null);
  }, [movie?.path, movie?.title]);

  // Only pre-warm related seasons & "For you" movies AFTER current video has started playing smoothly (>= 8s)
  useEffect(() => {
    if (!movie || !hasStartedPlayback || currentTime < 8) return;
    const timer = window.setTimeout(() => {
      (detail?.relatedSeasons || []).slice(0, 3).forEach((s) => {
        prefetchMovieDetails(s.path, s.title, activeNodeId);
      });
      relatedMovies.slice(0, 4).forEach((rel) => {
        if (rel.path !== movie.path) {
          prefetchMovieDetails(rel.path, rel.title, activeNodeId);
        }
      });
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [movie, detail?.relatedSeasons, relatedMovies, activeNodeId, hasStartedPlayback, currentTime >= 8]);

  const effectiveDetail = detail || instantDetailOnRender;
  const episodes = useMemo<EpisodeItem[]>(() => {
    if (effectiveDetail?.episodes && effectiveDetail.episodes.length > 0) {
      return effectiveDetail.episodes;
    }
    if (loading) {
      return [];
    }
    if (myflixData?.seasonsData && myflixData.seasonsData.length > 0) {
      const built: EpisodeItem[] = [];
      let globalIdx = 0;
      for (const sObj of myflixData.seasonsData) {
        const sNum = Number(sObj?.index) || 1;
        for (const epObj of sObj?.episodes || []) {
          globalIdx++;
          const epNum = Number(epObj?.index) || globalIdx;
          const epTitle = epObj?.title || `Episode ${epNum}`;
          const srvs = (epObj?.servers || []).filter((s) => s?.url);
          if (srvs.length > 0) {
            built.push({
              id: `mf-s${sNum}-e${epNum}`,
              label: `S${String(sNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')} • ${epTitle}`,
              number: epNum,
              rangeStart: epNum,
              rangeEnd: epNum,
              season: sNum,
              kind: 'episode',
              sources: srvs.map((srv, idx) => ({
                id: `mf-ep-${sNum}-${epNum}-${idx}`,
                name: srv.label || `Cloud Server ${idx + 1}`,
                quality: 1080,
                qualityLabel: 'Cloud HLS',
                audio: movie?.language || 'Multi Audio',
                audioLanguages: [movie?.language || 'Multi'],
                provider: srv.label || `Cloud Server ${idx + 1}`,
                url: String(srv.url),
                downloadUrl: String(srv.url),
                type: 'embed',
              })),
            });
          }
        }
      }
      if (built.length > 0) return built;
    }
    return [];
  }, [effectiveDetail?.episodes, loading, myflixData?.seasonsData, movie?.language]);

  const activeEpisode: EpisodeItem | undefined = episodes[selectedEpIdx] || episodes[0];
  const sources = useMemo<StreamSource[]>(() => {
    const rawList = activeEpisode?.sources ? [...activeEpisode.sources] : [];
    const directVideoSources = rawList.filter(
      (s) => s.type !== 'embed' && !/abyssplayer\.com|abysscdn\.com|vidsrc|superembed|multiembed|\/embed\//i.test(s.url || '')
    );
    const score = (src: StreamSource) => {
      const url = src.url || '';
      const isMovieBox =
        src.id?.startsWith('mb-') || /\/api\/mb-stream|\/api\/mb-ep-stream/i.test(url);
      if (isMovieBox) {
        // Prioritize native H.264 MP4 Micro-Chunk streams from movie-box.co first!
        // Rank fast-start 720p/480p/360p (or 1080p <= 350MB) ahead of heavy 900MB 1080p files for <150ms startup
        const szMatch = (src.name || '').match(/(\d+)\s*MB/i);
        const szMb = szMatch ? parseInt(szMatch[1], 10) : 0;
        const isHeavyFile = szMb > 350;
        const base = 4500;
        if (src.quality === 720) return base + 260;
        if (src.quality === 480) return base + 250;
        if (src.quality >= 360 && src.quality <= 576) return base + 235;
        if (src.quality === 1080) return isHeavyFile ? base + 140 : base + 245;
        return base + 200;
      }
      const isDirectCdn = /fsldownload\.com|r2\.dev|workers\.dev|cloudflare/i.test(url);
      if (isDirectCdn) {
        if (src.quality === 720) return 3850;
        if (src.quality >= 360 && src.quality <= 576) return 3800;
        if (src.quality === 1080) return 3750;
        return 3600;
      }
      const isHevc = /\b(hevc|h\.?265|x265|10bit|av1)\b/i.test(`${src.name} ${src.qualityLabel}`);
      const isBestHeavy = /best\s*quality/i.test(src.qualityLabel || '');
      let sc = isHevc ? 600 : 2600;
      if (isBestHeavy) sc -= 250;
      if (src.quality >= 360 && src.quality <= 576) sc += 650;
      else if (src.quality === 720) sc += 500;
      else if (src.quality === 1080) sc += 350;
      else sc += 150;
      return sc;
    };

    const sortedDirect = [...directVideoSources].sort((a, b) => score(b) - score(a));
    const embedRaw = rawList.filter(
      (s) => s.type === 'embed' || /abyssplayer\.com|abysscdn\.com|vidsrc|superembed|multiembed|\/embed\//i.test(s.url || '')
    );

    // Put direct <video> streams FIRST so native HTML5 <video>, OS PiP, Quality Selector, and Gesture Controls work on every video,
    // and ALWAYS append embed/MyFlix backup servers after them so playback never fails if a regional CDN is unreachable!
    const myflixFirst: StreamSource[] = [];
    const seen = new Set<string>();

    for (const [idx, d] of sortedDirect.entries()) {
      if (d.url && !seen.has(d.url)) {
        seen.add(d.url);
        myflixFirst.push({
          ...d,
          name: d.name || `MovieBox HD #${idx + 1} (${d.quality || 720}p)`,
          provider: d.provider || `MovieBox HD #${idx + 1}`,
        });
      }
    }

    // While /api/details is still loading and we have no direct streams yet, wait before falling back to embed
    if (loading && myflixFirst.length === 0) {
      return [];
    }

    for (const e of embedRaw) {
      if (e.url && !seen.has(e.url)) {
        seen.add(e.url);
        myflixFirst.push(e);
      }
    }

    if (myflixData?.seasonsData?.length) {
      const flatEpList = myflixData.seasonsData.flatMap((s) => s.episodes || []);
      const matchedMfEp =
        flatEpList.find((e) => Number(e.index) === (activeEpisode?.number || selectedEpIdx + 1)) ||
        flatEpList[selectedEpIdx] ||
        flatEpList[0];
      for (const [idx, srv] of (matchedMfEp?.servers || []).entries()) {
        if (srv?.url && !seen.has(srv.url)) {
          seen.add(srv.url);
          myflixFirst.push({
            id: `myflix-ep-${idx}`,
            name: `MyFlix Turbo #${idx + 1}`,
            quality: 1080,
            qualityLabel: 'MyFlix HLS',
            audio: movie?.language || 'Multi Audio',
            audioLanguages: [movie?.language || 'Multi'],
            provider: `MyFlix Turbo #${idx + 1}`,
            url: srv.url,
            downloadUrl: srv.url,
            type: 'embed',
          });
        }
      }
    }

    if (myflixData?.embedServers?.length) {
      myflixData.embedServers.forEach((srv, idx) => {
        if (srv.url && !seen.has(srv.url)) {
          seen.add(srv.url);
          myflixFirst.push({
            id: `myflix-${idx}`,
            name: `MyFlix Turbo #${idx + 1}`,
            quality: 1080,
            qualityLabel: 'MyFlix HLS',
            audio: movie?.language || 'Multi Audio',
            audioLanguages: [movie?.language || 'Multi'],
            provider: `MyFlix Turbo #${idx + 1}`,
            url: srv.url,
            downloadUrl: srv.url,
            type: 'embed',
          });
        }
      });
    }

    return myflixFirst;
  }, [activeEpisode?.sources, activeEpisode?.number, selectedEpIdx, loading, myflixData?.seasonsData, myflixData?.embedServers, movie?.language]);
  const activeSource: StreamSource | undefined = sources[selectedSourceIdx] || sources[0];
  const isEmbedSource = Boolean(
    activeSource &&
      (activeSource.type === 'embed' || /abyssplayer\.com|abysscdn\.com|vidsrc|\/embed\//i.test(activeSource.url))
  );

  // If the selected episode uses lazy /api/mb-ep-stream.mp4 URLs, also resolve direct CDN MP4 tokens in the browser using user's local Geo-IP!
  useEffect(() => {
    if (!activeEpisode || !detail) return;
    const firstLazy = activeEpisode.sources?.find((s) =>
      String(s.url || '').includes('/api/mb-ep-stream')
    );
    if (!firstLazy) return;
    let cancelled = false;
    try {
      const u = new URL(firstLazy.url, 'https://cinepulse.local');
      const subjectId = u.searchParams.get('subjectId') || '';
      const detailPath = u.searchParams.get('detailPath') || '';
      const se = parseInt(u.searchParams.get('se') || '1', 10) || 1;
      const ep = parseInt(u.searchParams.get('ep') || '1', 10) || 1;
      if (!subjectId || !detailPath) return;
      resolveBrowserMovieBoxEpisodeSources(
        subjectId,
        detailPath,
        se,
        ep,
        `${detail.title} S${se}E${ep}`,
        detail.language || 'Original Audio'
      ).then(({ sources: resolvedSources, buttons: resolvedButtons }) => {
        if (cancelled || !resolvedSources.length) return;
        setDetail((prev) => {
          if (!prev) return prev;
          const nextEps = prev.episodes.map((item) =>
            item.id === activeEpisode.id ? { ...item, sources: resolvedSources } : item
          );
          return {
            ...prev,
            episodes: nextEps,
            downloadButtons:
              resolvedButtons.length > 0 ? resolvedButtons : prev.downloadButtons,
          };
        });
      });
    } catch {
      // ignore
    }
    return () => {
      cancelled = true;
    };
  }, [activeEpisode?.id, detail?.url]);

  // Distinct seasons present inside episodes list (e.g. Season 1, Season 2... Season 20)
  const distinctSeasons = useMemo(() => {
    const sSet = new Set<number>();
    episodes.forEach((ep) => {
      if (ep.season !== null && ep.season !== undefined && ep.season > 0) {
        sSet.add(ep.season);
      }
    });
    return Array.from(sSet).sort((a, b) => a - b);
  }, [episodes]);

  // Filtered & sorted episodes with original index preserved
  const filteredEpisodesWithIdx = useMemo(() => {
    const base = episodes.map((ep, idx) => ({ ep, idx }));
    const bySeason =
      selectedSeasonFilter === 'all'
        ? base
        : base.filter((x) => x.ep.season === selectedSeasonFilter);

    const q = episodeSearchQuery.trim().toLowerCase();
    const matched = !q
      ? bySeason
      : bySeason.filter(({ ep, idx }) => {
          const badge = formatEpisodeTileBadge(ep, idx).toLowerCase();
          const lbl = ep.label.toLowerCase();
          return badge.includes(q) || lbl.includes(q);
        });

    return episodeSortOrder === 'desc' ? [...matched].reverse() : matched;
  }, [episodes, selectedSeasonFilter, episodeSearchQuery, episodeSortOrder]);

  // Automatic Synchronized Bangla Subtitle Resolver — Starts 700ms after movie opens
  // using effectiveDetail so both instant-cached and live-fetched titles resolve Bangla subtitles!
  useEffect(() => {
    if (!movie || !autoBanglaSubEnabled) return;
    let cancelled = false;

    const subDelayTimer = window.setTimeout(() => {
      if (cancelled) return;

      // Fast-path: check if our Micro-Chunk MKV remuxer already extracted embedded subtitles from RAM!
      const inMemoryMkvSubs = iosControllerRef.current?.getExtractedSubtitles() || [];
      if (inMemoryMkvSubs.length >= 8) {
        const mappedCues: SubtitleCue[] = inMemoryMkvSubs.map((s) => ({
          startSec: s.ptsMs / 1000,
          endSec: s.endPtsMs / 1000,
          text: s.text,
        }));
        ensureBanglaTranslationAroundTime(mappedCues, Math.max(0, currentTime - subOffsetSec))
          .then(() => {
            if (cancelled) return;
            const vttText = buildVttFromCues(mappedCues);
            const blob = new Blob([vttText], { type: 'text/vtt' });
            setSubtitleCues(mappedCues);
            setSubtitleUrl(URL.createObjectURL(blob));
            setSubtitleName('বাংলা Sub (Embedded Sync)');
          })
          .catch(() => {});
        return;
      }

      setLoadingAutoSub(true);
      const isSeriesItem = Boolean(
        episodes.length > 1 ||
          movie.typeBadge === 'SERIES' ||
          /\b(season|episode|ep\s*\d+|s\d+)\b/i.test(
            `${effectiveDetail?.title || movie.title} ${activeEpisode?.label || ''}`
          )
      );
      const resolvedSeason =
        activeEpisode?.season && activeEpisode.season > 0
          ? activeEpisode.season
          : isSeriesItem
            ? selectedSeasonFilter !== 'all'
              ? Number(selectedSeasonFilter)
              : distinctSeasons[0] || 1
            : undefined;
      const resolvedEpisode =
        activeEpisode?.number && activeEpisode.number > 0
          ? activeEpisode.number
          : isSeriesItem
            ? selectedEpIdx + 1
            : undefined;

      fetchOrGenerateAutoBanglaSubtitles({
        moviePath: movie.path || movie.url,
        title: effectiveDetail?.title || movie.title,
        storyline: effectiveDetail?.storyline || '',
        episodeLabel: activeEpisode?.label || '',
        season: resolvedSeason,
        episode: resolvedEpisode,
        language: effectiveDetail?.language || movie.language,
        streamUrl: activeSource?.url,
        streamName: `${activeSource?.name || ''} ${activeSource?.qualityLabel || ''} ${effectiveDetail?.quality || movie.quality || ''}`,
        videoDurationSec: duration || undefined,
        currentTimeSec: Math.max(0, currentTime - subOffsetSec),
      })
        .then((res) => {
          if (cancelled) return;
          setSubtitleCues(res.cues);
          setSubtitleUrl(res.vttBlobUrl);
          setSubtitleName(res.sourceLabel);
          setAvailableSubTracks(res.availableTracks || []);
          setActiveSubTrackIdx(res.activeTrackIndex || 0);
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setLoadingAutoSub(false);
        });
    }, 700);

    return () => {
      cancelled = true;
      window.clearTimeout(subDelayTimer);
    };
  }, [
    movie?.path,
    effectiveDetail?.title,
    selectedEpIdx,
    activeEpisode?.label,
    autoBanglaSubEnabled,
    hasStartedPlayback,
  ]);

  // Advance playhead clock when playing an embed source so Bangla subtitles stay active on Cloud HLS too
  useEffect(() => {
    if (!movie || !isEmbedSource || !autoBanglaSubEnabled) return;
    const t = window.setInterval(() => {
      setCurrentTime((prev) => prev + 1);
    }, 1000);
    return () => window.clearInterval(t);
  }, [movie?.path, isEmbedSource, autoBanglaSubEnabled, selectedEpIdx, selectedSourceIdx]);

  // Live Windowed Bengali Translation around the viewer's current playback timestamp (even after seeking!)
  const translationBucket = Math.floor(Math.max(0, currentTime - subOffsetSec) / 6);
  useEffect(() => {
    if (!autoBanglaSubEnabled || subtitleCues.length === 0) return;
    let cancelled = false;
    const v = videoRef.current;
    const exactNow =
      v && !isEmbedSource
        ? useHlsBridge
          ? iosSegmentStartSec + v.currentTime
          : v.currentTime
        : currentTime;
    const effectiveTime = Math.max(0, exactNow - subOffsetSec);
    ensureBanglaTranslationAroundTime(subtitleCues, effectiveTime, (updated) => {
      if (!cancelled) {
        setSubtitleCues(updated);
      }
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [
    autoBanglaSubEnabled,
    subtitleCues.length,
    translationBucket,
    subOffsetSec,
    useHlsBridge,
    iosSegmentStartSec,
    isEmbedSource,
  ]);

  // Frame-Accurate 55ms Floating-Point Subtitle Sync Ticker:
  // Reads exact float `videoRef.current.currentTime` (instead of 1s floored integer) so Bengali subtitles
  // appear & disappear at the exact millisecond the actor speaks, with zero unnecessary React re-renders!
  useEffect(() => {
    if (!autoBanglaSubEnabled || subtitleCues.length === 0) {
      if (lastRenderedSubTextRef.current !== '') {
        lastRenderedSubTextRef.current = '';
        setActiveBanglaCueText('');
      }
      return;
    }

    const syncSubToExactVoiceTime = () => {
      const v = videoRef.current;
      const rawPlayhead =
        v && !isEmbedSource
          ? useHlsBridge
            ? iosSegmentStartSec + v.currentTime
            : v.currentTime
          : currentTime;
      const effectiveTimeSec = Math.max(0, rawPlayhead - subOffsetSec);
      const nextCueText = findActiveCueTextAtTime(subtitleCues, effectiveTimeSec);
      if (nextCueText !== lastRenderedSubTextRef.current) {
        lastRenderedSubTextRef.current = nextCueText;
        setActiveBanglaCueText(nextCueText);
      }
    };

    syncSubToExactVoiceTime();
    const timer = window.setInterval(syncSubToExactVoiceTime, 55);
    return () => window.clearInterval(timer);
  }, [
    autoBanglaSubEnabled,
    subtitleCues,
    subOffsetSec,
    useHlsBridge,
    iosSegmentStartSec,
    isEmbedSource,
    currentTime,
  ]);

  // Client-Side In-Browser Turbo Micro-Chunk MKV-to-MP4 Engine (700KB Instant Start + 650KB Exact Cues Seek)
  useEffect(() => {
    const rawUrl = activeSource?.url || '';
    const isAlreadyNativeMp4 =
      /\.(mp4|m4v|m3u8)(\?|$)/i.test(rawUrl) ||
      /\/api\/mb-stream|\/api\/mb-ep-stream/i.test(rawUrl) ||
      activeSource?.type === 'mp4';

    if (!useHlsBridge || !rawUrl || isAlreadyNativeMp4 || isEmbedSource) {
      if (iosControllerRef.current) {
        iosControllerRef.current.destroy();
        iosControllerRef.current = null;
      }
      isSeekingRef.current = false;
      iosSegmentStartSecRef.current = 0;
      iosCurrentSegIndexRef.current = 0;
      setIosBlobUrl('');
      setIosSegmentStartSec(0);
      setIosCurrentSegIndex(0);
      return;
    }

    if (iosControllerRef.current) {
      iosControllerRef.current.destroy();
      iosControllerRef.current = null;
    }

    // Compute any initial resume timestamp BEFORE starting the controller so it jumps straight
    // to the resumed CuePoint in a single fetch, and immediately lock `hasAppliedIntroSkipRef`
    // so live-updating `savedProgress` NEVER re-triggers a backward jump mid-playback!
    const initialResumeTarget =
      pendingResumeSecRef.current && pendingResumeSecRef.current > 3
        ? pendingResumeSecRef.current
        : !hasAppliedIntroSkipRef.current &&
            savedProgress &&
            (savedProgress.episodeIdx === undefined ||
              savedProgress.episodeIdx === selectedEpIdx) &&
            savedProgress.progressSeconds &&
            savedProgress.progressSeconds > 20
          ? savedProgress.progressSeconds
          : 0;

    hasAppliedIntroSkipRef.current = true;
    if (initialResumeTarget > 3) {
      pendingResumeSecRef.current = null;
    }

    const ctrl = new IosMkvStreamController(rawUrl, introSkipSec, initialResumeTarget);
    iosControllerRef.current = ctrl;
    iosTransitioningRef.current = false;
    isSeekingRef.current = false;
    iosSegmentStartSecRef.current = 0;
    iosCurrentSegIndexRef.current = 0;
    setIosBlobUrl('');
    setIosSegmentStartSec(0);
    setIosCurrentSegIndex(0);
    setVideoError(false);
    setIsBuffering(true);

    ctrl
      .startInitialSegment()
      .then(async (seg0) => {
        if (iosControllerRef.current !== ctrl) return;
        const totalDur = ctrl.getTotalDurationSec();
        if (totalDur > 0) {
          setDuration(Math.floor(totalDur));
        }

        iosCurrentSegIndexRef.current = seg0.index;
        iosSegmentStartSecRef.current = seg0.startSec;
        lastRecordedSecondRef.current = Math.floor(seg0.startSec);
        setIosCurrentSegIndex(seg0.index);
        setIosSegmentStartSec(seg0.startSec);
        setIosBlobUrl(seg0.blobUrl);
        setCurrentTime(Math.floor(seg0.startSec));
        if (initialResumeTarget > 20 && seg0.startSec >= 18) {
          setResumedBannerSec(Math.floor(seg0.startSec));
        }
        setIsBuffering(false);
      })
      .catch(() => {
        if (iosControllerRef.current !== ctrl) return;
        const nextFailed = Array.from(new Set([...failedSourceIndices, selectedSourceIdx]));
        setFailedSourceIndices(nextFailed);
        const nextCandidateIdx = sources.findIndex((_, idx) => !nextFailed.includes(idx));
        if (nextCandidateIdx !== -1) {
          setSelectedSourceIdx(nextCandidateIdx);
          return;
        }
        setIsBuffering(false);
        setVideoError(true);
      });

    return () => {
      if (iosControllerRef.current === ctrl) {
        ctrl.destroy();
        iosControllerRef.current = null;
      }
    };
  }, [activeSource?.url, useHlsBridge]);

  const effectiveVideoUrl = useMemo(() => {
    const rawUrl = activeSource?.url || '';
    if (!rawUrl) return '';
    const isAlreadyNativeMp4 =
      /\.(mp4|m4v|m3u8)(\?|$)/i.test(rawUrl) ||
      /\/api\/mb-stream|\/api\/mb-ep-stream/i.test(rawUrl) ||
      activeSource?.type === 'mp4';
    if (useHlsBridge && !isAlreadyNativeMp4 && !isEmbedSource) {
      return iosBlobUrl;
    }
    return rawUrl;
  }, [activeSource?.url, activeSource?.type, useHlsBridge, iosBlobUrl, isEmbedSource]);

  // OS Phone-Screen Picture-in-Picture (PiP) & MediaSession Integration when leaving browser/app
  useEffect(() => {
    const v = videoRef.current as any;
    if (!v) return;
    try {
      v.disablePictureInPicture = false;
      v.autoPictureInPicture = true;
    } catch {
      // ignore
    }
    const onEnterPip = () => setIsOsPipActive(true);
    const onLeavePip = () => setIsOsPipActive(false);
    const onWebkitPresentationChange = () => {
      if (v.webkitPresentationMode === 'picture-in-picture') {
        setIsOsPipActive(true);
      } else {
        setIsOsPipActive(false);
      }
    };
    v.addEventListener('enterpictureinpicture', onEnterPip);
    v.addEventListener('leavepictureinpicture', onLeavePip);
    v.addEventListener('webkitpresentationmodechanged', onWebkitPresentationChange);

    if ('mediaSession' in navigator && movie) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: movie.title,
          artist: 'CinePulse HD',
          artwork: movie.poster ? [{ src: movie.poster, sizes: '512x512', type: 'image/jpeg' }] : [],
        });
        navigator.mediaSession.setActionHandler('play', () => {
          v.play().catch(() => {});
        });
        navigator.mediaSession.setActionHandler('pause', () => {
          v.pause();
        });
        // Enable Chrome / Android / iOS Safari automatic Picture-in-Picture when swiping to Home screen or switching tabs
        (navigator.mediaSession as any).setActionHandler('enterpictureinpicture', () => {
          try {
            if (!document.pictureInPictureElement && v.requestPictureInPicture) {
              v.requestPictureInPicture().catch(() => {});
            } else if (v.webkitSupportsPresentationMode && v.webkitSetPresentationMode) {
              v.webkitSetPresentationMode('picture-in-picture');
            }
          } catch {
            // ignore
          }
        });
      } catch {
        // ignore
      }
    }

    const triggerAutoPipOnExit = () => {
      if (!v || v.paused || v.readyState < 1) return;
      try {
        v.disablePictureInPicture = false;
        v.autoPictureInPicture = true;
        v.setAttribute('autopictureinpicture', 'true');
        if (!document.pictureInPictureElement && v.requestPictureInPicture) {
          v.requestPictureInPicture().catch(() => {
            if (onToggleMiniPlayer && !isMiniPlayer) {
              onToggleMiniPlayer(true);
            }
          });
        } else if (
          v.webkitSupportsPresentationMode &&
          v.webkitSetPresentationMode &&
          v.webkitPresentationMode !== 'picture-in-picture'
        ) {
          v.webkitSetPresentationMode('picture-in-picture');
        }
      } catch {
        if (onToggleMiniPlayer && !isMiniPlayer) {
          onToggleMiniPlayer(true);
        }
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        triggerAutoPipOnExit();
      }
    };

    const onWindowBlur = () => {
      if (document.visibilityState === 'hidden') {
        triggerAutoPipOnExit();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', triggerAutoPipOnExit);
    window.addEventListener('blur', onWindowBlur);

    return () => {
      v.removeEventListener('enterpictureinpicture', onEnterPip);
      v.removeEventListener('leavepictureinpicture', onLeavePip);
      v.removeEventListener('webkitpresentationmodechanged', onWebkitPresentationChange);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', triggerAutoPipOnExit);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, [movie, effectiveVideoUrl, isEmbedSource, isMiniPlayer, onToggleMiniPlayer]);

  // Immediately trigger native video.play() inside useLayoutEffect (preserving user tap gesture!)
  // and only show buffering spinner if the stream takes > 600ms so instant streams never flash a spinner!
  useLayoutEffect(() => {
    stopBackgroundWarmVideo();
    if (!effectiveVideoUrl) {
      if (!useHlsBridge) setIsBuffering(false);
      return;
    }
    setVideoError(false);
    setIsBuffering(false);

    const v = videoRef.current;
    if (v && !isEmbedSource) {
      if (hlsInstanceRef.current) {
        hlsInstanceRef.current.destroy();
        hlsInstanceRef.current = null;
      }
      const isM3u8 = /\.m3u8(\?|$)/i.test(effectiveVideoUrl);
      if (isM3u8 && Hls.isSupported() && !v.canPlayType('application/vnd.apple.mpegurl')) {
        const hls = new Hls({
          enableWorker: true,
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          backBufferLength: 30,
          startFragPrefetch: true,
          testBandwidth: true,
          abrEwmaDefaultEstimate: 2_500_000,
        });
        hlsInstanceRef.current = hls;
        hls.loadSource(effectiveVideoUrl);
        hls.attachMedia(v);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          syncCleanAudioVolume(v);
          v.play().catch(() => {});
        });
      } else {
        syncCleanAudioVolume(v);
        const p = v.play();
        if (p !== undefined) {
          p.catch((err: any) => {
            if (err && err.name === 'NotAllowedError') {
              v.muted = true;
              setIsMuted(true);
              setAutoMutedForiOS(true);
              v.play().catch(() => {});
            }
          });
        }
      }
    }

    const bufTimer = window.setTimeout(() => {
      const curV = videoRef.current;
      if (curV && curV.readyState < 2 && !curV.paused) {
        setIsBuffering(true);
      }
    }, 500);

    // Fast 3.2s Startup Watchdog: if current server hasn't delivered metadata within 3.2s, immediately switch to the next server!
    if (startupWatchdogTimerRef.current) {
      window.clearTimeout(startupWatchdogTimerRef.current);
    }
    startupWatchdogTimerRef.current = window.setTimeout(() => {
      const curV = videoRef.current;
      if (curV && curV.readyState === 0 && sources.length > 1) {
        const nextFailed = Array.from(new Set([...failedSourceIndices, selectedSourceIdx]));
        const nextIdx = sources.findIndex(
          (s, idx) => !nextFailed.includes(idx) && s.type !== 'embed'
        );
        if (nextIdx !== -1) {
          setFailedSourceIndices(nextFailed);
          setSelectedSourceIdx(nextIdx);
        }
      }
    }, 3200);

    return () => {
      window.clearTimeout(bufTimer);
      if (startupWatchdogTimerRef.current) {
        window.clearTimeout(startupWatchdogTimerRef.current);
        startupWatchdogTimerRef.current = null;
      }
      if (hlsInstanceRef.current) {
        hlsInstanceRef.current.destroy();
        hlsInstanceRef.current = null;
      }
    };
  }, [effectiveVideoUrl, useHlsBridge, isEmbedSource]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = isHold2x ? 2.0 : playbackSpeed;
    }
  }, [playbackSpeed, isHold2x]);

  // High-frequency 80ms audio gate during the opening 16s so the 0s..13.5s voice tag is 100% silent
  // from millisecond 0 and unmutes cleanly the instant the voice tag ends!
  useEffect(() => {
    if (!movie || isEmbedSource || currentTime > 16) return;
    if (videoRef.current) {
      syncCleanAudioVolume(videoRef.current);
    }
    const timer = window.setInterval(() => {
      if (videoRef.current) {
        syncCleanAudioVolume(videoRef.current);
      }
    }, 80);
    return () => window.clearInterval(timer);
  }, [movie?.path, isEmbedSource, currentTime <= 16, isMuted, volume, introSkipSec, useHlsBridge]);

  // Keyboard Shortcuts (Space/K = Play/Pause, ArrowLeft/Right = +-10s, M = Mute, F = Fullscreen)
  useEffect(() => {
    if (!movie) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'Space' || e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        const v = videoRef.current;
        if (v) {
          if (v.paused) v.play().catch(() => {});
          else v.pause();
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        handleSeekRelative(10);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handleSeekRelative(-10);
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        setIsMuted((prev) => {
          const next = !prev;
          if (videoRef.current) videoRef.current.muted = next;
          return next;
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [movie, currentTime, duration]);

  // Listen to network speed changes only to update the status label (never tear down the active video mid-play!)
  useEffect(() => {
    if (!movie) return;
    const nav = navigator as any;
    const conn = nav?.connection || nav?.mozConnection || nav?.webkitConnection;
    if (!conn || !conn.addEventListener) return;

    const onNetworkChange = () => {
      const detected = detectIdealQualityForNetwork();
      setNetStatusLabel(detected.netLabel);
    };

    conn.addEventListener('change', onNetworkChange);
    return () => {
      conn.removeEventListener('change', onNetworkChange);
    };
  }, [movie]);

  if (!movie) return null;

  const advanceToNextIosSegment = async (): Promise<boolean> => {
    const ctrl = iosControllerRef.current;
    if (!ctrl || iosTransitioningRef.current || isSeekingRef.current) return false;
    iosTransitioningRef.current = true;
    try {
      const nextSeg = await ctrl.ensureNextSegmentPrebuffered(iosCurrentSegIndexRef.current + 1, 0);
      if (nextSeg && iosControllerRef.current === ctrl && !isSeekingRef.current) {
        const monotonicStartSec = Math.max(
          iosSegmentStartSecRef.current,
          lastRecordedSecondRef.current,
          nextSeg.startSec
        );
        pendingResumeSecRef.current = null;
        iosCurrentSegIndexRef.current = nextSeg.index;
        iosSegmentStartSecRef.current = monotonicStartSec;
        setIosCurrentSegIndex(nextSeg.index);
        setIosSegmentStartSec(monotonicStartSec);
        setIosBlobUrl(nextSeg.blobUrl);
        void ctrl.ensureNextSegmentPrebuffered(nextSeg.index + 1, 0);
        window.setTimeout(() => {
          iosTransitioningRef.current = false;
        }, 420);
        return true;
      }
      iosTransitioningRef.current = false;
      return false;
    } catch {
      iosTransitioningRef.current = false;
      return false;
    }
  };

  const seekVideoToGlobalTime = (targetGlobalSec: number) => {
    const v = videoRef.current;
    const ctrlDur = iosControllerRef.current?.getTotalDurationSec() || 0;
    const maxDur =
      ctrlDur > 0
        ? ctrlDur
        : duration > 0
          ? duration
          : !useHlsBridge && v?.duration
            ? v.duration
            : 99999;
    const clamped = Math.max(0, Math.min(maxDur - 1, targetGlobalSec));
    const roundedTarget = Math.floor(clamped);
    lastRecordedSecondRef.current = roundedTarget;
    setCurrentTime(roundedTarget);
    resetOverlayAutoHide();

    if (!useHlsBridge || !iosControllerRef.current) {
      if (v) {
        isSeekingRef.current = true;
        try {
          v.currentTime = clamped;
          if (v.paused) v.play().catch(() => {});
        } catch {
          // ignore
        }
        window.setTimeout(() => {
          isSeekingRef.current = false;
        }, 550);
      }
      return;
    }

    const segStart = iosSegmentStartSecRef.current;
    const segDur = v?.duration || 0;
    if (
      v &&
      !isSeekingRef.current &&
      segDur > 1 &&
      clamped >= segStart &&
      clamped < segStart + segDur - 0.6
    ) {
      try {
        v.currentTime = Math.max(0, clamped - segStart);
        if (v.paused) v.play().catch(() => {});
      } catch {
        // ignore
      }
      return;
    }

    const ctrl = iosControllerRef.current;
    const reqId = ++seekReqIdRef.current;
    isSeekingRef.current = true;
    setIsBuffering(true);
    // Pause old segment immediately so it never fires onTimeUpdate or onEnded with the old timestamp while seeking!
    if (v && !v.paused) {
      try {
        v.pause();
      } catch {
        // ignore
      }
    }

    ctrl.seekToSeconds(clamped).then((seekSeg) => {
      if (iosControllerRef.current !== ctrl || seekReqIdRef.current !== reqId) return;
      const latestTotal = ctrl.getTotalDurationSec();
      if (latestTotal > 0 && Math.floor(latestTotal) !== duration) {
        setDuration(Math.floor(latestTotal));
      }
      if (seekSeg) {
        const offsetInsideSeg = Math.max(
          0,
          Math.min((seekSeg.durationSec || 10) - 0.5, clamped - seekSeg.startSec)
        );
        const exactDisplaySec = Math.floor(seekSeg.startSec + offsetInsideSeg);
        iosCurrentSegIndexRef.current = seekSeg.index;
        iosSegmentStartSecRef.current = seekSeg.startSec;
        lastRecordedSecondRef.current = exactDisplaySec;
        pendingResumeSecRef.current = offsetInsideSeg > 0.35 ? offsetInsideSeg : null;
        setIosCurrentSegIndex(seekSeg.index);
        setIosSegmentStartSec(seekSeg.startSec);
        setIosBlobUrl(seekSeg.blobUrl);
        setCurrentTime(exactDisplaySec);
        window.setTimeout(() => {
          if (seekReqIdRef.current === reqId) {
            isSeekingRef.current = false;
          }
        }, 750);
      } else {
        isSeekingRef.current = false;
        if (v && v.paused) {
          v.play().catch(() => {});
        }
      }
      setIsBuffering(false);
    });
  };

  const handleSelectEpisode = (idx: number) => {
    setSelectedEpIdx(idx);
    const ep = episodes[idx];
    setSelectedSourceIdx(0);
    setFailedSourceIndices([]);
    setPlayerMode('stream');
    setVideoError(false);
    setHasStartedPlayback(false);
    setStandbyUpgradeIdx(null);
    setResumedBannerSec(null);
    setShowAllEpisodesModal(false);
    setNextEpPrewarmed(false);
    prewarmedNextEpIdxRef.current = null;
    isSeekingRef.current = false;
    iosSegmentStartSecRef.current = 0;
    iosCurrentSegIndexRef.current = 0;
    setCurrentTime(0);
    setBufferedEnd(0);
    smoothPlaySecondsRef.current = 0;
    hasStalledInSessionRef.current = false;
    hasTriedBridgeFallbackRef.current = false;
    hasUserManualServerRef.current = false;
    hasAppliedIntroSkipRef.current = false;
    pendingResumeSecRef.current = null;
    const directSrc =
      (ep?.sources || []).find(
        (s) => s.type !== 'embed' && !/abyssplayer\.com|abysscdn\.com|vidsrc|\/embed\//i.test(s.url || '')
      ) || ep?.sources?.[0];
    if (directSrc?.url && directSrc.type !== 'embed') {
      warmStreamConnection(directSrc.url);
    }
    onRecordWatchProgress(movie, ep, idx, directSrc, 0);
  };

  const handleSelectSource = (idx: number, isManualChoice = false) => {
    if (currentTime > 3) {
      pendingResumeSecRef.current = currentTime;
    }
    if (isManualChoice) {
      hasUserManualServerRef.current = true;
      setAutoNetQuality(false);
      setStandbyUpgradeIdx(null);
    }
    smoothPlaySecondsRef.current = 0;
    setShowQualityMenu(false);
    setShowAudioServerMenu(false);
    setSelectedSourceIdx(idx);
    setPlayerMode('stream');
    setVideoError(false);
    const src = sources[idx];
    onRecordWatchProgress(movie, activeEpisode, selectedEpIdx, src, currentTime);
  };

  const handleEnableAutoQuality = () => {
    setAutoNetQuality(true);
    setShowQualityMenu(false);
    setShowAudioServerMenu(false);
    hasStalledInSessionRef.current = false;
    smoothPlaySecondsRef.current = 0;
    const detected = detectIdealQualityForNetwork();
    setNetStatusLabel(detected.netLabel);
    if (sources.length > 0) {
      const bestIdx = pickBestSourceIndexForNet(sources, true);
      if (bestIdx !== selectedSourceIdx) {
        handleSelectSource(bestIdx, false);
      } else {
        triggerHud(
          'toast',
          `অটো কোয়ালিটি চালু: ইনস্ট্যান্ট ${sources[bestIdx]?.quality || 480}p → স্মুথ HD আপগ্রেড`
        );
      }
    }
  };

  const handleSetSleepTimer = (mode: number | 'end_of_ep' | null) => {
    setSleepTimerMode(mode);
    setShowSleepMenu(false);
    if (mode === null) {
      setSleepRemainingSec(null);
      triggerHud('toast', '🌙 স্লিপ টাইমার বন্ধ করা হয়েছে');
    } else if (mode === 'end_of_ep') {
      setSleepRemainingSec(null);
      triggerHud('toast', '🌙 এই এপিসোড শেষ হলে অটোমেটিক ভিডিও বন্ধ হবে');
    } else {
      setSleepRemainingSec(mode * 60);
      triggerHud('toast', `🌙 স্লিপ টাইমার চালু: ${mode} মিনিট পর অটো পজ হবে`);
    }
  };

  const startVideoWithiOSFallback = (v: HTMLVideoElement) => {
    if (!v.paused) return;
    const playPromise = v.play();
    if (playPromise !== undefined) {
      playPromise.catch((err: any) => {
        // Only fall back to muted autoplay if browser explicitly blocked unmuted autoplay (NotAllowedError)
        if (err && err.name === 'NotAllowedError') {
          v.muted = true;
          setIsMuted(true);
          setAutoMutedForiOS(true);
          v.play().catch(() => {
            setIsBuffering(false);
            setShowOverlayControls(true);
          });
        }
      });
    }
  };

  const isMovieBoxStream = Boolean(
    movie?.path?.startsWith('/mb/') ||
      activeSource?.id?.startsWith('mb-') ||
      /\/api\/mb-stream|\/api\/mb-ep-stream/i.test(activeSource?.url || '')
  );

  // Enforces 0% volume & muted state during the 0s..13.5s upstream voice-tag window
  // so external site audio tags ("this video downloaded from...") NEVER play on any device!
  const syncCleanAudioVolume = (v: HTMLVideoElement) => {
    const dur = duration || v.duration || 0;
    const globalTime = useHlsBridge ? iosSegmentStartSecRef.current + v.currentTime : v.currentTime;
    const muteWindowSec = Math.max(13.5, introSkipSec);
    const inVoiceTagWindow =
      !isMovieBoxStream &&
      globalTime < muteWindowSec &&
      (!dur || dur > muteWindowSec + 25);

    if (isMuted) {
      syncVideoAudioBooster(v, 0, true);
    } else if (inVoiceTagWindow) {
      v.volume = 0;
      if (useHlsBridge) {
        v.muted = true;
      } else {
        v.muted = false;
      }
    } else {
      syncVideoAudioBooster(v, volume, false);
    }
  };

  const handleVideoLoadedMetadata = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    v.playbackRate = isHold2x ? 2.0 : playbackSpeed;
    try {
      for (let i = 0; i < v.textTracks.length; i++) {
        v.textTracks[i].mode = 'disabled';
      }
    } catch {
      // ignore
    }
    const totalFromCtrl = iosControllerRef.current?.getTotalDurationSec() || 0;
    if (totalFromCtrl > 0) {
      setDuration(Math.floor(totalFromCtrl));
    } else if (!useHlsBridge && v.duration > 0) {
      setDuration(Math.floor(v.duration));
    }
    // Only mark hasStartedPlayback when the first video frame is actually decoded (readyState >= 2)
    // so the poster overlay never disappears prematurely into a black screen!
    if (v.readyState >= 2) {
      setHasStartedPlayback(true);
      setIsBuffering(false);
    }

    // Silence any upstream intro audio tag immediately before first frame plays
    syncCleanAudioVolume(v);

    // If user requested OS Phone-Screen PiP while on an embed source and we switched to direct <video>, enter PiP now
    if (pendingOsPipRef.current) {
      pendingOsPipRef.current = false;
      window.setTimeout(() => {
        try {
          const vidEl = videoRef.current as any;
          if (!vidEl) return;
          if (vidEl.requestPictureInPicture) {
            vidEl.requestPictureInPicture().catch(() => {});
          } else if (vidEl.webkitSupportsPresentationMode && vidEl.webkitSetPresentationMode) {
            vidEl.webkitSetPresentationMode('picture-in-picture');
          }
        } catch {
          // ignore
        }
      }, 250);
    }

    if (useHlsBridge) {
      if (pendingResumeSecRef.current !== null && pendingResumeSecRef.current > 0.3) {
        const localOffset = pendingResumeSecRef.current;
        pendingResumeSecRef.current = null;
        try {
          v.currentTime = Math.min(Math.max(0, (v.duration || 12) - 0.4), localOffset);
        } catch {
          // ignore
        }
      }
      isSeekingRef.current = false;
      startVideoWithiOSFallback(v);
      return;
    }

    // 1. If switching resolution mid-playback, restore exact timestamp
    if (pendingResumeSecRef.current !== null && pendingResumeSecRef.current > 2) {
      const target = pendingResumeSecRef.current;
      pendingResumeSecRef.current = null;
      try {
        v.currentTime = target;
      } catch {
        // ignore
      }
      isSeekingRef.current = false;
      syncCleanAudioVolume(v);
      startVideoWithiOSFallback(v);
      return;
    }

    const isInitialFreshStart =
      !hasAppliedIntroSkipRef.current &&
      currentTime < 3 &&
      lastRecordedSecondRef.current < 3;

    const canResumeSaved =
      isInitialFreshStart &&
      savedProgress &&
      (savedProgress.episodeIdx === undefined || savedProgress.episodeIdx === selectedEpIdx) &&
      savedProgress.progressSeconds &&
      savedProgress.progressSeconds > 15 &&
      (!v.duration || savedProgress.progressSeconds < v.duration - 20);

    hasAppliedIntroSkipRef.current = true;

    if (canResumeSaved && savedProgress?.progressSeconds) {
      try {
        v.currentTime = savedProgress.progressSeconds;
        lastRecordedSecondRef.current = Math.floor(savedProgress.progressSeconds);
        setCurrentTime(savedProgress.progressSeconds);
        setResumedBannerSec(savedProgress.progressSeconds);
      } catch {
        // ignore
      }
      isSeekingRef.current = false;
      syncCleanAudioVolume(v);
      startVideoWithiOSFallback(v);
      return;
    }

    // Automatically skip the 0s..13.5s upstream intro watermark on fresh playback (for non-MovieBox streams)
    if (
      !isMovieBoxStream &&
      isInitialFreshStart &&
      introSkipSec > 0 &&
      (!v.duration || v.duration > introSkipSec + 30)
    ) {
      try {
        v.currentTime = introSkipSec;
        lastRecordedSecondRef.current = Math.floor(introSkipSec);
        setCurrentTime(Math.floor(introSkipSec));
      } catch {
        // ignore
      }
    }

    isSeekingRef.current = false;
    syncCleanAudioVolume(v);
    startVideoWithiOSFallback(v);
  };

  const handleVideoError = () => {
    const resumeAt = Math.max(currentTime, lastRecordedSecondRef.current);
    const nextFailed = Array.from(new Set([...failedSourceIndices, selectedSourceIdx]));
    setFailedSourceIndices(nextFailed);

    const nextCandidateIdx = sources.findIndex((_, idx) => !nextFailed.includes(idx));
    if (nextCandidateIdx !== -1) {
      if (resumeAt > 3) {
        pendingResumeSecRef.current = resumeAt;
      }
      setSelectedSourceIdx(nextCandidateIdx);
      setVideoError(false);
      return;
    }

    // If all cached sources failed once, request a fresh live stream token via enrich=1 (without looping old sources)
    if (!hasTriedBridgeFallbackRef.current && movie) {
      hasTriedBridgeFallbackRef.current = true;
      const params = new URLSearchParams({
        path: movie.path || movie.url,
        title: movie.title,
        node: activeNodeId,
        enrich: '1',
      });
      universalApiFetch(`/api/details?${params.toString()}`)
        .then((data) => {
          if (data?.ok && data?.detail?.episodes?.length) {
            setDetail(data.detail);
            setFailedSourceIndices([]);
            setSelectedSourceIdx(0);
            setVideoError(false);
          } else {
            setIsBuffering(false);
            setVideoError(true);
          }
        })
        .catch(() => {
          setIsBuffering(false);
          setVideoError(true);
        });
      return;
    }

    setIsBuffering(false);
    setVideoError(true);
  };

  const handleTogglePlayPause = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().catch(() => {});
    } else {
      v.pause();
    }
    resetOverlayAutoHide();
  };

  const handleSeekRelative = (deltaSec: number) => {
    const baseTime = currentTime || videoRef.current?.currentTime || 0;
    seekVideoToGlobalTime(baseTime + deltaSec);
    setSeekRipple({
      side: deltaSec < 0 ? 'left' : 'right',
      delta: deltaSec,
      id: Date.now(),
    });
    if (rippleTimerRef.current) window.clearTimeout(rippleTimerRef.current);
    rippleTimerRef.current = window.setTimeout(() => {
      setSeekRipple(null);
    }, 680);
    triggerHud('seek', deltaSec > 0 ? `+${deltaSec}s Forward` : `${deltaSec}s Rewind`);
    resetOverlayAutoHide();
  };

  const handleToggleMute = () => {
    const v = videoRef.current;
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    if (v) {
      syncVideoAudioBooster(v, volume, nextMuted);
    }
    const hudPct = nextMuted ? 0 : Math.min(100, Math.round((volume / 400) * 100));
    triggerHud(
      'volume',
      nextMuted
        ? 'Muted (0%)'
        : volume > 100
          ? `🔊 Sound Boost ${volume}%`
          : `Sound ${volume}%`,
      hudPct
    );
  };

  const handleCycleSoundBoost = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const nextBoost =
      isMuted || volume < 100
        ? 100
        : volume < 150
          ? 150
          : volume < 200
            ? 200
            : volume < 300
              ? 300
              : volume < 400
                ? 400
                : 100;
    applyVolumeLevel(nextBoost);
  };

  const handleChangeBrightness = (newVal: number) => {
    const clamped = Math.max(20, Math.min(160, Math.round(newVal)));
    setBrightness(clamped);
    triggerHud('brightness', `Brightness ${clamped}%`, Math.round(((clamped - 20) / 140) * 100));
  };

  const handleCycleVideoFit = () => {
    const nextFit =
      videoFit === 'contain' ? 'cover' : videoFit === 'cover' ? 'fill' : 'contain';
    setVideoFit(nextFit);
    triggerHud(
      'toast',
      nextFit === 'contain'
        ? 'Screen Fit: Original'
        : nextFit === 'cover'
          ? 'Screen Fit: Zoom Crop'
          : 'Screen Fit: Full Stretch'
    );
  };

  // Dedicated Quality Selection Helper (Switches resolution while preserving playback time)
  const directQualitySources = (() => {
    const seenQ = new Map<number, { idx: number; source: StreamSource }>();
    sources.forEach((s, idx) => {
      const isEmb =
        s.type === 'embed' || /abyssplayer\.com|abysscdn\.com|vidsrc|\/embed\//i.test(s.url || '');
      if (!isEmb && s.quality) {
        if (!seenQ.has(s.quality)) {
          seenQ.set(s.quality, { idx, source: s });
        }
      }
    });
    return Array.from(seenQ.entries())
      .sort((a, b) => b[0] - a[0])
      .map(([quality, item]) => ({
        quality,
        idx: item.idx,
        source: item.source,
        label:
          quality >= 1080
            ? '1080p Full HD'
            : quality >= 720
              ? '720p HD'
              : quality >= 480
                ? '480p SD'
                : `${quality}p`,
      }));
  })();

  const activeQualityLabel =
    selectedQualityPref === 'auto'
      ? activeSource?.quality
        ? `Auto (${activeSource.quality}p)`
        : 'Auto HD'
      : `${selectedQualityPref}p`;

  const handleSelectQualityOption = (pref: 'auto' | number, targetIdx?: number) => {
    setSelectedQualityPref(pref);
    setShowQualityMenu(false);
    setShowSeparateQualityBar(false);
    if (pref === 'auto') {
      setAutoNetQuality(true);
      if (sources.length > 0 && selectedSourceIdx !== 0) {
        handleSelectSource(0, false);
      }
      return;
    }
    setAutoNetQuality(false);
    if (typeof targetIdx === 'number' && targetIdx >= 0 && targetIdx < sources.length) {
      handleSelectSource(targetIdx, true);
      return;
    }
    // Find best matching source for requested quality
    const exactIdx = sources.findIndex(
      (s) =>
        s.quality === pref &&
        s.type !== 'embed' &&
        !/abyssplayer\.com|abysscdn\.com|vidsrc|\/embed\//i.test(s.url || '')
    );
    if (exactIdx !== -1) {
      handleSelectSource(exactIdx, true);
    } else {
      const fallbackIdx = sources.findIndex((s) => s.quality === pref);
      if (fallbackIdx !== -1) {
        handleSelectSource(fallbackIdx, true);
      }
    }
  };

  // OS Phone-Screen Picture-in-Picture (PiP) + In-App Mini-Screen Handler
  const handleTogglePiP = async () => {
    const v = videoRef.current as any;

    // If Mini-Player is already active, restore to full modal
    if (isMiniPlayer && onToggleMiniPlayer) {
      onToggleMiniPlayer(false);
      return;
    }

    // If currently on an iframe embed, switch to direct <video> stream and activate Mini-Player / OS PiP
    if (isEmbedSource) {
      const directIdx = sources.findIndex(
        (s) => s.type !== 'embed' && !/abyssplayer\.com|vidsrc|\/embed\//i.test(s.url || '')
      );
      if (directIdx !== -1) {
        pendingOsPipRef.current = true;
        handleSelectSource(directIdx, true);
      }
      if (onToggleMiniPlayer) {
        onToggleMiniPlayer(!isMiniPlayer);
      }
      return;
    }

    if (v) {
      try {
        v.disablePictureInPicture = false;
        v.autoPictureInPicture = true;
        v.setAttribute('autopictureinpicture', 'true');

        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
          setIsOsPipActive(false);
          return;
        }
        if (v.webkitPresentationMode === 'picture-in-picture' && v.webkitSetPresentationMode) {
          v.webkitSetPresentationMode('inline');
          setIsOsPipActive(false);
          return;
        }
        // Ensure video has started before requesting OS PiP
        if (v.paused && v.readyState >= 1) {
          await v.play().catch(() => {});
        }
        if (v.requestPictureInPicture && v.readyState >= 1) {
          await v.requestPictureInPicture();
          setIsOsPipActive(true);
          return;
        }
        if (
          v.webkitSupportsPresentationMode &&
          v.webkitSetPresentationMode &&
          v.webkitSupportsPresentationMode('picture-in-picture')
        ) {
          v.webkitSetPresentationMode('picture-in-picture');
          setIsOsPipActive(true);
          return;
        }
      } catch {
        // If OS PiP is restricted by embedded preview iframe or webview, immediately activate Floating Mini-Screen PiP!
      }
    }

    if (onToggleMiniPlayer) {
      onToggleMiniPlayer(!isMiniPlayer);
    }
  };

  // Portrait Fullscreen Mode Toggle (Vertical Full-Screen on Phone)
  const handleTogglePortraitMode = () => {
    manualLandscapeLockRef.current = false;
    autoTiltLandscapeRef.current = false;
    if (isMiniPlayer && onToggleMiniPlayer) {
      onToggleMiniPlayer(false);
    }
    if (isPortraitFullscreen) {
      setIsPortraitFullscreen(false);
      return;
    }
    // Exit Landscape if active and switch to Portrait Fullscreen
    setIsLandscapeMode(false);
    setIsFullscreen(false);
    try {
      const currentFs = document.fullscreenElement || (document as any).webkitFullscreenElement;
      if (currentFs) {
        if (document.exitFullscreen) {
          document.exitFullscreen().catch(() => {});
        } else if ((document as any).webkitExitFullscreen) {
          (document as any).webkitExitFullscreen();
        }
      }
      if ((screen.orientation as any)?.unlock) {
        (screen.orientation as any).unlock();
      }
    } catch {
      // ignore
    }
    setIsPortraitFullscreen(true);
    resetOverlayAutoHide();
  };

  // Landscape Fullscreen Mode Toggle (True 90-deg Rotation on Portrait Phones + Native Fullscreen)
  const handleToggleFullscreen = () => {
    const stage = playerStageRef.current as any;
    const currentFs = document.fullscreenElement || (document as any).webkitFullscreenElement;
    const currentlyActive = isLandscapeMode || isFullscreen || Boolean(currentFs);

    const w = window.innerWidth || 390;
    const h = window.innerHeight || 844;
    setIsViewportPortrait(h >= w);
    setViewportDims({ width: w, height: h });

    if (currentlyActive) {
      manualLandscapeLockRef.current = false;
      autoTiltLandscapeRef.current = false;
      setIsLandscapeMode(false);
      setIsFullscreen(false);
      setIsPortraitFullscreen(false);
      try {
        if (currentFs) {
          if (document.exitFullscreen) {
            document.exitFullscreen().catch(() => {});
          } else if ((document as any).webkitExitFullscreen) {
            (document as any).webkitExitFullscreen();
          }
        }
        if ((screen.orientation as any)?.unlock) {
          (screen.orientation as any).unlock();
        }
      } catch {
        // ignore
      }
      return;
    }

    manualLandscapeLockRef.current = true;
    if (isMiniPlayer && onToggleMiniPlayer) {
      onToggleMiniPlayer(false);
    }
    setIsPortraitFullscreen(false);

    // Activate Fullscreen + 90-deg Landscape Rotation Mode immediately
    if (modalContainerRef.current) {
      modalContainerRef.current.scrollTo({ top: 0 });
    }
    setIsLandscapeMode(true);
    setIsFullscreen(true);
    resetOverlayAutoHide();

    try {
      if (stage && stage.requestFullscreen) {
        stage
          .requestFullscreen()
          .then(() => {
            if ((screen.orientation as any)?.lock) {
              (screen.orientation as any).lock('landscape').catch(() => {});
            }
          })
          .catch(() => {});
      } else if (stage && stage.webkitRequestFullscreen) {
        stage.webkitRequestFullscreen();
      }
    } catch {
      // CSS 90deg landscape rotation on #player-container-0 handles portrait screens automatically
    }
  };

  const applyVolumeLevel = (nextV: number) => {
    const clamped = Math.max(0, Math.min(400, Math.round(nextV)));
    setVolume(clamped);
    setIsMuted(clamped === 0);
    try {
      if (clamped > 0) {
        localStorage.setItem(SOUND_BOOST_STORAGE_KEY, String(clamped));
      }
    } catch {
      // ignore
    }
    if (videoRef.current) {
      syncVideoAudioBooster(videoRef.current, clamped, clamped === 0);
    }
    if (embedIframeRef.current?.contentWindow) {
      try {
        embedIframeRef.current.contentWindow.postMessage(
          JSON.stringify({
            context: 'player.js',
            method: 'setVolume',
            value: Math.min(100, clamped),
          }),
          '*'
        );
      } catch {
        // ignore
      }
    }
    const barPercent =
      clamped <= 100
        ? Math.round((clamped / 400) * 100)
        : Math.min(100, Math.round((clamped / 400) * 100));
    const label =
      clamped === 0
        ? 'Muted (0%)'
        : clamped > 250
          ? `🔥 Ultra Sound Boost ${clamped}%`
          : clamped > 100
            ? `🔊 Sound Boost ${clamped}%`
            : `Sound ${clamped}%`;
    triggerHud('volume', label, barPercent, 950);
  };

  const applyBrightnessLevel = (nextB: number) => {
    const clamped = Math.max(20, Math.min(160, Math.round(nextB)));
    setBrightness(clamped);
    try {
      localStorage.setItem(BRIGHTNESS_STORAGE_KEY, String(clamped));
    } catch {
      // ignore
    }
    triggerHud(
      'brightness',
      `Brightness ${clamped}%`,
      Math.round(((clamped - 20) / 140) * 100),
      850
    );
  };

  // Touch Gesture Handlers on Video Stage (Left vertical swipe = Sound, Right vertical swipe = Brightness, Double tap = +-10s, Long press = 2x Speed)
  const handleStageTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (isMiniPlayer || isScreenLocked || playerMode === 'trailer') return;
    if ((e.target as HTMLElement).closest('button, input, select, a, [data-scrubber="true"]')) return;
    if (e.touches.length !== 1) return;

    const touch = e.touches[0];
    const rect = e.currentTarget.getBoundingClientRect();
    const isRotated90 = isLandscapeMode && isViewportPortrait;
    const isLeftHalf = isRotated90
      ? touch.clientY - rect.top < rect.height / 2
      : touch.clientX - rect.left < rect.width / 2;

    touchGestureRef.current = {
      active: true,
      side: isLeftHalf ? 'left' : 'right',
      startX: touch.clientX,
      startY: touch.clientY,
      // Left side = Sound (Volume), Right side = Brightness
      startVal: isLeftHalf ? (isMuted ? 0 : volume) : brightness,
      moved: false,
    };

    if (holdTimerRef.current) window.clearTimeout(holdTimerRef.current);
    holdTimerRef.current = window.setTimeout(() => {
      if (touchGestureRef.current && !touchGestureRef.current.moved && isPlaying) {
        setIsHold2x(true);
      }
    }, 500);
  };

  const handleStageTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    const g = touchGestureRef.current;
    if (!g || !g.active || isMiniPlayer || isScreenLocked || e.touches.length !== 1) return;

    const touch = e.touches[0];
    const isRotated90 = isLandscapeMode && isViewportPortrait;
    const dx = isRotated90 ? touch.clientY - g.startY : touch.clientX - g.startX;
    const dy = isRotated90 ? touch.clientX - g.startX : g.startY - touch.clientY;

    if (!g.moved) {
      if (Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy)) {
        g.active = false;
        if (holdTimerRef.current) window.clearTimeout(holdTimerRef.current);
        return;
      }
      if (Math.abs(dy) > 8) {
        g.moved = true;
        if (holdTimerRef.current) window.clearTimeout(holdTimerRef.current);
        setIsHold2x(false);
      } else {
        return;
      }
    }

    if (g.side === 'right') {
      // Right side swipe up/down -> Brightness increase/decrease (20% to 160%)
      const deltaBrightness = Math.round(dy * 0.75);
      applyBrightnessLevel(g.startVal + deltaBrightness);
    } else {
      // Left side swipe up/down -> Sound & Ultra Sound Boost (0% to 400%)
      const scale = g.startVal >= 100 || dy > 0 ? 1.65 : 0.95;
      const deltaVol = Math.round(dy * scale);
      applyVolumeLevel(g.startVal + deltaVol);
    }
  };

  const handleStageTouchEnd = () => {
    if (holdTimerRef.current) window.clearTimeout(holdTimerRef.current);
    if (isHold2x) {
      setIsHold2x(false);
    }
    touchGestureRef.current = null;
  };

  const clampMiniPosition = (x: number, y: number, widthVal: number) => {
    const vw = window.innerWidth || 390;
    const vh = window.innerHeight || 844;
    const heightVal = Math.round((widthVal * 9) / 16);
    const maxX = Math.max(8, vw - widthVal - 8);
    const maxY = Math.max(8, vh - heightVal - 8);
    return {
      x: Math.max(8, Math.min(maxX, Math.round(x))),
      y: Math.max(8, Math.min(maxY, Math.round(y))),
    };
  };

  const clampMiniWidthVal = (w: number) => {
    const vw = window.innerWidth || 390;
    const maxW = Math.min(370, Math.max(220, vw - 16));
    return Math.max(165, Math.min(maxW, Math.round(w)));
  };

  const handleCycleMiniSize = (e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    const vw = window.innerWidth || 390;
    const maxW = Math.min(350, Math.max(240, vw - 20));
    const nextW = miniWidth < 215 ? 255 : miniWidth < 295 ? maxW : 185;
    const clampedW = clampMiniWidthVal(nextW);
    setMiniWidth(clampedW);
    if (miniPos) {
      setMiniPos(clampMiniPosition(miniPos.x, miniPos.y, clampedW));
    }
  };

  const handleMiniTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!isMiniPlayer) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-mini-close="true"]') || target.closest('[data-mini-cycle="true"]')) {
      return;
    }
    const container = modalContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();

    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      miniDragRef.current = {
        mode: 'pinch',
        startX: 0,
        startY: 0,
        origX: rect.left,
        origY: rect.top,
        origWidth: miniWidth,
        initialPinchDist: Math.max(24, Math.hypot(dx, dy)),
        moved: true,
      };
      return;
    }

    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    const isResizeHandle = Boolean(target.closest('[data-mini-resize="true"]'));

    miniDragRef.current = {
      mode: isResizeHandle ? 'resize' : 'move',
      startX: touch.clientX,
      startY: touch.clientY,
      origX: rect.left,
      origY: rect.top,
      origWidth: miniWidth,
      initialPinchDist: 0,
      moved: isResizeHandle,
    };
  };

  const handleMiniTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!isMiniPlayer) return;
    const g = miniDragRef.current;
    if (!g) return;

    if (g.mode === 'pinch' && e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.max(24, Math.hypot(dx, dy));
      const nextW = clampMiniWidthVal(g.origWidth * (dist / g.initialPinchDist));
      setMiniWidth(nextW);
      setMiniPos(clampMiniPosition(g.origX, g.origY, nextW));
      return;
    }

    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    const dx = touch.clientX - g.startX;
    const dy = touch.clientY - g.startY;

    if (g.mode === 'resize') {
      const deltaW = Math.abs(dx) >= Math.abs(dy) ? dx : dy * (16 / 9);
      const nextW = clampMiniWidthVal(g.origWidth + deltaW);
      setMiniWidth(nextW);
      setMiniPos(clampMiniPosition(g.origX, g.origY, nextW));
      return;
    }

    if (!g.moved && Math.hypot(dx, dy) > 7) {
      g.moved = true;
    }

    if (g.moved) {
      setMiniPos(clampMiniPosition(g.origX + dx, g.origY + dy, g.origWidth));
    }
  };

  const handleMiniTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!isMiniPlayer) return;
    const target = e.target as HTMLElement;
    if (
      target.closest('[data-mini-close="true"]') ||
      target.closest('[data-mini-cycle="true"]') ||
      target.closest('[data-mini-resize="true"]')
    ) {
      miniDragRef.current = null;
      return;
    }
    const g = miniDragRef.current;
    miniDragRef.current = null;
    if (g && g.mode === 'move' && !g.moved) {
      lastMiniTapTimeRef.current = Date.now();
      if (onToggleMiniPlayer) onToggleMiniPlayer(false);
    }
  };

  const handleMiniMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isMiniPlayer || e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-mini-close="true"]') || target.closest('[data-mini-cycle="true"]')) {
      return;
    }
    const container = modalContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const isResizeHandle = Boolean(target.closest('[data-mini-resize="true"]'));

    miniDragRef.current = {
      mode: isResizeHandle ? 'resize' : 'move',
      startX: e.clientX,
      startY: e.clientY,
      origX: rect.left,
      origY: rect.top,
      origWidth: miniWidth,
      initialPinchDist: 0,
      moved: isResizeHandle,
    };

    const onMouseMove = (ev: MouseEvent) => {
      const g = miniDragRef.current;
      if (!g) return;
      const dx = ev.clientX - g.startX;
      const dy = ev.clientY - g.startY;
      if (g.mode === 'resize') {
        const deltaW = Math.abs(dx) >= Math.abs(dy) ? dx : dy * (16 / 9);
        const nextW = clampMiniWidthVal(g.origWidth + deltaW);
        setMiniWidth(nextW);
        setMiniPos(clampMiniPosition(g.origX, g.origY, nextW));
        return;
      }
      if (!g.moved && Math.hypot(dx, dy) > 6) {
        g.moved = true;
      }
      if (g.moved) {
        setMiniPos(clampMiniPosition(g.origX + dx, g.origY + dy, g.origWidth));
      }
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      const g = miniDragRef.current;
      miniDragRef.current = null;
      if (g && g.mode === 'move' && !g.moved) {
        lastMiniTapTimeRef.current = Date.now();
        if (onToggleMiniPlayer) onToggleMiniPlayer(false);
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const handleStageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button, input, select, a, [data-scrubber="true"]')) return;
    if (isMiniPlayer) {
      if (Date.now() - lastMiniTapTimeRef.current > 350) {
        if (onToggleMiniPlayer) onToggleMiniPlayer(false);
      }
      return;
    }
    if (isScreenLocked) {
      resetOverlayAutoHide();
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const isRotated90 = isLandscapeMode && isViewportPortrait;
    const ratio = isRotated90
      ? (e.clientY - rect.top) / Math.max(1, rect.height)
      : (e.clientX - rect.left) / Math.max(1, rect.width);
    const side: 'left' | 'right' | 'center' =
      ratio < 0.34 ? 'left' : ratio > 0.66 ? 'right' : 'center';

    const now = Date.now();
    if (now - lastTapRef.current.time < 290 && lastTapRef.current.side === side && side !== 'center') {
      handleSeekRelative(side === 'left' ? -10 : 10);
      lastTapRef.current = { time: 0, side: 'center' };
      return;
    }

    lastTapRef.current = { time: now, side };
    if (showOverlayControls) {
      setShowOverlayControls(false);
      setShowBrightnessPanel(false);
      setShowQualityMenu(false);
      setShowAudioServerMenu(false);
      setShowSleepMenu(false);
    } else {
      resetOverlayAutoHide();
    }
  };

  const handleSubtitleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setLoadingAutoSub(true);
      const text = await file.text();
      const parsedCues = parseSrtOrVttToCues(text);
      if (parsedCues.length > 0) {
        // Automatically translate uploaded English/foreign subtitles to Bengali if not already Bengali
        const sampleText = parsedCues
          .slice(0, 5)
          .map((c) => c.text)
          .join(' ');
        const hasBanglaChars = /[\u0980-\u09FF]/.test(sampleText);
        if (!hasBanglaChars) {
          triggerHud('toast', 'ইংরেজি সাবটাইটেল বাংলায় অনুবাদ করা হচ্ছে...');
          const firstBatch = parsedCues.slice(0, 60);
          for (let i = 0; i < firstBatch.length; i += 30) {
            const chunk = firstBatch.slice(i, i + 30);
            const tr = await translateLinesToBangla(chunk.map((c) => c.text));
            chunk.forEach((c, idx) => {
              if (tr[idx]) c.text = tr[idx];
            });
          }
          // Translate rest in background
          if (parsedCues.length > 60) {
            (async () => {
              for (let i = 60; i < Math.min(parsedCues.length, 500); i += 35) {
                const chunk = parsedCues.slice(i, i + 35);
                const tr = await translateLinesToBangla(chunk.map((c) => c.text));
                chunk.forEach((c, idx) => {
                  if (tr[idx]) c.text = tr[idx];
                });
              }
            })().catch(() => {});
          }
        }
        const vttBuilt = buildVttFromCues(parsedCues);
        const blob = new Blob([vttBuilt], { type: 'text/vtt' });
        if (subtitleUrl) URL.revokeObjectURL(subtitleUrl);
        const url = URL.createObjectURL(blob);
        setSubtitleCues(parsedCues);
        setSubtitleUrl(url);
        setSubtitleName(`বাংলা Sub (${file.name})`);
        setAutoBanglaSubEnabled(true);
        triggerHud('toast', `বাংলা সাবটাইটেল লোড হয়েছে: ${file.name}`);
      } else {
        const vttText = convertSrtToVtt(text);
        const blob = new Blob([vttText], { type: 'text/vtt' });
        if (subtitleUrl) URL.revokeObjectURL(subtitleUrl);
        const url = URL.createObjectURL(blob);
        setSubtitleUrl(url);
        setSubtitleName(file.name);
        setAutoBanglaSubEnabled(true);
        triggerHud('toast', `Subtitle Loaded: ${file.name}`);
      }
    } catch {
      // ignore
    } finally {
      setLoadingAutoSub(false);
    }
  };

  const handleShare = async () => {
    const baseUrl = `${window.location.origin}${window.location.pathname}`;
    const shareParams = new URLSearchParams({
      watch: movie.path || movie.url,
      title: detail?.title || movie.title,
    });
    const shareUrl = `${baseUrl}?${shareParams.toString()}`;
    try {
      if (navigator.share) {
        await navigator.share({
          title: detail?.title || movie.title,
          text: `Watch ${detail?.title || movie.title} in Full HD on CinePulse`,
          url: shareUrl,
        });
      } else {
        await navigator.clipboard.writeText(shareUrl);
        setCopiedShare(true);
        setTimeout(() => setCopiedShare(false), 2000);
      }
    } catch {
      // ignore
    }
  };

  const handleCopyAllEpisodes = async () => {
    const lines = episodes
      .map((ep) => {
        const bestSrc = ep.sources?.[0];
        if (!bestSrc) return null;
        return `${ep.label}: ${toGatewayAbsoluteUrl(bestSrc.downloadUrl || bestSrc.url)}`;
      })
      .filter(Boolean)
      .join('\n');

    if (!lines) return;
    try {
      await navigator.clipboard.writeText(lines);
      setCopiedBatch(true);
      setTimeout(() => setCopiedBatch(false), 2200);
    } catch {
      // ignore
    }
  };

  const handleDownloadM3UPlaylist = () => {
    const lines = ['#EXTM3U'];
    episodes.forEach((ep) => {
      const bestSrc = ep.sources?.[0];
      if (bestSrc?.url) {
        lines.push(`#EXTINF:-1,${detail?.title || movie.title} - ${ep.label}`);
        lines.push(bestSrc.url);
      }
    });
    const blob = new Blob([lines.join('\n')], { type: 'audio/x-mpegurl' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(detail?.title || movie.title).replace(/[^a-zA-Z0-9_-]/g, '_')}_Playlist.m3u`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const vlcUrl = activeSource?.url
    ? `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(activeSource.url)}`
    : '';
  const infuseUrl = activeSource?.url
    ? `infuse://x-callback-url/play?url=${encodeURIComponent(activeSource.url)}`
    : '';
  const outplayerUrl = activeSource?.url ? `outplayer://${activeSource.url}` : '';

  const ratingScore = detail?.communityScore
    ? (detail.communityScore.recommendedPercent / 10).toFixed(1)
    : '8.7';

  const ctrlTotalDur = iosControllerRef.current?.getTotalDurationSec() || 0;
  const displayDuration = Math.floor(duration > 0 ? duration : ctrlTotalDur > 0 ? ctrlTotalDur : 0);
  const effectiveDuration = Math.max(1, displayDuration || 1);
  const activePlayheadSec = isScrubbing && scrubPreview !== null ? scrubPreview.sec : currentTime;
  const progressPercent =
    displayDuration > 0 ? Math.min(100, (activePlayheadSec / effectiveDuration) * 100) : 0;
  const bufferedPercent =
    displayDuration > 0 ? Math.min(100, (bufferedEnd / effectiveDuration) * 100) : 0;

  // CSS video brightness boost filter (supports darkening down to 20% AND brightening dark movie scenes up to 160%)
  const videoFilterStyle: React.CSSProperties = {
    filter: `brightness(${brightness}%) contrast(${brightness > 110 ? 105 : 100}%) saturate(${
      brightness > 115 ? 108 : 100
    }%)`,
    objectFit: videoFit,
  };

  // Show up to 60 tiles in the horizontal bar for instant 60fps scrolling, and all in the "All" grid
  const horizontalEpisodesSlice = filteredEpisodesWithIdx.slice(0, 60);

  const isRotated90 = !isMiniPlayer && (isLandscapeMode || isFullscreen) && isViewportPortrait;

  const computeScrubberTarget = (
    clientX: number,
    clientY: number,
    el?: HTMLDivElement | null
  ) => {
    const targetEl = el || scrubberRef.current;
    if (!targetEl) {
      return { targetSec: currentTime, percent: progressPercent };
    }
    const rect = targetEl.getBoundingClientRect();
    const ratio = isRotated90
      ? (clientY - rect.top) / Math.max(1, rect.height)
      : (clientX - rect.left) / Math.max(1, rect.width);
    const clampedRatio = Math.max(0, Math.min(1, ratio));
    const targetSec = Math.floor(clampedRatio * effectiveDuration);
    return { targetSec, percent: clampedRatio * 100 };
  };

  const previewScrubberAtPointer = (
    clientX: number,
    clientY: number,
    el?: HTMLDivElement | null
  ) => {
    const { targetSec, percent } = computeScrubberTarget(clientX, clientY, el);
    scrubTargetSecRef.current = targetSec;
    lastRecordedSecondRef.current = targetSec;
    setScrubPreview({ sec: targetSec, percent });
    setCurrentTime(targetSec);
    return targetSec;
  };

  const commitScrubberSeek = (targetSec: number) => {
    scrubTargetSecRef.current = targetSec;
    lastRecordedSecondRef.current = targetSec;
    setCurrentTime(targetSec);
    seekVideoToGlobalTime(targetSec);
  };

  const hasNextEpisode = episodes.length > 1 && selectedEpIdx + 1 < episodes.length;
  const nextEpisodeItem = hasNextEpisode ? episodes[selectedEpIdx + 1] : undefined;

  const combinedScreenshots = (() => {
    const list: string[] = [];
    const add = (u?: string) => {
      if (u && u.startsWith('http') && !list.includes(u)) list.push(u);
    };
    (myflixData?.screenshots || []).forEach(add);
    (effectiveDetail?.screenshots || []).forEach(add);
    if (list.length === 0) {
      add(effectiveDetail?.backdrop);
      add(movie.poster || effectiveDetail?.poster);
    }
    return list;
  })();

  const combinedCast = (() => {
    const list: Array<{ name: string; role: string; photo: string }> = [];
    const seen = new Set<string>();
    const add = (c: { name?: string; role?: string; photo?: string }) => {
      const n = (c.name || '').trim();
      if (!n || seen.has(n.toLowerCase())) return;
      seen.add(n.toLowerCase());
      list.push({
        name: n,
        role: c.role || 'Actor',
        photo: c.photo || '',
      });
    };
    (myflixData?.cast || []).forEach(add);
    (effectiveDetail?.cast || []).forEach(add);
    return list;
  })();

  const combinedDownloads = (() => {
    const list: Array<{ label: string; subLabel?: string; url: string }> = [];
    const seen = new Set<string>();
    for (const src of activeEpisode?.sources || []) {
      const dlUrl = src.downloadUrl || src.url;
      if (dlUrl && src.type !== 'embed' && !seen.has(dlUrl)) {
        seen.add(dlUrl);
        list.push({
          label: `Download ${src.quality || 720}p`,
          subLabel: `${src.audioLanguages?.join(' + ') || src.audio || movie.language} • ${
            src.quality >= 1080 ? 'Full HD' : 'High Speed'
          }`,
          url: dlUrl,
        });
      }
    }
    for (const btn of effectiveDetail?.downloadButtons || []) {
      if (btn.url && !seen.has(btn.url)) {
        seen.add(btn.url);
        list.push({
          label: btn.label.replace(/^download\s*/i, 'Download '),
          subLabel: btn.quality ? `${btn.quality} • Direct Link` : 'Direct High-Speed Server',
          url: btn.url,
        });
      }
    }
    for (const mDl of myflixData?.downloads || []) {
      if (mDl.url && !seen.has(mDl.url)) {
        seen.add(mDl.url);
        list.push({
          label: mDl.label,
          subLabel: 'Cloud Mirror Download',
          url: mDl.url,
        });
      }
    }
    return list;
  })();

  const displayYear =
    myflixData?.year ||
    effectiveDetail?.releaseDate?.match(/\b(20\d{2}|19\d{2})\b/)?.[1] ||
    (movie.title.match(/\b(20\d{2}|19\d{2})\b/)?.[1] ?? '2026');
  const displayGenre =
    myflixData?.genre ||
    effectiveDetail?.genre ||
    (movie.typeBadge === 'SERIES' ? 'Drama, Crime, Series' : 'Action, Drama, Thriller');
  const displayDirector = myflixData?.director || 'CinePulse Original';
  const displayRelease =
    myflixData?.release || effectiveDetail?.releaseDate || normalizeMovieCardItem(movie).timeAgo;
  const displayRating =
    myflixData?.rating || normalizeMovieCardItem(movie).rating || ratingScore || '8.7';
  const currentEpBadgeText = activeEpisode
    ? formatEpisodeTileBadge(activeEpisode, selectedEpIdx)
    : '1';
  const activeSeasonLabel =
    selectedSeasonFilter === 'all'
      ? distinctSeasons.length > 0
        ? `Season ${String(distinctSeasons[0]).padStart(2, '0')}`
        : 'Season 01'
      : `Season ${String(selectedSeasonFilter).padStart(2, '0')}`;

  const availableDubs = (() => {
    if (effectiveDetail?.dubs && effectiveDetail.dubs.length > 0) {
      return effectiveDetail.dubs;
    }
    const rawLang = (effectiveDetail?.language || movie.language || 'Hindi dub').trim();
    const formatted =
      /dub|audio|sub/i.test(rawLang) ? rawLang : `${rawLang} dub`;
    return [
      {
        id: 'default-dub',
        label: formatted,
        path: movie.path || movie.url,
        active: true,
      },
    ];
  })();

  const activeDubOption =
    availableDubs.find((d) => d.path === (movie.path || movie.url)) ||
    availableDubs.find((d) => d.active) ||
    availableDubs[0];

  const activeDubLabel = activeDubOption?.label || effectiveDetail?.language || movie.language || 'Hindi dub';

  return (
    <div
      ref={modalContainerRef}
      onTouchStart={isMiniPlayer ? handleMiniTouchStart : undefined}
      onTouchMove={isMiniPlayer ? handleMiniTouchMove : undefined}
      onTouchEnd={isMiniPlayer ? handleMiniTouchEnd : undefined}
      onMouseDown={isMiniPlayer ? handleMiniMouseDown : undefined}
      style={
        isMiniPlayer
          ? {
              width: `${miniWidth}px`,
              ...(miniPos
                ? { left: `${miniPos.x}px`, top: `${miniPos.y}px` }
                : { right: '12px', bottom: '76px' }),
              touchAction: 'none',
            }
          : undefined
      }
      className={
        isMiniPlayer
          ? 'fixed z-50 rounded-2xl overflow-hidden shadow-[0_18px_48px_rgba(0,0,0,0.92)] border border-[#dc2626]/60 bg-[#050505] text-[#e5e5e5] flex flex-col cursor-grab active:cursor-grabbing select-none'
          : 'fixed inset-0 z-50 w-full h-[100dvh] max-w-[100vw] bg-[#050505] text-[#e5e5e5] flex flex-col overflow-hidden'
      }
    >
      {/* Top Clean MyFlixBD-Style Navbar (Locked at Top; Hidden in Mini Player or Fullscreen) */}
      {!isMiniPlayer && !isLandscapeMode && !isFullscreen && !isPortraitFullscreen && (
        <header className="shrink-0 relative z-40 w-full bg-[#0a0a0a]/95 backdrop-blur-md border-b border-white/[0.08]">
          <div className="max-w-5xl mx-auto px-3 sm:px-6 h-13 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <button
                type="button"
                onClick={onClose}
                aria-label="Back to Home"
                className="w-9 h-9 rounded-lg bg-[#151515] hover:bg-[#222222] border border-white/[0.08] flex items-center justify-center text-white active:scale-95 transition-all shrink-0"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <button
                type="button"
                onClick={onClose}
                className="flex items-center gap-2 text-left group truncate"
              >
                <span className="w-7 h-7 rounded-md bg-[#dc2626] flex items-center justify-center text-white shadow-[0_0_12px_rgba(220,38,38,0.5)] shrink-0">
                  <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
                </span>
                <span className="text-base font-black tracking-wider text-white">
                  CINE<span className="text-[#dc2626]">PULSE</span>
                </span>
              </button>
            </div>

            <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
              <button
                type="button"
                onClick={() => onToggleWatchlist(movie, currentFolder)}
                className={`h-8 px-2.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 border transition-colors ${
                  isInWatchlist
                    ? 'bg-[#dc2626]/20 border-[#dc2626] text-white'
                    : 'bg-[#151515] hover:bg-[#222222] border-white/[0.08] text-gray-200'
                }`}
              >
                <ListPlus className="w-3.5 h-3.5 text-[#dc2626]" />
                <span className="hidden sm:inline">{isInWatchlist ? 'Saved' : 'Watchlist'}</span>
              </button>

              <button
                type="button"
                onClick={handleShare}
                className="h-8 px-2.5 rounded-lg bg-[#151515] hover:bg-[#222222] border border-white/[0.08] text-xs font-semibold text-gray-200 flex items-center gap-1.5 transition-colors"
              >
                {copiedShare ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="hidden sm:inline">Copied</span>
                  </>
                ) : (
                  <>
                    <Share2 className="w-3.5 h-3.5 text-[#dc2626]" />
                    <span className="hidden sm:inline">Share</span>
                  </>
                )}
              </button>

              {/* Settings Icon (⚙️) ONLY in Top Header Bar — Never on Video Play Screen */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowAudioServerMenu((v) => !v)}
                  title="Server, Sound, Brightness & View Settings"
                  className={`h-8 px-2.5 rounded-lg border text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer ${
                    showAudioServerMenu
                      ? 'bg-[#dc2626] border-[#dc2626] text-white'
                      : 'bg-[#151515] hover:bg-[#222222] border-white/[0.08] text-gray-200'
                  }`}
                >
                  <Settings className="w-3.5 h-3.5 text-current" />
                  <span className="hidden xs:inline">Settings</span>
                </button>

                {showAudioServerMenu && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="absolute right-0 top-full mt-2 w-72 max-h-[78dvh] overflow-y-auto rounded-xl bg-[#111318]/98 border border-white/15 shadow-2xl p-3 z-50 divide-y divide-white/10"
                  >
                    {/* 1. Manual Server Selection */}
                    <div className="pb-2.5">
                      <div className="px-1 py-0.5 text-[11px] font-extrabold uppercase tracking-wider text-gray-300 flex items-center justify-between">
                        <span>Select Server (ম্যানুয়াল সার্ভার)</span>
                        <button
                          type="button"
                          onClick={() => setShowAudioServerMenu(false)}
                          className="text-gray-400 hover:text-white cursor-pointer"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                      <div className="space-y-1 mt-1.5">
                        {sources.map((src, idx) => {
                          const isActive = selectedSourceIdx === idx;
                          const isMf =
                            idx === 0 ||
                            src.type === 'embed' ||
                            /abyssplayer|abysscdn|myflix/i.test(`${src.url || ''} ${src.id || ''}`);
                          const label =
                            idx === 0
                              ? 'MyFlix Server #1 (Default)'
                              : isMf
                                ? `MyFlix Server #${idx + 1}`
                                : `Cloud Server (Manual • ${src.quality || 720}p)`;
                          return (
                            <button
                              key={src.id || idx}
                              type="button"
                              onClick={() => handleSelectSource(idx, true)}
                              className={`w-full text-left px-2.5 py-2 rounded-lg text-xs font-bold flex items-center justify-between transition-colors cursor-pointer ${
                                isActive
                                  ? 'bg-[#dc2626] text-white'
                                  : 'bg-white/[0.05] hover:bg-white/[0.12] text-gray-200'
                              }`}
                            >
                              <span className="truncate">{label}</span>
                              {isActive && <Check className="w-3.5 h-3.5 shrink-0 ml-1.5" />}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* 2. Sound (Volume) & Brightness Controls */}
                    <div className="py-2.5 space-y-2.5">
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-xs font-semibold text-gray-200">
                          <span className="flex items-center gap-1.5">
                            {isMuted || volume === 0 ? (
                              <VolumeX className="w-3.5 h-3.5 text-red-400" />
                            ) : (
                              <Volume2
                                className={`w-3.5 h-3.5 ${
                                  volume > 100 ? 'text-emerald-400 animate-pulse' : 'text-[#dc2626]'
                                }`}
                              />
                            )}
                            <span>
                              {volume > 100 ? 'Ultra Sound Boost (সাউন্ড বুস্ট)' : 'Sound (সাউন্ড)'}
                            </span>
                          </span>
                          <span
                            className={`font-mono text-[11px] font-bold ${
                              volume > 100 ? 'text-emerald-400' : 'text-gray-300'
                            }`}
                          >
                            {isMuted ? 0 : volume}%{volume > 100 ? ' 🔥' : ''}
                          </span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={400}
                          step={5}
                          value={isMuted ? 0 : volume}
                          onChange={(e) => applyVolumeLevel(Number(e.target.value))}
                          className="w-full h-1.5 bg-white/20 rounded-lg accent-[#dc2626] cursor-pointer"
                        />
                        {/* Quick 1-Tap Sound Boost Presets (100% Normal -> 400% Max Boost) */}
                        <div className="grid grid-cols-5 gap-1 pt-0.5">
                          {[
                            { val: 100, label: '100%' },
                            { val: 150, label: '150%' },
                            { val: 200, label: '200%' },
                            { val: 300, label: '300%' },
                            { val: 400, label: '400%🔥' },
                          ].map((preset) => {
                            const active = !isMuted && volume === preset.val;
                            return (
                              <button
                                key={preset.val}
                                type="button"
                                onClick={() => applyVolumeLevel(preset.val)}
                                className={`py-1 rounded text-[10px] font-extrabold transition-colors cursor-pointer ${
                                  active
                                    ? preset.val > 100
                                      ? 'bg-emerald-600 text-white shadow'
                                      : 'bg-[#dc2626] text-white shadow'
                                    : 'bg-white/[0.07] hover:bg-white/[0.15] text-gray-300'
                                }`}
                              >
                                {preset.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-xs font-semibold text-gray-200">
                          <span className="flex items-center gap-1.5">
                            <Sun className="w-3.5 h-3.5 text-amber-400" />
                            <span>Brightness (ব্রাইটনেস)</span>
                          </span>
                          <span className="font-mono text-[11px] text-gray-300">{brightness}%</span>
                        </div>
                        <input
                          type="range"
                          min={20}
                          max={160}
                          value={brightness}
                          onChange={(e) => applyBrightnessLevel(Number(e.target.value))}
                          className="w-full h-1.5 bg-white/20 rounded-lg accent-amber-400 cursor-pointer"
                        />
                      </div>
                    </div>

                    {/* 3. Portrait Mode, Landscape Mode & Phone PiP Mode */}
                    <div className="py-2.5 space-y-1.5">
                      <div className="text-[10px] font-extrabold uppercase tracking-wider text-gray-400">
                        Screen & PiP Mode
                      </div>
                      <div className="grid grid-cols-3 gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setShowAudioServerMenu(false);
                            handleTogglePortraitMode();
                          }}
                          className="px-2 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.14] text-[11px] font-bold text-gray-100 flex flex-col items-center gap-1 cursor-pointer"
                        >
                          <Smartphone className="w-4 h-4 text-[#dc2626]" />
                          <span>Portrait</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setShowAudioServerMenu(false);
                            handleToggleFullscreen();
                          }}
                          className="px-2 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.14] text-[11px] font-bold text-gray-100 flex flex-col items-center gap-1 cursor-pointer"
                        >
                          <Maximize className="w-4 h-4 text-[#dc2626]" />
                          <span>Landscape</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setShowAudioServerMenu(false);
                            handleTogglePiP();
                          }}
                          className="px-2 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.14] text-[11px] font-bold text-gray-100 flex flex-col items-center gap-1 cursor-pointer"
                        >
                          <PictureInPicture2 className="w-4 h-4 text-[#dc2626]" />
                          <span>PiP Mode</span>
                        </button>
                      </div>
                    </div>

                    {/* 4. Subtitle & Playback Speed */}
                    <div className="pt-2 space-y-1">
                      <button
                        type="button"
                        onClick={() => setAutoBanglaSubEnabled((v) => !v)}
                        className="w-full text-left px-2 py-1.5 rounded-lg text-xs font-semibold text-gray-200 hover:bg-white/10 flex items-center justify-between cursor-pointer"
                      >
                        <span>বাংলা Subtitle</span>
                        <span
                          className={
                            autoBanglaSubEnabled ? 'text-emerald-400 font-bold' : 'text-gray-400'
                          }
                        >
                          {autoBanglaSubEnabled ? 'ON' : 'OFF'}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setPlaybackSpeed((s) =>
                            s === 1 ? 1.25 : s === 1.25 ? 1.5 : s === 1.5 ? 2 : 1
                          )
                        }
                        className="w-full text-left px-2 py-1.5 rounded-lg text-xs font-semibold text-gray-200 hover:bg-white/10 flex items-center justify-between cursor-pointer"
                      >
                        <span>Playback Speed</span>
                        <span className="text-[#ef4444] font-bold">{playbackSpeed}x</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={handleTogglePiP}
                title="Phone Screen PiP Mode"
                className={`w-8 h-8 rounded-lg border flex items-center justify-center transition-colors cursor-pointer ${
                  isOsPipActive
                    ? 'bg-[#dc2626] border-[#dc2626] text-white'
                    : 'bg-[#151515] hover:bg-[#222222] border-white/[0.08] text-gray-200'
                }`}
              >
                <PictureInPicture2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        </header>
      )}

      {/* Main MyFlixBD Container — Video Pinned at Top (shrink-0), Lower Page Scrolls Independently */}
      <div
        className={
          isMiniPlayer
            ? 'w-full'
            : isLandscapeMode || isFullscreen || isPortraitFullscreen
              ? 'w-full h-full'
              : 'flex-1 min-h-0 w-full max-w-5xl mx-auto flex flex-col overflow-hidden'
        }
      >
        {/* =====================================================================
            SECTION 1: PINNED 16:9 VIDEO CONTAINER (NEVER SCROLLS OUT OF VIEW, NO SETTINGS ICON ON VIDEO)
           ===================================================================== */}
        <section
          className={
            isMiniPlayer || isLandscapeMode || isFullscreen || isPortraitFullscreen
              ? 'w-full shrink-0'
              : 'w-full shrink-0 px-2.5 sm:px-6 pt-2 pb-1.5 bg-[#050505] z-30'
          }
        >
          <div className="bg-[#0a0a0a] border border-white/[0.08] rounded-xl overflow-hidden shadow-2xl">
            {/* #player-container-0 — Zero-Overhead 16:9 Hardware Video Container + Left Sound / Right Brightness Finger Swipe */}
            <div
              ref={playerStageRef}
              id="player-container-0"
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onTouchStart={handleStageTouchStart}
              onTouchMove={handleStageTouchMove}
              onTouchEnd={handleStageTouchEnd}
              onClick={handleStageClick}
              style={{
                WebkitTouchCallout: 'none',
                WebkitUserSelect: 'none',
                userSelect: 'none',
                ...(isLandscapeMode && isViewportPortrait
                  ? {
                      position: 'fixed',
                      top: '50%',
                      left: '50%',
                      width: '100dvh',
                      height: '100dvw',
                      transform: 'translate(-50%, -50%) rotate(90deg)',
                      zIndex: 9999,
                    }
                  : {}),
              }}
              className={
                isMiniPlayer
                  ? 'relative w-full aspect-video bg-black select-none'
                  : isLandscapeMode && isViewportPortrait
                    ? 'bg-black flex items-center justify-center select-none touch-none overflow-hidden'
                    : isLandscapeMode || isFullscreen || isPortraitFullscreen
                      ? 'fixed inset-0 z-[9999] w-screen h-[100dvh] bg-black flex items-center justify-center select-none touch-none overflow-hidden'
                      : 'relative w-full aspect-video bg-black overflow-hidden select-none'
              }
            >
              {/* On-Screen Volume (Left Swipe) & Brightness (Right Swipe) Visual Gesture HUD */}
              {!isMiniPlayer && hudNotice && (
                <div className="pointer-events-none absolute top-3.5 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full bg-black/85 border border-white/20 backdrop-blur-md shadow-2xl flex items-center gap-2.5 min-w-[170px]">
                  {hudNotice.type === 'volume' ? (
                    isMuted || (hudNotice.percent ?? volume) === 0 ? (
                      <VolumeX className="w-4 h-4 text-red-400 shrink-0" />
                    ) : (
                      <Volume2 className="w-4 h-4 text-[#dc2626] shrink-0" />
                    )
                  ) : (
                    <Sun className="w-4 h-4 text-amber-400 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-extrabold text-white tracking-wide truncate">
                      {hudNotice.label}
                    </div>
                    {typeof hudNotice.percent === 'number' && (
                      <div className="w-full h-1.5 bg-white/20 rounded-full overflow-hidden mt-1">
                        <div
                          style={{ width: `${Math.max(0, Math.min(100, hudNotice.percent))}%` }}
                          className={`h-full rounded-full transition-all duration-75 ${
                            hudNotice.type === 'volume' ? 'bg-[#dc2626]' : 'bg-amber-400'
                          }`}
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Mini-Player Quick Controls (Resize, Play/Pause, Close & Progress Bar) */}
              {isMiniPlayer && (
                <div className="pointer-events-none absolute inset-0 z-30 flex flex-col justify-between bg-gradient-to-t from-black/65 via-transparent to-black/45">
                  <div className="flex items-center justify-between p-1.5">
                    <button
                      type="button"
                      data-mini-cycle="true"
                      onClick={handleCycleMiniSize}
                      className="pointer-events-auto w-6 h-6 rounded-full bg-black/75 text-white flex items-center justify-center border border-white/20"
                    >
                      {miniWidth >= 295 ? (
                        <Minimize2 className="w-3 h-3" />
                      ) : (
                        <Maximize2 className="w-3 h-3" />
                      )}
                    </button>
                    <div className="flex items-center gap-1">
                      {!isEmbedSource && (
                        <button
                          type="button"
                          data-mini-cycle="true"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleTogglePlayPause();
                          }}
                          className="pointer-events-auto w-6 h-6 rounded-full bg-black/75 text-white flex items-center justify-center border border-white/20"
                        >
                          {isPlaying ? (
                            <Pause className="w-3 h-3 fill-current" />
                          ) : (
                            <Play className="w-3 h-3 fill-current ml-0.5" />
                          )}
                        </button>
                      )}
                      <button
                        type="button"
                        data-mini-close="true"
                        onClick={(e) => {
                          e.stopPropagation();
                          onClose();
                        }}
                        className="pointer-events-auto w-6 h-6 rounded-full bg-black/75 text-white hover:text-red-400 flex items-center justify-center border border-white/20"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="w-full h-1 bg-white/20 overflow-hidden">
                    <div
                      style={{ width: `${progressPercent}%` }}
                      className="h-full bg-[#dc2626] transition-all duration-150"
                    />
                  </div>
                </div>
              )}

              {/* Top Control Bar when in Portrait Fullscreen or Landscape Fullscreen */}
              {!isMiniPlayer && (isLandscapeMode || isFullscreen || isPortraitFullscreen) && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="absolute top-3 inset-x-3 z-40 flex items-center justify-between gap-2 pointer-events-none"
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (isPortraitFullscreen) {
                        setIsPortraitFullscreen(false);
                      } else {
                        handleToggleFullscreen();
                      }
                    }}
                    className="pointer-events-auto px-3 py-1.5 rounded-lg bg-black/75 border border-white/20 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                  >
                    <ChevronLeft className="w-4 h-4" />
                    <span>Exit</span>
                  </button>

                  <div className="pointer-events-auto flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        if (isPortraitFullscreen) {
                          handleToggleFullscreen();
                        } else {
                          handleTogglePortraitMode();
                        }
                      }}
                      className="px-2.5 py-1.5 rounded-lg bg-black/75 border border-white/20 text-white text-xs font-bold flex items-center gap-1 cursor-pointer"
                    >
                      <Smartphone className="w-3.5 h-3.5 text-[#dc2626]" />
                      <span>{isPortraitFullscreen ? 'Landscape' : 'Portrait'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleCycleVideoFit}
                      className="px-2.5 py-1.5 rounded-lg bg-black/75 border border-white/20 text-white text-xs font-bold cursor-pointer"
                    >
                      {videoFit === 'contain' ? 'Fit' : videoFit === 'cover' ? 'Zoom' : 'Stretch'}
                    </button>
                    <button
                      type="button"
                      onClick={handleTogglePiP}
                      className="px-2.5 py-1.5 rounded-lg bg-black/75 border border-white/20 text-white text-xs font-bold flex items-center gap-1 cursor-pointer"
                    >
                      <PictureInPicture2 className="w-3.5 h-3.5 text-[#dc2626]" />
                      <span>PiP</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Hold 2x Speed Indicator */}
              {!isMiniPlayer && isHold2x && (
                <div className="pointer-events-none absolute top-4 left-1/2 -translate-x-1/2 z-40 px-3.5 py-1 rounded-full bg-[#dc2626] text-white text-xs font-extrabold flex items-center gap-1.5 shadow-lg">
                  <FastForward className="w-3.5 h-3.5 fill-current" />
                  <span>2x Fast Speed</span>
                </div>
              )}

              {/* Double-Tap +-10s Ripple Indicator */}
              {!isMiniPlayer && seekRipple && (
                <div
                  className={`pointer-events-none absolute inset-y-0 ${
                    seekRipple.side === 'left' ? 'left-0 rounded-r-full' : 'right-0 rounded-l-full'
                  } w-1/3 bg-[#dc2626]/25 backdrop-blur-[2px] z-30 flex flex-col items-center justify-center text-white animate-pulse`}
                >
                  {seekRipple.side === 'left' ? (
                    <RotateCcw className="w-7 h-7 text-white mb-1" />
                  ) : (
                    <RotateCw className="w-7 h-7 text-white mb-1" />
                  )}
                  <span className="text-xs font-extrabold">
                    {seekRipple.delta > 0 ? `+${seekRipple.delta}s` : `${seekRipple.delta}s`}
                  </span>
                </div>
              )}

              {playerMode === 'trailer' && effectiveDetail?.youtubeTrailerId ? (
                <iframe
                  src={`https://www.youtube-nocookie.com/embed/${effectiveDetail.youtubeTrailerId}?autoplay=1&rel=0&playsinline=1`}
                  title={effectiveDetail.title}
                  sandbox="allow-scripts allow-same-origin allow-presentation"
                  className="w-full h-full border-0"
                  allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                  allowFullScreen
                />
              ) : isEmbedSource && activeSource?.url ? (
                <div className="relative w-full h-full">
                  <iframe
                    ref={embedIframeRef}
                    key={activeSource.url}
                    src={activeSource.url}
                    title={effectiveDetail?.title || movie.title}
                    sandbox="allow-scripts allow-same-origin allow-presentation"
                    referrerPolicy="no-referrer"
                    style={{ filter: `brightness(${brightness}%)` }}
                    className="w-full h-full border-0 bg-black"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                    allowFullScreen
                  />
                  {/* Left & Right Vertical Swipe Gesture Zones for Sound (Left) & Brightness (Right) on Embed Player */}
                  {!isMiniPlayer && (
                    <>
                      <div
                        onTouchStart={handleStageTouchStart}
                        onTouchMove={handleStageTouchMove}
                        onTouchEnd={handleStageTouchEnd}
                        className="absolute inset-y-12 left-0 w-[18%] z-20 touch-none"
                      />
                      <div
                        onTouchStart={handleStageTouchStart}
                        onTouchMove={handleStageTouchMove}
                        onTouchEnd={handleStageTouchEnd}
                        className="absolute inset-y-12 right-0 w-[18%] z-20 touch-none"
                      />
                    </>
                  )}
                </div>
              ) : effectiveVideoUrl && !videoError ? (
                <>
                  <video
                    ref={(el) => {
                      videoRef.current = el;
                      if (el) {
                        el.disablePictureInPicture = false;
                        (el as any).autoPictureInPicture = true;
                        el.setAttribute('autopictureinpicture', 'true');
                      }
                    }}
                    src={effectiveVideoUrl}
                    poster={movie.poster || effectiveDetail?.poster}
                    style={{
                      ...videoFilterStyle,
                      WebkitTouchCallout: 'none',
                      WebkitUserSelect: 'none',
                      userSelect: 'none',
                    }}
                    muted={isMuted}
                    controls={false}
                    playsInline
                    autoPlay
                    preload="auto"
                    controlsList="nodownload"
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onPlay={(e) => {
                      const v = e.currentTarget;
                      v.disablePictureInPicture = false;
                      (v as any).autoPictureInPicture = true;
                      v.setAttribute('autopictureinpicture', 'true');
                      setIsPlaying(true);
                      syncCleanAudioVolume(v);
                      try {
                        for (let i = 0; i < v.textTracks.length; i++) {
                          v.textTracks[i].mode = 'disabled';
                        }
                      } catch {
                        // ignore
                      }
                    }}
                    onPause={() => {
                      if (!isSeekingRef.current && !iosTransitioningRef.current) {
                        setIsPlaying(false);
                      }
                    }}
                    onPlaying={(e) => {
                      const v = e.currentTarget;
                      if (stallDownshiftTimerRef.current) {
                        window.clearTimeout(stallDownshiftTimerRef.current);
                        stallDownshiftTimerRef.current = null;
                      }
                      if (startupWatchdogTimerRef.current) {
                        window.clearTimeout(startupWatchdogTimerRef.current);
                        startupWatchdogTimerRef.current = null;
                      }
                      setIsPlaying(true);
                      setHasStartedPlayback(true);
                      setIsBuffering(false);
                      syncCleanAudioVolume(v);
                      try {
                        for (let i = 0; i < v.textTracks.length; i++) {
                          v.textTracks[i].mode = 'disabled';
                        }
                      } catch {
                        // ignore
                      }
                    }}
                    onLoadedData={(e) => {
                      const v = e.currentTarget;
                      isSeekingRef.current = false;
                      iosTransitioningRef.current = false;
                      setHasStartedPlayback(true);
                      setIsBuffering(false);
                      syncCleanAudioVolume(v);
                      try {
                        for (let i = 0; i < v.textTracks.length; i++) {
                          v.textTracks[i].mode = 'disabled';
                        }
                      } catch {
                        // ignore
                      }
                      if (v.paused && v.currentTime < 0.5) {
                        startVideoWithiOSFallback(v);
                      }
                    }}
                    onCanPlay={(e) => {
                      const v = e.currentTarget;
                      if (stallDownshiftTimerRef.current) {
                        window.clearTimeout(stallDownshiftTimerRef.current);
                        stallDownshiftTimerRef.current = null;
                      }
                      if (startupWatchdogTimerRef.current) {
                        window.clearTimeout(startupWatchdogTimerRef.current);
                        startupWatchdogTimerRef.current = null;
                      }
                      isSeekingRef.current = false;
                      setHasStartedPlayback(true);
                      setIsBuffering(false);
                      syncCleanAudioVolume(v);
                      try {
                        for (let i = 0; i < v.textTracks.length; i++) {
                          v.textTracks[i].mode = 'disabled';
                        }
                      } catch {
                        // ignore
                      }
                      if (v.paused && v.currentTime < 0.5) {
                        startVideoWithiOSFallback(v);
                      }
                    }}
                    onWaiting={() => {
                      smoothPlaySecondsRef.current = 0;
                      setIsBuffering(true);
                      // Only downshift if already playing a heavy HD stream (> 576p) and it stalls mid-movie for > 8s!
                      // Never tear down the stream during initial startup!
                      if (stallDownshiftTimerRef.current) {
                        window.clearTimeout(stallDownshiftTimerRef.current);
                      }
                      if (
                        autoNetQuality &&
                        hasStartedPlayback &&
                        currentTime > 5 &&
                        (activeSource?.quality || 480) > 576 &&
                        sources.length > 1 &&
                        !hasStalledInSessionRef.current
                      ) {
                        stallDownshiftTimerRef.current = window.setTimeout(() => {
                          const v = videoRef.current;
                          if (!v || v.readyState >= 3) return;
                          const curQ = activeSource?.quality || 720;
                          const lighterIdx = sources.findIndex(
                            (s, idx) =>
                              idx !== selectedSourceIdx &&
                              !failedSourceIndices.includes(idx) &&
                              s.type !== 'embed' &&
                              s.quality < curQ
                          );
                          if (lighterIdx !== -1) {
                            hasStalledInSessionRef.current = true;
                            handleSelectSource(lighterIdx, false);
                          }
                        }, 8000);
                      }
                    }}
                    onSeeked={(e) => {
                      const v = e.currentTarget;
                      isSeekingRef.current = false;
                      setHasStartedPlayback(true);
                      setIsBuffering(false);
                      syncCleanAudioVolume(v);
                    }}
                    onLoadedMetadata={handleVideoLoadedMetadata}
                    onTimeUpdate={(e) => {
                      if (
                        isScrubbing ||
                        isScrubbingRef.current ||
                        isSeekingRef.current ||
                        iosTransitioningRef.current
                      ) {
                        return;
                      }
                      const v = e.currentTarget;
                      syncCleanAudioVolume(v);
                      try {
                        for (let i = 0; i < v.textTracks.length; i++) {
                          if (v.textTracks[i].mode !== 'disabled') {
                            v.textTracks[i].mode = 'disabled';
                          }
                        }
                      } catch {
                        // ignore
                      }
                      if (v.readyState >= 2) {
                        if (!hasStartedPlayback) setHasStartedPlayback(true);
                        if (isBuffering) setIsBuffering(false);
                      }
                      try {
                        if (v.buffered && v.buffered.length > 0) {
                          const rawBufEnd = v.buffered.end(v.buffered.length - 1);
                          const globalBufEnd = useHlsBridge
                            ? iosSegmentStartSecRef.current + rawBufEnd
                            : rawBufEnd;
                          if (Math.abs(globalBufEnd - bufferedEnd) >= 1) {
                            setBufferedEnd(Math.floor(globalBufEnd));
                          }
                        }
                      } catch {
                        // ignore
                      }
                      const segDur = v.duration || 0;
                      if (useHlsBridge && iosControllerRef.current && segDur > 0) {
                        // Trigger next segment pre-buffer early (when < 14s left) AND prime hardware decoder
                        if (segDur - v.currentTime < 14) {
                          const nextSegIdx = iosCurrentSegIndexRef.current + 1;
                          iosControllerRef.current
                            .ensureNextSegmentPrebuffered(nextSegIdx, 0)
                            .then((readySeg) => {
                              if (
                                readySeg?.blobUrl &&
                                preloadVideoRef.current &&
                                preloadVideoRef.current.src !== readySeg.blobUrl
                              ) {
                                preloadVideoRef.current.src = readySeg.blobUrl;
                                preloadVideoRef.current.load();
                              }
                            })
                            .catch(() => {});
                        }
                        // Proactive seamless transition 140ms before segment end so Safari never pauses at EOF!
                        if (segDur > 2 && segDur - v.currentTime <= 0.14) {
                          void advanceToNextIosSegment();
                          return;
                        }
                      }
                      const globalSec = Math.floor(
                        useHlsBridge
                          ? iosSegmentStartSecRef.current + v.currentTime
                          : v.currentTime
                      );
                      const totalFromCtrl = iosControllerRef.current?.getTotalDurationSec() || 0;
                      const dur = Math.floor(totalFromCtrl > 0 ? totalFromCtrl : segDur);
                      if (globalSec !== lastRecordedSecondRef.current) {
                        lastRecordedSecondRef.current = globalSec;
                        setCurrentTime(globalSec);
                        if (dur > 0 && dur !== duration) setDuration(dur);
                        if (globalSec > 5 && globalSec % 10 === 0) {
                          onRecordWatchProgress(
                            movie,
                            activeEpisode,
                            selectedEpIdx,
                            activeSource,
                            globalSec,
                            dur
                          );
                        }
                        // Pre-warm next episode stream when within 45s of episode completion
                        if (
                          dur > 60 &&
                          dur - globalSec <= 45 &&
                          selectedEpIdx + 1 < episodes.length &&
                          prewarmedNextEpIdxRef.current !== selectedEpIdx + 1
                        ) {
                          prewarmedNextEpIdxRef.current = selectedEpIdx + 1;
                          setNextEpPrewarmed(true);
                          const nextEp = episodes[selectedEpIdx + 1];
                          const nextDirect = (nextEp?.sources || []).find(
                            (s) =>
                              s.type !== 'embed' &&
                              !/abyssplayer\.com|abysscdn\.com|vidsrc|\/embed\//i.test(s.url || '')
                          );
                          if (nextDirect?.url) {
                            warmStreamConnection(nextDirect.url);
                          }
                        }
                      }
                    }}
                    onEnded={() => {
                      if (useHlsBridge && iosControllerRef.current) {
                        advanceToNextIosSegment().then((advanced) => {
                          if (!advanced) {
                            setIsPlaying(false);
                            if (sleepTimerMode === 'end_of_ep') {
                              setSleepTimerMode(null);
                              triggerHud('toast', 'স্লিপ টাইমার: এপিসোড শেষে ভিডিও বন্ধ হয়েছে', undefined, 2200);
                              return;
                            }
                            if (autoNextEp && selectedEpIdx + 1 < episodes.length) {
                              handleSelectEpisode(selectedEpIdx + 1);
                            }
                          }
                        });
                        return;
                      }
                      setIsPlaying(false);
                      if (sleepTimerMode === 'end_of_ep') {
                        setSleepTimerMode(null);
                        triggerHud('toast', 'স্লিপ টাইমার: এপিসোড শেষে ভিডিও বন্ধ হয়েছে', undefined, 2200);
                        return;
                      }
                      if (autoNextEp && selectedEpIdx + 1 < episodes.length) {
                        handleSelectEpisode(selectedEpIdx + 1);
                      }
                    }}
                    onError={handleVideoError}
                    className="w-full h-full bg-black object-contain select-none"
                  />

                  {/* MyFlix Clean JWPlayer-Style Dark Overlay (Only shown when user taps screen or pauses) */}
                  {!isMiniPlayer && hasStartedPlayback && (showOverlayControls || !isPlaying) && (
                    <div
                      onClick={() => setShowOverlayControls(false)}
                      className="absolute inset-0 z-30 flex flex-col justify-end bg-gradient-to-t from-black/80 via-transparent to-transparent select-none"
                    >
                      {/* Center Minimal MyFlix Transport Icons: [-10s] [Play/Pause] [+10s] */}
                      <div className="flex items-center justify-center gap-8 sm:gap-12 my-auto">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSeekRelative(-10);
                          }}
                          className="w-10 h-10 rounded-full bg-black/50 hover:bg-black/75 border border-white/15 flex items-center justify-center text-white active:scale-90 transition-transform cursor-pointer"
                        >
                          <RotateCcw className="w-5 h-5" />
                        </button>

                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleTogglePlayPause();
                          }}
                          className="w-12 h-12 rounded-full bg-black/65 hover:bg-black/85 border border-white/25 text-white flex items-center justify-center shadow-lg active:scale-90 transition-transform cursor-pointer"
                        >
                          {isBuffering ? (
                            <Loader2 className="w-6 h-6 animate-spin text-sky-400" />
                          ) : isPlaying ? (
                            <Pause className="w-6 h-6 fill-current" />
                          ) : (
                            <Play className="w-6 h-6 fill-current ml-0.5" />
                          )}
                        </button>

                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSeekRelative(10);
                          }}
                          className="w-10 h-10 rounded-full bg-black/50 hover:bg-black/75 border border-white/15 flex items-center justify-center text-white active:scale-90 transition-transform cursor-pointer"
                        >
                          <RotateCw className="w-5 h-5" />
                        </button>
                      </div>

                      {/* Bottom Full-Duration Scrubber & Controls */}
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className="px-3 pb-2.5 pt-1 space-y-1.5"
                      >
                        {/* Interactive Full-Movie Scrubber Bar */}
                        <div
                          ref={scrubberRef}
                          data-scrubber="true"
                          onTouchStart={(e) => {
                            e.stopPropagation();
                            const t = e.touches[0];
                            if (!t) return;
                            isScrubbingRef.current = true;
                            setIsScrubbing(true);
                            previewScrubberAtPointer(t.clientX, t.clientY, e.currentTarget);
                          }}
                          onTouchMove={(e) => {
                            e.stopPropagation();
                            if (!isScrubbingRef.current) return;
                            const t = e.touches[0];
                            if (!t) return;
                            previewScrubberAtPointer(t.clientX, t.clientY, e.currentTarget);
                          }}
                          onTouchEnd={(e) => {
                            e.stopPropagation();
                            if (!isScrubbingRef.current) return;
                            isScrubbingRef.current = false;
                            setIsScrubbing(false);
                            setScrubPreview(null);
                            commitScrubberSeek(scrubTargetSecRef.current);
                          }}
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            const el = e.currentTarget;
                            isScrubbingRef.current = true;
                            setIsScrubbing(true);
                            previewScrubberAtPointer(e.clientX, e.clientY, el);
                            const onMove = (ev: MouseEvent) => {
                              if (!isScrubbingRef.current) return;
                              previewScrubberAtPointer(ev.clientX, ev.clientY, el);
                            };
                            const onUp = (ev: MouseEvent) => {
                              window.removeEventListener('mousemove', onMove);
                              window.removeEventListener('mouseup', onUp);
                              if (!isScrubbingRef.current) return;
                              isScrubbingRef.current = false;
                              setIsScrubbing(false);
                              setScrubPreview(null);
                              const { targetSec } = computeScrubberTarget(ev.clientX, ev.clientY, el);
                              commitScrubberSeek(targetSec);
                            };
                            window.addEventListener('mousemove', onMove);
                            window.addEventListener('mouseup', onUp);
                          }}
                          className="relative h-5 flex items-center cursor-pointer touch-none"
                        >
                          <div className="w-full h-1.5 rounded-full bg-white/25 overflow-hidden relative">
                            <div
                              style={{ width: `${bufferedPercent}%` }}
                              className="absolute inset-y-0 left-0 bg-white/40 rounded-full transition-all duration-150"
                            />
                            <div
                              style={{ width: `${progressPercent}%` }}
                              className="absolute inset-y-0 left-0 bg-[#dc2626] rounded-full"
                            />
                          </div>
                          <div
                            style={{ left: `calc(${progressPercent}% - 7px)` }}
                            className="absolute w-3.5 h-3.5 rounded-full bg-[#dc2626] border-2 border-white shadow-md pointer-events-none"
                          />
                        </div>

                        {/* Time & Right Action Buttons */}
                        <div className="flex items-center justify-between text-[11px] sm:text-xs font-mono text-gray-200">
                          <div className="flex items-center gap-2.5">
                            <button
                              type="button"
                              onClick={handleTogglePlayPause}
                              className="text-white hover:text-[#dc2626] cursor-pointer"
                            >
                              {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
                            </button>
                            <button
                              type="button"
                              onClick={handleToggleMute}
                              className="text-white hover:text-[#dc2626] cursor-pointer"
                            >
                              {isMuted ? (
                                <VolumeX className="w-4 h-4 text-red-400" />
                              ) : (
                                <Volume2
                                  className={`w-4 h-4 ${
                                    volume > 100 ? 'text-emerald-400' : 'text-white'
                                  }`}
                                />
                              )}
                            </button>
                            {/* 1-Tap Ultra Sound Boost Button Inside Player Bar (Cycles 100% -> 150% -> 200% -> 300% -> 400%) */}
                            <button
                              type="button"
                              onClick={handleCycleSoundBoost}
                              title="Tap to Boost Sound up to 400%"
                              className={`px-1.5 py-0.5 rounded text-[10px] font-sans font-extrabold border transition-colors cursor-pointer ${
                                !isMuted && volume > 100
                                  ? 'bg-emerald-600/90 border-emerald-400 text-white shadow'
                                  : 'bg-white/10 hover:bg-white/20 border-white/20 text-gray-200'
                              }`}
                            >
                              {isMuted ? '0%' : volume > 100 ? `🔊 ${volume}%` : 'Boost+'}
                            </button>
                            <span>
                              {formatSeconds(activePlayheadSec)} / {formatSeconds(displayDuration)}
                            </span>
                          </div>

                          <div className="relative flex items-center gap-1.5 sm:gap-2">
                            {/* Dedicated Quality Selector Button Inside Player Control Bar */}
                            <div className="relative">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setShowQualityMenu((v) => !v);
                                }}
                                title="Select Video Quality"
                                className={`px-2 py-0.5 rounded text-[10px] font-sans font-bold border cursor-pointer flex items-center gap-1 ${
                                  showQualityMenu
                                    ? 'bg-[#dc2626] border-[#dc2626] text-white'
                                    : 'bg-black/65 border-white/25 text-white hover:border-white/50'
                                }`}
                              >
                                <Sparkles className="w-2.5 h-2.5 text-[#dc2626]" />
                                <span>{activeQualityLabel}</span>
                              </button>

                              {showQualityMenu && (
                                <div
                                  onClick={(e) => e.stopPropagation()}
                                  className="absolute right-0 bottom-full mb-2 w-40 rounded-xl bg-[#111318]/95 border border-white/15 shadow-2xl p-1.5 z-50 backdrop-blur-md"
                                >
                                  <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-gray-400 border-b border-white/10 mb-1">
                                    Video Quality
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => handleSelectQualityOption('auto')}
                                    className={`w-full px-2.5 py-1.5 rounded-lg text-left text-[11px] font-semibold flex items-center justify-between cursor-pointer ${
                                      selectedQualityPref === 'auto'
                                        ? 'bg-[#dc2626] text-white'
                                        : 'text-gray-200 hover:bg-white/10'
                                    }`}
                                  >
                                    <span>Auto (Recommended)</span>
                                    {selectedQualityPref === 'auto' && <Check className="w-3.5 h-3.5" />}
                                  </button>
                                  {(directQualitySources.length > 0
                                    ? directQualitySources
                                    : [
                                        { quality: 1080, idx: -1, label: '1080p Full HD' },
                                        { quality: 720, idx: -1, label: '720p HD' },
                                        { quality: 480, idx: -1, label: '480p SD' },
                                      ]
                                  ).map((qItem) => (
                                    <button
                                      key={qItem.quality}
                                      type="button"
                                      onClick={() =>
                                        handleSelectQualityOption(
                                          qItem.quality,
                                          qItem.idx >= 0 ? qItem.idx : undefined
                                        )
                                      }
                                      className={`w-full px-2.5 py-1.5 rounded-lg text-left text-[11px] font-semibold flex items-center justify-between cursor-pointer mt-0.5 ${
                                        selectedQualityPref === qItem.quality
                                          ? 'bg-[#dc2626] text-white'
                                          : 'text-gray-200 hover:bg-white/10'
                                      }`}
                                    >
                                      <span>{qItem.label}</span>
                                      {selectedQualityPref === qItem.quality && (
                                        <Check className="w-3.5 h-3.5" />
                                      )}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>

                            <button
                              type="button"
                              onClick={() => setAutoBanglaSubEnabled((v) => !v)}
                              className={`px-2 py-0.5 rounded text-[10px] font-sans font-bold border cursor-pointer ${
                                autoBanglaSubEnabled
                                  ? 'bg-[#dc2626] border-[#dc2626] text-white'
                                  : 'bg-black/60 border-white/20 text-gray-200'
                              }`}
                            >
                              বাংলা Sub
                            </button>
                            <button
                              type="button"
                              onClick={handleTogglePortraitMode}
                              title="Portrait Fullscreen Mode"
                              className="p-1 rounded hover:bg-white/10 text-white cursor-pointer"
                            >
                              <Smartphone className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={handleTogglePiP}
                              title="OS Phone-Screen PiP / Mini-Screen Mode"
                              className="p-1 rounded hover:bg-white/10 text-white cursor-pointer"
                            >
                              <PictureInPicture2 className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={handleToggleFullscreen}
                              title="Landscape Fullscreen Mode"
                              className="p-1 rounded hover:bg-white/10 text-white cursor-pointer"
                            >
                              {isLandscapeMode || isFullscreen ? (
                                <Minimize className="w-4 h-4" />
                              ) : (
                                <Maximize className="w-4 h-4" />
                              )}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Steady Poster & Buffering Shield until First Video Frame is Decoded */}
                  {!hasStartedPlayback && (
                    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-black">
                      {(movie.poster || effectiveDetail?.poster) && (
                        <img
                          src={movie.poster || effectiveDetail?.poster}
                          alt={movie.title}
                          className="absolute inset-0 w-full h-full object-cover opacity-35 blur-xs"
                        />
                      )}
                      <div className="relative z-10 flex flex-col items-center gap-2 px-4 py-2 rounded-xl bg-black/65 backdrop-blur-xs">
                        <Loader2 className="w-7 h-7 animate-spin text-[#dc2626]" />
                        <span className="text-[11px] font-semibold text-white tracking-wide">
                          Starting Stream...
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Hidden Hardware Pre-Decoder for Zero-Gap Segment Handover */}
                  <video
                    ref={preloadVideoRef}
                    muted
                    playsInline
                    preload="auto"
                    className="hidden pointer-events-none w-0 h-0 opacity-0"
                  />

                  {/* iOS 1-Tap Unmute Pill if Safari blocked unmuted autoplay after 13.5s */}
                  {autoMutedForiOS && isMuted && currentTime >= 13.5 && !isMiniPlayer && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setIsMuted(false);
                        setAutoMutedForiOS(false);
                        if (videoRef.current) {
                          videoRef.current.muted = false;
                          videoRef.current.play().catch(() => {});
                        }
                      }}
                      className="absolute top-3 left-3 z-30 px-3 py-1.5 rounded-lg bg-[#dc2626] text-white text-xs font-bold flex items-center gap-1.5 shadow-xl"
                    >
                      <Volume2 className="w-4 h-4" />
                      <span>Tap for Sound</span>
                    </button>
                  )}
                </>
              ) : loading ||
                episodeStreamLoading ||
                (useHlsBridge &&
                  !isEmbedSource &&
                  activeSource?.url &&
                  !effectiveVideoUrl &&
                  !videoError) ? (
                <div className="pointer-events-none relative w-full h-full flex items-center justify-center bg-black">
                  {(movie.poster || effectiveDetail?.poster) && (
                    <img
                      src={movie.poster || effectiveDetail?.poster}
                      alt={movie.title}
                      className="absolute inset-0 w-full h-full object-cover opacity-35 blur-xs"
                    />
                  )}
                  <div className="relative z-10 flex flex-col items-center gap-2 px-4 py-2 rounded-xl bg-black/65 backdrop-blur-xs">
                    <Loader2 className="w-7 h-7 animate-spin text-[#dc2626]" />
                    <span className="text-[11px] font-semibold text-white tracking-wide">
                      Starting Stream...
                    </span>
                  </div>
                </div>
              ) : (
                <div className="relative w-full h-full flex flex-col items-center justify-center p-5 text-center bg-[#0a0a0a]">
                  <p className="text-xs sm:text-sm text-gray-300 mb-3">
                    যদি Server 1 প্লে না হয়, নিচের অন্য Server সিলেক্ট করুন অথবা সরাসরি ডাউনলোড করুন।
                  </p>
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    {sources.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          handleSelectSource((selectedSourceIdx + 1) % sources.length, true)
                        }
                        className="px-4 py-2 rounded-lg bg-[#dc2626] hover:bg-[#b91c1c] text-white text-xs font-bold flex items-center gap-1.5"
                      >
                        <Play className="w-3.5 h-3.5 fill-current" />
                        <span>Try Next Server</span>
                      </button>
                    )}
                    {activeSource?.url && (
                      <a
                        href={vlcUrl}
                        className="px-4 py-2 rounded-lg bg-[#151515] hover:bg-[#222222] border border-white/10 text-white text-xs font-bold flex items-center gap-1.5"
                      >
                        <Tv className="w-3.5 h-3.5 text-[#dc2626]" />
                        <span>Play in VLC</span>
                      </a>
                    )}
                  </div>
                </div>
              )}

              {/* Single Small Bangla Subtitle at the Bottom of the Video Screen (Only when manually turned ON) */}
              {!isMiniPlayer && autoBanglaSubEnabled && activeBanglaCueText && (
                <div className="pointer-events-none select-none absolute inset-x-2 bottom-12 sm:bottom-14 z-30 flex justify-center">
                  <div
                    className="max-w-[90%] px-2 py-0.5 rounded bg-black/55 text-center font-medium text-white text-[11px] sm:text-xs leading-tight tracking-wide"
                    style={{
                      fontFamily: "'Hind Siliguri', sans-serif",
                      textShadow:
                        '0 1px 2px rgba(0,0,0,0.98), 0 0 4px rgba(0,0,0,0.95), -1px -1px 0 #000, 1px -1px 0 #000',
                    }}
                  >
                    {activeBanglaCueText}
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* =====================================================================
            LOWER UI SECTION — SCROLLS INDEPENDENTLY WHILE VIDEO REMAINS LOCKED AT TOP
           ===================================================================== */}
        {!isMiniPlayer && !isLandscapeMode && !isFullscreen && !isPortraitFullscreen && (
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-y-contain px-2.5 sm:px-6 pt-2 pb-28 space-y-5">
            {/* 1. Title + "Info >" + Single-Line Metadata + Horizontal Action Pills */}
            <section className="space-y-2.5">
              {/* Title + Inline "Info >" */}
              <div className="flex items-baseline flex-wrap gap-x-2.5 gap-y-1">
                <h1 className="text-lg sm:text-2xl font-extrabold text-white leading-tight">
                  {effectiveDetail?.title || movie.title}
                </h1>
                <button
                  type="button"
                  onClick={() =>
                    setBottomTab(bottomTab === 'infoCast' ? 'forYou' : 'infoCast')
                  }
                  className="inline-flex items-center gap-0.5 text-sm font-medium text-gray-400 hover:text-white transition-colors cursor-pointer"
                >
                  <span>Info</span>
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              {/* Compact Single-Line Metadata: 📺 | ⭐ 8.0 | 2026 | Language | Genre | 1 seasons */}
              <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm text-gray-400">
                <Tv className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                <span className="text-gray-600">|</span>
                <span className="inline-flex items-center gap-1 text-amber-400 font-bold">
                  <Star className="w-3.5 h-3.5 fill-current" />
                  <span>{displayRating}</span>
                </span>
                <span className="text-gray-600">|</span>
                <span>{displayYear}</span>
                <span className="text-gray-600">|</span>
                <span>{effectiveDetail?.language || movie.language}</span>
                <span className="text-gray-600">|</span>
                <span>{(displayGenre.split(',')[0] || 'Drama').trim()}</span>
                <span className="text-gray-600">|</span>
                <span>{distinctSeasons.length || 1} seasons</span>
              </div>

              {/* Horizontal Action Pills: [ Add to list ] [ Share ] [ Download ] [ Landscape ] [ Portrait ] [ PiP ] [ Video / Sub ] */}
              <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pt-1">
                <button
                  type="button"
                  onClick={() => onToggleWatchlist(movie, currentFolder)}
                  className={`h-9 px-3.5 rounded-full text-xs sm:text-sm font-medium flex items-center gap-1.5 shrink-0 transition-colors cursor-pointer ${
                    isInWatchlist
                      ? 'bg-[#dc2626]/25 border border-[#dc2626] text-white'
                      : 'bg-[#1b1d21] hover:bg-[#25282e] text-gray-200'
                  }`}
                >
                  <ListPlus className="w-4 h-4" />
                  <span>{isInWatchlist ? 'Added to list' : 'Add to list'}</span>
                </button>

                <button
                  type="button"
                  onClick={handleShare}
                  className="h-9 px-3.5 rounded-full bg-[#1b1d21] hover:bg-[#25282e] text-xs sm:text-sm font-medium text-gray-200 flex items-center gap-1.5 shrink-0 transition-colors cursor-pointer"
                >
                  {copiedShare ? (
                    <>
                      <Check className="w-4 h-4 text-emerald-400" />
                      <span>Copied</span>
                    </>
                  ) : (
                    <>
                      <Share2 className="w-4 h-4" />
                      <span>Share</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => setShowDownloadSheet(true)}
                  className="h-9 px-3.5 rounded-full bg-[#1b1d21] hover:bg-[#25282e] text-xs sm:text-sm font-medium text-gray-200 flex items-center gap-1.5 shrink-0 transition-colors cursor-pointer"
                >
                  <Download className="w-4 h-4" />
                  <span>Download</span>
                </button>

                <button
                  type="button"
                  onClick={() => setShowSoundBoostBar((v) => !v)}
                  className={`h-9 px-3.5 rounded-full text-xs sm:text-sm font-medium flex items-center gap-1.5 shrink-0 transition-colors cursor-pointer ${
                    showSoundBoostBar || (!isMuted && volume > 100)
                      ? 'bg-emerald-600/25 border border-emerald-500 text-white'
                      : 'bg-[#1b1d21] hover:bg-[#25282e] text-gray-200'
                  }`}
                >
                  <Volume2
                    className={`w-4 h-4 ${
                      !isMuted && volume > 100 ? 'text-emerald-400' : 'text-[#dc2626]'
                    }`}
                  />
                  <span>
                    {!isMuted && volume > 100
                      ? `Sound Boost: ${volume}% 🔥`
                      : `Sound Boost (${isMuted ? 0 : volume}%)`}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setShowSeparateQualityBar((v) => !v)}
                  className={`h-9 px-3.5 rounded-full text-xs sm:text-sm font-medium flex items-center gap-1.5 shrink-0 transition-colors cursor-pointer ${
                    showSeparateQualityBar || selectedQualityPref !== 'auto'
                      ? 'bg-[#dc2626]/25 border border-[#dc2626] text-white'
                      : 'bg-[#1b1d21] hover:bg-[#25282e] text-gray-200'
                  }`}
                >
                  <Sparkles className="w-4 h-4 text-[#dc2626]" />
                  <span>Quality: {activeQualityLabel}</span>
                  <ChevronDown
                    className={`w-3.5 h-3.5 transition-transform ${
                      showSeparateQualityBar ? 'rotate-180' : ''
                    }`}
                  />
                </button>

                <button
                  type="button"
                  onClick={handleToggleFullscreen}
                  className="h-9 px-3.5 rounded-full bg-[#1b1d21] hover:bg-[#25282e] text-xs sm:text-sm font-medium text-gray-200 flex items-center gap-1.5 shrink-0 transition-colors cursor-pointer"
                >
                  <Maximize className="w-4 h-4 text-[#dc2626]" />
                  <span>Landscape</span>
                </button>

                <button
                  type="button"
                  onClick={handleTogglePortraitMode}
                  className="h-9 px-3.5 rounded-full bg-[#1b1d21] hover:bg-[#25282e] text-xs sm:text-sm font-medium text-gray-200 flex items-center gap-1.5 shrink-0 transition-colors cursor-pointer"
                >
                  <Smartphone className="w-4 h-4 text-[#dc2626]" />
                  <span>Portrait</span>
                </button>

                <button
                  type="button"
                  onClick={handleTogglePiP}
                  className={`h-9 px-3.5 rounded-full text-xs sm:text-sm font-medium flex items-center gap-1.5 shrink-0 transition-colors cursor-pointer ${
                    isOsPipActive || isMiniPlayer
                      ? 'bg-[#dc2626]/25 border border-[#dc2626] text-white'
                      : 'bg-[#1b1d21] hover:bg-[#25282e] text-gray-200'
                  }`}
                >
                  <PictureInPicture2 className="w-4 h-4 text-[#dc2626]" />
                  <span>PiP / Mini</span>
                </button>

                <input
                  ref={subtitleInputRef}
                  type="file"
                  accept=".srt,.vtt"
                  onChange={handleSubtitleFileUpload}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => setAutoBanglaSubEnabled((v) => !v)}
                  className={`h-9 px-3.5 rounded-full text-xs sm:text-sm font-medium flex items-center gap-1.5 shrink-0 transition-colors cursor-pointer ${
                    autoBanglaSubEnabled
                      ? 'bg-[#dc2626]/25 border border-[#dc2626] text-white'
                      : 'bg-[#1b1d21] hover:bg-[#25282e] text-gray-200'
                  }`}
                >
                  <ListVideo className="w-4 h-4" />
                  <span>{autoBanglaSubEnabled ? 'Bangla Sub: ON' : 'Video / Sub'}</span>
                </button>
              </div>

              {/* Separate Dedicated Sound Booster Bar (Opens when tapping Sound Boost pill) */}
              {showSoundBoostBar && (
                <div className="mt-2 p-3 rounded-xl bg-[#14161b] border border-emerald-500/30 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-gray-200 flex items-center gap-1.5">
                      <Volume2 className="w-4 h-4 text-emerald-400" />
                      <span>Ultra Sound Booster (ক্লিয়ার ভয়েস ও ৪ গুণ বেশি সাউন্ড):</span>
                    </span>
                    <span className="text-xs font-mono font-extrabold text-emerald-400">
                      {isMuted ? 0 : volume}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={400}
                    step={5}
                    value={isMuted ? 0 : volume}
                    onChange={(e) => applyVolumeLevel(Number(e.target.value))}
                    className="w-full h-2 bg-white/15 rounded-lg accent-emerald-500 cursor-pointer"
                  />
                  <div className="flex flex-wrap items-center gap-1.5">
                    {[
                      { val: 100, label: '100% Normal' },
                      { val: 150, label: '150% Clear' },
                      { val: 200, label: '200% Double (2x)' },
                      { val: 300, label: '300% Super (3x)' },
                      { val: 400, label: '400% Max Boost 🔥' },
                    ].map((preset) => {
                      const active = !isMuted && volume === preset.val;
                      return (
                        <button
                          key={preset.val}
                          type="button"
                          onClick={() => applyVolumeLevel(preset.val)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                            active
                              ? preset.val > 100
                                ? 'bg-emerald-600 text-white shadow-md'
                                : 'bg-[#dc2626] text-white shadow-md'
                              : 'bg-[#1f2229] text-gray-300 hover:bg-[#2a2e37]'
                          }`}
                        >
                          {preset.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Separate Dedicated Quality Selection Bar (Opens when tapping Quality pill) */}
              {showSeparateQualityBar && (
                <div className="mt-2 p-2.5 rounded-xl bg-[#14161b] border border-white/15 flex flex-wrap items-center gap-2">
                  <span className="text-xs font-bold text-gray-300 mr-1 flex items-center gap-1">
                    <Sparkles className="w-3.5 h-3.5 text-[#dc2626]" />
                    <span>Select Quality:</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => handleSelectQualityOption('auto')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                      selectedQualityPref === 'auto'
                        ? 'bg-[#dc2626] text-white shadow-md'
                        : 'bg-[#1f2229] text-gray-300 hover:bg-[#2a2e37]'
                    }`}
                  >
                    Auto ({activeSource?.quality || 720}p)
                  </button>
                  {(directQualitySources.length > 0
                    ? directQualitySources
                    : [
                        { quality: 1080, idx: -1, label: '1080p Full HD' },
                        { quality: 720, idx: -1, label: '720p HD' },
                        { quality: 480, idx: -1, label: '480p SD' },
                      ]
                  ).map((qItem) => (
                    <button
                      key={qItem.quality}
                      type="button"
                      onClick={() =>
                        handleSelectQualityOption(
                          qItem.quality,
                          qItem.idx >= 0 ? qItem.idx : undefined
                        )
                      }
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                        selectedQualityPref === qItem.quality
                          ? 'bg-[#dc2626] text-white shadow-md'
                          : 'bg-[#1f2229] text-gray-300 hover:bg-[#2a2e37]'
                      }`}
                    >
                      {qItem.label}
                    </button>
                  ))}
                </div>
              )}
            </section>

            {/* 2. Resources Section: Header + [ Hindi dub v ] [ Season 01 v ] + [ All ] [ 01 ] [ 02 ] [ 03 ] Episode Tiles */}
            <section className="space-y-3">
              {/* Resources Header */}
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base sm:text-lg font-extrabold text-white">Resources</h2>
                <span className="text-xs sm:text-sm text-gray-400">
                  Uploaded by {effectiveDetail?.uploadedBy || 'MarieNo Ess'} etc.
                </span>
                <HelpCircle className="w-4 h-4 text-gray-400 shrink-0" />
              </div>

              {/* Two Side-by-Side Dropdown Boxes: [ Hindi dub ⌄ ] [ Season 01 ⌄ ] (Exact Match to Screenshot) */}
              <div className="flex items-center gap-2.5 flex-wrap">
                {/* Left Dropdown: Audio / Dub Language + Stream Servers */}
                <div className="relative inline-block">
                  <button
                    type="button"
                    onClick={() => {
                      setShowDubDropdown((v) => !v);
                      setShowSeasonDropdown(false);
                    }}
                    className="h-10 px-3.5 rounded-lg bg-[#121418] hover:bg-[#1b1d21] border border-white/15 text-xs sm:text-sm font-medium text-gray-100 flex items-center gap-2.5 transition-colors cursor-pointer"
                  >
                    <span>{activeDubLabel}</span>
                    <ChevronDown
                      className={`w-4 h-4 text-gray-400 transition-transform ${
                        showDubDropdown ? 'rotate-180' : ''
                      }`}
                    />
                  </button>

                  {showDubDropdown && (
                    <div className="absolute left-0 top-full mt-1.5 min-w-[220px] max-h-72 overflow-y-auto bg-[#121418] border border-white/15 rounded-xl shadow-2xl z-30 py-1.5 divide-y divide-white/10">
                      {/* Available Audio / Dub Languages */}
                      <div className="py-1">
                        <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">
                          Audio / Dubbing Languages
                        </div>
                        {availableDubs.map((dub) => {
                          const isCurrentDub =
                            dub.path === (movie.path || movie.url) ||
                            dub.id === activeDubOption?.id;
                          return (
                            <button
                              key={dub.id || dub.label}
                              type="button"
                              onClick={() => {
                                setShowDubDropdown(false);
                                if (dub.path && dub.path !== (movie.path || movie.url)) {
                                  onSelectMovie({
                                    ...movie,
                                    path: dub.path,
                                    url: dub.path,
                                    language: dub.label,
                                  });
                                }
                              }}
                              className={`w-full text-left px-3 py-2 text-xs font-semibold flex items-center justify-between transition-colors cursor-pointer ${
                                isCurrentDub
                                  ? 'bg-[#dc2626]/20 text-[#ef4444]'
                                  : 'text-gray-200 hover:bg-white/5'
                              }`}
                            >
                              <span>{dub.label}</span>
                              {isCurrentDub && <Check className="w-3.5 h-3.5 text-[#ef4444]" />}
                            </button>
                          );
                        })}
                      </div>

                      {/* Stream Servers / Resolutions */}
                      {sources.length > 0 && (
                        <div className="py-1">
                          <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">
                            Stream Servers
                          </div>
                          {sources.map((src, idx) => {
                            const isActive = selectedSourceIdx === idx;
                            return (
                              <button
                                key={src.id || idx}
                                type="button"
                                onClick={() => {
                                  handleSelectSource(idx, true);
                                  setShowDubDropdown(false);
                                }}
                                className={`w-full text-left px-3 py-2 text-xs font-semibold flex items-center justify-between transition-colors cursor-pointer ${
                                  isActive
                                    ? 'bg-[#dc2626]/20 text-[#ef4444]'
                                    : 'text-gray-200 hover:bg-white/5'
                                }`}
                              >
                                <span>
                                  Server {idx + 1} · {src.provider || src.name || 'HD'} ({src.quality || 720}p)
                                </span>
                                {isActive && <Check className="w-3.5 h-3.5 text-[#ef4444]" />}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Right Dropdown: Season Selector ([ Season 01 ⌄ ]) */}
                <div className="relative inline-block">
                  <button
                    type="button"
                    onClick={() => {
                      setShowSeasonDropdown((v) => !v);
                      setShowDubDropdown(false);
                    }}
                    className="h-10 px-3.5 rounded-lg bg-[#121418] hover:bg-[#1b1d21] border border-white/15 text-xs sm:text-sm font-medium text-gray-100 flex items-center gap-2.5 transition-colors cursor-pointer"
                  >
                    <span>{activeSeasonLabel}</span>
                    <ChevronDown
                      className={`w-4 h-4 text-gray-400 transition-transform ${
                        showSeasonDropdown ? 'rotate-180' : ''
                      }`}
                    />
                  </button>

                  {showSeasonDropdown && (
                    <div className="absolute left-0 top-full mt-1.5 min-w-[190px] max-h-72 overflow-y-auto bg-[#121418] border border-white/15 rounded-xl shadow-2xl z-30 py-1.5 divide-y divide-white/10">
                      <div className="py-1">
                        <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">
                          Seasons
                        </div>
                        {(distinctSeasons.length > 0 ? distinctSeasons : [1]).map((sNum) => {
                          const isCurrentSeason =
                            selectedSeasonFilter === sNum ||
                            (selectedSeasonFilter === 'all' &&
                              sNum === (distinctSeasons[0] || 1));
                          return (
                            <button
                              key={sNum}
                              type="button"
                              onClick={() => {
                                setSelectedSeasonFilter(sNum);
                                setShowSeasonDropdown(false);
                                const firstEpIdx = episodes.findIndex((ep) => ep.season === sNum);
                                if (firstEpIdx !== -1) {
                                  handleSelectEpisode(firstEpIdx);
                                }
                              }}
                              className={`w-full text-left px-3 py-2 text-xs font-semibold flex items-center justify-between transition-colors cursor-pointer ${
                                isCurrentSeason
                                  ? 'bg-[#dc2626]/20 text-[#ef4444]'
                                  : 'text-gray-200 hover:bg-white/5'
                              }`}
                            >
                              <span>Season {String(sNum).padStart(2, '0')}</span>
                              {isCurrentSeason && <Check className="w-3.5 h-3.5 text-[#ef4444]" />}
                            </button>
                          );
                        })}
                        {distinctSeasons.length > 1 && (
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedSeasonFilter('all');
                              setShowSeasonDropdown(false);
                            }}
                            className={`w-full text-left px-3 py-2 text-xs font-semibold flex items-center justify-between transition-colors cursor-pointer ${
                              selectedSeasonFilter === 'all'
                                ? 'bg-[#dc2626]/20 text-[#ef4444]'
                                : 'text-gray-200 hover:bg-white/5'
                            }`}
                          >
                            <span>All Seasons ({episodes.length})</span>
                            {selectedSeasonFilter === 'all' && (
                              <Check className="w-3.5 h-3.5 text-[#ef4444]" />
                            )}
                          </button>
                        )}
                      </div>

                      {/* Related Season Packs */}
                      {(effectiveDetail?.relatedSeasons || []).length > 0 && (
                        <div className="py-1">
                          <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">
                            More Seasons
                          </div>
                          {(effectiveDetail?.relatedSeasons || []).map((relSeason) => {
                            const normS = normalizeMovieCardItem(relSeason);
                            return (
                              <button
                                key={relSeason.path}
                                type="button"
                                onClick={() => {
                                  setShowSeasonDropdown(false);
                                  onSelectMovie(normS);
                                }}
                                className="w-full text-left px-3 py-2 text-xs text-gray-200 hover:bg-white/5 truncate cursor-pointer"
                              >
                                {normS.episodePill || normS.title}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Horizontal Episode Tiles Row: [ All ] [ 01 ] [ 02 ] [ 03 ] [ 04 ] [ 05 ] [ 06 ] ... */}
              <div className="flex items-center gap-2.5 overflow-x-auto no-scrollbar py-0.5">
                {/* "All" Tile First on the Left (Exact Match to Screenshot 1) */}
                <button
                  type="button"
                  onClick={() => setShowAllEpisodesModal(true)}
                  className="w-[54px] h-[48px] rounded-xl bg-[#1b1d21] hover:bg-[#25282e] text-white text-sm font-medium flex items-center justify-center shrink-0 transition-colors cursor-pointer"
                >
                  All
                </button>

                {(horizontalEpisodesSlice.length > 0
                  ? horizontalEpisodesSlice
                  : [
                      {
                        ep: {
                          id: 'ep-1',
                          label: '01',
                          number: 1,
                          season: 1,
                          kind: 'movie' as const,
                          sources: [],
                        },
                        idx: 0,
                      },
                    ]
                ).map(({ ep, idx }) => {
                  const isSelected = idx === selectedEpIdx;
                  const rawBadge = formatEpisodeTileBadge(ep, idx);
                  const badgeStr = rawBadge === 'Movie' ? '01' : rawBadge;
                  return (
                    <button
                      key={ep.id || idx}
                      type="button"
                      onClick={() => handleSelectEpisode(idx)}
                      className={`min-w-[54px] h-[48px] px-3 rounded-xl text-sm font-semibold flex items-center justify-center shrink-0 transition-all cursor-pointer ${
                        isSelected
                          ? 'bg-gradient-to-br from-[#dc2626]/30 to-[#7f1d1d]/35 border border-[#dc2626]/60 text-[#ef4444] font-bold shadow-[0_0_12px_rgba(220,38,38,0.2)]'
                          : 'bg-[#1b1d21] hover:bg-[#25282e] text-gray-200'
                      }`}
                    >
                      {badgeStr}
                    </button>
                  );
                })}
              </div>
            </section>

            {/* 3. Bottom Navigation Tabs: "For you" and "Comments(36)•" */}
            <section className="pt-1 space-y-4">
              <div className="flex items-center gap-7 border-b border-white/[0.06]">
                <button
                  type="button"
                  onClick={() => setBottomTab('forYou')}
                  className="relative pb-2.5 text-base sm:text-lg font-extrabold transition-colors cursor-pointer"
                >
                  <span className={bottomTab === 'forYou' ? 'text-white' : 'text-gray-400'}>
                    For you
                  </span>
                  {bottomTab === 'forYou' && (
                    <span className="absolute left-0 right-0 bottom-0 h-1 bg-white rounded-full" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => setBottomTab('reviews')}
                  className="relative pb-2.5 text-base sm:text-lg font-medium flex items-center gap-1 transition-colors cursor-pointer"
                >
                  <span
                    className={
                      bottomTab === 'reviews' ? 'text-white font-extrabold' : 'text-gray-400'
                    }
                  >
                    Comments({36 + (customReviewsMap[movie.path]?.length || 0)})
                  </span>
                  <span className="w-1.5 h-1.5 rounded-full bg-[#ef4444] -mt-2" />
                  {bottomTab === 'reviews' && (
                    <span className="absolute left-0 right-0 bottom-0 h-1 bg-white rounded-full" />
                  )}
                </button>

                {bottomTab === 'infoCast' && (
                  <button
                    type="button"
                    onClick={() => setBottomTab('infoCast')}
                    className="relative pb-2.5 text-base sm:text-lg font-extrabold text-white cursor-pointer"
                  >
                    <span>Info & Cast</span>
                    <span className="absolute left-0 right-0 bottom-0 h-1 bg-white rounded-full" />
                  </button>
                )}
              </div>

              {/* TAB 1: "For you" — 3-Column Poster Grid with Top-Right Language Badge & Bottom 1-Line Title */}
              {bottomTab === 'forYou' && (
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2.5">
                  {relatedMovies.slice(0, 12).map((rawRel) => {
                    const rel = normalizeMovieCardItem(rawRel);
                    const shortLang = /bangla|bengali/i.test(rel.language)
                      ? 'Bangla'
                      : /hindi/i.test(rel.language)
                        ? 'Hindi'
                        : /korean/i.test(rel.language)
                          ? 'Korean'
                          : /tamil|telugu/i.test(rel.language)
                            ? 'South'
                            : 'Hindi';
                    return (
                      <button
                        key={rel.path + rel.title}
                        type="button"
                        onMouseEnter={() =>
                          prefetchMovieDetails(rel.path, rel.title, activeNodeId, true)
                        }
                        onTouchStart={() =>
                          prefetchMovieDetails(rel.path, rel.title, activeNodeId, true)
                        }
                        onClick={() => {
                          if (modalContainerRef.current) {
                            modalContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
                          }
                          onSelectMovie(rel);
                        }}
                        className="group rounded-xl overflow-hidden bg-[#16181c] flex flex-col text-left transition-transform active:scale-95 cursor-pointer"
                      >
                        <div className="relative aspect-[2/3] w-full bg-[#101216] overflow-hidden">
                          {rel.poster && (
                            <img
                              src={rel.poster}
                              alt={rel.title}
                              referrerPolicy="no-referrer"
                              loading="lazy"
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                            />
                          )}
                          <span className="absolute top-1.5 right-1.5 px-2 py-0.5 rounded bg-black/60 backdrop-blur-[2px] text-[10px] sm:text-[11px] font-medium text-white">
                            {shortLang}
                          </span>
                        </div>
                        <div className="px-2.5 py-2 bg-[#16181c]">
                          <div className="text-xs sm:text-sm font-medium text-gray-100 truncate">
                            {rel.title}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* TAB 2: "Comments(36)" — Audience Comments & Rating */}
              {bottomTab === 'reviews' && (
                <div className="space-y-4">
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const trimmed = userReviewText.trim();
                      if (!trimmed) return;
                      const entry = {
                        id: String(Date.now()),
                        author: userReviewName.trim() || 'CinePulse Viewer',
                        stars: userRatingStars,
                        text: trimmed,
                        date: 'Just now',
                      };
                      const nextMap = {
                        ...customReviewsMap,
                        [movie.path]: [entry, ...(customReviewsMap[movie.path] || [])],
                      };
                      setCustomReviewsMap(nextMap);
                      setUserReviewText('');
                      try {
                        localStorage.setItem('cp_moviebox_reviews_v1', JSON.stringify(nextMap));
                      } catch {
                        // ignore
                      }
                    }}
                    className="bg-[#121418] border border-white/10 rounded-xl p-3.5 space-y-2.5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-gray-200">Leave a Comment</span>
                      <div className="flex items-center gap-1">
                        {[1, 2, 3, 4, 5].map((st) => (
                          <button
                            key={st}
                            type="button"
                            onClick={() => setUserRatingStars(st)}
                            className="p-0.5"
                          >
                            <Star
                              className={`w-4 h-4 ${
                                st <= userRatingStars
                                  ? 'text-amber-400 fill-current'
                                  : 'text-gray-600'
                              }`}
                            />
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={userReviewText}
                        onChange={(e) => setUserReviewText(e.target.value)}
                        placeholder="Write your comment..."
                        className="flex-1 h-9 px-3 rounded-lg bg-[#1b1d21] border border-white/10 text-xs text-white focus:outline-none focus:border-[#dc2626]"
                      />
                      <button
                        type="submit"
                        className="h-9 px-4 rounded-lg bg-[#dc2626] text-white text-xs font-bold shrink-0"
                      >
                        Post
                      </button>
                    </div>
                  </form>

                  <div className="space-y-2.5">
                    {[
                      ...(customReviewsMap[movie.path] || []),
                      {
                        id: 'c1',
                        author: 'Tanvir Ahmed',
                        stars: 5,
                        text: 'অসাধারণ প্রিন্ট আর একদম বাফারিং ছাড়া স্মুথ চলছে! ১০/১০।',
                        date: '2h ago',
                      },
                      {
                        id: 'c2',
                        author: 'Sadia Islam',
                        stars: 5,
                        text: 'ভয়েস এবং সাউন্ড কোয়ালিটি একদম ক্লিয়ার। ধন্যবাদ আপলোড করার জন্য।',
                        date: '5h ago',
                      },
                      {
                        id: 'c3',
                        author: 'Rohan Khan',
                        stars: 4,
                        text: 'Server 1 এ ক্লিক করার সাথে সাথেই প্লে হয়েছে!',
                        date: '1d ago',
                      },
                    ].map((rev) => (
                      <div
                        key={rev.id}
                        className="bg-[#121418] border border-white/[0.06] rounded-xl p-3 space-y-1"
                      >
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-bold text-white">{rev.author}</span>
                          <span className="text-[11px] text-gray-400">{rev.date}</span>
                        </div>
                        <p className="text-xs text-gray-300 leading-relaxed">{rev.text}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* TAB 3: "Info >" Details, Cast & Screenshots Panel */}
              {bottomTab === 'infoCast' && (
                <div className="space-y-4 bg-[#121418] border border-white/10 rounded-xl p-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-bold text-white">Synopsis, Cast & Stills</h3>
                    <button
                      type="button"
                      onClick={() => setBottomTab('forYou')}
                      className="text-xs text-[#ef4444] font-bold cursor-pointer"
                    >
                      Back to For You
                    </button>
                  </div>
                  <p className="text-xs sm:text-sm text-gray-300 leading-relaxed">
                    {effectiveDetail?.storyline ||
                      `${effectiveDetail?.title || movie.title} (${displayYear}) — Stream in Full HD with crystal clear audio on CinePulse.`}
                  </p>
                  {combinedCast.length > 0 && (
                    <div className="space-y-2 pt-1">
                      <div className="text-xs font-bold text-gray-400 uppercase tracking-wider">
                        Cast & Crew
                      </div>
                      <div className="flex items-center gap-3 overflow-x-auto no-scrollbar pt-1">
                        {combinedCast.map((actor, idx) => (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => {
                              onClose();
                              onSearchByActor(actor.name);
                            }}
                            className="w-20 shrink-0 flex flex-col items-center text-center cursor-pointer"
                          >
                            <div className="w-14 h-14 rounded-full overflow-hidden bg-[#1b1d21] border border-white/10 mb-1.5">
                              {actor.photo ? (
                                <img
                                  src={actor.photo}
                                  alt={actor.name}
                                  referrerPolicy="no-referrer"
                                  className="w-full h-full object-cover"
                                />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center text-gray-400 font-bold text-xs">
                                  {actor.name.charAt(0)}
                                </div>
                              )}
                            </div>
                            <span className="text-[11px] font-semibold text-white truncate w-full">
                              {actor.name}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {combinedScreenshots.length > 0 && (
                    <div className="space-y-2 pt-1">
                      <div className="text-xs font-bold text-gray-400 uppercase tracking-wider">
                        HD Screenshots
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {(showAllScreenshots
                          ? combinedScreenshots
                          : combinedScreenshots.slice(0, 6)
                        ).map((shotUrl, idx) => (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => setLightboxImage(shotUrl)}
                            className="relative aspect-video rounded-lg overflow-hidden bg-[#1b1d21] border border-white/10 group cursor-pointer"
                          >
                            <img
                              src={shotUrl}
                              alt={`Scene ${idx + 1}`}
                              referrerPolicy="no-referrer"
                              loading="lazy"
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                            />
                          </button>
                        ))}
                      </div>
                      {combinedScreenshots.length > 6 && (
                        <button
                          type="button"
                          onClick={() => setShowAllScreenshots((v) => !v)}
                          className="text-xs font-bold text-[#ef4444] hover:underline cursor-pointer"
                        >
                          {showAllScreenshots
                            ? 'Show Less'
                            : `View All Screenshots (${combinedScreenshots.length})`}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* Download Links Sheet Modal (Opens when tapping [ Download ] pill) */}
            {showDownloadSheet && (
              <div
                onClick={() => setShowDownloadSheet(false)}
                className="fixed inset-0 z-50 bg-black/85 backdrop-blur-xs flex items-end sm:items-center justify-center p-3 sm:p-4"
              >
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="bg-[#121418] border border-white/15 rounded-2xl w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden shadow-2xl"
                >
                  <div className="p-4 border-b border-white/10 flex items-center justify-between">
                    <h3 className="text-base font-bold text-white flex items-center gap-2">
                      <Download className="w-4 h-4 text-[#ef4444]" />
                      <span>Direct High-Speed Downloads</span>
                    </h3>
                    <button
                      type="button"
                      onClick={() => setShowDownloadSheet(false)}
                      className="w-8 h-8 rounded-lg bg-[#1b1d21] text-gray-300 flex items-center justify-center cursor-pointer"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="p-4 overflow-y-auto space-y-2.5">
                    {combinedDownloads.length > 0 ? (
                      combinedDownloads.map((dl, idx) => (
                        <a
                          key={idx}
                          href={dl.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="w-full px-4 py-3 rounded-xl bg-[#1b1d21] hover:bg-[#25282e] border border-white/10 flex items-center justify-between gap-3 transition-colors"
                        >
                          <div className="min-w-0">
                            <div className="text-sm font-bold text-white truncate">{dl.label}</div>
                            {dl.subLabel && (
                              <div className="text-[11px] text-gray-400 truncate">{dl.subLabel}</div>
                            )}
                          </div>
                          <Download className="w-4 h-4 text-[#ef4444] shrink-0" />
                        </a>
                      ))
                    ) : (
                      <p className="text-xs text-gray-400 text-center py-4">
                        Direct download links are preparing for this title.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Full All-Episodes Modal with Instant Episode Search & Sort */}
            {showAllEpisodesModal && (
              <div
                onClick={() => setShowAllEpisodesModal(false)}
                className="fixed inset-0 z-50 bg-black/90 backdrop-blur-xs flex items-center justify-center p-4"
              >
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="bg-[#121418] border border-white/15 rounded-2xl w-full max-w-2xl max-h-[82vh] flex flex-col overflow-hidden shadow-2xl"
                >
                  <div className="p-4 border-b border-white/10 space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-base font-bold text-white">
                        All Episodes ({filteredEpisodesWithIdx.length})
                      </h3>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            setEpisodeSortOrder((s) => (s === 'asc' ? 'desc' : 'asc'))
                          }
                          className="h-8 px-2.5 rounded-lg bg-[#1b1d21] hover:bg-[#25282e] border border-white/10 text-xs font-semibold text-gray-200 flex items-center gap-1.5 cursor-pointer"
                        >
                          <ArrowUpDown className="w-3.5 h-3.5 text-[#ef4444]" />
                          <span>{episodeSortOrder === 'asc' ? '1 → Last' : 'Last → 1'}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowAllEpisodesModal(false)}
                          className="w-8 h-8 rounded-lg bg-[#1b1d21] hover:bg-[#25282e] text-gray-300 flex items-center justify-center cursor-pointer"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    {episodes.length > 6 && (
                      <div className="relative">
                        <Search className="w-3.5 h-3.5 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                          type="text"
                          value={episodeSearchQuery}
                          onChange={(e) => setEpisodeSearchQuery(e.target.value)}
                          placeholder="Search episode number (e.g. 12, 45)..."
                          className="w-full h-9 pl-8 pr-8 rounded-lg bg-[#1b1d21] border border-white/10 text-xs text-white placeholder-gray-400 focus:outline-none focus:border-[#dc2626]"
                        />
                        {episodeSearchQuery && (
                          <button
                            type="button"
                            onClick={() => setEpisodeSearchQuery('')}
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="p-4 overflow-y-auto grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2.5">
                    {filteredEpisodesWithIdx.map(({ ep, idx }) => {
                      const isSelected = idx === selectedEpIdx;
                      const rawBadge = formatEpisodeTileBadge(ep, idx);
                      const badgeStr = rawBadge === 'Movie' ? '01' : rawBadge;
                      return (
                        <button
                          key={ep.id || idx}
                          type="button"
                          onClick={() => {
                            handleSelectEpisode(idx);
                            setShowAllEpisodesModal(false);
                          }}
                          className={`h-12 px-2 rounded-xl text-sm font-semibold flex items-center justify-center transition-colors cursor-pointer ${
                            isSelected
                              ? 'bg-gradient-to-br from-[#dc2626]/30 to-[#7f1d1d]/35 border border-[#dc2626]/60 text-[#ef4444] font-bold'
                              : 'bg-[#1b1d21] hover:bg-[#25282e] text-gray-200'
                          }`}
                        >
                          {badgeStr}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* Fullscreen Screenshot Lightbox Modal */}
            {lightboxImage && (
              <div
                onClick={() => setLightboxImage(null)}
                className="fixed inset-0 z-50 bg-black/95 backdrop-blur-xs flex items-center justify-center p-4"
              >
                <button
                  type="button"
                  onClick={() => setLightboxImage(null)}
                  className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
                >
                  <X className="w-6 h-6" />
                </button>
                <img
                  src={lightboxImage}
                  alt="Screenshot Fullview"
                  referrerPolicy="no-referrer"
                  className="max-w-full max-h-[90vh] object-contain rounded-lg border border-white/15 shadow-2xl"
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

