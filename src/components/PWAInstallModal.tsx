import React, { useState } from 'react';
import {
  Check,
  CheckCircle2,
  Copy,
  Download,
  Globe,
  PlusSquare,
  Share,
  Share2,
  Smartphone,
  X,
} from 'lucide-react';

interface PWAInstallModalProps {
  isOpen: boolean;
  onClose: () => void;
  isInstallable: boolean;
  isInstalled: boolean;
  isIOS: boolean;
  onTriggerInstall: () => Promise<boolean>;
}

export const PWAInstallModal: React.FC<PWAInstallModalProps> = ({
  isOpen,
  onClose,
  isInstallable,
  isInstalled,
  onTriggerInstall,
}) => {
  const [copiedLink, setCopiedLink] = useState(false);

  if (!isOpen) return null;

  const liveUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}${window.location.pathname}`
      : '';

  const handleCopyLiveLink = async () => {
    try {
      await navigator.clipboard.writeText(liveUrl);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2500);
    } catch {
      // ignore
    }
  };

  const handleNativeShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'CinePulse HD — Movie, Series & Anime App',
          text: 'Ad-free HD Movie, Web Series & Anime Streaming App (iPhone & Android)',
          url: liveUrl,
        });
        return;
      } catch {
        // fallback to copy
      }
    }
    handleCopyLiveLink();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-end sm:items-center justify-center sm:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-[#14171f] border-t sm:border border-white/10 rounded-t-3xl sm:rounded-3xl w-full max-w-md p-5 sm:p-6 space-y-4 shadow-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-[#00e68a]/15 border border-[#00e68a]/40 text-[#00e68a] flex items-center justify-center shrink-0">
              <Smartphone className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-base font-extrabold text-white">
                Install & Share Live App
              </h3>
              <p className="text-xs text-slate-400">
                iPhone, Android ও সব ইউজারদের জন্য ফুল-স্ক্রিন অ্যাপ
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close install guide"
            className="min-h-[40px] min-w-[40px] rounded-xl bg-white/5 hover:bg-white/10 text-slate-300 flex items-center justify-center transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 1. Share Public Live App Link to Any User */}
        <div className="rounded-2xl bg-[#0c0e12] border border-[#00e68a]/25 p-3.5 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-[#00e68a] flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5" />
              <span>সবার জন্য লাইভ অ্যাপ লিংক (Share Link)</span>
            </span>
            <span className="px-2 py-0.5 rounded-full bg-[#00e68a]/15 text-[#00e68a] text-[10px] font-bold">
              LIVE 24/7
            </span>
          </div>

          <div className="flex items-center gap-2 bg-[#161a24] border border-white/10 rounded-xl px-3 py-2">
            <input
              type="text"
              readOnly
              value={liveUrl}
              className="flex-1 bg-transparent text-xs text-slate-200 font-mono focus:outline-none truncate"
            />
            <button
              type="button"
              onClick={handleCopyLiveLink}
              className="px-2.5 py-1 rounded-lg bg-[#00e68a] text-black font-extrabold text-[11px] flex items-center gap-1 shrink-0"
            >
              {copiedLink ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedLink ? 'Copied' : 'Copy'}</span>
            </button>
          </div>

          <button
            type="button"
            onClick={handleNativeShare}
            className="w-full py-2.5 rounded-xl bg-white/10 hover:bg-white/15 text-white font-bold text-xs flex items-center justify-center gap-2 transition-colors"
          >
            <Share2 className="w-4 h-4 text-[#00e68a]" />
            <span>বন্ধুদের সাথে অ্যাপ লিংক শেয়ার করুন (Share App)</span>
          </button>
        </div>

        {/* 2. Install Status or 1-Tap Android/Chrome Install + iPhone Safari Steps */}
        {isInstalled ? (
          <div className="rounded-2xl bg-[#00e68a]/10 border border-[#00e68a]/30 p-4 flex items-center gap-3 text-emerald-200 text-xs">
            <CheckCircle2 className="w-5 h-5 text-[#00e68a] shrink-0" />
            <span>অ্যাপটি ইতিমধ্যে আপনার ডিভাইসের হোম স্ক্রিনে ইনস্টল করা আছে!</span>
          </div>
        ) : (
          <div className="space-y-3.5">
            {isInstallable && (
              <button
                type="button"
                onClick={async () => {
                  const ok = await onTriggerInstall();
                  if (ok) onClose();
                }}
                className="w-full min-h-[48px] px-4 py-3 rounded-2xl bg-[#00e68a] hover:bg-[#19f59c] text-black font-extrabold text-sm flex items-center justify-center gap-2 shadow-[0_8px_25px_rgba(0,230,138,0.3)] transition-all"
              >
                <Download className="w-4 h-4 stroke-[2.5]" />
                <span>1-Tap Install App (Android / Chrome)</span>
              </button>
            )}

            {/* iPhone / iPad Safari Guide */}
            <div className="rounded-2xl bg-[#0c0e12] border border-white/10 p-4 space-y-3">
              <div className="text-xs font-extrabold text-white flex items-center justify-between">
                <span>iPhone / iPad (Safari) হোম স্ক্রিনে অ্যাপ করার নিয়ম:</span>
                <span className="text-[10px] px-2 py-0.5 rounded bg-white/10 text-slate-300">
                  iOS App
                </span>
              </div>

              <div className="flex items-start gap-3 text-xs text-slate-300">
                <div className="w-6 h-6 rounded-lg bg-[#181c26] border border-[#00e68a]/30 flex items-center justify-center text-[#00e68a] shrink-0 font-extrabold">
                  1
                </div>
                <div className="leading-relaxed">
                  আইফোনের <strong className="text-white">Safari</strong> ব্রাউজারে এই লিংকটি ওপেন করে নিচে থাকা{' '}
                  <strong className="text-white">Share</strong> বাটনে ট্যাপ করুন।
                  <span className="inline-flex items-center ml-1.5 px-1.5 py-0.5 rounded bg-white/10 text-[#00e68a]">
                    <Share className="w-3.5 h-3.5" />
                  </span>
                </div>
              </div>

              <div className="flex items-start gap-3 text-xs text-slate-300">
                <div className="w-6 h-6 rounded-lg bg-[#181c26] border border-[#00e68a]/30 flex items-center justify-center text-[#00e68a] shrink-0 font-extrabold">
                  2
                </div>
                <div className="leading-relaxed">
                  নিচে স্ক্রল করে <strong className="text-white">Add to Home Screen</strong> অপশনে ট্যাপ করুন।
                  <span className="inline-flex items-center ml-1.5 px-1.5 py-0.5 rounded bg-white/10 text-amber-300">
                    <PlusSquare className="w-3.5 h-3.5" />
                  </span>
                </div>
              </div>

              <div className="flex items-start gap-3 text-xs text-slate-300">
                <div className="w-6 h-6 rounded-lg bg-[#181c26] border border-[#00e68a]/30 flex items-center justify-center text-[#00e68a] shrink-0 font-extrabold">
                  3
                </div>
                <div className="leading-relaxed">
                  উপরে ডান কোণায় <strong className="text-white">Add</strong> বাটনে ট্যাপ করলেই আপনার আইফোনে{' '}
                  <strong className="text-[#00e68a]">CinePulse</strong> নেটিভ অ্যাপ হিসেবে যুক্ত হয়ে যাবে!
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 3. GitHub Automatic Hosting Ready Card */}
        <div className="rounded-2xl bg-[#0c0e12] border border-emerald-500/25 p-4 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-extrabold text-white">
              GitHub Auto-Hosting (ফ্রি লাইভ হোস্টিং রেডি):
            </span>
            <span className="text-[10px] px-2 py-0.5 rounded bg-[#00e68a]/15 text-[#00e68a] font-bold">
              Configured ✓
            </span>
          </div>
          <ol className="text-xs text-slate-300 space-y-1.5 list-decimal list-inside leading-relaxed">
            <li>
              AI Studio-এর একদম উপরে <strong className="text-white">GitHub</strong> বাটনে চাপ দিয়ে রিপোজিটরি তৈরি করুন।
            </li>
            <li>
              আমরা ভেতরে <code className="text-[#00e68a]">.github/workflows/deploy.yml</code> ও{' '}
              <code className="text-[#00e68a]">render.yaml</code> যুক্ত করে দিয়েছি।
            </li>
            <li>
              GitHub-এ গিয়ে <strong className="text-white">Settings ➔ Pages ➔ Source: GitHub Actions</strong> সিলেক্ট করলেই অটোমেটিক আপনার স্থায়ী গিটহাব লিংক লাইভ হয়ে যাবে!
            </li>
          </ol>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="w-full min-h-[44px] rounded-xl bg-white/10 hover:bg-white/15 text-white text-xs font-bold transition-colors"
        >
          ঠিক আছে (Close)
        </button>
      </div>
    </div>
  );
};
