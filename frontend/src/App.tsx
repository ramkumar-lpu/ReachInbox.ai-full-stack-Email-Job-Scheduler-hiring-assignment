import React, { useState, useEffect, useCallback } from 'react';
import { Navbar } from './components/Navbar';
import { EmailTable } from './components/EmailTable';
import { ComposeModal } from './components/ComposeModal';
import { EmailRecord, SenderRecord } from './types';
import {
  fetchScheduledEmails,
  fetchSentEmails,
  fetchSenders,
  fetchCurrentUser,
  fetchSlackStatus,
} from './api/client';
import {
  Clock,
  CheckCircle2,
  AlertTriangle,
  Users,
  Flame,
  Info,
} from 'lucide-react';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'scheduled' | 'sent'>('scheduled');
  const [scheduledEmails, setScheduledEmails] = useState<EmailRecord[]>([]);
  const [sentEmails, setSentEmails] = useState<EmailRecord[]>([]);
  const [senders, setSenders] = useState<SenderRecord[]>([]);
  const [currentUser, setCurrentUser] = useState<{
    email: string;
    name?: string;
    avatarUrl?: string;
    hasGoogleAuth: boolean;
  } | null>(null);
  const [slackConnected, setSlackConnected] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isComposeOpen, setIsComposeOpen] = useState(false);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      setError(null);
      const [scheduledRes, sentRes, sendersRes, userRes, slackRes] = await Promise.all([
        fetchScheduledEmails(),
        fetchSentEmails(),
        fetchSenders(),
        fetchCurrentUser(),
        fetchSlackStatus(),
      ]);

      setScheduledEmails(scheduledRes);
      setSentEmails(sentRes);
      setSenders(sendersRes);
      if (userRes.authenticated && userRes.user) {
        setCurrentUser(userRes.user);
      }
      setSlackConnected(slackRes.connected);
    } catch (err: unknown) {
      setError((err as Error).message || 'Failed to connect to backend API');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();

    // Check for OAuth callbacks in URL params
    const params = new URLSearchParams(window.location.search);
    if (params.get('auth') === 'success') {
      setSuccessBanner('Successfully signed in with Google OAuth!');
      window.history.replaceState({}, '', window.location.pathname);
    } else if (params.get('slack') === 'connected') {
      setSuccessBanner('Slack channel successfully linked for campaign notifications!');
      window.history.replaceState({}, '', window.location.pathname);
    }

    // Auto-refresh every 5 seconds to show real-time transitions (scheduled -> processing -> sent)
    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, [loadData]);

  const handleComposeSuccess = () => {
    setSuccessBanner('New email campaign successfully scheduled into BullMQ queue!');
    loadData();
    setTimeout(() => setSuccessBanner(null), 5000);
  };

  const totalDelivered = sentEmails.filter((e) => e.status === 'sent').length;
  const totalFailed = sentEmails.filter((e) => e.status === 'failed').length;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      <Navbar
        onOpenCompose={() => setIsComposeOpen(true)}
        onRefresh={loadData}
        loading={loading}
        currentUser={currentUser}
        slackConnected={slackConnected}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        {/* Alerts / Banners */}
        {error && (
          <div className="flex items-center gap-3 p-4 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm">
            <AlertTriangle className="w-5 h-5 shrink-0 text-rose-400" />
            <div className="flex-1">
              <span className="font-semibold">Backend Connection Issue:</span> {error}.
              Ensure backend server is running on port 4000 (`npm run dev`).
            </div>
            <button
              onClick={loadData}
              className="px-3 py-1 text-xs rounded-lg bg-rose-500/20 hover:bg-rose-500/30 font-medium"
            >
              Retry
            </button>
          </div>
        )}

        {successBanner && (
          <div className="flex items-center gap-3 p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-sm animate-in fade-in">
            <CheckCircle2 className="w-5 h-5 shrink-0 text-emerald-400" />
            <span>{successBanner}</span>
          </div>
        )}

        {/* Quick Metrics Bar */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="p-4 rounded-2xl bg-slate-900/60 border border-slate-800/80">
            <div className="flex items-center justify-between text-slate-400 mb-1">
              <span className="text-xs font-medium uppercase tracking-wider">Scheduled Queue</span>
              <Clock className="w-4 h-4 text-amber-400" />
            </div>
            <div className="text-2xl font-bold text-white font-mono">
              {scheduledEmails.length}
            </div>
            <span className="text-[11px] text-slate-400">Delayed BullMQ jobs</span>
          </div>

          <div className="p-4 rounded-2xl bg-slate-900/60 border border-slate-800/80">
            <div className="flex items-center justify-between text-slate-400 mb-1">
              <span className="text-xs font-medium uppercase tracking-wider">Sent / Delivered</span>
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="text-2xl font-bold text-white font-mono">
              {totalDelivered}
            </div>
            <span className="text-[11px] text-slate-400">SMTP confirmed</span>
          </div>

          <div className="p-4 rounded-2xl bg-slate-900/60 border border-slate-800/80">
            <div className="flex items-center justify-between text-slate-400 mb-1">
              <span className="text-xs font-medium uppercase tracking-wider">Delivery Failures</span>
              <Flame className="w-4 h-4 text-rose-400" />
            </div>
            <div className="text-2xl font-bold text-white font-mono">
              {totalFailed}
            </div>
            <span className="text-[11px] text-slate-400">Exhausted retries</span>
          </div>

          <div className="p-4 rounded-2xl bg-slate-900/60 border border-slate-800/80">
            <div className="flex items-center justify-between text-slate-400 mb-1">
              <span className="text-xs font-medium uppercase tracking-wider">Active Senders</span>
              <Users className="w-4 h-4 text-indigo-400" />
            </div>
            <div className="text-2xl font-bold text-white font-mono">
              {senders.length}
            </div>
            <span className="text-[11px] text-slate-400">Rate-limited tenants</span>
          </div>
        </div>

        {/* Tab Selection Navigation */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveTab('scheduled')}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition ${
                activeTab === 'scheduled'
                  ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                  : 'text-slate-400 hover:text-white hover:bg-slate-900'
              }`}
            >
              <Clock className="w-4 h-4" />
              Scheduled Emails
              <span
                className={`ml-1 px-2 py-0.5 rounded-full text-xs font-mono ${
                  activeTab === 'scheduled'
                    ? 'bg-indigo-700/60 text-indigo-100'
                    : 'bg-slate-800 text-slate-400'
                }`}
              >
                {scheduledEmails.length}
              </span>
            </button>

            <button
              onClick={() => setActiveTab('sent')}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition ${
                activeTab === 'sent'
                  ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                  : 'text-slate-400 hover:text-white hover:bg-slate-900'
              }`}
            >
              <CheckCircle2 className="w-4 h-4" />
              Sent Emails
              <span
                className={`ml-1 px-2 py-0.5 rounded-full text-xs font-mono ${
                  activeTab === 'sent'
                    ? 'bg-indigo-700/60 text-indigo-100'
                    : 'bg-slate-800 text-slate-400'
                }`}
              >
                {sentEmails.length}
              </span>
            </button>
          </div>

          <div className="hidden sm:flex items-center gap-1.5 text-xs text-slate-400">
            <Info className="w-3.5 h-3.5 text-slate-400" />
            <span>Auto-refreshing every 5 seconds</span>
          </div>
        </div>

        {/* Tab Content */}
        {activeTab === 'scheduled' ? (
          <EmailTable
            emails={scheduledEmails}
            type="scheduled"
            loading={loading}
          />
        ) : (
          <EmailTable emails={sentEmails} type="sent" loading={loading} />
        )}
      </main>

      {/* Compose Email Modal */}
      <ComposeModal
        isOpen={isComposeOpen}
        onClose={() => setIsComposeOpen(false)}
        senders={senders}
        onSuccess={handleComposeSuccess}
      />
    </div>
  );
};
export default App;
