export interface MovieCardItem {
  id: string;
  title: string;
  url: string;
  path: string;
  poster: string;
  previewImage?: string;
  country?: string;
  sportGenre?: string;
  quality: string;
  views: string;
  language: string;
  typeBadge: 'MOVIE' | 'SERIES' | 'ANIME' | 'DRAMA';
  timeAgo: string;
  episodePill: string;
  isPinned: boolean;
  isAdult: boolean;
  folder?: WatchlistFolder;
  rating?: string;
  hypeScore?: number;
  isHot?: boolean;
  isDhamaka?: boolean;
  hypeBadge?: string;
  uploadedAtMs?: number;
}

export type WatchlistFolder = 'favorites' | 'watch_later' | 'anime_series';

export interface StreamSource {
  id: string;
  quality: number;
  qualityLabel: string;
  audio: string;
  audioLanguages: string[];
  provider: string;
  url: string;
  downloadUrl: string;
  type: string;
  name: string;
  screenshot?: string;
}

export interface EpisodeItem {
  id: string;
  label: string;
  number: number | null;
  rangeStart?: number | null;
  rangeEnd?: number | null;
  season: number | null;
  kind: string;
  sources: StreamSource[];
}

export interface DirectDownloadButton {
  label: string;
  url: string;
  quality: string;
  size: string;
}

export interface CastMember {
  name: string;
  role: string;
  photo: string;
  url: string;
}

export interface MovieDubOption {
  id: string;
  label: string;
  lanCode?: string;
  path: string;
  active?: boolean;
}

export interface MovieDetailData {
  title: string;
  url: string;
  poster: string;
  backdrop?: string;
  qualityNote: string;
  typeBadge: string;
  language: string;
  quality: string;
  genre: string;
  resolution: string;
  releaseDate: string;
  storyline: string;
  youtubeTrailerId: string;
  screenshots: string[];
  episodes: EpisodeItem[];
  downloadButtons: DirectDownloadButton[];
  cast: CastMember[];
  relatedSeasons?: MovieCardItem[];
  dubs?: MovieDubOption[];
  uploadedBy?: string;
  communityScore?: {
    recommendedPercent: number;
    totalVotes: number;
    verdict: string;
  };
}

export interface CategoryOption {
  label: string;
  bnLabel: string;
  path: string;
  group: 'zone' | 'language' | 'genre' | 'collection';
  isAdult?: boolean;
}

export interface WatchProgressItem {
  movie: MovieCardItem;
  episodeId?: string;
  episodeIdx?: number;
  episodeLabel?: string;
  quality?: number;
  audio?: string;
  updatedAt: number;
  progressSeconds?: number;
  durationSeconds?: number;
}

export interface ServerNodeStatus {
  id: string;
  name: string;
  region: string;
  latencyMs: number;
  online: boolean;
}

export interface UserMovieRequest {
  id: string;
  title: string;
  type: 'MOVIE' | 'SERIES' | 'ANIME' | 'BROKEN_LINK';
  language: string;
  notes: string;
  status: 'Queued' | 'Processing';
  createdAt: number;
}

export interface GlobalMovieNotification {
  id: string;
  category: 'NEW_UPLOAD' | 'TOP_RATED_POPULAR';
  badgeText: string;
  headlineBn: string;
  subtitleBn: string;
  movie: MovieCardItem;
  createdAt: number;
  ratingScore: number;
}

export interface MovieBoxLiveSportItem {
  id: string;
  title: string;
  bnTitle: string;
  subtitle: string;
  sportType: 'football' | 'basketball' | 'cricket' | 'wwe';
  liveUrl: string;
  categoryPath: string;
  badge: string;
  accentColor: string;
}

export interface MovieBoxQuickCategory {
  id: string;
  title: string;
  bnTitle: string;
  image: string;
  path: string;
}

export interface MovieBoxComingSoonItem {
  id: string;
  title: string;
  releaseDate: string;
  releaseBadge: string;
  bookedCount: number;
  poster: string;
  path: string;
  genre: string;
  country: string;
}

export interface MovieBoxHomeShelf {
  id: string;
  title: string;
  bnTitle: string;
  categoryPath: string;
  badge?: string;
  items: MovieCardItem[];
}

export interface MovieBoxHomePayload {
  ok: boolean;
  banners: MovieCardItem[];
  liveSports: MovieBoxLiveSportItem[];
  quickCategories: MovieBoxQuickCategory[];
  comingSoon: MovieBoxComingSoonItem[];
  sections: MovieBoxHomeShelf[];
}

export interface LiveSportMatchTeam {
  id: string;
  name: string;
  abbreviation: string;
  avatar: string;
  score: string;
  voteCount: number;
  cricketScoreText?: string;
}

export interface LiveSportPlaySource {
  title: string;
  path: string;
}

export interface LiveSportMatch {
  id: string;
  sportType: 'football' | 'cricket' | 'basketball';
  league: string;
  leagueId: string;
  matchRound: string;
  status: 'MatchLiving' | 'MatchNotStart' | 'MatchEnded' | string;
  isLive: boolean;
  startTimeMs: number;
  timeDesc: string;
  matchResult: string;
  team1: LiveSportMatchTeam;
  team2: LiveSportMatchTeam;
  playPath: string;
  playSource: LiveSportPlaySource[];
  detailUrl: string;
}
