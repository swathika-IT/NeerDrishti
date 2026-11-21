import { apiFetch } from '../lib/api';
import React, { useEffect, useState } from 'react';
import { User as UserIcon, LogOut, ShieldCheck, Mail, Briefcase } from 'lucide-react';

export interface AuthUser {
  id: number;
  email: string;
  full_name: string;
  role: 'CITIZEN' | 'OFFICIAL' | 'ADMIN';
  status: string;
  email_verified: boolean;
  created_at: string;
  last_login_at: string | null;
}

interface AccountViewProps {
  user: AuthUser | null;
  onLogout: () => void;
  onGoToAuth: () => void;
}

export const AccountView: React.FC<AccountViewProps> = ({ user, onLogout, onGoToAuth }) => {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [pwMessage, setPwMessage] = useState<string | null>(null);
  const [pwError, setPwError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [department, setDepartment] = useState('');
  const [roleMessage, setRoleMessage] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [myReports, setMyReports] = useState<any[]>([]);

  useEffect(() => {
    if (!user) return;
    fetch('/api/citizen/reports')
      .then(r => (r.ok ? r.json() : { reports: [] }))
      .then(d => setMyReports(d.reports || []))
      .catch(() => setMyReports([]));
  }, [user]);

  if (!user) {
    return (
      <div className="max-w-lg mx-auto bg-white border border-slate-200 rounded-2xl shadow-sm p-8 text-center space-y-4">
        <UserIcon className="w-8 h-8 text-slate-400 mx-auto" />
        <h2 className="text-lg font-bold text-slate-900">Sign in required</h2>
        <p className="text-sm text-slate-500">Create a citizen account or sign in to manage your reports and preferences.</p>
        <button onClick={onGoToAuth} className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700">
          Go to sign in
        </button>
      </div>
    );
  }

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwError(null);
    setPwMessage(null);
    try {
      await apiFetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      });
    } catch (err: any) {
      setPwError(err?.message || 'Could not change password.');
      return;
    }
    setPwMessage('Password changed. Other sessions were signed out.');
    setCurrentPassword('');
    setNewPassword('');
  };

  const requestOfficial = async (e: React.FormEvent) => {
    e.preventDefault();
    setRoleError(null);
    setRoleMessage(null);
    try {
      const data = await apiFetch('/api/auth/role-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, department }),
      });
      setRoleMessage(data?.message || 'Request submitted for administrator review.');
    } catch (err: any) {
      setRoleError(err?.message || 'Could not submit request.');
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-blue-50 rounded-xl">
            <UserIcon className="w-6 h-6 text-blue-600" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-900">{user.full_name}</h2>
            <p className="text-xs text-slate-500 flex items-center gap-2">
              <Mail className="w-3.5 h-3.5" /> {user.email}
              <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 font-semibold">{user.role}</span>
            </p>
            <p className="text-[11px] text-slate-400 mt-1">
              Account status: {user.status} · Email {user.email_verified ? 'verified' : 'not verified (no provider configured)'}
            </p>
          </div>
        </div>
        <button onClick={onLogout} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-rose-50 text-rose-700 border border-rose-200 text-xs font-semibold hover:bg-rose-100">
          <LogOut className="w-3.5 h-3.5" /> Sign out
        </button>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <form onSubmit={changePassword} className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6 space-y-3">
          <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-blue-600" /> Change password</h3>
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
            placeholder="Current password"
            className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            placeholder="New password (min 10, upper, lower, digit)"
            className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button type="submit" className="w-full py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700">Update password</button>
          {pwError && <p className="text-xs text-rose-600">{pwError}</p>}
          {pwMessage && <p className="text-xs text-emerald-600">{pwMessage}</p>}
        </form>

        <form onSubmit={requestOfficial} className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6 space-y-3">
          <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2"><Briefcase className="w-4 h-4 text-blue-600" /> Request official access</h3>
          <p className="text-[11px] text-slate-500">Official accounts require administrator approval and district jurisdiction assignment.</p>
          <input
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            placeholder="Department / organisation"
            className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason for official access"
            rows={3}
            className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button type="submit" className="w-full py-2 rounded-lg bg-slate-800 text-white text-sm font-semibold hover:bg-slate-900">Submit request</button>
          {roleError && <p className="text-xs text-rose-600">{roleError}</p>}
          {roleMessage && <p className="text-xs text-emerald-600">{roleMessage}</p>}
        </form>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6">
        <h3 className="text-sm font-bold text-slate-800 mb-3">My submitted reports ({myReports.length})</h3>
        {myReports.length === 0 ? (
          <p className="text-xs text-slate-500">No reports linked to your account yet. Reports submitted while signed in appear here.</p>
        ) : (
          <ul className="space-y-2">
            {myReports.map((r) => (
              <li key={r.id} className="text-xs border border-slate-200 rounded-lg p-3 flex items-center justify-between gap-3">
                <span className="text-slate-700">
                  <strong>#{r.id}</strong> · {r.incident_type} · {r.district_id} · {r.severity}
                </span>
                <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 font-semibold">{r.status}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
