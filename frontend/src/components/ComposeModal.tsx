import React, { useState, useMemo } from 'react';
import { X, Upload, Send, AlertCircle, CheckCircle, Clock } from 'lucide-react';
import { SenderRecord, SchedulePayload } from '../types';
import { scheduleEmails } from '../api/client';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  senders: SenderRecord[];
  onSuccess: (isImmediate?: boolean) => void;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const ComposeModal: React.FC<Props> = ({
  isOpen,
  onClose,
  senders,
  onSuccess,
}) => {
  const [selectedSenderId, setSelectedSenderId] = useState<string>('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [recipientInput, setRecipientInput] = useState('');
  const [sendType, setSendType] = useState<'now' | 'scheduled'>('now');
  const [scheduledDateTime, setScheduledDateTime] = useState('');
  const [delaySeconds, setDelaySeconds] = useState<number>(0);
  const [hourlyLimit, setHourlyLimit] = useState<number>(50);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Parse and extract valid emails from text input
  const detectedEmails = useMemo(() => {
    const rawTokens = recipientInput
      .split(/[\r\n,; \t]+/)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);

    const valid = rawTokens.filter((token) => EMAIL_REGEX.test(token));
    return Array.from(new Set(valid));
  }, [recipientInput]);

  // Handle CSV / TXT file drop or selection
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (content) {
        setRecipientInput((prev) => (prev ? `${prev}\n${content}` : content));
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (detectedEmails.length === 0) {
      setError('Please provide at least one valid recipient email address.');
      return;
    }
    if (!subject.trim()) {
      setError('Subject cannot be empty.');
      return;
    }
    if (!body.trim()) {
      setError('Email body cannot be empty.');
      return;
    }

    const isNow = sendType === 'now';
    let startTimeISO: string | undefined = undefined;
    if (!isNow) {
      if (!scheduledDateTime) {
        setError('Please select a scheduled date and time.');
        return;
      }
      startTimeISO = new Date(scheduledDateTime).toISOString();
    }

    try {
      setLoading(true);
      const payload: SchedulePayload = {
        senderId: selectedSenderId || undefined,
        subject: subject.trim(),
        body: body.trim(),
        recipients: detectedEmails,
        startTime: startTimeISO,
        delaySeconds: isNow && detectedEmails.length === 1 ? 0 : delaySeconds,
        hourlyLimit,
        sendNow: isNow,
      };

      await scheduleEmails(payload);
      onSuccess(isNow);
      onClose();
      // Reset form
      setSubject('');
      setBody('');
      setRecipientInput('');
      setSendType('now');
      setScheduledDateTime('');
      setDelaySeconds(0);
    } catch (err: unknown) {
      setError((err as Error).message || 'Failed to dispatch emails');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/60">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <Send className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Compose New Campaign</h2>
              <p className="text-xs text-slate-400">
                {sendType === 'now'
                  ? 'Immediate dispatch into BullMQ processing queue'
                  : 'Schedule persistent jobs via BullMQ & Redis'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <form onSubmit={handleSubmit} className="p-6 overflow-y-auto space-y-5 flex-1">
          {error && (
            <div className="flex items-start gap-3 p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm">
              <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 text-rose-400" />
              <span>{error}</span>
            </div>
          )}

          {/* Sender Identity */}
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
              From Sender Identity
            </label>
            <select
              value={selectedSenderId}
              onChange={(e) => setSelectedSenderId(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition"
            >
              <option value="">Default Active Sender (Auto-selected)</option>
              {senders.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.email} ({s.smtpHost} - {s.hourlyLimit} emails/hr)
                </option>
              ))}
            </select>
          </div>

          {/* Recipients Input & CSV Drop */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                Recipients (Emails or CSV)
              </label>
              <label className="inline-flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 cursor-pointer font-medium">
                <Upload className="w-3.5 h-3.5" />
                Upload CSV / TXT
                <input
                  type="file"
                  accept=".csv,.txt"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </label>
            </div>
            <textarea
              rows={3}
              placeholder="Paste comma or newline separated email addresses..."
              value={recipientInput}
              onChange={(e) => setRecipientInput(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono transition"
            />
            <div className="flex items-center justify-between mt-1.5">
              <span className="text-xs text-slate-400">
                Supports copy-pasting raw text or CSV email lists
              </span>
              <span
                className={`text-xs px-2.5 py-0.5 rounded-md font-medium flex items-center gap-1 ${
                  detectedEmails.length > 0
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                    : 'bg-slate-800 text-slate-500'
                }`}
              >
                <CheckCircle className="w-3 h-3" />
                {detectedEmails.length} recipient(s) detected
              </span>
            </div>
          </div>

          {/* Subject */}
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
              Subject Line
            </label>
            <input
              type="text"
              placeholder="e.g. Quick follow-up on our meeting"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition"
            />
          </div>

          {/* Email Body */}
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
              Email Content
            </label>
            <textarea
              rows={5}
              placeholder="Type your email body here..."
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition"
            />
          </div>

          {/* Scheduling & Rate Limiting Controls */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 p-4 rounded-xl bg-slate-950 border border-slate-800/80">
            {/* Delivery Timing */}
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                Dispatch Schedule
              </label>
              <div className="flex rounded-lg bg-slate-900 p-0.5 border border-slate-800 text-xs">
                <button
                  type="button"
                  onClick={() => setSendType('now')}
                  className={`flex-1 py-1.5 rounded-md font-medium transition ${
                    sendType === 'now'
                      ? 'bg-indigo-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Send Now
                </button>
                <button
                  type="button"
                  onClick={() => setSendType('scheduled')}
                  className={`flex-1 py-1.5 rounded-md font-medium transition ${
                    sendType === 'scheduled'
                      ? 'bg-indigo-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Scheduled
                </button>
              </div>
              {sendType === 'scheduled' && (
                <div className="mt-2">
                  <input
                    type="datetime-local"
                    value={scheduledDateTime}
                    onChange={(e) => setScheduledDateTime(e.target.value)}
                    className="w-full px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
              )}
            </div>

            {/* Delay Seconds */}
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                Delay Between Emails
              </label>
              <div className="relative">
                <input
                  type="number"
                  min="0"
                  max="3600"
                  value={delaySeconds}
                  onChange={(e) => setDelaySeconds(Math.max(0, parseInt(e.target.value) || 0))}
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 pr-12"
                />
                <span className="absolute right-3 top-2 text-[10px] text-slate-500">
                  seconds
                </span>
              </div>
              <span className="text-[10px] text-slate-500 mt-1 block">
                Paces out batch delivery
              </span>
            </div>

            {/* Hourly Limit */}
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                Hourly Rate Limit
              </label>
              <div className="relative">
                <input
                  type="number"
                  min="1"
                  max="1000"
                  value={hourlyLimit}
                  onChange={(e) => setHourlyLimit(Math.max(1, parseInt(e.target.value) || 50))}
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 pr-12"
                />
                <span className="absolute right-3 top-2 text-[10px] text-slate-500">
                  per hr
                </span>
              </div>
              <span className="text-[10px] text-slate-500 mt-1 block">
                Redis sliding window limit
              </span>
            </div>
          </div>

          {/* Modal Footer */}
          <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 rounded-xl text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/25 transition disabled:opacity-50"
            >
              {loading ? (
                <>
                  <Clock className="w-4 h-4 animate-spin" />
                  {sendType === 'now' ? 'Dispatching Immediately...' : 'Scheduling Queue...'}
                </>
              ) : (
                <>
                  {sendType === 'now' ? <Send className="w-4 h-4" /> : <Clock className="w-4 h-4" />}
                  {sendType === 'now'
                    ? `Send Now ${detectedEmails.length > 0 ? `(${detectedEmails.length})` : ''}`
                    : `Schedule Campaign ${detectedEmails.length > 0 ? `(${detectedEmails.length})` : ''}`}
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
