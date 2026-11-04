import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  BellRing,
  BookOpen,
  Bookmark,
  Calendar,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  Film,
  Flame,
  FolderHeart,
  GraduationCap,
  History,
  Home,
  Layers,
  Loader2,
  Megaphone,
  MessageCircle,
  MessageSquareWarning,
  Mic,
  Play,
  RefreshCw,
  ScanLine,
  Search,
  Settings,
  SlidersHorizontal,
  Smile,
  Star,
  Trash2,
  Trophy,
  Tv,
  Upload,
  User,
  WifiOff,
  X,
} from 'lucide-react';
import {
  ALL_CATEGORIES,
  CURATED_COLLECTION_CARDS,
  INITIAL_FALLBACK_MOVIES,
  TOP_10_THIS_WEEK_ITEMS,
  UPCOMING_RELEASES,
} from './data/categories';
import type {
  CategoryOption,
  EpisodeItem,
  GlobalMovieNotification,
  LiveSportMatch,
  MovieBoxHomePayload,
  MovieBoxLiveSportItem,
  MovieCardItem,
  StreamSource,
  UserMovieRequest,
  WatchlistFolder,
  WatchProgressItem,
} from './types/cinema';
import { usePWAInstall } from './hooks/usePWAInstall';
import { MovieDetailModal } from './components/MovieDetailModal';
import { PWAInstallModal } from './components/PWAInstallModal';
import { MovieRequestModal } from './components/MovieRequestModal';
import { prefetchMovieDetails, universalApiFetch } from './services/liveClientEngine';
import {
  deduplicateMovieCards,
  getItemMinutesAgo,
  isUploadedWithinMinutes,
  normalizeMovieCardItem,
  normalizeMovieCardList,
  sortItemsByHighRating,
  sortItemsByHotAndHype,
  sortItemsByRecentUpload,
} from './utils/timeAgo';

const WATCHLIST_STORAGE_KEY = 'cp_iphone_watchlist_v2';
const CONTINUE_STORAGE_KEY = 'cp_iphone_continue_v2';
const RECENT_SEARCH_STORAGE_KEY = 'cp_recent_searches_v1';
const ACTIVE_NODE_STORAGE_KEY = 'cp_active_node_v1';
const READ_NOTIFS_STORAGE_KEY = 'cp_read_notifications_v1';

function parseViewsCount(viewsStr: string): number {
  if (!viewsStr) return 0;
  const clean = viewsStr.toUpperCase().replace(/[^0-9.KM]/g, '');
  const num = parseFloat(clean) || 0;
  if (clean.includes('M')) return num * 1_000_000;
  if (clean.includes('K')) return num * 1_000;
  return num;
}

