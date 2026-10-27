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
  ShieldCheck,
  ExternalLink,
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
      setError((err as Error).message || 'Failed to fetch email data from backend');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();

    // Check for Slack integration callback
    const params = new URLSearchParams(window.location.search);
    if (params.get('slack') === 'connected') {
      setSuccessBanner('Slack channel successfully linked for campaign notifications!');
      window.history.replaceState({}, '', window.location.pathname);
    }

    // Auto-refresh every 5 seconds to show real-time transitions (scheduled -> processing -> sent)
    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, [loadData]);

  const handleComposeSuccess = (isImmediate?: boolean) => {
    if (isImmediate) {
      setSuccessBanner('Email campaign dispatched immediately! Monitoring delivery in Sent tab.');
      setActiveTab('sent');
    } else {
      setSuccessBanner('New email campaign successfully scheduled into BullMQ queue!');
      setActiveTab('scheduled');
    }
    loadData();
    // Re-check after 1.5s to capture the worker's processing completion and state change
    setTimeout(loadData, 1500);
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
        {/* Error Notification */}
        {error && (
          <div className="flex items-center gap-3 p-4 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm">
            <AlertTriangle className="w-5 h-5 shrink-0 text-rose-400" />
            <div className="flex-1">
              <span className="font-semibold">Notice:</span> {error}
            </div>
            <button
              onClick={loadData}
              className="px-3 py-1 text-xs rounded-lg bg-rose-500/20 hover:bg-rose-500/30 font-medium"
            >
              Retry
            </button>
          </div>
        )}

        {/* Success Banner */}
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

        {/* Admin Access Section for Hiring Reviewers */}
        <section
          aria-labelledby="admin-access-heading"
          className="p-4 sm:p-5 rounded-2xl bg-gradient-to-r from-slate-900 via-slate-900/90 to-indigo-950/30 border border-slate-800 hover:border-indigo-500/30 transition shadow-lg shadow-black/20 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4"
        >
          <div className="flex items-start sm:items-center gap-3.5">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center shrink-0 text-indigo-400">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="admin-access-heading" className="text-sm font-semibold text-white tracking-wide">
                  Admin Access
                </h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-400/10 text-amber-300 border border-amber-400/20">
                  For authorized hiring reviewers
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-1 flex flex-wrap items-center gap-1.5">
                <span>Manage BullMQ email queues, retry failed jobs, and monitor worker concurrency.</span>
                <span className="text-slate-300">
                  Username: <code className="px-1.5 py-0.5 rounded bg-slate-800/80 border border-slate-700 text-indigo-300 font-mono text-[11px]">admin</code>
                </span>
              </p>
            </div>
          </div>

          <a
            href="/admin/queues"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs sm:text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white shadow-md shadow-indigo-600/25 transition transform hover:-translate-y-0.5 shrink-0 self-stretch sm:self-auto justify-center"
          >
            <ExternalLink className="w-4 h-4" />
            <span>Open Admin Dashboard</span>
          </a>
        </section>

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
