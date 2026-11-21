import { apiFetch, ApiError } from '../lib/api';
import React, { useState, useEffect } from 'react';
import type { AuthUser } from './AccountView';

interface AuthViewProps {
  onAuthenticated: (user: AuthUser | null) => void;
}

type Mode = 'login' | 'register' | 'forgot' | 'reset' | 'setup' | 'verify';

export const AuthView: React.FC<AuthViewProps> = ({ onAuthenticated }) => {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [token, setToken] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const verifyToken = params.get('verify_email');
    const resetToken = params.get('reset_password');
    if (verifyToken) {
      setToken(verifyToken);
      setMode('verify');
      window.history.replaceState(null, '', window.location.pathname);
      return;
    }
    if (resetToken) {
      setToken(resetToken);
      setMode('reset');
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  const post = async (path: string, body: Record<string, any>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      return await apiFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err: any) {
      setError(err instanceof ApiError ? err.message : 'Unexpected error. Please try again.');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === 'login') {
      const data = await post('/api/auth/login', { email, password });
      if (data?.user) {
        setMessage('Signed in.');
        onAuthenticated(data.user);
      }
    } else if (mode === 'register') {
      const data = await post('/api/auth/register', { email, password, full_name: fullName });
      if (data?.success) {
        setMessage(
          data?.dev_verification_token
            ? `Account created. Dev verification token: ${data.dev_verification_token}`
            : (data?.message || 'Account created. You can sign in now.')
        );
        setMode('login');
      }
    } else if (mode === 'forgot') {
      const data = await post('/api/auth/forgot-password', { email });
      if (data) {
        setMessage(
          data?.dev_reset_token
            ? `Reset requested. Dev reset token: ${data.dev_reset_token}`
            : (data?.message || 'If that email exists, a reset link will be generated.')
        );
      }
    } else if (mode === 'reset') {
      const data = await post('/api/auth/reset-password', { token, new_password: password });
      if (data?.success) {
        setMessage('Password reset. Please sign in.');
        setMode('login');
      }
    } else if (mode === 'verify') {
      const data = await post('/api/auth/verify-email', { token });
      if (data?.success) {
        setMessage('Email verified. You can now sign in.');
        setMode('login');
      }
    } else if (mode === 'setup') {
      const data = await post('/api/auth/setup-admin', { token, email, password });
      if (data?.success) {
        setMessage('Administrator created. Please sign in.');
        setMode('login');
      }
    }
  };

  const titles: Record<Mode, string> = {
    login: 'Sign in',
    register: 'Create citizen account',
    forgot: 'Reset your password',
    reset: 'Set a new password',
    setup: 'First administrator setup',
    verify: 'Verify email address',
  };

  return (
    <div className="max-w-md mx-auto bg-white border border-slate-200 rounded-2xl shadow-sm p-6 sm:p-8 space-y-5">
      <div className="space-y-1">
        <h2 className="text-xl font-bold text-slate-900">{titles[mode]}</h2>
        <p className="text-xs text-slate-500">
          Public dashboards and maps remain available without an account. Accounts are required to submit and manage your own reports.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        {(['login', 'register', 'forgot', 'reset'] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => { setMode(m); setError(null); setMessage(null); }}
            className={`px-3 py-1.5 rounded-full font-semibold border ${mode === m ? 'bg-blue-600 text-white border-blue-600' : 'bg-slate-100 text-slate-600 border-slate-200 hover:bg-slate-200'}`}
          >
            {m === 'login' ? 'Login' : m === 'register' ? 'Register' : m === 'forgot' ? 'Forgot password' : 'Use reset token'}
          </button>
        ))}
        <button
          type="button"
          onClick={() => { setMode('setup'); setError(null); setMessage(null); }}
          className={`px-3 py-1.5 rounded-full font-semibold border ${mode === 'setup' ? 'bg-slate-800 text-white border-slate-800' : 'bg-slate-100 text-slate-500 border-slate-200 hover:bg-slate-200'}`}
        >
          Admin setup
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        {mode === 'register' && (
          <label className="block text-xs font-semibold text-slate-600">
            Full name
            <input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
              className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Your full name"
            />
          </label>
        )}

        {(mode === 'login' || mode === 'register' || mode === 'forgot' || mode === 'setup') && (
          <label className="block text-xs font-semibold text-slate-600">
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="you@example.com"
            />
          </label>
        )}

        {(mode === 'reset' || mode === 'setup' || mode === 'verify') && (
          <label className="block text-xs font-semibold text-slate-600">
            {mode === 'setup' ? 'One-time setup token (printed in the server console)' : mode === 'verify' ? 'Verification token' : 'Reset token'}
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
              className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Paste token"
            />
          </label>
        )}

        {(mode === 'login' || mode === 'register' || mode === 'reset' || mode === 'setup') && (
          <label className="block text-xs font-semibold text-slate-600">
            {mode === 'reset' ? 'New password' : 'Password'}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder={mode === 'login' ? 'Your password' : 'Min 10 chars, upper, lower, digit'}
            />
          </label>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full py-2.5 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-60"
        >
          {busy ? 'Please wait…' : titles[mode]}
        </button>
      </form>

      {error && (
        <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{error}</div>
      )}
      {message && (
        <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg p-3 break-words">{message}</div>
      )}

      <p className="text-[11px] text-slate-400">
        Email delivery remains disabled in this environment; no message is delivered while MAIL_DRY_RUN=true. Verification links use APP_BASE_URL.
      </p>
    </div>
  );
};