function formatResumeTime(sec?: number): string {
  if (!sec || sec < 5) return 'Resume';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatShortLanguage(lang: string): string {
  const up = (lang || '').toUpperCase();
  if (up.includes('BANGLA') || up.includes('BENGALI')) return 'Bengali';
  if (up.includes('HINDI')) return 'Hindi';
  if (up.includes('TAMIL')) return 'Tamil';
  if (up.includes('TELUGU')) return 'Telugu';
  if (up.includes('JAP')) return 'Anime';
  if (up.includes('KOR')) return 'Korean';
  if (up.includes('DUAL') || up.includes('MULTI')) return 'Dual Audio';
  return 'English';
}

function getCardSourceInfo(_path?: string): { id: 'MOVIEBOX' | 'MOVIELINKBD' | 'MYFLIX'; label: string; badgeClass: string } {
  return {
    id: 'MOVIEBOX',
    label: 'MovieBox',
    badgeClass: 'bg-emerald-600/90 text-white border-emerald-400/40',
  };
}

export default function App() {
  const { isInstallable, isInstalled, isIOS, isOnline, install } = usePWAInstall();

  // Navigation & View Mode
  const [activeTab, setActiveTab] = useState<'browse' | 'categories' | 'watchlist' | 'me'>('browse');
  const [currentCategory, setCurrentCategory] = useState<CategoryOption>(ALL_CATEGORIES[0]);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [maxPage, setMaxPage] = useState<number>(520);
  const [jumpPageInput, setJumpPageInput] = useState<string>('');

  // Search & Instant Live Suggestions
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [submittedSearch, setSubmittedSearch] = useState<string>('');
  const [suggestions, setSuggestions] = useState<MovieCardItem[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState<boolean>(false);
  const [showSearchDropdown, setShowSearchDropdown] = useState<boolean>(false);
  const [searchTabFilter, setSearchTabFilter] = useState<
    'ALL' | 'MOVIE_SERIES' | 'SHORT_TV' | 'SPORTS' | 'MUSIC'
  >('ALL');
  const [recentSearches, setRecentSearches] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(RECENT_SEARCH_STORAGE_KEY);
      return raw ? JSON.parse(raw) : ['Tower of God [Hindi]', 'Bohurupi', 'Mirzapur', 'One Piece'];
    } catch {
      return ['Tower of God [Hindi]', 'Bohurupi', 'Mirzapur'];
    }
  });
  const searchContainerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Advanced Filters & Sorting (Default: HOT_HYPE so popular, high-rating, dhamaka items stay on top)
  const [sourceFilter, setSourceFilter] = useState<'ALL' | 'MOVIEBOX' | 'MOVIELINKBD' | 'MYFLIX'>('ALL');
  const [audioFilter, setAudioFilter] = useState<'ALL' | 'BANGLA' | 'HINDI' | 'DUAL' | 'SUB'>('ALL');
  const [qualityFilter, setQualityFilter] = useState<'ALL' | '4K' | '1080P' | 'WEBDL' | 'HDTC'>('ALL');
  const [yearFilter, setYearFilter] = useState<'ALL' | '2026' | '2025' | 'OLDER'>('ALL');
  const [sortBy, setSortBy] = useState<'HOT_HYPE' | 'LATEST' | 'RATING' | 'VIEWS' | 'TITLE'>('HOT_HYPE');

  // Anonymized Server Node Selection (Default: MovieBox HD Server)
  const [activeNodeId, setActiveNodeId] = useState<string>(() => {
    try {
      return localStorage.getItem(ACTIVE_NODE_STORAGE_KEY) || 'node-moviebox';
    } catch {
      return 'node-moviebox';
    }
  });

  // Catalog Items State
  const [items, setItems] = useState<MovieCardItem[]>(() =>
    sortItemsByHotAndHype(INITIAL_FALLBACK_MOVIES['/'])
  );
  const [loadingCatalog, setLoadingCatalog] = useState<boolean>(false);
  const [brokenImages, setBrokenImages] = useState<Record<string, boolean>>({});

  // Modals, Mini-Player & Entry Splash Screen State
  const [showSplashScreen, setShowSplashScreen] = useState<boolean>(false);
  const [selectedMovie, setSelectedMovie] = useState<MovieCardItem | null>(null);
  const [isMiniPlayer, setIsMiniPlayer] = useState<boolean>(false);
  const [liveClockNow, setLiveClockNow] = useState<number>(() => Date.now());
  const [showInstallModal, setShowInstallModal] = useState<boolean>(false);
  const [showRequestModal, setShowRequestModal] = useState<boolean>(false);
  const [requestPrefillTitle, setRequestPrefillTitle] = useState<string>('');
  const [requestPrefillType, setRequestPrefillType] = useState<UserMovieRequest['type']>('MOVIE');

  // Silent Automatic Phone OS Push Notification State (No in-app popup clutter)
  const [serverNotifications, setServerNotifications] = useState<GlobalMovieNotification[]>([]);
  const [pushedPhoneNotifIds, setPushedPhoneNotifIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(READ_NOTIFS_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const pushedSetRef = useRef<Set<string>>(new Set(pushedPhoneNotifIds));

  // Tick live clock every 20 seconds so upload times ("4 mins ago" -> "5 mins ago" -> "1 hour ago") update dynamically!
  useEffect(() => {
    const clockTimer = window.setInterval(() => {
      setLiveClockNow(Date.now());
    }, 20_000);
    return () => window.clearInterval(clockTimer);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setShowSplashScreen(false);
    }, 1350);
    return () => window.clearTimeout(timer);
  }, []);

  // Watchlist & Custom Folders + Backup/Restore
  const [watchlistFolderTab, setWatchlistFolderTab] = useState<'all' | WatchlistFolder>('all');
  const backupInputRef = useRef<HTMLInputElement | null>(null);
  const [latest3SiteUploads, setLatest3SiteUploads] = useState<MovieCardItem[]>([]);
  const [refreshing24h, setRefreshing24h] = useState(false);
  const [mbHomeData, setMbHomeData] = useState<MovieBoxHomePayload | null>(null);
  const [activeLiveSportModal, setActiveLiveSportModal] = useState<MovieBoxLiveSportItem | null>(null);
  const [bookedComingSoonIds, setBookedComingSoonIds] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem('cp_mb_booked_coming_soon_v1');
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });

  const toggleBookComingSoon = useCallback((id: string) => {
    setBookedComingSoonIds((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem('cp_mb_booked_coming_soon_v1', JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = (await universalApiFetch('/api/mb-home')) as MovieBoxHomePayload;
        if (!cancelled && res && res.ok) {
          setMbHomeData(res);
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshLatest3SiteUploads = useCallback(async (force = false) => {
    setRefreshing24h(true);
    try {
      const qs = force ? '?path=/new-uploads&page=1&refresh=1' : '?path=/new-uploads&page=1';
      const data = await universalApiFetch(`/api/catalog${qs}`);
      if (data && Array.isArray(data.items) && data.items.length > 0) {
        setLatest3SiteUploads(data.items);
      }
    } catch {
      // ignore
    } finally {
      setRefreshing24h(false);
    }
  }, []);

  useEffect(() => {
    if (showRequestModal || latest3SiteUploads.length === 0) {
      refreshLatest3SiteUploads(showRequestModal);
    }
  }, [showRequestModal, refreshLatest3SiteUploads, latest3SiteUploads.length]);

  const [watchlist, setWatchlist] = useState<MovieCardItem[]>(() => {
    try {
      const raw = localStorage.getItem(WATCHLIST_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

  const [continueWatching, setContinueWatching] = useState<WatchProgressItem[]>(() => {
    try {
      const raw = localStorage.getItem(CONTINUE_STORAGE_KEY);
      const parsed: WatchProgressItem[] = raw ? JSON.parse(raw) : [];
      return parsed.map((entry) => ({
        ...entry,
        movie: {
          ...entry.movie,
          uploadedAtMs: undefined,
        },
      }));
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(watchlist));
    } catch {
      // ignore
    }
  }, [watchlist]);

  useEffect(() => {
    try {
      localStorage.setItem(CONTINUE_STORAGE_KEY, JSON.stringify(continueWatching));
    } catch {
      // ignore
    }
  }, [continueWatching]);

  useEffect(() => {
    try {
      localStorage.setItem(RECENT_SEARCH_STORAGE_KEY, JSON.stringify(recentSearches));
    } catch {
      // ignore
    }
  }, [recentSearches]);

  useEffect(() => {
    try {
      localStorage.setItem(ACTIVE_NODE_STORAGE_KEY, activeNodeId);
    } catch {
      // ignore
    }
  }, [activeNodeId]);

  useEffect(() => {
    if (showSearchDropdown) {
      window.setTimeout(() => {
        searchInputRef.current?.focus();
      }, 20);
    }
  }, [showSearchDropdown]);

  // Debounced Instant Live Search Suggestions across all 3 sites (Starts from 1st character!)
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 1) {
      setSuggestions([]);
      setLoadingSuggestions(false);
      return;
    }

    const interleaveThreeSites = (pool: MovieCardItem[]): MovieCardItem[] => {
      const mb = pool.filter((i) => i.path?.startsWith('/mb/'));
      const mf = pool.filter((i) => i.path?.startsWith('/mf/'));
      const mlbd = pool.filter((i) => !i.path?.startsWith('/mb/') && !i.path?.startsWith('/mf/'));
      const out: MovieCardItem[] = [];
      const maxLen = Math.max(mb.length, mlbd.length, mf.length);
      for (let i = 0; i < maxLen; i++) {
        if (i < mb.length) out.push(mb[i]);
        if (i < mlbd.length) out.push(mlbd[i]);
        if (i < mf.length) out.push(mf[i]);
      }
      return deduplicateMovieCards(out);
    };

    // Immediate local match across all 3 sites (loaded items + Top 10 + full multi-site catalog fallback)
    const lower = q.toLowerCase();
    const allLocalSources: MovieCardItem[] = [
      ...items,
      ...TOP_10_THIS_WEEK_ITEMS,
      ...Object.values(INITIAL_FALLBACK_MOVIES).flat(),
    ];
    const localInstant = interleaveThreeSites(
      allLocalSources.filter((item) => item?.title?.toLowerCase().includes(lower))
    ).slice(0, 14);
    if (localInstant.length > 0) {
      setSuggestions(localInstant);
    }

    let cancelled = false;
    setLoadingSuggestions(true);
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q, node: activeNodeId });
        const data = await universalApiFetch(`/api/suggest?${params.toString()}`);
        if (!cancelled && data && Array.isArray(data.items) && data.items.length > 0) {
          const mergedAllSites = interleaveThreeSites([...data.items, ...localInstant]).slice(0, 30);
          setSuggestions(mergedAllSites);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoadingSuggestions(false);
      }
    }, 180);

    // Also sync submittedSearch automatically after 260ms so full 3-site catalog results populate seamlessly
    const submitTimer = setTimeout(() => {
      if (!cancelled) {
        setSubmittedSearch(q);
      }
    }, 260);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearTimeout(submitTimer);
    };
  }, [searchQuery, activeNodeId, items]);

  // Fetch Live Catalog from Express Server or GitHub Live Engine (18+ Always Unlocked + Live Auto-Sync)
  const fetchCatalog = useCallback(
    async (path: string, page: number, query: string, nodeId: string, forceRefresh = false, silent = false) => {
      if (!silent) setLoadingCatalog(true);
      try {
        const params = new URLSearchParams({
          path,
          page: String(page),
          q: query,
          node: nodeId,
          ...(forceRefresh ? { refresh: '1' } : {}),
        });
        const data = await universalApiFetch(`/api/catalog?${params.toString()}`);
        if (data && Array.isArray(data.items) && data.items.length > 0) {
          setItems(normalizeMovieCardList(data.items));
          if (data.maxPage) setMaxPage(data.maxPage);
          if (!silent) setLoadingCatalog(false);
          return;
        }
      } catch {
        // Keep fallback items if offline
      } finally {
        if (!silent) setLoadingCatalog(false);
      }
    },
    []
  );

  useEffect(() => {
    fetchCatalog(currentCategory.path, currentPage, submittedSearch, activeNodeId);
  }, [currentCategory.path, currentPage, submittedSearch, activeNodeId, fetchCatalog]);

  // Automatic Real-Time Background Sync for New Movies & Episodes (Every 30s + App Foreground Wake)
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible' && activeTab === 'browse') {
        setLiveClockNow(Date.now());
        fetchCatalog(currentCategory.path, currentPage, submittedSearch, activeNodeId, true, true);
      }
    }, 30_000);

    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && activeTab === 'browse') {
        setLiveClockNow(Date.now());
        fetchCatalog(currentCategory.path, currentPage, submittedSearch, activeNodeId, false, true);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [activeTab, currentCategory.path, currentPage, submittedSearch, activeNodeId, fetchCatalog]);

  // Prevent background page rubber-banding / scrolling when Fullscreen Movie Player or Modals are open
  // (Keep scrolling UNLOCKED when player is minimized to Floating Mini Player!)
  useEffect(() => {
    if ((selectedMovie && !isMiniPlayer) || showInstallModal || showRequestModal) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [selectedMovie, isMiniPlayer, showInstallModal, showRequestModal]);

  useEffect(() => {
    pushedSetRef.current = new Set(pushedPhoneNotifIds);
    try {
      localStorage.setItem(READ_NOTIFS_STORAGE_KEY, JSON.stringify(pushedPhoneNotifIds.slice(-150)));
    } catch {
      // ignore
    }
  }, [pushedPhoneNotifIds]);

  // Register Service Worker (/sw-push.js) & listen for Phone Notification tap to open movie directly
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('./sw-push.js').catch(() => {
      // ignore if main PWA SW is already controlling
    });

    const handleSwMessage = (event: MessageEvent) => {
      if (event.data?.type === 'CINEPULSE_OPEN_MOVIE' && event.data.movie) {
        setIsMiniPlayer(false);
        setSelectedMovie(normalizeMovieCardItem(event.data.movie));
      }
    };
    navigator.serviceWorker.addEventListener('message', handleSwMessage);
    return () => navigator.serviceWorker.removeEventListener('message', handleSwMessage);
  }, []);

  // Helper to send Native Phone OS Notification (Status Bar / Lock Screen) — Zero in-app UI clutter
  const sendNativePhoneNotification = useCallback((notif: GlobalMovieNotification) => {
    if (typeof window === 'undefined' || !('Notification' in window)) return false;
    if (Notification.permission !== 'granted') return false;

    const deepLinkUrl = `${window.location.origin}${window.location.pathname}?watch=${encodeURIComponent(
      notif.movie.path
    )}&title=${encodeURIComponent(notif.movie.title)}`;

    const options: NotificationOptions & Record<string, any> = {
      body: `${notif.badgeText} • ${notif.subtitleBn}`,
      icon: notif.movie.poster || './pwa-192x192.png',
      image: notif.movie.poster || undefined,
      badge: './pwa-192x192.png',
      tag: notif.id,
      renotify: true,
      vibrate: [180, 80, 180],
      data: {
        url: deepLinkUrl,
        movie: notif.movie,
      },
    };

    try {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.ready
          .then((reg) => {
            reg.showNotification(notif.headlineBn, options);
          })
          .catch(() => {
            const n = new Notification(notif.headlineBn, options);
            n.onclick = () => {
              window.focus();
              setIsMiniPlayer(false);
              setSelectedMovie(notif.movie);
              n.close();
            };
          });
      } else {
        const n = new Notification(notif.headlineBn, options);
        n.onclick = () => {
          window.focus();
          setIsMiniPlayer(false);
          setSelectedMovie(notif.movie);
          n.close();
        };
      }
      return true;
    } catch {
      return false;
    }
  }, []);

  // Fetch Global Notifications (New Movie Uploads + Popular High-Rated Movies) from Server & Auto-Poll every 25s
  const fetchGlobalNotifications = useCallback(async () => {
    try {
      const data = await universalApiFetch('/api/notifications');
      if (data && Array.isArray(data.notifications) && data.notifications.length > 0) {
        setServerNotifications(data.notifications);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchGlobalNotifications();
    const timer = window.setInterval(() => {
      fetchGlobalNotifications();
    }, 25_000);
    return () => window.clearInterval(timer);
  }, [fetchGlobalNotifications]);

  // Synthesize complete live notifications list (New Uploads + Top Rated Popular hits)
  const allNotifications = useMemo<GlobalMovieNotification[]>(() => {
    const merged: GlobalMovieNotification[] = [...serverNotifications];
    const seenIds = new Set<string>(merged.map((n) => n.id));
    const seenMovieCat = new Set<string>(merged.map((n) => `${n.category}::${n.movie.path}`));

    const cleanItems = normalizeMovieCardList(
      [...items, ...TOP_10_THIS_WEEK_ITEMS].filter((i) => !i.isAdult),
      liveClockNow
    );
    const recentList = sortItemsByRecentUpload(cleanItems, liveClockNow).slice(0, 10);
    const popularHighRated = sortItemsByHighRating(cleanItems, liveClockNow).slice(0, 10);

    const maxLen = Math.max(recentList.length, popularHighRated.length);
    for (let i = 0; i < maxLen; i++) {
      const newIt = recentList[i];
      if (newIt && !seenMovieCat.has(`NEW_UPLOAD::${newIt.path}`)) {
        const id = `notif-new-${newIt.id}`;
        if (!seenIds.has(id)) {
          seenIds.add(id);
          seenMovieCat.add(`NEW_UPLOAD::${newIt.path}`);
          const mins = getItemMinutesAgo(newIt, i, liveClockNow);
          const ratingNum = parseFloat(newIt.rating || '8.8') || 8.8;
          const isEp = Boolean(newIt.episodePill);
          merged.push({
            id,
            category: 'NEW_UPLOAD',
            badgeText: isEp ? `নতুন এপিসোড • ${newIt.episodePill}` : 'নতুন মুভি আপলোড 🔥',
            headlineBn: isEp
              ? `নতুন এপিসোড: ${newIt.title}`
              : `নতুন মুভি আপলোড: ${newIt.title}`,
            subtitleBn: `${formatShortLanguage(newIt.language)} • ${newIt.quality || '1080p HD'} • ★ ${ratingNum.toFixed(1)} • ${newIt.timeAgo}`,
            movie: newIt,
            createdAt: Math.max(liveClockNow - mins * 60_000, liveClockNow - 24 * 3600_000),
            ratingScore: ratingNum,
          });
        }
      }

      const popIt = popularHighRated[i];
      if (popIt && !seenMovieCat.has(`TOP_RATED_POPULAR::${popIt.path}`)) {
        const id = `notif-pop-${popIt.id}`;
        if (!seenIds.has(id)) {
          seenIds.add(id);
          seenMovieCat.add(`TOP_RATED_POPULAR::${popIt.path}`);
          const ratingNum = Math.max(8.5, parseFloat(popIt.rating || '9.2') || 9.2);
          merged.push({
            id,
            category: 'TOP_RATED_POPULAR',
            badgeText: `জনপ্রিয় • রেটিং ★ ${ratingNum.toFixed(1)}`,
            headlineBn: `জনপ্রিয় ও হাই-রেটিং মুভি: ${popIt.title}`,
            subtitleBn: `রেটিং ★ ${ratingNum.toFixed(1)}/10 • ${popIt.views || '310K+'} ভিউ • ${formatShortLanguage(popIt.language)} • ${popIt.quality || 'Full HD'}`,
            movie: popIt,
            createdAt: liveClockNow - (i + 1) * 180_000,
            ratingScore: ratingNum,
          });
        }
      }
    }

    return merged.slice(0, 30);
  }, [serverNotifications, items, liveClockNow]);

  // Automatically request Phone OS Notification permission on first user touch & deliver unseen notifications directly to Phone Status Bar!
  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;

    const deliverNextUnseenPhoneNotification = () => {
      if (Notification.permission !== 'granted') return;
      const nextUnseen = allNotifications.find((n) => !pushedSetRef.current.has(n.id));
      if (nextUnseen) {
        pushedSetRef.current.add(nextUnseen.id);
        setPushedPhoneNotifIds((prev) =>
          prev.includes(nextUnseen.id) ? prev : [...prev, nextUnseen.id]
        );
        sendNativePhoneNotification(nextUnseen);
      }
    };

    if (Notification.permission === 'granted') {
      const timer = window.setTimeout(deliverNextUnseenPhoneNotification, 1800);
      return () => window.clearTimeout(timer);
    }

    if (Notification.permission === 'default') {
      const requestOnFirstGesture = () => {
        Notification.requestPermission()
          .then((perm) => {
            if (perm === 'granted') {
              deliverNextUnseenPhoneNotification();
            }
          })
          .catch(() => {});
        window.removeEventListener('pointerdown', requestOnFirstGesture);
        window.removeEventListener('keydown', requestOnFirstGesture);
      };
      window.addEventListener('pointerdown', requestOnFirstGesture, { once: true, passive: true });
      window.addEventListener('keydown', requestOnFirstGesture, { once: true, passive: true });
      return () => {
        window.removeEventListener('pointerdown', requestOnFirstGesture);
        window.removeEventListener('keydown', requestOnFirstGesture);
      };
    }
  }, [allNotifications, sendNativePhoneNotification]);

  // Support Direct Shared Movie Links (?watch=/path/to/movie&title=...) on App Load
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const watchPath = params.get('watch');
      const watchTitle = params.get('title') || 'Featured Stream';
      if (watchPath) {
        const matched =
          items.find((m) => m.path === watchPath) ||
          TOP_10_THIS_WEEK_ITEMS.find((m) => m.path === watchPath);
        if (matched) {
          setSelectedMovie(matched);
        } else {
          setSelectedMovie({
            id: watchPath.replace(/[^a-zA-Z0-9_-]/g, '_'),
            title: watchTitle,
            url: watchPath,
            path: watchPath,
            poster: '',
            quality: '1080p Full HD',
            views: 'Live',
            language: 'Multi Audio',
            typeBadge: watchPath.includes('/anime') ? 'ANIME' : 'MOVIE',
            timeAgo: 'Shared Link',
            episodePill: '',
            isPinned: false,
            isAdult: false,
          });
        }
      }
    } catch {
      // ignore
    }
  }, []);

  // Mobile / Browser Hardware Back Button Support: Minimize player to Floating Mini Player or close modal
  useEffect(() => {
    const anyModalOpen = Boolean(
      (selectedMovie && !isMiniPlayer) || showInstallModal || showRequestModal
    );
    if (anyModalOpen) {
      window.history.pushState({ cinepulseModal: true }, '');
    }
    const handlePopState = () => {
      if (selectedMovie && !isMiniPlayer) {
        setIsMiniPlayer(true);
      } else if (showRequestModal) {
        setShowRequestModal(false);
      } else if (showInstallModal) {
        setShowInstallModal(false);
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [selectedMovie, isMiniPlayer, showInstallModal, showRequestModal]);

  const saveRecentSearch = (term: string) => {
    const cleaned = term.trim();
    if (!cleaned) return;
    setRecentSearches((prev) => [cleaned, ...prev.filter((s) => s.toLowerCase() !== cleaned.toLowerCase())].slice(0, 8));
  };

  const handleSelectCategory = (cat: CategoryOption) => {
    setCurrentCategory(cat);
    setCurrentPage(1);
    setSubmittedSearch('');
    setSearchQuery('');
    setAudioFilter('ALL');
    setQualityFilter('ALL');
    setYearFilter('ALL');
    setShowSearchDropdown(false);
    setActiveTab('browse');
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = searchQuery.trim();
    setSourceFilter('ALL');
    setSubmittedSearch(trimmed);
    if (trimmed) saveRecentSearch(trimmed);
    setCurrentPage(1);
    setShowSearchDropdown(false);
    setActiveTab('browse');
  };

  const handleTriggerActorSearch = (actorName: string) => {
    setSourceFilter('ALL');
    setSearchQuery(actorName);
    setSubmittedSearch(actorName);
    saveRecentSearch(actorName);
    setCurrentPage(1);
    setActiveTab('browse');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handlePageChange = (newPage: number) => {
    const clamped = Math.max(1, Math.min(maxPage, newPage));
    setCurrentPage(clamped);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleJumpPage = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseInt(jumpPageInput, 10);
    if (!isNaN(parsed) && parsed >= 1) {
      handlePageChange(parsed);
      setJumpPageInput('');
    }
  };

  const handleToggleWatchlist = useCallback((movie: MovieCardItem, folder: WatchlistFolder = 'favorites') => {
    setWatchlist((prev) => {
      const existing = prev.find((m) => m.path === movie.path || m.title === movie.title);
      if (existing) {
        if (existing.folder !== folder) {
          return prev.map((m) =>
            m.path === movie.path || m.title === movie.title ? { ...m, folder } : m
          );
        }
        return prev.filter((m) => m.path !== movie.path && m.title !== movie.title);
      }
      const defaultFolder: WatchlistFolder =
        movie.typeBadge === 'ANIME' || movie.typeBadge === 'SERIES' || movie.typeBadge === 'DRAMA'
          ? 'anime_series'
          : folder;
      return [{ ...movie, folder: defaultFolder }, ...prev];
    });
  }, []);

  const handleRecordWatchProgress = useCallback(
    (
      movie: MovieCardItem,
      episode?: EpisodeItem,
      episodeIdx?: number,
      source?: StreamSource,
      seconds?: number,
      duration?: number
    ) => {
      setContinueWatching((prev) => {
        const existing = prev.find((p) => p.movie.path === movie.path || p.movie.title === movie.title);
        const filtered = prev.filter((p) => p.movie.path !== movie.path && p.movie.title !== movie.title);
        const entry: WatchProgressItem = {
          movie,
          episodeId: episode?.id ?? existing?.episodeId,
          episodeIdx: episodeIdx ?? existing?.episodeIdx ?? 0,
          episodeLabel: episode?.label ?? existing?.episodeLabel,
          quality: source?.quality ?? existing?.quality,
          audio: source?.audio ?? existing?.audio,
          updatedAt: Date.now(),
          progressSeconds: seconds && seconds > 0 ? seconds : existing?.progressSeconds || 0,
          durationSeconds: duration && duration > 0 ? duration : existing?.durationSeconds || 0,
        };
        return [entry, ...filtered].slice(0, 18);
      });
    },
    []
  );

  // Automatically add opened movie/series to Watch History so it appears in Me -> Watch History immediately
  useEffect(() => {
    if (selectedMovie) {
      handleRecordWatchProgress(selectedMovie);
    }
  }, [selectedMovie, handleRecordWatchProgress]);

  const handleExportWatchlist = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      watchlist,
      continueWatching,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'CinePulse_Backup.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImportWatchlist = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed.watchlist)) {
        setWatchlist(parsed.watchlist);
      }
      if (Array.isArray(parsed.continueWatching)) {
        setContinueWatching(parsed.continueWatching);
      }
    } catch {
      // ignore
    }
  };

  const sourceCounts = useMemo(() => {
    const norm = normalizeMovieCardList(items, liveClockNow);
    let mb = 0;
    let mlbd = 0;
    let mf = 0;
    for (const it of norm) {
      if (it.path?.startsWith('/mb/')) mb++;
      else if (it.path?.startsWith('/mf/')) mf++;
      else mlbd++;
    }
    return { total: norm.length, mb, mlbd, mf };
  }, [items, liveClockNow]);

  const displayedItems = useMemo(() => {
    let list = normalizeMovieCardList(items, liveClockNow);

    if (sourceFilter !== 'ALL') {
      list = list.filter((i) => getCardSourceInfo(i.path).id === sourceFilter);
    }

    if (audioFilter !== 'ALL') {
      list = list.filter((i) => {
        const lang = (i.language + ' ' + i.title).toUpperCase();
        if (audioFilter === 'BANGLA') return lang.includes('BANGLA') || lang.includes('BENGALI');
        if (audioFilter === 'HINDI') return lang.includes('HINDI');
        if (audioFilter === 'DUAL') return lang.includes('DUAL') || lang.includes('MULTI');
        if (audioFilter === 'SUB') return lang.includes('SUB') || lang.includes('JAP') || lang.includes('KOR');
        return true;
      });
    }

    if (qualityFilter !== 'ALL') {
      list = list.filter((i) => {
        const q = (i.quality + ' ' + i.title).toUpperCase();
        if (qualityFilter === '4K') return q.includes('4K') || q.includes('2160P') || q.includes('UHD');
        if (qualityFilter === '1080P') return q.includes('1080P') || q.includes('FULL HD') || q.includes('FHD');
        if (qualityFilter === 'WEBDL') return q.includes('WEB-DL') || q.includes('WEBRIP') || q.includes('BLURAY');
        if (qualityFilter === 'HDTC') return q.includes('HDTC') || q.includes('CAM') || q.includes('HDTS');
        return true;
      });
    }

    if (yearFilter !== 'ALL') {
      list = list.filter((i) => {
        const t = i.title;
        if (yearFilter === '2026') return t.includes('2026');
        if (yearFilter === '2025') return t.includes('2025');
        if (yearFilter === 'OLDER') return !t.includes('2026') && !t.includes('2025');
        return true;
      });
    }

    if (sortBy === 'HOT_HYPE') {
      list = sortItemsByHotAndHype(list, liveClockNow);
    } else if (sortBy === 'LATEST') {
      list.sort((a, b) => getItemMinutesAgo(a, 0, liveClockNow) - getItemMinutesAgo(b, 0, liveClockNow));
    } else if (sortBy === 'RATING') {
      list = sortItemsByHighRating(list, liveClockNow);
    } else if (sortBy === 'VIEWS') {
      list.sort((a, b) => parseViewsCount(b.views) - parseViewsCount(a.views));
    } else if (sortBy === 'TITLE') {
      list.sort((a, b) => a.title.localeCompare(b.title));
    }

    return list;
  }, [items, sourceFilter, audioFilter, qualityFilter, yearFilter, sortBy, liveClockNow]);

  const heroSlides = useMemo(() => {
    const mbBanners = mbHomeData?.banners || [];
    const pool = normalizeMovieCardList(
      currentCategory.path === '/'
        ? [...mbBanners, ...TOP_10_THIS_WEEK_ITEMS, ...displayedItems, ...INITIAL_FALLBACK_MOVIES['/']]
        : displayedItems,
      liveClockNow
    );
    const seen = new Set<string>();
    const mbPopular: MovieCardItem[] = [];
    const mlbdPopular: MovieCardItem[] = [];
    const fallbackList: MovieCardItem[] = [];

    for (const item of pool) {
      const tk = item.title.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!seen.has(item.path) && !seen.has(tk) && item.poster && !brokenImages[item.id] && !item.isAdult) {
        seen.add(item.path);
        seen.add(tk);
        if (item.path?.startsWith('/mb/')) {
          mbPopular.push(item);
        } else if (!item.path?.startsWith('/mf/')) {
          mlbdPopular.push(item);
        } else {
          fallbackList.push(item);
        }
      }
    }

    mbPopular.sort((a, b) => (b.hypeScore || 0) - (a.hypeScore || 0));
    mlbdPopular.sort((a, b) => (b.hypeScore || 0) - (a.hypeScore || 0));
    fallbackList.sort((a, b) => (b.hypeScore || 0) - (a.hypeScore || 0));

    const interleavedHero: MovieCardItem[] = [];
    const maxLen = Math.max(mbPopular.length, mlbdPopular.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < mbPopular.length) interleavedHero.push(mbPopular[i]);
      if (i < mlbdPopular.length) interleavedHero.push(mlbdPopular[i]);
    }
    if (interleavedHero.length < 10) {
      interleavedHero.push(...fallbackList);
    }

    return interleavedHero.length > 0 ? interleavedHero.slice(0, 12) : displayedItems.slice(0, 12);
  }, [mbHomeData, displayedItems, brokenImages, currentCategory.path, liveClockNow]);

  const [heroSlideIdx, setHeroSlideIdx] = useState(0);
  const heroTouchStartXRef = useRef<number | null>(null);

  // Reset slide index when category changes
  useEffect(() => {
    setHeroSlideIdx(0);
  }, [currentCategory.path]);

  // Auto-advance Hero Background Cover through Hot/Popular Movies one after another every 3.8s
  useEffect(() => {
    if (activeTab !== 'browse' || selectedMovie || submittedSearch || currentPage !== 1) return;
    if (heroSlides.length <= 1) return;
    const timer = window.setInterval(() => {
      setHeroSlideIdx((prev) => (prev + 1) % heroSlides.length);
    }, 3800);
    return () => window.clearInterval(timer);
  }, [activeTab, selectedMovie, submittedSearch, currentPage, heroSlides.length]);

  const safeSlideIdx = heroSlides.length > 0 ? heroSlideIdx % heroSlides.length : 0;

  const spotlightItem = useMemo(() => {
    return (
      heroSlides[safeSlideIdx] ||
      displayedItems.find((i) => i.poster) ||
      displayedItems[0] ||
      INITIAL_FALLBACK_MOVIES['/'][0]
    );
  }, [heroSlides, safeSlideIdx, displayedItems]);

  const heroMiniCards = useMemo(() => {
    if (heroSlides.length === 0) return displayedItems.slice(0, 4);
    const ordered: MovieCardItem[] = [];
    const count = Math.min(6, heroSlides.length);
    for (let i = 0; i < count; i++) {
      ordered.push(heroSlides[(safeSlideIdx + i) % heroSlides.length]);
    }
    return ordered;
  }, [heroSlides, safeSlideIdx, displayedItems]);

  const top10ThisWeekItems = useMemo(() => {
    const merged: MovieCardItem[] = [];
    const seen = new Set<string>();
    const combined = normalizeMovieCardList([...TOP_10_THIS_WEEK_ITEMS, ...displayedItems], liveClockNow);
    for (const item of combined) {
      const tk = item.title.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!seen.has(item.path) && !seen.has(tk) && item.poster && !brokenImages[item.id]) {
        seen.add(item.path);
        seen.add(tk);
        merged.push(item);
        if (merged.length >= 10) break;
      }
    }
    return merged.slice(0, 10);
  }, [displayedItems, brokenImages, liveClockNow]);

  // Last 24 Hours updated movies, series, and anime across all 3 sites
  const last24hItems = useMemo(() => {
    const recentPool: MovieCardItem[] = [];
    const seen = new Set<string>();
    const combined = normalizeMovieCardList(
      [
        ...latest3SiteUploads,
        ...items,
        ...TOP_10_THIS_WEEK_ITEMS,
        ...INITIAL_FALLBACK_MOVIES['/'],
      ],
      liveClockNow
    );
    for (let idx = 0; idx < combined.length; idx++) {
      const item = combined[idx];
      if (!item?.title || !item?.path) continue;
      if (seen.has(item.path)) continue;
      const yearMatch = item.title.match(/\((19\d{2}|20[0-2]\d)\)/);
      if (yearMatch) {
        const yr = parseInt(yearMatch[1], 10);
        if (yr <= 2024 && !item.episodePill) continue;
      }
      const mins = getItemMinutesAgo(item, idx, liveClockNow);
      if (mins <= 1440 || item.title.includes('2026') || item.title.includes('2025')) {
        seen.add(item.path);
        recentPool.push(item);
      }
    }
    const mb = recentPool.filter((i) => i.path?.startsWith('/mb/'));
    const mf = recentPool.filter((i) => i.path?.startsWith('/mf/'));
    const mlbd = recentPool.filter((i) => !i.path?.startsWith('/mb/') && !i.path?.startsWith('/mf/'));
    const interleaved: MovieCardItem[] = [];
    const maxLen = Math.max(mb.length, mlbd.length, mf.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < mlbd.length) interleaved.push(mlbd[i]);
      if (i < mb.length) interleaved.push(mb[i]);
      if (i < mf.length) interleaved.push(mf[i]);
    }
    const baseList = interleaved.length >= 8 ? interleaved : combined.slice(0, 36);
    return baseList;
  }, [latest3SiteUploads, items, liveClockNow]);

  // Gently pre-warm active Hero slide + top 3 visible movies after initial page load settles
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const toWarm = [spotlightItem, ...displayedItems.slice(0, 3)].filter(Boolean);
      const seen = new Set<string>();
      toWarm.forEach((m, idx) => {
        if (m?.path && !seen.has(m.path)) {
          seen.add(m.path);
          prefetchMovieDetails(m.path, m.title, activeNodeId, idx === 0);
        }
      });
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [currentCategory.path, activeNodeId]);

  const isMovieInWatchlist = useCallback(
    (movie: MovieCardItem | null) => {
      if (!movie) return false;
      return watchlist.some((m) => m.path === movie.path || m.title === movie.title);
    },
    [watchlist]
  );

  const getMovieWatchlistFolder = useCallback(
    (movie: MovieCardItem | null): WatchlistFolder => {
      if (!movie) return 'favorites';
      const found = watchlist.find((m) => m.path === movie.path || m.title === movie.title);
      return found?.folder || 'favorites';
    },
    [watchlist]
  );

  const selectedMovieProgress = useMemo(() => {
    if (!selectedMovie) return undefined;
    return continueWatching.find(
      (p) => p.movie.path === selectedMovie.path || p.movie.title === selectedMovie.title
    );
  }, [selectedMovie, continueWatching]);

  const filteredWatchlist = useMemo(() => {
    if (watchlistFolderTab === 'all') return watchlist;
    return watchlist.filter((item) => (item.folder || 'favorites') === watchlistFolderTab);
  }, [watchlist, watchlistFolderTab]);

  const findCat = (path: string) =>
    ALL_CATEGORIES.find((c) => c.path === path) || ALL_CATEGORIES[0];

  const topNavTabs = [
    { label: 'Home', cat: findCat('/') },
    { label: 'Trending', cat: findCat('/mostwatch/7d') },
    { label: 'Movie', cat: findCat('/type/movies') },
    { label: 'TV Show', cat: findCat('/type/series') },
    { label: 'Anime', cat: findCat('/anime') },
    { label: 'Trending Bengali', cat: findCat('/language/bangla') },
    { label: 'Bollywood', cat: findCat('/bollywood') },
    { label: 'South Indian', cat: findCat('/southIndian') },
    { label: 'Hollywood', cat: findCat('/language/english') },
    { label: 'Anime in Hindi', cat: findCat('/category/anime-hindi') },
    { label: 'Asian Drama', cat: findCat('/drama') },
    { label: '🔥Hot Short TV', cat: findCat('/category/short-tv') },
    { label: 'Western TV', cat: findCat('/category/western-tv') },
    { label: 'Midnight 18+', cat: findCat('/adult18plus') },
  ];

  const isSportsCategoryView = false;

  const [liveSportMatches, setLiveSportMatches] = useState<LiveSportMatch[]>([]);
  const [loadingSportMatches, setLoadingSportMatches] = useState(false);
  const [selectedSportLeagueId, setSelectedSportLeagueId] = useState<string>('');
  const [selectedLiveMatchModal, setSelectedLiveMatchModal] = useState<LiveSportMatch | null>(null);
  const [activeMatchStreamUrl, setActiveMatchStreamUrl] = useState<string>('');
  const [votedTeamsMap, setVotedTeamsMap] = useState<Record<string, 'team1' | 'team2'>>({});

  useEffect(() => {
    setSelectedSportLeagueId('');
  }, [currentCategory.path]);

  const fetchLiveSportMatches = useCallback(
    async (silent = false) => {
      if (!isSportsCategoryView) return;
      if (!silent) setLoadingSportMatches(true);
      try {
        const sportParam =
          currentCategory.path === '/category/cricket'
            ? 'cricket'
            : currentCategory.path === '/category/football'
              ? 'football'
              : 'all';
        const res = await fetch(
          `/api/sports/matches?sport=${encodeURIComponent(sportParam)}&leagueId=${encodeURIComponent(selectedSportLeagueId)}`
        );
        const data = await res.json();
        if (data?.ok && Array.isArray(data.matches)) {
          setLiveSportMatches(data.matches);
        }
      } catch {
        // ignore transient error
      } finally {
        if (!silent) setLoadingSportMatches(false);
      }
    },
    [isSportsCategoryView, currentCategory.path, selectedSportLeagueId]
  );

  useEffect(() => {
    if (!isSportsCategoryView) return;
    fetchLiveSportMatches(false);
    const interval = window.setInterval(() => {
      fetchLiveSportMatches(true);
    }, 25_000);
    return () => window.clearInterval(interval);
  }, [isSportsCategoryView, fetchLiveSportMatches]);

  return (
    <div className="min-h-screen w-full bg-[#050505] text-[#e5e5e5] flex flex-col pb-24">
      {/* App Entry Splash Screen with Crimson Red CinePulse Logo */}
      {showSplashScreen && (
        <div
          onClick={() => setShowSplashScreen(false)}
          className="fixed inset-0 z-[9999] bg-[#050505] flex flex-col items-center justify-between py-14 px-6 select-none animate-fade-in"
        >
          <div className="h-8" />

          {/* Center Crimson Red CinePulse Logo */}
          <div className="flex flex-col items-center justify-center gap-4">
            <div className="w-32 h-32 sm:w-36 sm:h-36 rounded-[32px] bg-gradient-to-tr from-[#7f1d1d] via-[#dc2626] to-[#ef4444] p-1 shadow-[0_18px_45px_rgba(220,38,38,0.35)] flex items-center justify-center">
              <div className="w-full h-full bg-[#050505] rounded-[28px] flex items-center justify-center">
                <Play className="w-16 h-16 text-[#ef4444] fill-current ml-1.5 drop-shadow-[0_0_16px_rgba(220,38,38,0.55)]" />
              </div>
            </div>
          </div>

          {/* Bottom Brand Name & Tagline */}
          <div className="text-center space-y-1 pb-4">
            <div className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white font-display">
              CINE<span className="text-[#dc2626]">PULSE</span>
            </div>
            <p className="text-xs sm:text-sm font-medium text-gray-400 tracking-wide">
              Box of Movies and TV shows
            </p>
          </div>
        </div>
      )}

      {/* Offline Banner */}
      {!isOnline && (
        <div className="bg-[#dc2626] text-white px-4 py-2 text-xs font-semibold flex items-center justify-center gap-2 z-50">
          <WifiOff className="w-4 h-4 shrink-0" />
          <span>Offline Mode — ক্যাশ করা মুভি তালিকা এবং আপনার ওয়াচলিস্ট দেখানো হচ্ছে</span>
        </div>
      )}

      {/* TOP SEARCH BAR & MAIN CONTENT CONTAINER */}
      <div className="relative w-full max-w-7xl mx-auto">
        {/* Sticky Top Search Bar + Clean Pill Category Strip (Hidden on full-screen Me tab) */}
        {activeTab !== 'me' && (
          <header className="sticky top-0 z-30 bg-[#0d0f12]/95 backdrop-blur-xl border-b border-white/[0.08] px-3 sm:px-8 pt-2.5 pb-0 shadow-lg">
            {Boolean(searchQuery.trim() || submittedSearch.trim() || showSearchDropdown) ? (
              /* MOVIEBOX-STYLE SEARCH HEADER + CATEGORY TABS (Exact Match to Screenshot) */
              <div className="space-y-2">
                <div className="flex items-center gap-2.5 w-full">
                  {/* Left Back Chevron (<) */}
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery('');
                      setSubmittedSearch('');
                      setSuggestions([]);
                      setShowSearchDropdown(false);
                      setSearchTabFilter('ALL');
                    }}
                    aria-label="Back"
                    className="w-8 h-10 flex items-center justify-center text-gray-200 hover:text-white shrink-0 cursor-pointer"
                  >
                    <ChevronLeft className="w-6 h-6 stroke-[2.2]" />
                  </button>

                  {/* Rounded Dark-Gray Search Box */}
                  <form
                    onSubmit={handleSearchSubmit}
                    className="flex-1 min-w-0 flex items-center h-11 rounded-xl bg-[#22252b] border border-white/10 focus-within:border-white/25 px-3.5 gap-2.5 transition-colors"
                  >
                    <Search className="w-5 h-5 text-gray-300 shrink-0" />
                    <input
                      ref={searchInputRef}
                      type="text"
                      value={searchQuery}
                      onFocus={() => setShowSearchDropdown(true)}
                      onChange={(e) => {
                        setSearchQuery(e.target.value);
                        setShowSearchDropdown(true);
                        setActiveTab('browse');
                      }}
                      style={{
                        color: '#ffffff',
                        WebkitTextFillColor: '#ffffff',
                        opacity: 1,
                      }}
                      placeholder="Tower of God [Hindi] বা মুভি খুঁজুন..."
                      className="flex-1 w-full min-w-0 bg-transparent text-sm sm:text-[15px] font-normal text-white placeholder:text-gray-400 focus:outline-none truncate"
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={() => {
                          setSearchQuery('');
                          setSubmittedSearch('');
                          setSuggestions([]);
                          searchInputRef.current?.focus();
                        }}
                        aria-label="Clear search"
                        className="w-5 h-5 rounded-full bg-gray-400/90 hover:bg-gray-300 text-[#121418] flex items-center justify-center shrink-0 cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5 stroke-[2.8]" />
                      </button>
                    )}
                  </form>

                  {/* Right Voice / Mic Button */}
                  <button
                    type="button"
                    onClick={() => {
                      const SpeechRec =
                        (window as any).SpeechRecognition ||
                        (window as any).webkitSpeechRecognition;
                      if (SpeechRec) {
                        try {
                          const rec = new SpeechRec();
                          rec.lang = 'en-US';
                          rec.onresult = (ev: any) => {
                            const transcript = ev?.results?.[0]?.[0]?.transcript;
                            if (transcript) {
                              setSearchQuery(transcript);
                              setSubmittedSearch(transcript);
                              setActiveTab('browse');
                            }
                          };
                          rec.start();
                          return;
                        } catch {
                          // fallback to focus
                        }
                      }
                      searchInputRef.current?.focus();
                    }}
                    aria-label="Voice Search"
                    className="w-9 h-10 flex items-center justify-center text-gray-200 hover:text-white shrink-0 cursor-pointer"
                  >
                    <Mic className="w-5 h-5 stroke-[2]" />
                  </button>
                </div>

                {/* MovieBox Search Filter Tabs: All | Movie/Series | ShortTV | Music */}
                <div className="flex items-center gap-6 overflow-x-auto no-scrollbar pt-1 px-1">
                  {(
                    [
                      { id: 'ALL', label: 'All' },
                      { id: 'MOVIE_SERIES', label: 'Movie/Series' },
                      { id: 'SHORT_TV', label: 'ShortTV' },
                      { id: 'MUSIC', label: 'Music' },
                    ] as const
                  ).map((tab) => {
                    const isActive = searchTabFilter === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setSearchTabFilter(tab.id)}
                        className={`relative pb-2.5 text-sm sm:text-[15px] whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                          isActive
                            ? 'text-white font-bold'
                            : 'text-gray-400 hover:text-gray-200 font-medium'
                        }`}
                      >
                        <span>{tab.label}</span>
                        {isActive && (
                          <span className="absolute left-1/2 -translate-x-1/2 bottom-0 h-[3px] w-6 bg-white rounded-full" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              /* DEFAULT HOME HEADER (Brand + Search Pill + Category Strip) */
              <div className="space-y-2.5 pb-2.5">
                <div className="flex items-center gap-2 sm:gap-3 w-full">
                  <button
                    type="button"
                    onClick={() => handleSelectCategory(ALL_CATEGORIES[0])}
                    aria-label="Home"
                    className="h-10 px-2.5 sm:px-3 rounded-xl bg-[#121212] border border-white/10 hover:border-[#dc2626]/60 shrink-0 flex items-center gap-2 transition-colors"
                  >
                    <div className="w-6 h-6 rounded-lg bg-[#dc2626] flex items-center justify-center text-white shadow-[0_0_12px_rgba(220,38,38,0.5)]">
                      <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
                    </div>
                    <span className="hidden md:inline text-sm font-black tracking-wider text-white font-display">
                      CINE<span className="text-[#dc2626]">PULSE</span>
                    </span>
                  </button>

                  <div ref={searchContainerRef} className="relative flex-1 min-w-0">
                    <form
                      onSubmit={handleSearchSubmit}
                      className="flex items-center w-full h-10 rounded-full bg-[#121212] border border-white/15 focus-within:border-[#dc2626] pl-3 pr-1 overflow-hidden transition-colors"
                    >
                      <Search className="w-4 h-4 text-[#ef4444] shrink-0" />
                      <input
                        type="text"
                        value={searchQuery}
                        onFocus={() => {
                          setShowSearchDropdown(true);
                          setActiveTab('browse');
                        }}
                        onChange={(e) => {
                          setSearchQuery(e.target.value);
                          setShowSearchDropdown(true);
                          setActiveTab('browse');
                        }}
                        style={{
                          color: '#ffffff',
                          WebkitTextFillColor: '#ffffff',
                          opacity: 1,
                        }}
                        placeholder="মুভি বা সিরিজ খুঁজুন..."
                        className="flex-1 w-full min-w-0 bg-transparent px-2 text-xs sm:text-sm font-semibold text-white placeholder:text-gray-400 placeholder:font-normal caret-[#ef4444] focus:outline-none truncate"
                      />
                      <button
                        type="submit"
                        aria-label="Search"
                        className="h-8 w-9 rounded-full bg-[#dc2626] hover:bg-[#b91c1c] text-white flex items-center justify-center shrink-0 shadow-[0_0_12px_rgba(220,38,38,0.4)] transition-colors"
                      >
                        <Search className="w-4 h-4 stroke-[2.5]" />
                      </button>
                    </form>
                  </div>
                </div>

                {/* Row 2: MovieBox Style Category Strip (Football | Trending | MangoTV | Anime | Cricket | Movie | TV Show...) */}
                <div className="flex items-center gap-4 sm:gap-5 overflow-x-auto no-scrollbar pt-1 px-1">
                  {topNavTabs.map((t) => {
                    const isActive =
                      activeTab === 'browse' &&
                      currentCategory.path === t.cat.path &&
                      !submittedSearch;
                    return (
                      <button
                        key={t.cat.path + t.label}
                        type="button"
                        onClick={() => handleSelectCategory(t.cat)}
                        className={`relative py-1 text-sm sm:text-[15px] whitespace-nowrap shrink-0 flex items-center gap-1.5 transition-all cursor-pointer ${
                          isActive
                            ? 'text-white font-extrabold scale-[1.03]'
                            : 'text-gray-400 hover:text-gray-200 font-semibold'
                        }`}
                      >
                        {(t as any).isMango && (
                          <span className="w-4 h-4 rounded-md bg-gradient-to-tr from-orange-600 to-amber-500 text-white text-[10px] font-black flex items-center justify-center shadow-sm">
                            M
                          </span>
                        )}
                        <span>{t.label}</span>
                        {isActive && (
                          <span className="absolute left-1/2 -translate-x-1/2 -bottom-0.5 h-[3px] w-5 rounded-full bg-[#00e68a]" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </header>
        )}

        {/* MAIN VIEW 1: HOME & BROWSE */}
        {activeTab === 'browse' && (
          <main className="space-y-6 px-3 sm:px-8 pt-3">
            {Boolean(searchQuery.trim() || submittedSearch.trim() || showSearchDropdown) ? (
              /* MOVIEBOX-STYLE VERTICAL SEARCH RESULTS SCREEN (Exact Match to Screenshot) */
              <section className="space-y-3 pb-10">
                {/* Recent Searches Chips when input is empty */}
                {!searchQuery.trim() && !submittedSearch.trim() && recentSearches.length > 0 && (
                  <div className="space-y-2 pt-1 pb-2 border-b border-white/[0.07]">
                    <div className="flex items-center justify-between text-xs text-gray-400">
                      <span className="font-semibold text-gray-300">Recent Searches</span>
                      <button
                        type="button"
                        onClick={() => setRecentSearches([])}
                        className="text-[11px] text-gray-400 hover:text-white cursor-pointer"
                      >
                        Clear
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {recentSearches.map((term) => (
                        <button
                          key={term}
                          type="button"
                          onClick={() => {
                            setSearchQuery(term);
                            setSubmittedSearch(term);
                          }}
                          className="px-3 py-1.5 rounded-lg bg-[#1c1f26] hover:bg-[#262a34] text-xs font-medium text-gray-200 transition-colors cursor-pointer"
                        >
                          {term}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {(loadingSuggestions || loadingCatalog) && (
                  <div className="flex items-center gap-2 py-2 text-xs text-gray-400">
                    <Loader2 className="w-4 h-4 animate-spin text-white" />
                    <span>Searching MovieBox HD...</span>
                  </div>
                )}

                {(() => {
                  const activeQ = (searchQuery.trim() || submittedSearch.trim()).toLowerCase();
                  const rawPool = activeQ
                    ? deduplicateMovieCards([
                        ...normalizeMovieCardList(suggestions, liveClockNow),
                        ...displayedItems.filter((i) =>
                          i.title.toLowerCase().includes(activeQ)
                        ),
                        ...displayedItems,
                      ])
                    : deduplicateMovieCards([
                        ...displayedItems.slice(0, 24),
                        ...normalizeMovieCardList(TOP_10_THIS_WEEK_ITEMS, liveClockNow),
                      ]);

                  const filteredRows = rawPool.filter((item) => {
                    if (searchTabFilter === 'ALL') return true;
                    const t = `${item.title} ${item.typeBadge}`.toLowerCase();
                    if (searchTabFilter === 'SHORT_TV') {
                      return /short|drama|ep|s0\d|series/i.test(t);
                    }
                    if (searchTabFilter === 'SPORTS') {
                      return /wwe|sport|cricket|football|match|ufc|fight/i.test(t);
                    }
                    if (searchTabFilter === 'MUSIC') {
                      return /music|song|concert|audio|musical/i.test(t);
                    }
                    return true;
                  });

                  if (filteredRows.length === 0 && !loadingSuggestions && !loadingCatalog) {
                    return (
                      <div className="py-14 text-center space-y-3">
                        <Film className="w-10 h-10 text-gray-500 mx-auto" />
                        <p className="text-sm text-gray-300 font-medium">
                          No results found for "{searchQuery || submittedSearch}"
                        </p>
                      </div>
                    );
                  }

                  return (
                    <div className="divide-y divide-white/[0.04]">
                      {filteredRows.slice(0, 40).map((item, idx) => {
                        const hasBrokenImg = brokenImages[item.id] || !item.poster;
                        const langShort = formatShortLanguage(item.language);
                        const yearMatch = item.title.match(/\b(20\d{2}|19\d{2})\b/);
                        const yearStr = yearMatch ? yearMatch[1] : '2026';
                        const isSeriesItem =
                          item.typeBadge === 'SERIES' ||
                          item.typeBadge === 'ANIME' ||
                          item.typeBadge === 'DRAMA' ||
                          Boolean(item.episodePill) ||
                          /\bS0?\d|\bSeason|\bEp/i.test(item.title);

                        const cleanBaseTitle = item.title
                          .replace(/\s*\(\d{4}\)/g, '')
                          .replace(
                            /\s*(?:1080p|720p|480p|4K|WEB-DL|WEBRip|Full HD|HDTC|BluRay|Dual Audio|Multi Audio).*$/i,
                            ''
                          )
                          .trim();
                        const seasonMatch = item.title.match(
                          /\b(S\d+(?:-S?\d+)?|Season\s*\d+)\b/i
                        );
                        const seasonSuffix = seasonMatch ? ` ${seasonMatch[1].toUpperCase()}` : '';
                        const hasBracketLang = /\[[^\]]+\]/.test(cleanBaseTitle);
                        const bracketLang =
                          !hasBracketLang && langShort && langShort !== 'English'
                            ? ` [${langShort}]`
                            : '';
                        const baseWithoutSeason = cleanBaseTitle
                          .replace(/\b(S\d+(?:-S?\d+)?|Season\s*\d+)\b/gi, '')
                          .trim();
                        const rowTitle = `${baseWithoutSeason || item.title}${bracketLang}${seasonSuffix}`;

                        const isAnime =
                          item.typeBadge === 'ANIME' ||
                          /anime|tower of god|one piece|naruto|solo|bleach|demon|dragon|high school|garden of words|black torch|overgeared|tomb raider/i.test(
                            item.title
                          );
                        const genreLabel = isAnime
                          ? 'Anime'
                          : /action|war|pushpa|jailer|toofan|marco|king|raider/i.test(item.title)
                          ? 'Action'
                          : /thriller|crime|mirzapur|squid/i.test(item.title)
                          ? 'Thriller'
                          : /romance|love|heart/i.test(item.title)
                          ? 'Romance'
                          : isSeriesItem
                          ? 'Drama'
                          : 'Movie';

                        const viewsLabel =
                          item.views && item.views !== 'Live' ? item.views : '1.3M';
                        const middleMeta =
                          idx % 4 === 2
                            ? `Same Actor • ${viewsLabel}`
                            : idx % 4 === 3
                            ? `Also Watched • ${viewsLabel}`
                            : isAnime
                            ? 'Japan'
                            : langShort === 'Bangla'
                            ? 'Bangladesh'
                            : langShort === 'Korean'
                            ? 'Korea'
                            : 'India';

                        const ratingVal = item.rating
                          ? Number(item.rating).toFixed(1)
                          : (7.1 + ((idx * 3) % 18) / 10).toFixed(1);

                        return (
                          <div
                            key={`${item.path}-${item.id}-${idx}`}
                            onMouseEnter={() =>
                              prefetchMovieDetails(item.path, item.title, activeNodeId, true)
                            }
                            onTouchStart={() =>
                              prefetchMovieDetails(item.path, item.title, activeNodeId, true)
                            }
                            onClick={() => {
                              if (searchQuery.trim()) {
                                saveRecentSearch(searchQuery.trim());
                              }
                              setSelectedMovie(item);
                            }}
                            className="group py-2.5 flex items-center gap-3.5 cursor-pointer hover:bg-white/[0.03] rounded-xl px-1 transition-colors"
                          >
                            {/* Left Vertical Poster with Bottom Language Strip */}
                            <div className="relative w-[62px] h-[84px] sm:w-[68px] sm:h-[92px] rounded-lg overflow-hidden bg-[#161920] shrink-0">
                              {!hasBrokenImg ? (
                                <img
                                  src={item.poster}
                                  alt={item.title}
                                  referrerPolicy="no-referrer"
                                  loading="lazy"
                                  onError={() =>
                                    setBrokenImages((prev) => ({ ...prev, [item.id]: true }))
                                  }
                                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                                />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center">
                                  <Film className="w-6 h-6 text-gray-500" />
                                </div>
                              )}

                              {langShort && (
                                <div className="absolute inset-x-0 bottom-0 bg-black/65 py-0.5 text-center text-[11px] font-medium text-gray-100 leading-tight truncate px-1">
                                  {langShort}
                                </div>
                              )}
                            </div>

                            {/* Middle Column: Title + TV/Film | ★ Rating | Year | Region/Context | Genre */}
                            <div className="flex-1 min-w-0 pr-1">
                              <h3 className="text-[15px] sm:text-base font-medium text-white truncate mb-1.5 group-hover:text-gray-100">
                                {rowTitle}
                              </h3>
                              <div className="flex items-center gap-1.5 text-xs sm:text-[13px] text-gray-400 truncate">
                                {isSeriesItem ? (
                                  <Tv className="w-3.5 h-3.5 text-gray-300 shrink-0" />
                                ) : (
                                  <Film className="w-3.5 h-3.5 text-gray-300 shrink-0" />
                                )}
                                <span className="text-gray-600">|</span>
                                <span className="inline-flex items-center gap-1 text-amber-400 font-medium shrink-0">
                                  <Star className="w-3.5 h-3.5 fill-current" />
                                  <span>{ratingVal}</span>
                                </span>
                                <span className="text-gray-600">|</span>
                                <span className="shrink-0">{yearStr}</span>
                                <span className="text-gray-600">|</span>
                                <span className="truncate">{middleMeta}</span>
                                <span className="text-gray-600">|</span>
                                <span className="truncate">{genreLabel}</span>
                              </div>
                            </div>

                            {/* Right Circular Light Play Button */}
                            <div className="w-8 h-8 rounded-full bg-[#d1d5db] group-hover:bg-white text-[#0f1115] flex items-center justify-center shrink-0 transition-transform active:scale-95">
                              <Play className="w-4 h-4 fill-current ml-0.5" />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </section>
            ) : (
              <>
            {/* Clean Cinema Hero Cover + MovieBox-Style Bottom Compact Cards (Page 1 & Not Searching & Not Sports Tab) */}
            {!submittedSearch && !isSportsCategoryView && currentPage === 1 && spotlightItem && (
              <section className="select-none">
                <div
                  onClick={() => setSelectedMovie(spotlightItem)}
                  onTouchStart={(e) => {
                    if (e.touches.length === 1) {
                      heroTouchStartXRef.current = e.touches[0].clientX;
                    }
                  }}
                  onTouchEnd={(e) => {
                    if (heroTouchStartXRef.current !== null && e.changedTouches.length === 1) {
                      const deltaX = e.changedTouches[0].clientX - heroTouchStartXRef.current;
                      heroTouchStartXRef.current = null;
                      if (Math.abs(deltaX) > 45 && heroSlides.length > 1) {
                        if (deltaX < 0) {
                          setHeroSlideIdx((prev) => (prev + 1) % heroSlides.length);
                        } else {
                          setHeroSlideIdx(
                            (prev) => (prev - 1 + heroSlides.length) % heroSlides.length
                          );
                        }
                      }
                    }
                  }}
                  className="relative aspect-[16/10] sm:aspect-[21/9] w-full rounded-2xl sm:rounded-3xl bg-[#0a0a0a] border border-white/10 cursor-pointer overflow-hidden shadow-2xl group"
                >
                  {spotlightItem.poster && !brokenImages[spotlightItem.id] ? (
                    <img
                      key={spotlightItem.id}
                      src={spotlightItem.poster}
                      alt={spotlightItem.title}
                      referrerPolicy="no-referrer"
                      onError={() =>
                        setBrokenImages((prev) => ({ ...prev, [spotlightItem.id]: true }))
                      }
                      className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[#1a0b0b] to-[#050505]">
                      <Film className="w-14 h-14 text-gray-600" />
                    </div>
                  )}

                  {/* Smooth bottom fade into the compact card strip */}
                  <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-[#050505] via-[#050505]/55 to-transparent pointer-events-none" />
                </div>

                {/* MovieBox-Style Compact Floating Cards Strip Under Cover */}
                <div className="relative z-20 -mt-9 sm:-mt-11 px-2 flex items-end gap-2.5 overflow-x-auto no-scrollbar pt-4 pb-1">
                  {heroMiniCards.map((card, idx) => {
                    const yearMatch = card.title.match(/\b(20\d{2}|19\d{2})\b/);
                    const yearStr = yearMatch ? yearMatch[1] : '2026';
                    const isSeriesCard =
                      card.typeBadge === 'SERIES' ||
                      card.typeBadge === 'DRAMA' ||
                      Boolean(card.episodePill) ||
                      /\bS0?\d|\bSeason|\bEp/i.test(card.title);
                    const genreLabel =
                      card.typeBadge === 'ANIME'
                        ? 'Anime'
                        : isSeriesCard
                        ? 'Series'
                        : /action|fight|war|king|pushpa|jailer|toofan|marco/i.test(card.title)
                        ? 'Action'
                        : /drama|love|akka|bachelor/i.test(card.title)
                        ? 'Drama'
                        : 'Thriller';
                    const cleanShortTitle = card.title
                      .replace(/\s*\(\d{4}\).*$/i, '')
                      .replace(/\s*S\d+.*$/i, '')
                      .replace(/\s*(?:1080p|720p|480p|4K|WEB-DL|WEBRip|Full HD|HDTC).*$/i, '')
                      .trim();
                    const langShort = formatShortLanguage(card.language);
                    const displayTitle =
                      cleanShortTitle.length <= 16 && langShort !== 'English'
                        ? `${cleanShortTitle} [${langShort}]`
                        : cleanShortTitle || card.title;

                    return (
                      <div
                        key={card.path + card.id + idx}
                        onMouseEnter={() => prefetchMovieDetails(card.path, card.title, activeNodeId)}
                        onTouchStart={() => prefetchMovieDetails(card.path, card.title, activeNodeId)}
                        onClick={() => setSelectedMovie(card)}
                        className="w-[232px] sm:w-[258px] shrink-0 rounded-2xl bg-[#181a20]/95 backdrop-blur-md border border-white/[0.08] px-3 py-2.5 flex items-center gap-3 cursor-pointer shadow-[0_8px_24px_rgba(0,0,0,0.6)] active:scale-[0.98] transition-all"
                      >
                        {/* Protruding Mini Poster Thumbnail */}
                        <div className="relative -mt-6 w-12 h-16 sm:w-13 sm:h-17 rounded-lg overflow-hidden bg-[#0a0a0a] shrink-0 shadow-lg border border-white/15">
                          {card.poster ? (
                            <img
                              src={card.poster}
                              alt={card.title}
                              referrerPolicy="no-referrer"
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <Film className="w-4 h-4 text-gray-500" />
                            </div>
                          )}
                        </div>

                        {/* Clean Title + Icon | Year | Genre */}
                        <div className="min-w-0 flex-1">
                          <h2 className="text-xs sm:text-sm font-bold text-white truncate">
                            {displayTitle}
                          </h2>
                          <div className="text-[11px] text-gray-400 truncate mt-0.5 flex items-center gap-1.5 font-medium">
                            {isSeriesCard ? (
                              <Tv className="w-3 h-3 text-gray-400 shrink-0" />
                            ) : (
                              <Film className="w-3 h-3 text-gray-400 shrink-0" />
                            )}
                            <span>|</span>
                            <span>{yearStr}</span>
                            <span>|</span>
                            <span className="truncate">{genreLabel}</span>
                          </div>
                        </div>

                        {/* Circular Gradient Play Button */}
                        <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-[#00e68a] to-[#12d6df] text-[#050505] flex items-center justify-center shrink-0 shadow-[0_0_12px_rgba(0,230,138,0.35)]">
                          <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* MOVIEBOX OFFICIAL HOME PAGE SHELVES (100% Movies & Series — No Sports Clutter on Home!) */}
            {!submittedSearch && currentPage === 1 && currentCategory.path === '/' && (
              <div className="space-y-6">
                {/* 1. MovieBox Official "Categories" Visual Strip */}
                {mbHomeData?.quickCategories && mbHomeData.quickCategories.length > 0 && (
                  <section className="space-y-2.5">
                    <div className="flex items-center justify-between px-0.5">
                      <div className="flex items-center gap-2">
                        <Layers className="w-4 h-4 text-[#00e68a]" />
                        <h2 className="text-sm sm:text-base font-extrabold text-white tracking-tight">
                          Categories <span className="text-xs font-normal text-gray-400">· ক্যাটাগরি সমূহ</span>
                        </h2>
                      </div>
                      <button
                        type="button"
                        onClick={() => setActiveTab('categories')}
                        className="text-xs font-bold text-[#00e68a] hover:text-emerald-300 flex items-center gap-0.5 cursor-pointer"
                      >
                        <span>All Categories</span>
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="flex items-center gap-2.5 overflow-x-auto no-scrollbar pb-1">
                      {mbHomeData.quickCategories
                        .filter((qc) => qc.id !== 'qc-sports')
                        .map((qc) => (
                          <button
                            key={qc.id}
                            type="button"
                            onClick={() => handleSelectCategory(findCat(qc.path))}
                            className="group relative w-[124px] sm:w-[144px] h-[58px] sm:h-[64px] shrink-0 rounded-xl overflow-hidden bg-[#14171d] border border-white/10 hover:border-[#00e68a]/50 flex items-center justify-between px-3 text-left transition-all active:scale-95 cursor-pointer"
                          >
                            <img
                              src={qc.image}
                              alt={qc.title}
                              referrerPolicy="no-referrer"
                              loading="lazy"
                              className="absolute inset-0 w-full h-full object-cover opacity-35 group-hover:scale-105 group-hover:opacity-50 transition-all duration-300"
                            />
                            <div className="absolute inset-0 bg-gradient-to-r from-[#0c0e12]/95 via-[#0c0e12]/70 to-transparent" />
                            <div className="relative z-10 min-w-0">
                              <div className="text-xs sm:text-sm font-extrabold text-white truncate">
                                {qc.title}
                              </div>
                              <div className="text-[10px] text-gray-300 truncate mt-0.5">
                                {qc.bnTitle}
                              </div>
                            </div>
                          </button>
                        ))}
                    </div>
                  </section>
                )}

                  {/* 3. MovieBox Official "Coming Soon" (APPOINTMENT_LIST) Shelf */}
                  {currentCategory.path === '/' && mbHomeData?.comingSoon && mbHomeData.comingSoon.length > 0 && (
                    <section className="space-y-2.5">
                      <div className="flex items-center justify-between px-0.5">
                        <div className="flex items-center gap-2">
                          <Calendar className="w-4 h-4 text-amber-400" />
                          <h2 className="text-sm sm:text-base font-extrabold text-white tracking-tight">
                            Coming Soon <span className="text-xs font-normal text-gray-400">· আপকামিং রিলিজ</span>
                          </h2>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleSelectCategory(findCat('/upcoming'))}
                          className="text-xs font-bold text-[#00e68a] hover:text-emerald-300 flex items-center gap-0.5 cursor-pointer"
                        >
                          <span>More</span>
                          <ChevronRight className="w-4 h-4" />
                        </button>
                      </div>

                      <div className="flex items-stretch gap-3 overflow-x-auto no-scrollbar pb-1">
                        {mbHomeData.comingSoon.map((item) => {
                          const isBooked = Boolean(bookedComingSoonIds[item.id]);
                          const displayBooked = item.bookedCount + (isBooked ? 1 : 0);
                          return (
                            <div
                              key={item.id}
                              className="w-[126px] sm:w-[142px] shrink-0 flex flex-col justify-between rounded-xl bg-[#111318] border border-white/[0.08] overflow-hidden group"
                            >
                              <div>
                                {/* Release Date Pill Header */}
                                <div className="px-2.5 py-1.5 bg-[#181b22] border-b border-white/[0.06] flex items-center justify-between">
                                  <span className="text-[11px] font-extrabold text-[#00e68a]">
                                    {item.releaseBadge}
                                  </span>
                                  <span className="text-[10px] text-gray-400 font-medium">
                                    {displayBooked} booked
                                  </span>
                                </div>

                                {/* Poster */}
                                <div
                                  onClick={() => {
                                    setSearchQuery(item.title);
                                    setSubmittedSearch(item.title);
                                  }}
                                  className="relative aspect-[2/3] w-full bg-[#0a0c10] overflow-hidden cursor-pointer"
                                >
                                  <img
                                    src={item.poster}
                                    alt={item.title}
                                    referrerPolicy="no-referrer"
                                    loading="lazy"
                                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                                  />
                                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/45 to-transparent p-2">
                                    <div className="text-[10px] font-semibold text-gray-300 truncate">
                                      {item.country || item.genre}
                                    </div>
                                  </div>
                                </div>

                                <div className="p-2 pb-1">
                                  <h3 className="text-xs font-bold text-white truncate">
                                    {item.title}
                                  </h3>
                                </div>
                              </div>

                              <div className="px-2 pb-2 pt-1">
                                <button
                                  type="button"
                                  onClick={() => toggleBookComingSoon(item.id)}
                                  className={`w-full h-7 rounded-lg text-[11px] font-extrabold flex items-center justify-center gap-1 transition-all cursor-pointer ${
                                    isBooked
                                      ? 'bg-[#00e68a]/20 text-[#00e68a] border border-[#00e68a]/40'
                                      : 'bg-white/[0.08] hover:bg-white/[0.14] text-white border border-white/10'
                                  }`}
                                >
                                  <Bell className="w-3 h-3" />
                                  <span>{isBooked ? 'Booked ✓' : 'Remind Me'}</span>
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  )}

                  {/* 4. All Official MovieBox Horizontal Shelves (Trending Drama, Trending Bengali, Bollywood, South Indian, Hollywood, Hot Short TV, Anime in Hindi, etc.) */}
                  {currentCategory.path === '/' &&
                    mbHomeData?.sections &&
                    mbHomeData.sections.map((shelf) => (
                      <section key={shelf.id} className="space-y-2.5">
                        <div className="flex items-center justify-between px-0.5">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="w-1 h-4 rounded-full bg-[#00e68a] shrink-0" />
                            <h2 className="text-sm sm:text-base font-extrabold text-white tracking-tight truncate">
                              {shelf.title}
                            </h2>
                            <span className="hidden sm:inline text-xs text-gray-400 truncate">
                              · {shelf.bnTitle}
                            </span>
                            {shelf.badge && (
                              <span className="px-1.5 py-0.5 rounded bg-[#00e68a]/15 border border-[#00e68a]/30 text-[10px] font-extrabold text-[#00e68a] shrink-0">
                                {shelf.badge}
                              </span>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => handleSelectCategory(findCat(shelf.categoryPath))}
                            className="text-xs font-bold text-gray-300 hover:text-[#00e68a] flex items-center gap-0.5 shrink-0 cursor-pointer"
                          >
                            <span>More</span>
                            <ChevronRight className="w-4 h-4" />
                          </button>
                        </div>

                        <div className="flex items-stretch gap-2.5 sm:gap-3 overflow-x-auto no-scrollbar pb-1">
                          {shelf.items.map((item, idx) => {
                            const hasBrokenImg = brokenImages[item.id] || !item.poster;
                            const langShort = formatShortLanguage(item.language);
                            return (
                              <div
                                key={`${shelf.id}-${item.id}-${idx}`}
                                onMouseEnter={() =>
                                  prefetchMovieDetails(item.path, item.title, activeNodeId)
                                }
                                onTouchStart={() =>
                                  prefetchMovieDetails(item.path, item.title, activeNodeId)
                                }
                                onClick={() => setSelectedMovie(item)}
                                className="group w-[116px] sm:w-[138px] shrink-0 cursor-pointer flex flex-col"
                              >
                                <div className="relative aspect-[2/3] w-full rounded-xl overflow-hidden bg-[#14171f] border border-white/[0.08] group-hover:border-[#00e68a]/50 transition-all">
                                  {!hasBrokenImg ? (
                                    <img
                                      src={item.poster}
                                      alt={item.title}
                                      referrerPolicy="no-referrer"
                                      loading="lazy"
                                      onError={() =>
                                        setBrokenImages((prev) => ({ ...prev, [item.id]: true }))
                                      }
                                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                                    />
                                  ) : (
                                    <div className="w-full h-full flex items-center justify-center">
                                      <Film className="w-7 h-7 text-gray-600" />
                                    </div>
                                  )}

                                  {/* Top-Left MovieBox Language Corner Tag */}
                                  {langShort && (
                                    <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/75 backdrop-blur-sm text-[10px] font-bold text-white border border-white/10">
                                      {langShort}
                                    </span>
                                  )}

                                  {/* Top-Right Rating Pill */}
                                  {item.rating && (
                                    <span className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/75 backdrop-blur-sm text-[10px] font-extrabold text-amber-400 flex items-center gap-0.5">
                                      <Star className="w-2.5 h-2.5 fill-current" />
                                      {item.rating}
                                    </span>
                                  )}

                                  {/* Bottom Episode / Quality Strip */}
                                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent p-1.5 flex items-center justify-between text-[10px] font-bold text-gray-200">
                                    <span className="truncate">
                                      {item.episodePill || item.typeBadge}
                                    </span>
                                    <span className="text-[#00e68a] shrink-0">HD</span>
                                  </div>
                                </div>

                                <h3 className="text-xs font-bold text-gray-100 group-hover:text-[#00e68a] truncate mt-1.5">
                                  {item.title}
                                </h3>
                                <p className="text-[10px] text-gray-400 truncate">
                                  {item.language} • {item.timeAgo}
                                </p>
                              </div>
                            );
                          })}
                        </div>
                      </section>
                    ))}
                </div>
              )}

            {/* PRIMARY SECTION: MOVIEBOX SPORTS VIEW (Football / Cricket / Sports) OR MOVIES & SERIES CATALOG GRID */}
            <section className="space-y-4">
              {isSportsCategoryView ? (
                <div className="space-y-5">
                  {/* 1. MovieBox Official "Sports" Quick League & Live Match Strip */}
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between px-0.5">
                      <h2 className="text-[15px] sm:text-base font-extrabold text-white tracking-tight">
                        Sports
                      </h2>
                      <button
                        type="button"
                        onClick={() => fetchLiveSportMatches(false)}
                        className="text-xs text-[#00e68a] hover:underline flex items-center gap-1 font-semibold cursor-pointer"
                      >
                        <RefreshCw
                          className={`w-3.5 h-3.5 ${loadingSportMatches ? 'animate-spin' : ''}`}
                        />
                        <span>Refresh Live Score</span>
                      </button>
                    </div>
                    <div className="flex items-stretch gap-2.5 overflow-x-auto no-scrollbar pb-1">
                      {(currentCategory.path === '/category/cricket'
                        ? [
                            {
                              id: 'cr-all-matches',
                              label: 'All Matches',
                              badgeText: 'All',
                              badgeBg:
                                'from-emerald-500/30 to-teal-500/20 border-emerald-400/60 text-emerald-300',
                              isCalendar: true,
                              leagueId: '',
                              sportType: 'cricket' as const,
                              liveUrl: 'https://sportsnow.top/live?tab=live&sportType=cricket',
                            },
                            {
                              id: 'cr-all-table',
                              label: 'All Table',
                              badgeText: 'Table',
                              badgeBg:
                                'from-blue-500/30 to-sky-500/20 border-blue-400/60 text-blue-300',
                              isTable: true,
                              leagueId: 'TABLE',
                              sportType: 'cricket' as const,
                              liveUrl: 'https://sportsnow.top/live?tab=live&sportType=cricket',
                            },
                            {
                              id: 'cr-ipl',
                              label: 'IPL T20',
                              badgeText: 'IPL',
                              badgeBg:
                                'from-indigo-600/40 to-amber-500/30 border-amber-400/60 text-amber-300',
                              leagueId: '3790705008904141152',
                              sportType: 'cricket' as const,
                              liveUrl: 'https://sportsnow.top/live?tab=live&sportType=cricket',
                            },
                            {
                              id: 'cr-icc',
                              label: 'ICC Live',
                              badgeText: 'ICC',
                              badgeBg:
                                'from-sky-600/40 to-cyan-500/30 border-cyan-400/60 text-cyan-200',
                              leagueId: '',
                              sportType: 'cricket' as const,
                              liveUrl: 'https://sportsnow.top/live?tab=live&sportType=cricket',
                            },
                            {
                              id: 'cr-bpl',
                              label: 'BPL T20',
                              badgeText: 'BPL',
                              badgeBg:
                                'from-emerald-600/40 to-red-500/30 border-emerald-400/60 text-emerald-200',
                              leagueId: '',
                              sportType: 'cricket' as const,
                              liveUrl: 'https://sportsnow.top/live?tab=live&sportType=cricket',
                            },
                            {
                              id: 'cr-asiacup',
                              label: 'Asia Cup',
                              badgeText: 'ASIA',
                              badgeBg:
                                'from-amber-600/40 to-orange-500/30 border-amber-400/60 text-amber-200',
                              leagueId: '',
                              sportType: 'cricket' as const,
                              liveUrl: 'https://sportsnow.top/live?tab=live&sportType=cricket',
                            },
                          ]
                        : [
                            {
                              id: 'fb-all-matches',
                              label: 'All Matches',
                              badgeText: 'All',
                              badgeBg:
                                'from-emerald-500/30 to-teal-500/20 border-emerald-400/60 text-emerald-300',
                              isCalendar: true,
                              leagueId: '',
                              sportType: 'football' as const,
                              liveUrl: 'https://sportsnow.top/live?tab=live&sportType=football',
                            },
                            {
                              id: 'fb-all-table',
                              label: 'All Table',
                              badgeText: 'Table',
                              badgeBg:
                                'from-blue-500/30 to-sky-500/20 border-blue-400/60 text-blue-300',
                              isTable: true,
                              leagueId: 'TABLE',
                              sportType: 'football' as const,
                              liveUrl: 'https://sportsnow.top/live?tab=live&sportType=football',
                            },
                            {
                              id: 'fb-ucl',
                              label: 'Champions',
                              badgeText: 'UCL',
                              badgeBg:
                                'from-blue-900/60 to-indigo-700/40 border-blue-400/50 text-blue-200',
                              leagueId: '1391412307422509408',
                              sportType: 'football' as const,
                              liveUrl: 'https://sportsnow.top/live?tab=live&sportType=football',
                            },
                            {
                              id: 'fb-epl',
                              label: 'Premier',
                              badgeText: 'EPL',
                              badgeBg:
                                'from-purple-900/60 to-fuchsia-700/40 border-purple-400/60 text-white',
                              leagueId: '4663840386660596064',
                              sportType: 'football' as const,
                              liveUrl: 'https://sportsnow.top/live?tab=live&sportType=football',
                            },
                            {
                              id: 'fb-laliga',
                              label: 'LaLiga',
                              badgeText: 'LL',
                              badgeBg:
                                'from-red-600/40 to-orange-600/30 border-red-400/60 text-red-400',
                              leagueId: '8879209637879380320',
                              sportType: 'football' as const,
                              liveUrl: 'https://sportsnow.top/live?tab=live&sportType=football',
                            },
                            {
                              id: 'fb-ligue1',
                              label: 'Ligue 1',
                              badgeText: 'L1',
                              badgeBg:
                                'from-slate-700/60 to-slate-600/40 border-slate-400/50 text-gray-200',
                              leagueId: '2249910986390010208',
                              sportType: 'football' as const,
                              liveUrl: 'https://sportsnow.top/live?tab=live&sportType=football',
                            },
                            {
                              id: 'fb-seriea',
                              label: 'Serie A',
                              badgeText: 'SA',
                              badgeBg:
                                'from-sky-700/50 to-blue-600/40 border-sky-400/50 text-sky-200',
                              leagueId: '4807955574736451936',
                              sportType: 'football' as const,
                              liveUrl: 'https://sportsnow.top/live?tab=live&sportType=football',
                            },
                          ]
                      ).map((lg) => {
                        const isSelectedLeague =
                          !lg.isTable && selectedSportLeagueId === lg.leagueId;
                        return (
                          <button
                            key={lg.id}
                            type="button"
                            onClick={() => {
                              if (lg.isTable) {
                                setActiveLiveSportModal({
                                  id: lg.id,
                                  title: `${lg.label} Standings & Live`,
                                  bnTitle:
                                    lg.sportType === 'cricket'
                                      ? 'ক্রিকেট পয়েন্ট টেবিল ও লাইভ স্কোরবোর্ড'
                                      : 'ফুটবল পয়েন্ট টেবিল ও স্ট্যান্ডিংস',
                                  subtitle: 'MovieBox Official Live Sports Portal',
                                  sportType: lg.sportType,
                                  liveUrl: lg.liveUrl,
                                  categoryPath: currentCategory.path,
                                  badge: 'LIVE',
                                  accentColor: '#00e68a',
                                });
                              } else {
                                setSelectedSportLeagueId(lg.leagueId);
                              }
                            }}
                            className={`w-[78px] sm:w-[88px] shrink-0 rounded-xl bg-[#11141a] hover:bg-[#191d26] border overflow-hidden flex flex-col items-center justify-between pt-2.5 transition-all active:scale-95 cursor-pointer ${
                              isSelectedLeague
                                ? 'border-[#00e68a] ring-1 ring-[#00e68a]/40'
                                : 'border-white/[0.06]'
                            }`}
                          >
                            <div
                              className={`w-11 h-11 rounded-full bg-gradient-to-b ${lg.badgeBg} border-2 flex flex-col items-center justify-center shadow-inner mb-2`}
                            >
                              {lg.isCalendar ? (
                                <div className="flex flex-col items-center leading-none">
                                  <Calendar className="w-3.5 h-3.5 mb-0.5" />
                                  <span className="text-[9px] font-black">All</span>
                                </div>
                              ) : lg.isTable ? (
                                <Layers className="w-5 h-5" />
                              ) : (
                                <span className="text-xs font-black tracking-tight">
                                  {lg.badgeText}
                                </span>
                              )}
                            </div>
                            <div
                              className={`w-full py-1.5 px-1.5 text-center ${
                                isSelectedLeague ? 'bg-[#00e68a]/20' : 'bg-[#1b1f27]'
                              }`}
                            >
                              <span
                                className={`block text-[11px] font-semibold truncate ${
                                  isSelectedLeague ? 'text-[#00e68a]' : 'text-gray-200'
                                }`}
                              >
                                {lg.label}
                              </span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 1B. Real-Time Live & Upcoming Match Scorecards (Team 1 vs Team 2 + Live Watch) */}
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between px-0.5">
                      <div className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-[#00e68a] animate-pulse" />
                        <h2 className="text-[15px] sm:text-base font-extrabold text-white tracking-tight">
                          Live & Match Schedule · কার সাথে কার খেলা
                        </h2>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setActiveLiveSportModal({
                            id: 'full-sport-portal',
                            title:
                              currentCategory.path === '/category/cricket'
                                ? 'Cricket Live Center'
                                : 'Football Live Center',
                            bnTitle: 'সকল লাইভ ম্যাচ ও ফুল স্কোরবোর্ড',
                            subtitle: 'MovieBox Official Live Sports Stream',
                            sportType:
                              currentCategory.path === '/category/cricket'
                                ? 'cricket'
                                : 'football',
                            liveUrl:
                              currentCategory.path === '/category/cricket'
                                ? 'https://sportsnow.top/live?tab=live&sportType=cricket'
                                : 'https://sportsnow.top/live?tab=live&sportType=football',
                            categoryPath: currentCategory.path,
                            badge: 'LIVE',
                            accentColor: '#00e68a',
                          })
                        }
                        className="text-xs text-[#00e68a] font-bold flex items-center gap-0.5 hover:underline cursor-pointer"
                      >
                        <span>Full Scoreboard</span>
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>

                    {loadingSportMatches && liveSportMatches.length === 0 ? (
                      <div className="flex items-center justify-center gap-2 py-5 rounded-2xl bg-[#12151c] border border-white/[0.06] text-xs text-gray-300">
                        <Loader2 className="w-4 h-4 animate-spin text-[#00e68a]" />
                        <span>লাইভ ও আপকামিং ম্যাচের তালিকা লোড হচ্ছে...</span>
                      </div>
                    ) : liveSportMatches.length > 0 ? (
                      <div className="flex items-stretch gap-3 overflow-x-auto no-scrollbar pb-1">
                        {liveSportMatches.map((match) => {
                          const totalVotes =
                            (match.team1.voteCount || 0) + (match.team2.voteCount || 0) || 1;
                          const t1VotePct = Math.round(
                            ((match.team1.voteCount || 0) / totalVotes) * 100
                          );
                          const t2VotePct = 100 - t1VotePct;
                          const userVote = votedTeamsMap[match.id];
                          const matchDateStr = new Date(match.startTimeMs).toLocaleString('en-BD', {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          });

                          return (
                            <div
                              key={match.id}
                              onClick={() => {
                                setSelectedLiveMatchModal(match);
                                const firstStream =
                                  match.playSource?.[0]?.path ||
                                  match.playPath ||
                                  match.detailUrl;
                                setActiveMatchStreamUrl(firstStream);
                              }}
                              className="w-[295px] sm:w-[330px] shrink-0 rounded-2xl bg-[#141821] hover:bg-[#191e29] border border-white/[0.08] hover:border-[#00e68a]/50 p-3.5 flex flex-col justify-between gap-3 cursor-pointer transition-all shadow-lg group"
                            >
                              {/* Top League + Live Status Row */}
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[11px] font-bold text-gray-300 truncate">
                                  {match.league || match.matchRound}
                                </span>
                                {match.isLive ? (
                                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-red-600/25 border border-red-500/50 text-[10px] font-black text-red-400 shrink-0">
                                    <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-ping" />
                                    LIVE NOW
                                  </span>
                                ) : match.status === 'MatchNotStart' ? (
                                  <span className="px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-400/30 text-[10px] font-bold text-amber-300 shrink-0">
                                    {matchDateStr}
                                  </span>
                                ) : (
                                  <span className="px-2 py-0.5 rounded-full bg-white/10 text-[10px] font-bold text-gray-300 shrink-0">
                                    {match.timeDesc || 'FINISHED'}
                                  </span>
                                )}
                              </div>

                              {/* Center Team 1 vs Team 2 Scoreboard */}
                              <div className="space-y-2 py-1">
                                {/* Team 1 */}
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex items-center gap-2.5 min-w-0">
                                    {match.team1.avatar ? (
                                      <img
                                        src={match.team1.avatar}
                                        alt={match.team1.name}
                                        referrerPolicy="no-referrer"
                                        className="w-7 h-7 rounded-full object-cover bg-black/40 border border-white/10 shrink-0"
                                      />
                                    ) : (
                                      <div className="w-7 h-7 rounded-full bg-emerald-500/20 text-emerald-300 text-[10px] font-black flex items-center justify-center shrink-0">
                                        {match.team1.abbreviation}
                                      </div>
                                    )}
                                    <span className="text-sm font-bold text-white truncate">
                                      {match.team1.name}
                                    </span>
                                  </div>
                                  <span className="text-sm font-black text-[#00e68a] font-mono tabular-nums shrink-0">
                                    {match.team1.score}
                                  </span>
                                </div>

                                {/* Team 2 */}
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex items-center gap-2.5 min-w-0">
                                    {match.team2.avatar ? (
                                      <img
                                        src={match.team2.avatar}
                                        alt={match.team2.name}
                                        referrerPolicy="no-referrer"
                                        className="w-7 h-7 rounded-full object-cover bg-black/40 border border-white/10 shrink-0"
                                      />
                                    ) : (
                                      <div className="w-7 h-7 rounded-full bg-sky-500/20 text-sky-300 text-[10px] font-black flex items-center justify-center shrink-0">
                                        {match.team2.abbreviation}
                                      </div>
                                    )}
                                    <span className="text-sm font-bold text-white truncate">
                                      {match.team2.name}
                                    </span>
                                  </div>
                                  <span className="text-sm font-black text-white font-mono tabular-nums shrink-0">
                                    {match.team2.score}
                                  </span>
                                </div>

                                {match.matchResult && (
                                  <p className="text-[11px] text-amber-300/90 font-medium truncate pt-0.5">
                                    {match.matchResult}
                                  </p>
                                )}
                              </div>

                              {/* Bottom Fan Vote Bar + Watch Live Button */}
                              <div className="pt-2 border-t border-white/[0.06] flex items-center justify-between gap-2">
                                <div
                                  className="flex-1 min-w-0 space-y-1"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <div className="flex items-center justify-between text-[10px] text-gray-400">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setVotedTeamsMap((prev) => ({
                                          ...prev,
                                          [match.id]: 'team1',
                                        }))
                                      }
                                      className={`hover:text-white cursor-pointer ${
                                        userVote === 'team1' ? 'text-[#00e68a] font-bold' : ''
                                      }`}
                                    >
                                      👍 {match.team1.abbreviation} ({t1VotePct}%)
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setVotedTeamsMap((prev) => ({
                                          ...prev,
                                          [match.id]: 'team2',
                                        }))
                                      }
                                      className={`hover:text-white cursor-pointer ${
                                        userVote === 'team2' ? 'text-sky-400 font-bold' : ''
                                      }`}
                                    >
                                      {match.team2.abbreviation} ({t2VotePct}%) 👍
                                    </button>
                                  </div>
                                  <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden flex">
                                    <div
                                      style={{ width: `${t1VotePct}%` }}
                                      className="h-full bg-[#00e68a]"
                                    />
                                    <div
                                      style={{ width: `${t2VotePct}%` }}
                                      className="h-full bg-sky-500"
                                    />
                                  </div>
                                </div>

                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedLiveMatchModal(match);
                                    const firstStream =
                                      match.playSource?.[0]?.path ||
                                      match.playPath ||
                                      match.detailUrl;
                                    setActiveMatchStreamUrl(firstStream);
                                  }}
                                  className="h-8 px-3 rounded-lg bg-gradient-to-r from-[#0ea5e9] via-[#10b981] to-[#22c55e] hover:brightness-110 text-white text-xs font-extrabold flex items-center gap-1 shrink-0 shadow-[0_4px_12px_rgba(16,185,129,0.35)] cursor-pointer"
                                >
                                  <Play className="w-3.5 h-3.5 fill-current" />
                                  <span>{match.isLive ? 'Watch Live' : 'Match Live'}</span>
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>

                  {/* 2. MovieBox Official "You May Also Like" 2-Column Split Video Cards */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between px-0.5">
                      <h2 className="text-base sm:text-lg font-extrabold text-white tracking-tight">
                        You May Also Like
                      </h2>
                      <span className="text-xs text-gray-400 font-mono tabular-nums">
                        Page {currentPage}/{maxPage}
                      </span>
                    </div>

                    {loadingCatalog && (
                      <div className="flex items-center justify-center gap-2 py-4 rounded-2xl bg-[#12151c] text-xs text-gray-300">
                        <Loader2 className="w-4 h-4 animate-spin text-[#00e68a]" />
                        <span>Loading {currentCategory.label} videos...</span>
                      </div>
                    )}

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                      {displayedItems.map((item) => {
                        const hasBrokenImg = brokenImages[item.id] || !item.poster;
                        const yearMatch = item.title.match(/\b(20\d{2}|19\d{2})\b/);
                        const yearStr = yearMatch ? yearMatch[1] : '2026';
                        const cleanTitle = item.title.replace(/\s*\(\d{4}\)\s*$/, '').trim();
                        const isCricket =
                          currentCategory.path === '/category/cricket' ||
                          /cricket|ipl|odi|t20|bpl|icc/i.test(
                            `${item.title} ${item.sportGenre || ''}`
                          );
                        const sportLabel =
                          item.sportGenre ||
                          (isCricket
                            ? 'Cricket'
                            : currentCategory.path === '/category/wwe'
                            ? 'Wrestling'
                            : 'Football');
                        const countryLabel =
                          item.country || (isCricket ? 'India' : 'United States');
                        const previewSrc = item.previewImage || item.poster;

                        return (
                          <article
                            key={item.path + item.id}
                            onMouseEnter={() =>
                              prefetchMovieDetails(item.path, item.title, activeNodeId, true)
                            }
                            onTouchStart={() =>
                              prefetchMovieDetails(item.path, item.title, activeNodeId, true)
                            }
                            onClick={() => setSelectedMovie(item)}
                            className="rounded-2xl bg-[#15181f] hover:bg-[#1a1e27] border border-white/[0.06] p-3 space-y-3 cursor-pointer transition-all shadow-lg group"
                          >
                            {/* Top 2-Column Split Media Row (Left Vertical Poster + Right 16:10 Video Preview with Play Circle) */}
                            <div className="flex items-stretch gap-2.5">
                              {/* Left Poster */}
                              <div className="w-[30%] aspect-[3/4] rounded-xl overflow-hidden bg-[#0c0e13] shrink-0">
                                {!hasBrokenImg ? (
                                  <img
                                    src={item.poster}
                                    alt={cleanTitle}
                                    referrerPolicy="no-referrer"
                                    loading="lazy"
                                    onError={() =>
                                      setBrokenImages((prev) => ({ ...prev, [item.id]: true }))
                                    }
                                    className="w-full h-full object-cover object-center group-hover:scale-105 transition-transform duration-300"
                                  />
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center">
                                    <Trophy className="w-6 h-6 text-gray-600" />
                                  </div>
                                )}
                              </div>

                              {/* Right Wide Video Preview + Centered Play Overlay */}
                              <div className="flex-1 aspect-[16/10] rounded-xl overflow-hidden bg-[#0c0e13] relative">
                                {!hasBrokenImg && previewSrc ? (
                                  <img
                                    src={previewSrc}
                                    alt={cleanTitle}
                                    referrerPolicy="no-referrer"
                                    loading="lazy"
                                    className="w-full h-full object-cover object-center group-hover:scale-105 transition-transform duration-300"
                                  />
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center">
                                    <Film className="w-8 h-8 text-gray-600" />
                                  </div>
                                )}
                                <div className="absolute inset-0 bg-black/20 flex items-center justify-center">
                                  <div className="w-11 h-11 rounded-full bg-black/55 backdrop-blur-xs border border-white/20 flex items-center justify-center text-white group-hover:scale-110 transition-transform shadow-lg">
                                    <Play className="w-5 h-5 fill-current ml-0.5" />
                                  </div>
                                </div>
                              </div>
                            </div>

                            {/* Bottom Info & Green Play Button Row */}
                            <div className="flex items-center justify-between gap-3 pt-0.5">
                              <div className="min-w-0 flex-1">
                                <h3 className="text-[15px] sm:text-base font-bold text-white truncate">
                                  {cleanTitle}
                                </h3>
                                <div className="flex items-center gap-1.5 text-xs text-gray-400 mt-1 truncate">
                                  <span className="text-[11px] opacity-80">
                                    {isCricket ? '🏏' : '⚽'}
                                  </span>
                                  <span className="truncate">
                                    {yearStr} • {countryLabel} • {sportLabel}
                                  </span>
                                </div>
                              </div>

                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedMovie(item);
                                }}
                                className="h-9 px-4 rounded-lg bg-gradient-to-r from-[#0ea5e9] via-[#10b981] to-[#22c55e] hover:brightness-110 text-white text-sm font-bold flex items-center justify-center gap-1.5 shrink-0 shadow-[0_4px_14px_rgba(16,185,129,0.35)] active:scale-95 transition-all cursor-pointer"
                              >
                                <Play className="w-4 h-4 fill-current" />
                                <span>Play</span>
                              </button>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  {/* Section Header + Filter Toolbar */}
                  <div className="rounded-2xl bg-[#0a0a0a] border border-white/[0.08] p-3 sm:p-4 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <Flame className="w-5 h-5 text-[#ef4444] shrink-0" />
                        <h2 className="text-base sm:text-xl font-extrabold text-white tracking-tight truncate">
                          {submittedSearch
                            ? `সার্চ ফলাফল: "${submittedSearch}"`
                            : `${currentCategory.label} · ${currentCategory.bnLabel}`}
                        </h2>
                      </div>
                      <span className="text-xs text-gray-400 font-mono tabular-nums shrink-0">
                        Page {currentPage}/{maxPage}
                      </span>
                    </div>

                    {/* Clean Audio Filter Segmented Controls + Quality/Sort Selectors */}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
                        {[
                          { label: 'All Audio', id: 'ALL' },
                          { label: 'Bengali', id: 'BANGLA' },
                          { label: 'Hindi', id: 'HINDI' },
                          { label: 'Dual Audio', id: 'DUAL' },
                          { label: 'Anime / Sub', id: 'SUB' },
                        ].map((f) => (
                          <button
                            key={f.id}
                            type="button"
                            onClick={() => setAudioFilter(f.id as any)}
                            className={`px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap shrink-0 transition-colors ${
                              audioFilter === f.id
                                ? 'bg-[#dc2626] text-white shadow-[0_0_10px_rgba(220,38,38,0.35)]'
                                : 'bg-[#141414] text-gray-300 hover:text-white border border-white/5'
                            }`}
                          >
                            {f.label}
                          </button>
                        ))}
                      </div>

                      {/* Compact Quality & Sort Dropdowns */}
                      <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1 bg-[#141414] border border-white/10 rounded-xl px-2.5 py-1.5">
                          <SlidersHorizontal className="w-3 h-3 text-[#ef4444]" />
                          <select
                            value={qualityFilter}
                            onChange={(e) => setQualityFilter(e.target.value as any)}
                            aria-label="Filter quality"
                            className="bg-transparent text-xs font-semibold text-gray-200 focus:outline-none"
                          >
                            <option value="ALL" className="bg-[#121212]">All Quality</option>
                            <option value="4K" className="bg-[#121212]">4K UHD</option>
                            <option value="1080P" className="bg-[#121212]">1080p FHD</option>
                            <option value="WEBDL" className="bg-[#121212]">WEB-DL</option>
                            <option value="HDTC" className="bg-[#121212]">HDTC</option>
                          </select>
                        </div>

                        <div className="flex items-center gap-1 bg-[#141414] border border-white/10 rounded-xl px-2.5 py-1.5">
                          <select
                            value={sortBy}
                            onChange={(e) => setSortBy(e.target.value as any)}
                            aria-label="Sort order"
                            className="bg-transparent text-xs font-semibold text-gray-200 focus:outline-none"
                          >
                            <option value="HOT_HYPE" className="bg-[#121212]">Hot & New</option>
                            <option value="LATEST" className="bg-[#121212]">Latest Upload</option>
                            <option value="RATING" className="bg-[#121212]">Top Rated</option>
                            <option value="VIEWS" className="bg-[#121212]">Most Popular</option>
                            <option value="TITLE" className="bg-[#121212]">A–Z</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  </div>

                  {loadingCatalog && (
                    <div className="flex items-center justify-center gap-2 py-3 rounded-2xl bg-[#101010] text-xs text-gray-300">
                      <Loader2 className="w-4 h-4 animate-spin text-[#ef4444]" />
                      <span>লোড হচ্ছে (Page {currentPage})...</span>
                    </div>
                  )}

                  {/* 3-Column Mobile / 5-Column Desktop Ultra-Clean Poster Grid */}
                  {displayedItems.length === 0 ? (
                    <div className="rounded-3xl bg-[#0a0a0a] border border-white/[0.08] p-10 text-center space-y-3">
                      <Film className="w-10 h-10 text-gray-500 mx-auto" />
                      <h3 className="text-base font-bold text-white">কোনো মুভি বা সিরিজ পাওয়া যায়নি</h3>
                      <button
                        type="button"
                        onClick={() => {
                          setSourceFilter('ALL');
                          setAudioFilter('ALL');
                          setQualityFilter('ALL');
                          setYearFilter('ALL');
                          setSubmittedSearch('');
                          setSearchQuery('');
                        }}
                        className="px-5 py-2 rounded-full bg-[#dc2626] text-white text-xs font-extrabold"
                      >
                        Reset Filters
                      </button>
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2.5 sm:gap-4">
                      {displayedItems.map((item) => {
                        const isSaved = isMovieInWatchlist(item);
                        const hasBrokenImg = brokenImages[item.id] || !item.poster;
                        const isJustUploaded = isUploadedWithinMinutes(item.timeAgo);
                        const srcInfo = getCardSourceInfo(item.path);

                        return (
                          <article
                            key={item.path + item.title}
                            onMouseEnter={() => prefetchMovieDetails(item.path, item.title, activeNodeId, true)}
                            onTouchStart={() => prefetchMovieDetails(item.path, item.title, activeNodeId, true)}
                            onClick={() => setSelectedMovie(item)}
                            className="group rounded-2xl overflow-hidden bg-[#0a0a0a] border border-white/[0.08] hover:border-[#dc2626]/65 transition-all flex flex-col cursor-pointer shadow-sm"
                          >
                            <div className="relative aspect-[2/3] w-full bg-[#050505] overflow-hidden">
                              {!hasBrokenImg ? (
                                <img
                                  src={item.poster}
                                  alt={item.title}
                                  referrerPolicy="no-referrer"
                                  loading="lazy"
                                  onError={() =>
                                    setBrokenImages((prev) => ({ ...prev, [item.id]: true }))
                                  }
                                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                                />
                              ) : (
                                <div className="w-full h-full flex flex-col items-center justify-center p-3 text-center">
                                  <Film className="w-7 h-7 text-[#ef4444] mb-1.5 opacity-80" />
                                  <span className="text-[11px] font-bold text-gray-300 line-clamp-3">
                                    {item.title}
                                  </span>
                                </div>
                              )}

                              {/* Top-Right Language Tag */}
                              <div className="absolute top-1.5 right-1.5 flex flex-col items-end gap-1">
                                <span className="px-1.5 py-0.5 rounded-md bg-black/75 backdrop-blur-xs text-[9px] sm:text-[10px] font-bold text-white border border-white/10">
                                  {formatShortLanguage(item.language)}
                                </span>
                              </div>

                              {/* Top-Left Bookmark / HOT */}
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleToggleWatchlist(item);
                                }}
                                aria-label="Save to list"
                                className={`absolute top-1.5 left-1.5 w-6 h-6 rounded-lg backdrop-blur-xs flex items-center justify-center transition-colors ${
                                  isSaved
                                    ? 'bg-[#dc2626] text-white'
                                    : 'bg-black/60 text-white/85 hover:text-white'
                                }`}
                              >
                                <Bookmark className={`w-3 h-3 ${isSaved ? 'fill-current' : ''}`} />
                              </button>

                              {/* Bottom Scrim: Episode/Quality + Star Rating */}
                              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/60 to-transparent px-2 pt-5 pb-1.5 flex items-center justify-between gap-1 text-[10px]">
                                <span className="font-bold text-[#ef4444] truncate">
                                  {item.episodePill || item.quality}
                                </span>
                                <span className="text-amber-400 font-bold flex items-center gap-0.5 shrink-0">
                                  <Star className="w-2.5 h-2.5 fill-current" />
                                  <span>{item.rating || '9.0'}</span>
                                </span>
                              </div>
                            </div>

                            <div className="p-2 sm:p-2.5 flex-1 flex flex-col justify-between space-y-1">
                              <h3 className="text-xs sm:text-sm font-bold text-gray-100 truncate group-hover:text-[#ef4444] transition-colors">
                                {item.title}
                              </h3>
                              <div className="flex items-center justify-between text-[10px] text-gray-400">
                                <span
                                  className={`font-medium truncate ${
                                    isJustUploaded ? 'text-[#ef4444]' : 'text-amber-300/90'
                                  }`}
                                >
                                  {item.timeAgo}
                                </span>
                                <span className="font-mono tabular-nums text-gray-400 shrink-0 hidden xs:inline">
                                  {item.views}
                                </span>
                              </div>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  )}
                </>
              )}

              {/* 🏆 TOP 10 THIS WEEK RAIL (Cleanly organized below main grid on Page 1) */}
              {!submittedSearch && currentPage === 1 && !isSportsCategoryView && (
                <div className="pt-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Trophy className="w-5 h-5 text-[#ef4444]" />
                      <h2 className="text-base sm:text-lg font-extrabold text-white tracking-tight">
                        TOP 10 THIS WEEK · সেরা ১০ হিট
                      </h2>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleSelectCategory(findCat('/mostwatch/7d'))}
                      className="text-xs text-[#ef4444] font-bold flex items-center gap-0.5"
                    >
                      <span>Most Watched</span>
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="flex items-stretch gap-3 overflow-x-auto no-scrollbar pb-1">
                    {top10ThisWeekItems.map((item, idx) => (
                      <div
                        key={item.path + idx}
                        onMouseEnter={() => prefetchMovieDetails(item.path, item.title, activeNodeId, true)}
                        onTouchStart={() => prefetchMovieDetails(item.path, item.title, activeNodeId, true)}
                        onClick={() => setSelectedMovie(item)}
                        className="w-[136px] sm:w-[162px] shrink-0 rounded-2xl overflow-hidden bg-[#0a0a0a] border border-white/[0.08] hover:border-[#dc2626]/60 cursor-pointer group flex flex-col transition-all"
                      >
                        <div className="relative aspect-[2/3] w-full bg-[#050505] overflow-hidden">
                          {item.poster && !brokenImages[item.id] ? (
                            <img
                              src={item.poster}
                              alt={item.title}
                              referrerPolicy="no-referrer"
                              loading="lazy"
                              onError={() =>
                                setBrokenImages((prev) => ({ ...prev, [item.id]: true }))
                              }
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <Film className="w-8 h-8 text-gray-600" />
                            </div>
                          )}

                          <span className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-[#dc2626] text-white text-[10px] font-black shadow">
                            #{idx + 1}
                          </span>

                          <span className="absolute top-2 right-2 px-1.5 py-0.5 rounded-md bg-black/75 text-[9px] font-semibold text-white">
                            {formatShortLanguage(item.language)}
                          </span>

                          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/45 to-transparent px-2 pt-4 pb-1.5 flex items-center justify-between text-[10px]">
                            <span className="font-semibold text-[#ef4444] truncate">
                              {item.episodePill || item.quality}
                            </span>
                            <span className="text-amber-400 font-bold flex items-center gap-0.5">
                              <Star className="w-2.5 h-2.5 fill-current" />
                              {item.rating || '9.3'}
                            </span>
                          </div>
                        </div>

                        <div className="p-2 space-y-0.5">
                          <h3 className="text-xs font-bold text-gray-100 truncate group-hover:text-[#ef4444]">
                            {item.title}
                          </h3>
                          <p className="text-[10px] text-amber-300/90 truncate">{item.timeAgo}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Static Collections & Upcoming sections removed for clean live feed */}

              {/* Bottom 520-Page Pagination Bar */}
              <div className="rounded-2xl bg-[#0a0a0a] border border-white/[0.08] p-4 flex flex-col sm:flex-row items-center justify-between gap-4">
                <div className="flex flex-wrap items-center justify-center gap-1.5">
                  <button
                    type="button"
                    disabled={currentPage <= 1}
                    onClick={() => handlePageChange(currentPage - 1)}
                    className="min-h-[40px] px-3.5 py-1.5 rounded-xl bg-[#141414] hover:bg-[#222222] disabled:opacity-40 text-xs font-bold text-white flex items-center gap-1"
                  >
                    <ChevronLeft className="w-4 h-4" />
                    <span>Prev</span>
                  </button>

                  {Array.from({ length: 5 }, (_, idx) => {
                    const start = Math.max(1, Math.min(currentPage - 2, maxPage - 4));
                    const pageNum = start + idx;
                    if (pageNum < 1 || pageNum > maxPage) return null;
                    return (
                      <button
                        key={pageNum}
                        type="button"
                        onClick={() => handlePageChange(pageNum)}
                        className={`min-h-[40px] min-w-[40px] px-3 py-1.5 rounded-xl text-xs font-bold font-mono tabular-nums transition-colors ${
                          currentPage === pageNum
                            ? 'bg-[#dc2626] text-white shadow-[0_0_12px_rgba(220,38,38,0.4)]'
                            : 'bg-[#141414] text-gray-300 hover:bg-[#222222]'
                        }`}
                      >
                        {pageNum}
                      </button>
                    );
                  })}

                  <button
                    type="button"
                    disabled={currentPage >= maxPage}
                    onClick={() => handlePageChange(currentPage + 1)}
                    className="min-h-[40px] px-3.5 py-1.5 rounded-xl bg-[#141414] hover:bg-[#222222] disabled:opacity-40 text-xs font-bold text-white flex items-center gap-1"
                  >
                    <span>Next</span>
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>

                <form onSubmit={handleJumpPage} className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={maxPage}
                    value={jumpPageInput}
                    onChange={(e) => setJumpPageInput(e.target.value)}
                    placeholder={`Page (1-${maxPage})`}
                    className="w-28 min-h-[40px] px-3 py-1.5 rounded-xl bg-[#141414] border border-white/10 text-xs text-white placeholder-gray-400 font-mono tabular-nums focus:outline-none focus:border-[#dc2626]"
                  />
                  <button
                    type="submit"
                    className="min-h-[40px] px-4 py-1.5 rounded-xl bg-[#dc2626] hover:bg-[#b91c1c] text-white text-xs font-extrabold whitespace-nowrap"
                  >
                    Go
                  </button>
                </form>
              </div>
            </section>
              </>
            )}
          </main>
        )}

        {/* VIEW 2: ALL 55+ CATEGORIES HUB ("Explore Hub") */}
        {activeTab === 'categories' && (
          <main className="px-3.5 sm:px-8 pt-2 space-y-6">
            <div className="rounded-3xl bg-[#0a0a0a] border border-white/[0.08] p-5 sm:p-6 space-y-6">
              <div className="flex items-center justify-between gap-4 border-b border-white/10 pb-4">
                <div>
                  <h1 className="text-lg sm:text-xl font-extrabold text-white">
                    Explore All 55+ Categories & Zones
                  </h1>
                  <p className="text-xs text-gray-400 mt-0.5">
                    যেকোনো ক্যাটাগরিতে ট্যাপ করে ৫২০+ পেজের সব মুভি ও সিরিজ দেখুন
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveTab('browse')}
                  className="px-4 py-2 rounded-full bg-[#dc2626] text-white text-xs font-extrabold"
                >
                  Back Home
                </button>
              </div>

              {(
                [
                  { group: 'zone', title: 'Featured Zones' },
                  { group: 'language', title: 'Languages & Audio Dubs' },
                  { group: 'genre', title: 'Movie & Anime Genres' },
                  { group: 'collection', title: 'Curated Franchises & Collections' },
                ] as const
              ).map((section) => {
                const groupItems = ALL_CATEGORIES.filter((c) => c.group === section.group);
                if (groupItems.length === 0) return null;
                return (
                  <div key={section.group} className="space-y-3">
                    <h2 className="text-sm font-extrabold text-[#ef4444]">{section.title}</h2>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2.5">
                      {groupItems.map((cat) => (
                        <button
                          key={cat.path}
                          type="button"
                          onClick={() => handleSelectCategory(cat)}
                          className={`min-h-[52px] px-3.5 py-2.5 rounded-2xl text-left transition-colors border flex flex-col justify-center ${
                            currentCategory.path === cat.path
                              ? 'bg-[#7f1d1d]/35 text-white border-[#dc2626]'
                              : 'bg-[#121212] text-gray-200 border-white/5 hover:border-[#dc2626]/50'
                          }`}
                        >
                          <span className="text-xs font-bold truncate">{cat.label}</span>
                          <span className="text-[11px] text-gray-400 truncate mt-0.5">
                            {cat.bnLabel}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </main>
        )}

        {/* VIEW 3: DOWNLOADS & WATCHLIST FOLDERS */}
        {activeTab === 'watchlist' && (
          <main className="px-3.5 sm:px-8 pt-2 space-y-6">
            {/* Saved Watchlist & Custom Folders */}
            <div className="rounded-3xl bg-[#0a0a0a] border border-white/[0.08] p-5 sm:p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-extrabold text-white">
                    My List & Saved Downloads ({watchlist.length})
                  </h2>
                  <p className="text-xs text-gray-400">
                    আপনার পছন্দের সেভ করা মুভি, অ্যানিমে ও ওয়াচ হিস্ট্রি
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleExportWatchlist}
                    className="px-3 py-1.5 rounded-full bg-[#141414] border border-white/10 text-xs font-semibold text-gray-200 flex items-center gap-1.5"
                  >
                    <Download className="w-3.5 h-3.5 text-[#ef4444]" />
                    <span>Backup</span>
                  </button>

                  <input
                    ref={backupInputRef}
                    type="file"
                    accept=".json"
                    onChange={handleImportWatchlist}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => backupInputRef.current?.click()}
                    className="px-3 py-1.5 rounded-full bg-[#141414] border border-white/10 text-xs font-semibold text-gray-200 flex items-center gap-1.5"
                  >
                    <Upload className="w-3.5 h-3.5 text-[#ef4444]" />
                    <span>Restore</span>
                  </button>
                </div>
              </div>

              {/* Folder Tabs */}
              <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1">
                {(
                  [
                    { id: 'all', label: `All (${watchlist.length})` },
                    {
                      id: 'favorites',
                      label: `Favorites (${watchlist.filter((m) => (m.folder || 'favorites') === 'favorites').length})`,
                    },
                    {
                      id: 'watch_later',
                      label: `Watch Later (${watchlist.filter((m) => m.folder === 'watch_later').length})`,
                    },
                    {
                      id: 'anime_series',
                      label: `Series & Anime (${watchlist.filter((m) => m.folder === 'anime_series').length})`,
                    },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setWatchlistFolderTab(tab.id)}
                    className={`px-4 py-1.5 rounded-full text-xs font-bold flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors ${
                      watchlistFolderTab === tab.id
                        ? 'bg-[#dc2626] text-white'
                        : 'bg-[#141414] text-gray-300'
                    }`}
                  >
                    <FolderHeart className="w-3.5 h-3.5" />
                    <span>{tab.label}</span>
                  </button>
                ))}
              </div>

              {filteredWatchlist.length === 0 ? (
                <div className="py-10 text-center space-y-3">
                  <Bookmark className="w-8 h-8 text-gray-500 mx-auto" />
                  <p className="text-sm text-gray-300 font-medium">No movies saved in this folder yet</p>
                  <button
                    type="button"
                    onClick={() => setActiveTab('browse')}
                    className="px-5 py-2 rounded-full bg-[#dc2626] text-white text-xs font-extrabold"
                  >
                    Discover Movies
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                  {filteredWatchlist.map((item) => {
                    const normItem = normalizeMovieCardItem(item);
                    return (
                      <div
                        key={item.path}
                        onClick={() => setSelectedMovie(normItem)}
                        className="group rounded-xl overflow-hidden bg-[#121212] border border-white/[0.08] cursor-pointer flex flex-col"
                      >
                        <div className="relative aspect-[2/3] w-full bg-[#050505] overflow-hidden">
                          <img
                            src={item.poster}
                            alt={item.title}
                            referrerPolicy="no-referrer"
                            loading="lazy"
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                          />
                          <span className="absolute top-1.5 right-1.5 px-2 py-0.5 rounded bg-black/75 text-[10px] font-semibold text-white">
                            {formatShortLanguage(item.language)}
                          </span>
                          <span className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/80 text-[10px] font-bold text-amber-300 flex items-center gap-1">
                            <Clock className="w-2.5 h-2.5" />
                            {normItem.timeAgo}
                          </span>
                        </div>
                        <div className="p-2">
                          <h3 className="text-xs font-bold text-white truncate">{item.title}</h3>
                          <p className="text-[10px] text-amber-300 mt-0.5">{normItem.timeAgo}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Watch History */}
            {continueWatching.length > 0 && (
              <div className="rounded-3xl bg-[#0a0a0a] border border-white/[0.08] p-5 sm:p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-extrabold text-white">
                    Recent Watch History ({continueWatching.length})
                  </h2>
                  <button
                    type="button"
                    onClick={() => setContinueWatching([])}
                    className="text-xs text-[#ef4444] flex items-center gap-1"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Clear</span>
                  </button>
                </div>
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                  {continueWatching.map((entry) => {
                    const normMovie = normalizeMovieCardItem(entry.movie);
                    return (
                      <div
                        key={entry.movie.path}
                        onClick={() => setSelectedMovie(normMovie)}
                        className="rounded-xl overflow-hidden bg-[#121212] border border-white/[0.08] cursor-pointer"
                      >
                        <div className="relative aspect-[2/3] w-full">
                          <img
                            src={entry.movie.poster}
                            alt={entry.movie.title}
                            referrerPolicy="no-referrer"
                            className="w-full h-full object-cover"
                          />
                          <div className="absolute bottom-0 inset-x-0 bg-black/80 px-2 py-1 text-[10px] text-[#ef4444] font-semibold truncate">
                            {entry.episodeLabel || 'Movie'} · {formatResumeTime(entry.progressSeconds)}
                          </div>
                        </div>
                        <div className="p-2">
                          <div className="text-xs font-semibold text-white truncate">
                            {entry.movie.title}
                          </div>
                          <div className="text-[10px] text-amber-300 mt-0.5">
                            {normMovie.timeAgo}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </main>
        )}

        {/* VIEW 4: FULL-SCREEN MOVIEBOX STYLE "ME" PAGE */}
        {activeTab === 'me' && (
          <main className="min-h-screen bg-[#0c0d11] text-white px-3.5 sm:px-6 pt-3 pb-10 max-w-2xl mx-auto space-y-3.5 select-none">
            {/* Top Bar with Scan Icon */}
            <div className="flex items-center justify-end py-1">
              <button
                type="button"
                onClick={() => setShowInstallModal(true)}
                aria-label="Scan or Share"
                className="p-1.5 text-gray-200 hover:text-white transition-colors"
              >
                <ScanLine className="w-6 h-6" />
              </button>
            </div>

            {/* Clean Essential Card Group: Watch History + My List + Last 24h Updates + App Install */}
            <div className="rounded-2xl bg-[#16181e] overflow-hidden shadow-lg">
              {/* Watch History Section */}
              <div className="pt-4 pb-3.5 space-y-3">
                <div
                  onClick={() => setActiveTab('watchlist')}
                  className="px-4 flex items-center justify-between cursor-pointer"
                >
                  <div className="flex items-center gap-2.5">
                    <History className="w-5 h-5 text-gray-300" />
                    <span className="text-[15px] font-bold text-white">Watch History</span>
                  </div>
                  <ChevronRight className="w-4 h-4 text-gray-400" />
                </div>

                {/* Horizontal Landscape Watch History Cards */}
                <div className="px-4 flex items-start gap-2.5 overflow-x-auto no-scrollbar">
                  {(continueWatching.length > 0
                    ? continueWatching.map((entry) => ({
                        movie: normalizeMovieCardItem(entry.movie),
                        pct:
                          entry.durationSeconds && entry.progressSeconds
                            ? Math.min(
                                98,
                                Math.max(
                                  14,
                                  Math.round((entry.progressSeconds / entry.durationSeconds) * 100)
                                )
                              )
                            : 42,
                      }))
                    : heroSlides.slice(0, 6).map((m, i) => ({
                        movie: m,
                        pct: [45, 22, 65, 30, 80, 50][i % 6],
                      }))
                  ).map(({ movie, pct }, idx) => {
                    const isSeries =
                      movie.typeBadge === 'SERIES' ||
                      movie.typeBadge === 'DRAMA' ||
                      movie.typeBadge === 'ANIME' ||
                      Boolean(movie.episodePill);
                    const cleanTitle = movie.title
                      .replace(/\s*\(\d{4}\).*$/i, '')
                      .replace(/\s*(?:1080p|720p|480p|4K|WEB-DL|WEBRip|Full HD|HDTC).*$/i, '')
                      .trim();

                    return (
                      <div
                        key={movie.path + idx}
                        onClick={() => setSelectedMovie(movie)}
                        className="w-[128px] sm:w-[144px] shrink-0 cursor-pointer group"
                      >
                        <div className="relative aspect-[16/10] w-full rounded-xl overflow-hidden bg-[#0e1015]">
                          {movie.poster ? (
                            <img
                              src={movie.poster}
                              alt={movie.title}
                              referrerPolicy="no-referrer"
                              loading="lazy"
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <Film className="w-5 h-5 text-gray-600" />
                            </div>
                          )}

                          <div className="absolute top-1.5 left-1.5 w-5 h-5 rounded-md bg-white/90 text-[#0c0d11] flex items-center justify-center shadow">
                            {isSeries ? (
                              <Tv className="w-3 h-3 stroke-[2.5]" />
                            ) : (
                              <Film className="w-3 h-3 stroke-[2.5]" />
                            )}
                          </div>

                          <div className="absolute bottom-0 inset-x-0 h-1 bg-black/50">
                            <div
                              className="h-full bg-gradient-to-r from-[#00e68a] to-[#12d6df]"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>

                        <div className="mt-1.5 text-xs text-gray-300 truncate group-hover:text-white">
                          {cleanTitle || movie.title}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Row: My List */}
              <button
                type="button"
                onClick={() => setActiveTab('watchlist')}
                className="w-full px-4 py-4 border-t border-white/[0.04] hover:bg-white/[0.03] flex items-center justify-between transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Bookmark className="w-5 h-5 text-gray-300" />
                  <span className="text-[15px] font-medium text-gray-100">My List</span>
                </div>
                <div className="flex items-center gap-1.5 text-sm text-gray-400">
                  <span>{watchlist.length}</span>
                  <ChevronRight className="w-4 h-4" />
                </div>
              </button>

              {/* Row: Last 24 Hours Updates */}
              <button
                type="button"
                onClick={() => setShowRequestModal(true)}
                className="w-full px-4 py-4 border-t border-white/[0.04] hover:bg-white/[0.03] flex items-center justify-between transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Bell className="w-5 h-5 text-gray-300" />
                  <span className="text-[15px] font-medium text-gray-100">
                    New Uploads · Last 24h
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded-full bg-[#e53935] text-white text-xs font-bold tabular-nums">
                    {last24hItems.length}
                  </span>
                  <ChevronRight className="w-4 h-4 text-gray-400" />
                </div>
              </button>

              {/* Row: Install App & Settings */}
              <button
                type="button"
                onClick={() => setShowInstallModal(true)}
                className="w-full px-4 py-4 border-t border-white/[0.04] hover:bg-white/[0.03] flex items-center justify-between transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Settings className="w-5 h-5 text-gray-300" />
                  <span className="text-[15px] font-medium text-gray-100">
                    Install App & TV Setup
                  </span>
                </div>
                <ChevronRight className="w-4 h-4 text-gray-400" />
              </button>
            </div>
          </main>
        )}
      </div>

      {/* FIXED BOTTOM NAVIGATION BAR WITH ELEVATED CENTER SHORTS/18+ BUTTON */}
      <nav
        aria-label="Bottom Navigation"
        className="fixed bottom-0 left-0 right-0 z-40 bg-[#0a0a0a]/95 backdrop-blur-lg border-t border-white/[0.08] pb-safe"
      >
        <div className="max-w-xl mx-auto grid grid-cols-5 items-center h-16 px-2">
          {/* 1. Home */}
          <button
            type="button"
            onClick={() => handleSelectCategory(ALL_CATEGORIES[0])}
            className={`flex flex-col items-center justify-center transition-colors ${
              activeTab === 'browse' && currentCategory.path !== '/adult18plus'
                ? 'text-[#ef4444]'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            <Home className="w-5 h-5" />
            <span className="text-[11px] font-medium mt-1">Home</span>
          </button>

          {/* 2. Categories Hub (With Red HOT Badge) */}
          <button
            type="button"
            onClick={() => setActiveTab('categories')}
            className={`relative flex flex-col items-center justify-center transition-colors ${
              activeTab === 'categories' ? 'text-[#ef4444]' : 'text-gray-400 hover:text-white'
            }`}
          >
            <div className="relative">
              <BookOpen className="w-5 h-5" />
              <span className="absolute -top-1.5 -right-5 px-1 py-0.2 rounded bg-[#dc2626] text-[8px] font-extrabold text-white leading-tight">
                HOT
              </span>
            </div>
            <span className="text-[11px] font-medium mt-1">Explore</span>
          </button>

          {/* 3. Center Elevated Circular Poster Button ("18+ Hub") */}
          <div className="flex flex-col items-center justify-center">
            <button
              type="button"
              onClick={() => handleSelectCategory(findCat('/adult18plus'))}
              className="relative -mt-6 w-14 h-14 rounded-full p-0.5 bg-gradient-to-tr from-[#7f1d1d] via-[#dc2626] to-[#ef4444] shadow-[0_6px_20px_rgba(220,38,38,0.45)] flex items-center justify-center transition-transform active:scale-95"
            >
              <div className="w-full h-full rounded-full overflow-hidden bg-[#121212] relative flex items-center justify-center">
                {spotlightItem?.poster && (
                  <img
                    src={spotlightItem.poster}
                    alt="18+ Hub"
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover opacity-75"
                  />
                )}
                <div className="absolute inset-0 bg-black/35 flex flex-col items-center justify-center">
                  <div className="w-6 h-6 rounded-full bg-[#dc2626] text-white flex items-center justify-center shadow">
                    <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
                  </div>
                </div>
              </div>
              <span className="absolute -bottom-1 px-1.5 py-0.2 rounded-full bg-black/90 text-[9px] font-extrabold text-white border border-[#dc2626]/50">
                18+ Hub
              </span>
            </button>
          </div>

          {/* 4. Downloads / Watchlist */}
          <button
            type="button"
            onClick={() => setActiveTab('watchlist')}
            className={`flex flex-col items-center justify-center transition-colors ${
              activeTab === 'watchlist' ? 'text-[#ef4444]' : 'text-gray-400 hover:text-white'
            }`}
          >
            <Download className="w-5 h-5" />
            <span className="text-[11px] font-medium mt-1">Downloads</span>
          </button>

          {/* 5. Me (Full-Screen MovieBox Me Page) */}
          <button
            type="button"
            onClick={() => setActiveTab('me')}
            className={`flex flex-col items-center justify-center transition-colors ${
              activeTab === 'me' ? 'text-[#00e68a]' : 'text-gray-400 hover:text-white'
            }`}
          >
            <div className="relative">
              <User className="w-5 h-5" />
              <span className="w-2 h-2 rounded-full bg-[#e53935] absolute -top-0.5 -right-1" />
            </div>
            <span className="text-[11px] font-medium mt-1">Me</span>
          </button>
        </div>
      </nav>

      {/* MovieBox Official Live Sports Hub Modal (Football Live / Basketball Live) */}
      {activeLiveSportModal && (
        <div className="fixed inset-0 z-[120] bg-black/95 backdrop-blur-xl flex flex-col">
          <div className="px-4 py-3 bg-[#10131a] border-b border-white/10 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-[#00e68a]/20 border border-[#00e68a]/40 flex items-center justify-center text-[#00e68a] shrink-0">
                <Trophy className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm sm:text-base font-extrabold text-white truncate">
                    {activeLiveSportModal.title}
                  </h3>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-600/20 border border-red-500/40 text-[10px] font-extrabold text-red-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-ping" />
                    LIVE
                  </span>
                </div>
                <p className="text-[11px] text-gray-400 truncate">
                  {activeLiveSportModal.bnTitle} • {activeLiveSportModal.subtitle}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {(mbHomeData?.liveSports || []).map((sp) => (
                <button
                  key={sp.id}
                  type="button"
                  onClick={() => setActiveLiveSportModal(sp)}
                  className={`hidden sm:inline-flex px-2.5 py-1 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                    activeLiveSportModal.id === sp.id
                      ? 'bg-[#00e68a] text-black'
                      : 'bg-white/10 text-gray-300 hover:text-white'
                  }`}
                >
                  {sp.title}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setActiveLiveSportModal(null)}
                className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center cursor-pointer"
                aria-label="Close Live Sports"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="flex-1 w-full bg-[#07090d] relative">
            <iframe
              src={activeLiveSportModal.liveUrl}
              title={activeLiveSportModal.title}
              className="w-full h-full border-0"
              allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
              referrerPolicy="no-referrer"
            />
          </div>
        </div>
      )}

      {/* Specific Match Live Stream & Real-Time Scoreboard Modal */}
      {selectedLiveMatchModal && (
        <div className="fixed inset-0 z-[155] bg-black/95 backdrop-blur-md flex flex-col animate-fade-in">
          {/* Top Match Scoreboard Header */}
          <div className="px-4 py-3 bg-[#0c0f16] border-b border-white/10 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  type="button"
                  onClick={() => setSelectedLiveMatchModal(null)}
                  className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center shrink-0 cursor-pointer"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-extrabold text-[#00e68a] truncate">
                      {selectedLiveMatchModal.league || selectedLiveMatchModal.matchRound}
                    </span>
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-600/25 border border-red-500/40 text-[10px] font-black text-red-400">
                      <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-ping" />
                      {selectedLiveMatchModal.isLive ? 'LIVE STREAM' : 'MATCH CENTER'}
                    </span>
                  </div>
                  <p className="text-xs font-bold text-white truncate">
                    {selectedLiveMatchModal.team1.name} ({selectedLiveMatchModal.team1.score}) vs{' '}
                    {selectedLiveMatchModal.team2.name} ({selectedLiveMatchModal.team2.score})
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setSelectedLiveMatchModal(null)}
                className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center shrink-0 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Stream Channel Switcher (Official Match Center + Channel 1/2/3 + Direct Stream) */}
            <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pt-0.5">
              <button
                type="button"
                onClick={() => setActiveMatchStreamUrl(selectedLiveMatchModal.detailUrl)}
                className={`px-3 py-1 rounded-lg text-xs font-bold shrink-0 cursor-pointer transition-colors ${
                  activeMatchStreamUrl === selectedLiveMatchModal.detailUrl
                    ? 'bg-[#00e68a] text-black'
                    : 'bg-white/10 text-gray-200 hover:bg-white/20'
                }`}
              >
                Official Live Center & Scoreboard
              </button>

              {selectedLiveMatchModal.playSource.map((src, idx) => (
                <button
                  key={src.path + idx}
                  type="button"
                  onClick={() => setActiveMatchStreamUrl(src.path)}
                  className={`px-3 py-1 rounded-lg text-xs font-bold shrink-0 cursor-pointer transition-colors ${
                    activeMatchStreamUrl === src.path
                      ? 'bg-[#00e68a] text-black'
                      : 'bg-white/10 text-gray-200 hover:bg-white/20'
                  }`}
                >
                  📺 {src.title || `Channel ${idx + 1}`}
                </button>
              ))}

              {selectedLiveMatchModal.playPath && (
                <button
                  type="button"
                  onClick={() => setActiveMatchStreamUrl(selectedLiveMatchModal.playPath)}
                  className={`px-3 py-1 rounded-lg text-xs font-bold shrink-0 cursor-pointer transition-colors ${
                    activeMatchStreamUrl === selectedLiveMatchModal.playPath
                      ? 'bg-[#00e68a] text-black'
                      : 'bg-white/10 text-gray-200 hover:bg-white/20'
                  }`}
                >
                  ⚡ Direct HD Stream
                </button>
              )}
            </div>
          </div>

          {/* Live Stream Player Area */}
          <div className="flex-1 w-full bg-[#05070b] relative">
            {activeMatchStreamUrl.includes('.m3u8') || activeMatchStreamUrl.includes('.mp4') ? (
              <div className="w-full h-full flex flex-col items-center justify-center p-4 gap-4">
                <video
                  key={activeMatchStreamUrl}
                  src={activeMatchStreamUrl}
                  controls
                  autoPlay
                  playsInline
                  className="w-full max-w-5xl max-h-[75vh] rounded-2xl bg-black border border-white/10 shadow-2xl"
                />
                <button
                  type="button"
                  onClick={() => setActiveMatchStreamUrl(selectedLiveMatchModal.detailUrl)}
                  className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-xs font-bold text-white cursor-pointer"
                >
                  সার্ভার কানেক্ট না হলে Official Live Center-এ ক্লিক করুন
                </button>
              </div>
            ) : (
              <iframe
                key={activeMatchStreamUrl}
                src={activeMatchStreamUrl || selectedLiveMatchModal.detailUrl}
                title={`${selectedLiveMatchModal.team1.name} vs ${selectedLiveMatchModal.team2.name}`}
                className="w-full h-full border-0"
                allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
                referrerPolicy="no-referrer"
              />
            )}
          </div>
        </div>
      )}

      {/* Full-Screen MovieBox Style Player & Floating Mini-Player View */}
      <MovieDetailModal
        movie={selectedMovie}
        relatedMovies={displayedItems}
        activeNodeId={activeNodeId}
        savedProgress={selectedMovieProgress}
        isMiniPlayer={isMiniPlayer}
        onToggleMiniPlayer={(mini) => setIsMiniPlayer(mini)}
        onClose={() => {
          setIsMiniPlayer(false);
          setSelectedMovie(null);
        }}
        onSelectMovie={(m) => {
          setIsMiniPlayer(false);
          setSelectedMovie(m);
        }}
        isInWatchlist={isMovieInWatchlist(selectedMovie)}
        currentFolder={getMovieWatchlistFolder(selectedMovie)}
        onToggleWatchlist={handleToggleWatchlist}
        onRecordWatchProgress={handleRecordWatchProgress}
        onSearchByActor={handleTriggerActorSearch}
        onOpenReportModal={(prefillTitle) => {
          setRequestPrefillTitle(prefillTitle);
          setRequestPrefillType('BROKEN_LINK');
          setShowRequestModal(true);
        }}
      />

      {/* Me Option: Watch History + Collapsible 24h Live 3-Site Upload Button */}
      <MovieRequestModal
        isOpen={showRequestModal}
        initialTitle={requestPrefillTitle}
        initialType={requestPrefillType}
        activeNodeId={activeNodeId}
        onSelectNode={(nodeId) => setActiveNodeId(nodeId)}
        onClose={() => setShowRequestModal(false)}
        last24hItems={last24hItems}
        liveClockNow={liveClockNow}
        isRefreshing24h={loadingCatalog || refreshing24h}
        onRefresh24h={() => {
          setLiveClockNow(Date.now());
          refreshLatest3SiteUploads(true);
          fetchCatalog(currentCategory.path, 1, '', activeNodeId, true);
        }}
        onSelectMovie={(m) => {
          setIsMiniPlayer(false);
          setSelectedMovie(m);
        }}
        continueWatching={continueWatching}
        onClearWatchHistory={() => setContinueWatching([])}
      />

      {/* iPhone PWA Install Guide Modal */}
      <PWAInstallModal
        isOpen={showInstallModal}
        onClose={() => setShowInstallModal(false)}
        isInstallable={isInstallable}
        isInstalled={isInstalled}
        isIOS={isIOS}
        onTriggerInstall={install}
      />
    </div>
  );
}
