import React from 'react';
import { Mail, Plus, ExternalLink, RefreshCw } from 'lucide-react';

interface Props {
  onOpenCompose: () => void;
  onRefresh: () => void;
  loading: boolean;
}

export const Navbar: React.FC<Props> = ({
  onOpenCompose,
  onRefresh,
  loading,
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
              Persistent BullMQ & Redis Job Dashboard
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3">
          <a
            href="http://localhost:4000/admin/queues"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700/60 transition"
          >
            <ExternalLink className="w-3.5 h-3.5 text-indigo-400" />
            Bull Board UI
          </a>

          <button
            onClick={onRefresh}
            disabled={loading}
            title="Refresh list"
            className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700/60 transition disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>

          <button
            onClick={onOpenCompose}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30 transition transform hover:-translate-y-0.5"
          >
            <Plus className="w-4 h-4" />
            Compose New Email
          </button>
        </div>
      </div>
    </header>
  );
};
