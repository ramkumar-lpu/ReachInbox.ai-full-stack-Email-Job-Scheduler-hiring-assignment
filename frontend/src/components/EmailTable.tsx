import React, { useState, useEffect } from 'react';
import { EmailRecord, EmailStatus } from '../types';
import { StatusBadge } from './StatusBadge';
import { Search, Mail, AlertTriangle, Calendar, User, Database, Zap } from 'lucide-react';
import { searchEmails } from '../api/client';

interface Props {
  emails: EmailRecord[];
  type: 'scheduled' | 'sent';
  loading: boolean;
}

export const EmailTable: React.FC<Props> = ({ emails, type, loading }) => {
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<EmailRecord[] | null>(null);
  const [searchSource, setSearchSource] = useState<string>('');
  const [searching, setSearching] = useState(false);

  // Debounced search querying Elasticsearch / backend API
  useEffect(() => {
    if (!search.trim()) {
      setSearchResults(null);
      setSearchSource('');
      return;
    }

    const timer = setTimeout(async () => {
      try {
        setSearching(true);
        const res = await searchEmails(search, type);
        setSearchResults(res.data);
        setSearchSource(res.source);
      } catch (err) {
        console.error('Search query failed:', err);
      } finally {
        setSearching(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [search, type]);

  const displayedEmails = searchResults !== null ? searchResults : emails;

  if (loading) {
    return (
      <div className="bg-slate-900/50 border border-slate-800 rounded-2xl p-12 text-center">
        <div className="inline-block w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mb-4" />
        <p className="text-sm text-slate-400">Loading email records...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Search Bar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md w-full">
          <Search className="absolute left-3.5 top-3 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search by recipient, subject, or content..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition"
          />
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-400 font-medium">
          {searching && <span className="text-indigo-400 animate-pulse">Searching ES8...</span>}
          {searchSource && (
            <span className="flex items-center gap-1 px-2.5 py-0.5 rounded-md bg-slate-800 text-slate-300 border border-slate-700">
              {searchSource === 'elasticsearch' ? (
                <>
                  <Zap className="w-3 h-3 text-amber-400" />
                  Elasticsearch 8
                </>
              ) : (
                <>
                  <Database className="w-3 h-3 text-blue-400" />
                  PostgreSQL
                </>
              )}
            </span>
          )}
          <span>
            Showing {displayedEmails.length} of {emails.length} record(s)
          </span>
        </div>
      </div>

      {/* Table Container */}
      <div className="overflow-hidden bg-slate-900/70 border border-slate-800 rounded-2xl shadow-xl">
        {displayedEmails.length === 0 ? (
          <div className="py-16 text-center">
            <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-slate-800/80 border border-slate-700/50 flex items-center justify-center text-slate-400">
              <Mail className="w-6 h-6" />
            </div>
            <h3 className="text-base font-semibold text-white mb-1">
              {search ? 'No Matching Emails Found' : type === 'scheduled' ? 'No Scheduled Emails in Queue' : 'No Sent Emails Yet'}
            </h3>
            <p className="text-xs text-slate-400 max-w-sm mx-auto">
              {search
                ? `No emails matched "${search}". Try searching for another keyword or recipient.`
                : type === 'scheduled'
                ? 'Compose a new email campaign to see queued delayed jobs.'
                : 'Emails dispatched by the BullMQ worker will show their delivery history here.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-950/80 border-b border-slate-800 text-xs text-slate-400 uppercase font-semibold tracking-wider">
                <tr>
                  <th className="px-6 py-3.5">Recipient</th>
                  <th className="px-6 py-3.5">Subject & Content</th>
                  <th className="px-6 py-3.5">Sender</th>
                  <th className="px-6 py-3.5">
                    {type === 'scheduled' ? 'Scheduled At' : 'Sent At'}
                  </th>
                  <th className="px-6 py-3.5">Status</th>
                  <th className="px-6 py-3.5">Attempts</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {displayedEmails.map((email) => {
                  const displayDate =
                    type === 'scheduled'
                      ? new Date(email.scheduledAt).toLocaleString()
                      : email.sentAt
                      ? new Date(email.sentAt).toLocaleString()
                      : new Date(email.updatedAt).toLocaleString();

                  return (
                    <tr
                      key={email.id}
                      className="hover:bg-slate-800/30 transition group"
                    >
                      <td className="px-6 py-4 font-medium text-slate-200">
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-indigo-500" />
                          <span className="font-mono text-xs">{email.recipient}</span>
                        </div>
                      </td>

                      <td className="px-6 py-4 max-w-xs">
                        <div className="font-medium text-slate-100 truncate">
                          {email.subject}
                        </div>
                        <div className="text-xs text-slate-400 truncate">
                          {email.body}
                        </div>
                        {email.error && (
                          <div className="mt-1 flex items-center gap-1 text-[11px] text-rose-400 font-medium">
                            <AlertTriangle className="w-3 h-3 shrink-0" />
                            <span className="truncate">{email.error}</span>
                          </div>
                        )}
                      </td>

                      <td className="px-6 py-4 text-xs text-slate-400">
                        <div className="flex items-center gap-1.5 text-slate-300">
                          <User className="w-3.5 h-3.5 text-slate-500" />
                          <span>{email.sender?.email || 'Default Sender'}</span>
                        </div>
                        {email.sender?.smtpHost && (
                          <div className="text-[11px] text-slate-500 ml-5 font-mono">
                            {email.sender.smtpHost}
                          </div>
                        )}
                      </td>

                      <td className="px-6 py-4 text-xs text-slate-300 whitespace-nowrap">
                        <div className="flex items-center gap-1.5 text-slate-400">
                          <Calendar className="w-3.5 h-3.5 text-slate-500" />
                          <span>{displayDate}</span>
                        </div>
                      </td>

                      <td className="px-6 py-4 whitespace-nowrap">
                        <StatusBadge status={email.status as EmailStatus} />
                      </td>

                      <td className="px-6 py-4 text-xs text-slate-400 whitespace-nowrap font-mono">
                        {email.attemptCount} attempt(s)
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
