import React from 'react';
import { Mail, Plus, ExternalLink, RefreshCw, MessageSquare, Check } from 'lucide-react';

interface Props {
  onOpenCompose: () => void;
  onRefresh: () => void;
  loading: boolean;
  currentUser?: {
    email: string;
    name?: string;
    avatarUrl?: string;
  } | null;
  slackConnected?: boolean;
}

export const Navbar: React.FC<Props> = ({
  onOpenCompose,
  onRefresh,
  loading,
  slackConnected,
}) => {
  return (
    <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        {/* Brand */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center text-white shadow-lg shadow-indigo-600/30">
            <Mail className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-white text-base tracking-tight">
                ReachInbox.ai
              </span>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
                Scheduler
              </span>
            </div>
            <p className="text-[11px] text-slate-400">
              Persistent BullMQ & Redis Job Engine
            </p>
          </div>
        </div>

        {/* Integrations & Actions */}
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Demo Mode Status Indicator */}
          <div className="hidden lg:flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-800/80 border border-slate-700/60 text-xs text-slate-300">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span className="font-medium text-slate-200">Demo Mode Active</span>
          </div>

          {/* Slack Integration CTA */}
          <a
            href="/api/slack/connect"
            title={slackConnected ? 'Slack connected' : 'Connect Slack channel'}
            className={`hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border transition ${
              slackConnected
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700/60'
            }`}
          >
            <MessageSquare className="w-3.5 h-3.5" />
            {slackConnected ? (
              <>
                <Check className="w-3 h-3 text-emerald-400" />
                Slack Linked
              </>
            ) : (
              'Connect Slack'
            )}
          </a>

          {/* Bull Board Link */}
          <a
            href="/admin/queues"
            target="_blank"
            rel="noopener noreferrer"
            title="BullMQ Queue Dashboard"
            className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700/60 transition"
          >
            <ExternalLink className="w-3.5 h-3.5 text-indigo-400" />
            Bull Board UI
          </a>

          {/* Refresh Action */}
          <button
            onClick={onRefresh}
            disabled={loading}
            title="Refresh list"
            className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700/60 transition disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>

          {/* Compose CTA */}
          <button
            onClick={onOpenCompose}
            className="inline-flex items-center gap-2 px-3.5 sm:px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30 transition transform hover:-translate-y-0.5"
          >
            <Plus className="w-4 h-4" />
            <span>Compose</span>
          </button>
        </div>
      </div>
    </header>
  );
};
