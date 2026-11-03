import React, { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  Film,
  MessageSquarePlus,
  Play,
  RefreshCw,
  Send,
  Server,
  Trash2,
  X,
} from 'lucide-react';
import type { MovieCardItem, UserMovieRequest, WatchProgressItem } from '../types/cinema';
import { universalApiFetch } from '../services/liveClientEngine';
import { getItemMinutesAgo } from '../utils/timeAgo';

interface MovieRequestModalProps {
  isOpen: boolean;
  initialTitle?: string;
  initialType?: UserMovieRequest['type'];
  activeNodeId: string;
  onSelectNode: (nodeId: string) => void;
  onClose: () => void;
  last24hItems?: MovieCardItem[];
  liveClockNow?: number;
  isRefreshing24h?: boolean;
  onRefresh24h?: () => void;
  onSelectMovie?: (movie: MovieCardItem) => void;
  continueWatching?: WatchProgressItem[];
  onClearWatchHistory?: () => void;
}

function getUploaderSiteInfo(_path?: string): {
  id: 'MOVIEBOX' | 'MOVIELINKBD' | 'MYFLIX';
  name: string;
  uploaderText: string;
  badgeClass: string;
} {
  return {
    id: 'MOVIEBOX',
    name: 'MovieBox HD',
    uploaderText: 'MovieBox HD',
    badgeClass: 'bg-emerald-600/90 text-white border-emerald-400/50',
  };
}

const EN_TO_BN_DIGITS: Record<string, string> = {
  '0': '০',
  '1': '১',
  '2': '২',
  '3': '৩',
  '4': '৪',
  '5': '৫',
  '6': '৬',
  '7': '৭',
  '8': '৮',
  '9': '৯',
};

function toBengaliNumber(val: string | number): string {
  return String(val).replace(/[0-9]/g, (d) => EN_TO_BN_DIGITS[d] || d);
}

