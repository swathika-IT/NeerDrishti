import React, { useEffect, useState } from 'react';
import { Briefcase, MapPin, RefreshCw, CheckCircle2, XCircle } from 'lucide-react';
import type { AuthUser } from './AccountView';

interface OfficialWorkspaceViewProps {
  user: AuthUser | null;
  onRequireLogin: () => void;
  onLogout: () => void;
}

const STATUS_OPTIONS = ['PENDING', 'UNDER_REVIEW', 'VERIFIED', 'RESOLVED', 'REJECTED'];

export const OfficialWorkspaceView: React.FC<OfficialWorkspaceViewProps> = ({ user, onRequireLogin }) => {
  const [jurisdictions, setJurisdictions] = useState<string[] | null>(null);
  const [reports, setReports] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const meRes = await fetch('/api/official/me');
      const me = await meRes.json().catch(() => ({}));
      if (!meRes.ok) {
        setError(me?.error || 'Official access is not available.');
        setJurisdictions([]);
        setReports([]);
        return;
      }
      setJurisdictions(me?.jurisdictions || null);
      const repRes = await fetch('/api/official/reports');
      const rep = await repRes.json().catch(() => ({}));
      if (!repRes.ok) {
        setError(rep?.error || 'Could not load reports.');
        setReports([]);
        return;
      }
      setReports(rep.reports || []);
    } catch {
      setError('Network error while loading official workspace.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user) load();
  }, [user]);

  const updateStatus = async (reportId: number, status: string) => {
    setNotice(null);
    setError(null);
    const res = await fetch(`/api/reports/${reportId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data?.error || 'Status update rejected.');
      return;
    }
    setNotice(data?.message || 'Report status updated.');
    load();
  };

  if (!user) {
    return (
      <div className="max-w-lg mx-auto bg-white border border-slate-200 rounded-2xl shadow-sm p-8 text-center space-y-4">
        <Briefcase className="w-8 h-8 text-slate-400 mx-auto" />
        <h2 className="text-lg font-bold text-slate-900">Official sign-in required</h2>
        <p className="text-sm text-slate-500">Official accounts require administrator approval before access is granted.</p>
        <button onClick={onRequireLogin} className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700">
          Go to sign in
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2"><Briefcase className="w-5 h-5 text-blue-600" /> Official Workspace</h2>
          <p className="text-xs text-slate-500">
            {jurisdictions === null
              ? 'Administrator: statewide access'
              : <>Assigned jurisdictions: {jurisdictions.length > 0 ? jurisdictions.join(', ') : 'none assigned'}</>}
          </p>
        </div>
        <button onClick={load} disabled={loading} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-100 text-slate-700 text-xs font-semibold hover:bg-slate-200">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {error && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{error}</div>}
      {notice && <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg p-3">{notice}</div>}

      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2"><MapPin className="w-4 h-4 text-blue-600" /> Reports in your jurisdiction</h3>
          <span className="text-xs text-slate-500">{reports.length} report(s)</span>
        </div>
        {reports.length === 0 ? (
          <p className="p-6 text-xs text-slate-500">No reports visible for your jurisdictions.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {reports.map((r) => (
              <div key={r.id} className="p-4 flex flex-wrap items-start justify-between gap-3">
                <div className="text-xs text-slate-600 space-y-1 max-w-xl">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-slate-800">#{r.id}</span>
                    <span className="px-2 py-0.5 rounded-full bg-slate-100 font-semibold">{r.status}</span>
                    <span className="text-slate-400">{r.district_id}</span>
                    <span className="text-slate-400">· {r.incident_type}</span>
                    <span className={`px-2 py-0.5 rounded-full ${r.severity === 'Critical' ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700'}`}>{r.severity}</span>
                  </div>
                  <p className="text-slate-600">{r.description}</p>
                  {r.location_description && <p className="text-slate-400">Location: {r.location_description}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <select
                    defaultValue=""
                    onChange={(e) => e.target.value && updateStatus(r.id, e.target.value)}
                    className="text-xs px-2 py-1.5 rounded-lg border border-slate-300 bg-white"
                  >
                    <option value="">Set status…</option>
                    {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="text-[11px] text-slate-400 flex items-center gap-2">
        <CheckCircle2 className="w-3.5 h-3.5" /> Status changes are audit-logged and restricted to your assigned districts.
        <XCircle className="w-3.5 h-3.5" /> Cross-jurisdiction actions are rejected by the server.
      </div>
    </div>
  );
};
