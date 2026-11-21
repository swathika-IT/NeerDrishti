import React, { useEffect, useState } from 'react';
import { ShieldCheck, Users, ClipboardList, RefreshCw, FileClock } from 'lucide-react';
import type { AuthUser } from './AccountView';

interface AdminConsoleViewProps {
  user: AuthUser | null;
  onRequireLogin: () => void;
  onLogout: () => void;
}

export const AdminConsoleView: React.FC<AdminConsoleViewProps> = ({ user, onRequireLogin }) => {
  const [overview, setOverview] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [roleRequests, setRoleRequests] = useState<any[]>([]);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [jurisdictionInput, setJurisdictionInput] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const [ov, us, rr, al] = await Promise.all([
        fetch('/api/admin/overview'),
        fetch('/api/admin/users'),
        fetch('/api/admin/role-requests'),
        fetch('/api/admin/audit-logs?limit=50'),
      ]);
      if (!ov.ok || !us.ok || !rr.ok || !al.ok) {
        const first = !ov.ok ? ov : !us.ok ? us : !rr.ok ? rr : al;
        const body = await first.json().catch(() => ({}));
        setError(body?.error || 'Administrator access required.');
        return;
      }
      setOverview(await ov.json());
      setUsers((await us.json()).users || []);
      setRoleRequests((await rr.json()).role_requests || []);
      setAuditLogs((await al.json()).audit_logs || []);
    } catch {
      setError('Network error while loading admin console.');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (user?.role === 'ADMIN') load();
  }, [user]);

  const act = async (path: string, body?: Record<string, any>) => {
    setNotice(null);
    setError(null);
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data?.error || 'Action rejected.');
      return;
    }
    setNotice('Action applied.');
    load();
  };

  if (!user || user.role !== 'ADMIN') {
    return (
      <div className="max-w-lg mx-auto bg-white border border-slate-200 rounded-2xl shadow-sm p-8 text-center space-y-4">
        <ShieldCheck className="w-8 h-8 text-slate-400 mx-auto" />
        <h2 className="text-lg font-bold text-slate-900">Administrator access required</h2>
        <p className="text-sm text-slate-500">This console is restricted to administrator accounts.</p>
        {!user && (
          <button onClick={onRequireLogin} className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700">
            Go to sign in
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2"><ShieldCheck className="w-5 h-5 text-blue-600" /> Admin Console</h2>
        <button onClick={load} disabled={busy} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-100 text-slate-700 text-xs font-semibold hover:bg-slate-200">
          <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {error && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{error}</div>}
      {notice && <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg p-3">{notice}</div>}

      {overview && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            ['Users', overview.users_total],
            ['Citizens', overview.citizens],
            ['Officials', overview.officials],
            ['Admins', overview.admins],
            ['Pending official requests', overview.pending_role_requests],
            ['Active sessions', overview.active_sessions],
            ['Audit events', overview.audit_events],
          ].map(([label, value]) => (
            <div key={String(label)} className="bg-white border border-slate-200 rounded-xl shadow-sm p-4">
              <p className="text-[11px] text-slate-500">{label}</p>
              <p className="text-xl font-black text-slate-900">{String(value)}</p>
            </div>
          ))}
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
          <ClipboardList className="w-4 h-4 text-blue-600" />
          <h3 className="text-sm font-bold text-slate-800">Official access requests</h3>
        </div>
        {roleRequests.length === 0 ? (
          <p className="p-6 text-xs text-slate-500">No role requests.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {roleRequests.map((rr) => (
              <div key={rr.id} className="p-4 space-y-2">
                <div className="flex items-center gap-2 text-xs text-slate-600">
                  <span className="font-bold text-slate-800">{rr.full_name}</span>
                  <span className="text-slate-400">{rr.email}</span>
                  <span className={`px-2 py-0.5 rounded-full font-semibold ${rr.status === 'PENDING' ? 'bg-amber-100 text-amber-700' : rr.status === 'APPROVED' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>{rr.status}</span>
                  {rr.department && <span className="text-slate-400">· {rr.department}</span>}
                </div>
                {rr.reason && <p className="text-xs text-slate-500">“{rr.reason}”</p>}
                {rr.status === 'PENDING' && (
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      value={jurisdictionInput[rr.id] || ''}
                      onChange={(e) => setJurisdictionInput(prev => ({ ...prev, [rr.id]: e.target.value }))}
                      placeholder="District IDs, comma separated (e.g. hyderabad, warangal)"
                      className="px-3 py-1.5 rounded-lg border border-slate-300 text-xs w-80"
                    />
                    <button
                      onClick={() => act(`/api/admin/role-requests/${rr.id}/approve`, {
                        jurisdictions: (jurisdictionInput[rr.id] || '').split(',').map(s => s.trim()).filter(Boolean),
                      })}
                      className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => act(`/api/admin/role-requests/${rr.id}/reject`, { note: 'Rejected by administrator' })}
                      className="px-3 py-1.5 rounded-lg bg-rose-600 text-white text-xs font-semibold hover:bg-rose-700"
                    >
                      Reject
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
          <Users className="w-4 h-4 text-blue-600" />
          <h3 className="text-sm font-bold text-slate-800">Users</h3>
        </div>
        {users.length === 0 ? (
          <p className="p-6 text-xs text-slate-500">No users.</p>
        ) : (
          <div className="divide-y divide-slate-100 max-h-96 overflow-auto">
            {users.map((u) => (
              <div key={u.id} className="px-4 py-3 flex items-center justify-between gap-3 text-xs">
                <div className="text-slate-600">
                  <span className="font-bold text-slate-800">{u.full_name}</span> · {u.email} · <span className="font-semibold">{u.role}</span> · {u.status}
                </div>
                <select
                  defaultValue=""
                  onChange={(e) => e.target.value && act(`/api/admin/users/${u.id}/status`, { status: e.target.value })}
                  className="text-xs px-2 py-1.5 rounded-lg border border-slate-300 bg-white"
                >
                  <option value="">Change status…</option>
                  <option value="ACTIVE">ACTIVE</option>
                  <option value="SUSPENDED">SUSPENDED</option>
                  <option value="DEACTIVATED">DEACTIVATED</option>
                </select>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
          <FileClock className="w-4 h-4 text-blue-600" />
          <h3 className="text-sm font-bold text-slate-800">Recent audit events</h3>
        </div>
        {auditLogs.length === 0 ? (
          <p className="p-6 text-xs text-slate-500">No audit events yet.</p>
        ) : (
          <div className="divide-y divide-slate-100 max-h-80 overflow-auto font-mono text-[11px]">
            {auditLogs.map((l) => (
              <div key={l.id} className="px-4 py-2 text-slate-600">
                <span className="text-slate-400">{l.created_at}</span> · <span className="font-semibold text-slate-800">{l.action}</span>
                {l.actor_user_id ? ` · actor ${l.actor_user_id}` : ''} · {l.entity_type}{l.entity_id ? `#${l.entity_id}` : ''}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