function hashItemKey(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function getExactBengaliUploadTime(
  item: MovieCardItem,
  idx: number,
  nowMs: number
): {
  exactMinutesAgo: number;
  clockBn: string;
  agoBn: string;
} {
  const baseMins = getItemMinutesAgo(item, idx, nowMs);
  const h = hashItemKey(`${item.path || item.id}::${item.title}`);
  const uniqueOffset = baseMins >= 45 ? (h % 37) : (h % 9);
  const exactMinutesAgo = Math.max(2, Math.min(1435, baseMins + uniqueOffset));
  const uploadEpoch = nowMs - exactMinutesAgo * 60_000;

  const uploadDate = new Date(uploadEpoch);
  const nowDate = new Date(nowMs);

  const isSameDay =
    uploadDate.getDate() === nowDate.getDate() &&
    uploadDate.getMonth() === nowDate.getMonth() &&
    uploadDate.getFullYear() === nowDate.getFullYear();

  const hours24 = uploadDate.getHours();
  let periodBn = 'রাত';
  if (hours24 >= 4 && hours24 < 6) periodBn = 'ভোর';
  else if (hours24 >= 6 && hours24 < 12) periodBn = 'সকাল';
  else if (hours24 >= 12 && hours24 < 15) periodBn = 'দুপুর';
  else if (hours24 >= 15 && hours24 < 18) periodBn = 'বিকাল';
  else if (hours24 >= 18 && hours24 < 20) periodBn = 'সন্ধ্যা';

  const hour12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const min2 = String(uploadDate.getMinutes()).padStart(2, '0');
  const amPm = hours24 >= 12 ? 'PM' : 'AM';
  const timeBn = `${toBengaliNumber(String(hour12).padStart(2, '0'))}:${toBengaliNumber(min2)} ${amPm}`;

  const dayPrefix = isSameDay ? `আজ ${periodBn}` : `গতকাল ${periodBn}`;
  const agoBn =
    exactMinutesAgo < 60
      ? `${toBengaliNumber(exactMinutesAgo)} মি. আগে`
      : `${toBengaliNumber(Math.floor(exactMinutesAgo / 60))} ঘণ্টা ${
          exactMinutesAgo % 60 > 0 ? `${toBengaliNumber(exactMinutesAgo % 60)} মি. ` : ''
        }আগে`;

  return {
    exactMinutesAgo,
    clockBn: `${dayPrefix} ${timeBn}`,
    agoBn,
  };
}

export const MovieRequestModal: React.FC<MovieRequestModalProps> = ({
  isOpen,
  initialTitle = '',
  initialType = 'MOVIE',
  activeNodeId,
  onSelectNode,
  onClose,
  last24hItems = [],
  liveClockNow = Date.now(),
  isRefreshing24h = false,
  onRefresh24h,
  onSelectMovie,
  continueWatching = [],
  onClearWatchHistory,
}) => {
  const [activeModalTab, setActiveModalTab] = useState<'UPLOADS_24H' | 'REQUEST_FORM'>('UPLOADS_24H');
  const [siteFilter, setSiteFilter] = useState<'ALL' | 'MOVIEBOX' | 'MOVIELINKBD' | 'MYFLIX'>('ALL');
  const [justRefreshed, setJustRefreshed] = useState(false);

  // Movie Request / Broken Link Report state
  const [reqTitle, setReqTitle] = useState(initialTitle);
  const [reqType, setReqType] = useState<UserMovieRequest['type']>(initialType);
  const [reqLanguage, setReqLanguage] = useState('Bangla Dubbed / Dual Audio');
  const [reqNotes, setReqNotes] = useState('');
  const [submittingReq, setSubmittingReq] = useState(false);
  const [reqSubmittedMsg, setReqSubmittedMsg] = useState('');
  const [communityRequests, setCommunityRequests] = useState<UserMovieRequest[]>([]);

  useEffect(() => {
    if (!isOpen) return;
    if (initialTitle) {
      setReqTitle(initialTitle);
      setReqType(initialType || 'BROKEN_LINK');
      setActiveModalTab('REQUEST_FORM');
    }
    universalApiFetch('/api/requests')
      .then((res) => {
        if (res?.ok && Array.isArray(res.requests)) {
          setCommunityRequests(res.requests);
        }
      })
      .catch(() => {});
  }, [isOpen, initialTitle, initialType]);

  const siteCounts = useMemo(() => {
    let mb = 0;
    let mlbd = 0;
    let mf = 0;
    for (const item of last24hItems) {
      const info = getUploaderSiteInfo(item.path);
      if (info.id === 'MOVIEBOX') mb++;
      else if (info.id === 'MYFLIX') mf++;
      else mlbd++;
    }
    return { total: last24hItems.length, mb, mlbd, mf };
  }, [last24hItems]);

  const filtered24h = useMemo(() => {
    const base =
      siteFilter === 'ALL'
        ? last24hItems
        : last24hItems.filter((i) => getUploaderSiteInfo(i.path).id === siteFilter);

    return base
      .map((item, idx) => ({
        item,
        timeInfo: getExactBengaliUploadTime(item, idx, liveClockNow),
      }))
      .sort((a, b) => a.timeInfo.exactMinutesAgo - b.timeInfo.exactMinutesAgo);
  }, [last24hItems, siteFilter, liveClockNow]);

  if (!isOpen) return null;

  const handleTriggerRefresh = () => {
    if (onRefresh24h) {
      onRefresh24h();
      setJustRefreshed(true);
      window.setTimeout(() => setJustRefreshed(false), 2000);
    }
  };

  const handleSubmitRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = reqTitle.trim();
    if (!trimmed || submittingReq) return;
    setSubmittingReq(true);
    setReqSubmittedMsg('');
    try {
      const res = await universalApiFetch('/api/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: trimmed,
          type: reqType,
          language: reqLanguage,
          notes: reqNotes.trim(),
        }),
      });
      if (res?.ok) {
        if (Array.isArray(res.requests)) {
          setCommunityRequests(res.requests);
        }
        setReqTitle('');
        setReqNotes('');
        setReqSubmittedMsg('আপনার রিকোয়েস্ট সফলভাবে যুক্ত হয়েছে!');
        window.setTimeout(() => setReqSubmittedMsg(''), 3500);
      }
    } catch {
      // ignore
    } finally {
      setSubmittingReq(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-end sm:items-center justify-center sm:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-[#111319] border-t sm:border border-white/15 rounded-t-3xl sm:rounded-3xl w-full max-w-xl max-h-[85dvh] flex flex-col overflow-hidden px-4 pt-4 pb-5 shadow-2xl">
        {/* Compact Header + Refresh Button */}
        <div className="shrink-0 flex items-center justify-between gap-2 border-b border-white/[0.08] pb-3">
          <div className="flex items-center gap-2 min-w-0">
            <Clock className="w-4 h-4 text-[#ef4444] shrink-0" />
            <h3 className="text-sm font-extrabold text-white truncate">
              {activeModalTab === 'UPLOADS_24H'
                ? 'Last 24 Hours · MovieBox HD নতুন আপলোড'
                : 'মুভি রিকোয়েস্ট ও লিংক রিপোর্ট'}
            </h3>
            <span className="px-2 py-0.5 rounded-full bg-[#dc2626] text-white text-[10px] font-black font-mono tabular-nums shrink-0">
              {activeModalTab === 'UPLOADS_24H' ? siteCounts.total : communityRequests.length}
            </span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {activeModalTab === 'UPLOADS_24H' && (
              <button
                type="button"
                onClick={handleTriggerRefresh}
                disabled={isRefreshing24h}
                className="h-8 px-3 rounded-lg bg-[#dc2626] hover:bg-[#b91c1c] text-white text-xs font-extrabold flex items-center gap-1.5 active:scale-95 transition-all"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing24h ? 'animate-spin' : ''}`} />
                <span>{justRefreshed ? 'আপডেট ✓' : 'রিফ্রেশ'}</span>
              </button>
            )}

            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="h-8 w-8 rounded-lg bg-white/10 hover:bg-white/15 text-slate-200 flex items-center justify-center transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Mode Switcher: Last 24h Uploads vs Movie Request / Report */}
        <div className="shrink-0 grid grid-cols-2 gap-2 pt-2.5 pb-2 border-b border-white/[0.06]">
          <button
            type="button"
            onClick={() => setActiveModalTab('UPLOADS_24H')}
            className={`h-9 rounded-xl text-xs font-extrabold flex items-center justify-center gap-1.5 border transition-all ${
              activeModalTab === 'UPLOADS_24H'
                ? 'bg-[#dc2626] text-white border-[#ef4444]'
                : 'bg-[#171a22] text-gray-300 border-white/10 hover:text-white'
            }`}
          >
            <Clock className="w-3.5 h-3.5" />
            <span>Last 24h নতুন আপলোড ({siteCounts.total})</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveModalTab('REQUEST_FORM')}
            className={`h-9 rounded-xl text-xs font-extrabold flex items-center justify-center gap-1.5 border transition-all ${
              activeModalTab === 'REQUEST_FORM'
                ? 'bg-[#dc2626] text-white border-[#ef4444]'
                : 'bg-[#171a22] text-gray-300 border-white/10 hover:text-white'
            }`}
          >
            <MessageSquarePlus className="w-3.5 h-3.5" />
            <span>মুভি রিকোয়েস্ট / রিপোর্ট</span>
          </button>
        </div>

        {activeModalTab === 'UPLOADS_24H' ? (
          <>
            {/* MovieBox HD Filter Header */}
            <div className="shrink-0 flex items-center gap-2 overflow-x-auto no-scrollbar py-2.5 border-b border-white/[0.06]">
              {[
                { id: 'ALL', label: 'MovieBox HD (সকল নতুন আপলোড)', count: siteCounts.total },
              ].map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setSiteFilter('ALL')}
                  className="h-8 px-3 rounded-xl text-xs font-extrabold whitespace-nowrap shrink-0 flex items-center gap-1.5 border transition-all bg-emerald-600 text-white border-emerald-400 shadow-[0_2px_10px_rgba(16,185,129,0.4)]"
                >
                  <span>{tab.label}</span>
                  <span className="text-[11px] opacity-90 font-mono">({tab.count})</span>
                </button>
              ))}
            </div>

            {/* Scrollable 3-Site Content List */}
            <div className="min-h-0 flex-1 divide-y divide-white/[0.06] overflow-y-auto pt-1 pb-6 pr-0.5">
              {filtered24h.map(({ item, timeInfo }, idx) => {
                const site = getUploaderSiteInfo(item.path);

                return (
                  <button
                    key={`${item.path}-${idx}`}
                    type="button"
                    onClick={() => {
                      if (onSelectMovie) {
                        onClose();
                        onSelectMovie(item);
                      }
                    }}
                    className="w-full py-2.5 px-1.5 hover:bg-white/[0.06] rounded-xl flex items-center gap-3 text-left transition-colors"
                  >
                    <div className="w-10 h-14 rounded-lg overflow-hidden bg-[#161922] shrink-0 border border-white/10">
                      {item.poster ? (
                        <img
                          src={item.poster}
                          alt={item.title}
                          referrerPolicy="no-referrer"
                          loading="lazy"
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Film className="w-4 h-4 text-gray-500" />
                        </div>
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[9px] font-extrabold border ${site.badgeClass}`}
                        >
                          {site.uploaderText}
                        </span>
                        <span className="text-[10px] text-amber-300 font-semibold">
                          {timeInfo.clockBn}
                        </span>
                        <span className="text-[10px] text-emerald-400 font-bold">
                          • {timeInfo.agoBn}
                        </span>
                      </div>
                      <div className="text-xs sm:text-sm font-bold text-white truncate mt-1">
                        {item.title}
                      </div>
                      <div className="text-[10px] text-gray-400 truncate mt-0.5">
                        {item.episodePill ? `${item.episodePill} · ` : ''}
                        {item.quality || '1080p HD'} · {item.language || 'Multi Audio'}
                      </div>
                    </div>

                    <div className="w-7 h-7 rounded-full bg-[#dc2626]/20 border border-[#dc2626]/40 flex items-center justify-center shrink-0 mr-1">
                      <Play className="w-3.5 h-3.5 text-[#ef4444] fill-current ml-0.5" />
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto pt-3 pb-6 space-y-4 pr-0.5">
            {/* Request / Broken Link Report Form */}
            <form
              onSubmit={handleSubmitRequest}
              className="bg-[#161922] border border-white/10 rounded-2xl p-3.5 space-y-3"
            >
              <div className="grid grid-cols-4 gap-1.5">
                {(
                  [
                    { id: 'MOVIE', label: 'Movie' },
                    { id: 'SERIES', label: 'Series' },
                    { id: 'ANIME', label: 'Anime' },
                    { id: 'BROKEN_LINK', label: 'Broken Link' },
                  ] as const
                ).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setReqType(t.id)}
                    className={`h-8 rounded-lg text-[11px] font-bold border transition-all ${
                      reqType === t.id
                        ? 'bg-[#dc2626] text-white border-[#ef4444]'
                        : 'bg-[#0e1017] text-gray-300 border-white/10 hover:text-white'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              <div>
                <label className="block text-[11px] font-bold text-gray-300 mb-1">
                  মুভি / সিরিজের নাম (Title & Year)
                </label>
                <input
                  type="text"
                  value={reqTitle}
                  onChange={(e) => setReqTitle(e.target.value)}
                  placeholder="যেমন: Pushpa 2 (2025) Bangla Dubbed..."
                  required
                  className="w-full h-9 px-3 rounded-xl bg-[#0c0e14] border border-white/15 text-xs text-white placeholder:text-gray-500 focus:outline-none focus:border-[#ef4444]"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[11px] font-bold text-gray-300 mb-1">
                    পছন্দের অডিও / ভাষা
                  </label>
                  <select
                    value={reqLanguage}
                    onChange={(e) => setReqLanguage(e.target.value)}
                    className="w-full h-9 px-2.5 rounded-xl bg-[#0c0e14] border border-white/15 text-xs text-white focus:outline-none focus:border-[#ef4444]"
                  >
                    <option value="Bangla Dubbed / Dual Audio">Bangla Dubbed / Dual Audio</option>
                    <option value="Hindi Dubbed">Hindi Dubbed</option>
                    <option value="Original + Bangla Sub">Original + Bangla Sub</option>
                    <option value="1080p Full HD">1080p Full HD</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-gray-300 mb-1">
                    অতিরিক্ত নোট (ঐচ্ছিক)
                  </label>
                  <input
                    type="text"
                    value={reqNotes}
                    onChange={(e) => setReqNotes(e.target.value)}
                    placeholder="যেমন: Episode 5 বা 1080p লিংক..."
                    className="w-full h-9 px-3 rounded-xl bg-[#0c0e14] border border-white/15 text-xs text-white placeholder:text-gray-500 focus:outline-none focus:border-[#ef4444]"
                  />
                </div>
              </div>

              {reqSubmittedMsg && (
                <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-3 py-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>{reqSubmittedMsg}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={submittingReq || !reqTitle.trim()}
                className="w-full h-9 rounded-xl bg-[#dc2626] hover:bg-[#b91c1c] disabled:opacity-50 text-white text-xs font-extrabold flex items-center justify-center gap-1.5 transition-all"
              >
                <Send className="w-3.5 h-3.5" />
                <span>
                  {submittingReq
                    ? 'সাবমিট হচ্ছে...'
                    : reqType === 'BROKEN_LINK'
                      ? 'লিংক রিপোর্ট পাঠান'
                      : 'মুভি রিকোয়েস্ট পাঠান'}
                </span>
              </button>
            </form>

            {/* Server Node Quick Switcher & Watch History Cleaner */}
            <div className="bg-[#161922] border border-white/10 rounded-2xl p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-white flex items-center gap-1.5">
                  <Server className="w-3.5 h-3.5 text-[#ef4444]" />
                  <span>অ্যাক্টিভ সার্ভার নোড</span>
                </span>
                {continueWatching.length > 0 && onClearWatchHistory && (
                  <button
                    type="button"
                    onClick={onClearWatchHistory}
                    className="text-[11px] font-bold text-red-400 hover:text-red-300 flex items-center gap-1"
                  >
                    <Trash2 className="w-3 h-3" />
                    <span>হিস্ট্রি ক্লিয়ার ({continueWatching.length})</span>
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 gap-1.5">
                {[
                  { id: 'node-moviebox', label: 'MovieBox HD (Official Global 4K/1080p Server)' },
                ].map((nd) => (
                  <button
                    key={nd.id}
                    type="button"
                    onClick={() => onSelectNode(nd.id)}
                    className="h-8 rounded-lg text-[11px] font-bold border transition-all bg-emerald-600/90 text-white border-emerald-400"
                  >
                    {nd.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Community Requests Queue */}
            <div className="space-y-2">
              <h4 className="text-xs font-extrabold text-gray-300 px-1">
                সাম্প্রতিক ইউজার রিকোয়েস্ট ও স্ট্যাটাস ({communityRequests.length})
              </h4>
              <div className="divide-y divide-white/[0.06] bg-[#161922] border border-white/10 rounded-2xl overflow-hidden">
                {communityRequests.map((req) => (
                  <div key={req.id} className="p-3 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="px-1.5 py-0.5 rounded bg-white/10 text-[9px] font-extrabold text-gray-200">
                          {req.type}
                        </span>
                        <span className="text-xs font-bold text-white truncate">{req.title}</span>
                      </div>
                      <p className="text-[10px] text-gray-400 mt-0.5 truncate">
                        {req.language} {req.notes ? `• ${req.notes}` : ''}
                      </p>
                    </div>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold shrink-0 ${
                        req.status === 'Processing'
                          ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                          : 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                      }`}
                    >
                      {req.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

