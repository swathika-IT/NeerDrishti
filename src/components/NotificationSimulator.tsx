import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, Smartphone, Mail, ShieldCheck, Lock, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import type { DistrictStatus } from '../types';
import { apiFetch } from '../lib/api';

type Channel = 'WHATSAPP' | 'SMS' | 'EMAIL';
type Lang = 'en' | 'te' | 'hi';
const SEVS = ['NORMAL', 'WATCH', 'ELEVATED', 'HIGH', 'CRITICAL'] as const;
const IST = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'medium' });
const fmtIst = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : `${IST.format(d)} IST`; };
const newKey = () => `sim-${crypto.randomUUID()}`;

interface Props { districts: DistrictStatus[]; user: { role: string } | null }

export const NotificationSimulator: React.FC<Props> = ({ districts, user }) => {
  const [districtId, setDistrictId] = useState<string>(() => (districts[0] as any)?.district_id || '');
  const [severity, setSeverity] = useState<string>('ACTUAL');
  const [language, setLanguage] = useState<Lang>('en');
  const [channel, setChannel] = useState<Channel>('WHATSAPP');
  const [contact, setContact] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const keyRef = useRef<string>(newKey());   // reused across double-clicks; regenerated when inputs change or after success
  const isAdmin = user?.role === 'ADMIN';

  const params = useMemo(() => ({ district_id: districtId, language, channel, ...(severity !== 'ACTUAL' ? { severity } : {}) }), [districtId, language, channel, severity]);

  useEffect(() => { keyRef.current = newKey(); setResult(null); setError(null); }, [districtId, language, channel, severity, contact]);

  useEffect(() => {
    if (!isAdmin || !districtId) return;
    const t = setTimeout(() => {
      apiFetch('/api/notifications/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) })
        .then(d => { setPreview(d); setPreviewErr(null); })
        .catch(e => { setPreview(null); setPreviewErr(e.message); });
    }, 200);
    return () => clearTimeout(t);
  }, [params, isAdmin, districtId]);

  const loadHistory = useCallback(() => {
    if (!isAdmin) return;
    apiFetch('/api/notifications/simulations?limit=10').then(d => setHistory(d.simulations || [])).catch(() => setHistory([]));
  }, [isAdmin]);
  useEffect(loadHistory, [loadHistory]);

  const run = async () => {
    if (busy) return;                      // frontend guard against double submission
    setBusy(true); setError(null);
    try {
      const r = await apiFetch('/api/notifications/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': keyRef.current },
        body: JSON.stringify({ ...params, contact: contact.trim() || undefined }),
      });
      setResult(r); loadHistory(); keyRef.current = newKey();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const Header = (
    <div className="flex items-center gap-3">
      <div className="p-2.5 rounded-xl bg-indigo-50"><ShieldCheck className="w-6 h-6 text-indigo-600" aria-hidden /></div>
      <div>
        <h2 className="text-xl font-bold text-slate-900">Notification Simulator</h2>
        <p className="text-sm text-slate-600">Rehearse WhatsApp, SMS and email messages. <b>Nothing is ever sent.</b></p>
      </div>
    </div>
  );

  if (!isAdmin) {
    return (
      <section className="mt-8 rounded-2xl border border-slate-300 bg-white p-6" aria-labelledby="sim-title">
        {Header}
        <p className="mt-4 flex items-center gap-2 text-sm text-slate-700"><Lock className="w-4 h-4" aria-hidden />Sign in as an administrator to use the simulator. Messaging actions are never available to public users.</p>
      </section>
    );
  }

  const sel = districts.find(d => (d as any).district_id === districtId);
  const pv = preview?.preview;
  const seg = (on: boolean) => `px-3 py-2 rounded-lg text-sm font-semibold border-2 ${on ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700 border-slate-300 hover:border-slate-500'}`;

  return (
    <section className="mt-8 rounded-2xl border border-slate-300 bg-white p-5 sm:p-6 space-y-6" aria-labelledby="sim-title">
      <div id="sim-title">{Header}</div>
      <div role="note" className="flex gap-2 rounded-lg bg-emerald-50 border border-emerald-300 p-3 text-sm text-emerald-950">
        <ShieldCheck className="w-5 h-5 shrink-0" aria-hidden />
        <span>Safe demo mode: <b>DRY_RUN</b>. No provider is contacted, so a simulation is never a delivered alert.</span>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Controls */}
        <div className="space-y-5">
          <div>
            <label htmlFor="sim-district" className="block text-sm font-bold text-slate-800">1 · District</label>
            <select id="sim-district" value={districtId} onChange={e => setDistrictId(e.target.value)} className="mt-1 w-full border-2 border-slate-300 rounded-lg px-3 py-2">
              {districts.slice().sort((a, b) => a.district.localeCompare(b.district)).map(d => <option key={(d as any).district_id} value={(d as any).district_id}>{d.district}</option>)}
            </select>
          </div>
          <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm">
            <p className="font-bold text-slate-800">2 · Actual district risk</p>
            {sel ? <p className="mt-1 text-slate-700">{sel.district}: <b>{sel.risk_category}</b> · score {sel.flood_risk_score.toFixed(1)} / 100 → alert level <b>{preview?.district?.actual_severity ?? '…'}</b></p> : null}
          </div>
          <div>
            <label htmlFor="sim-sev" className="block text-sm font-bold text-slate-800">3 · Preview severity</label>
            <select id="sim-sev" value={severity} onChange={e => setSeverity(e.target.value)} className="mt-1 w-full border-2 border-slate-300 rounded-lg px-3 py-2">
              <option value="ACTUAL">Use actual risk ({preview?.district?.actual_severity ?? '…'})</option>
              {SEVS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            {preview?.severity_override && (
              <p className="mt-2 inline-flex items-center gap-1.5 rounded bg-amber-100 border border-amber-400 px-2 py-1 text-xs font-bold text-amber-950"><AlertTriangle className="w-3.5 h-3.5" aria-hidden />MANUAL OVERRIDE: preview severity differs from the actual district risk</p>
            )}
          </div>
          <fieldset><legend className="block text-sm font-bold text-slate-800">4 · Language</legend>
            <div className="mt-1 flex gap-2">{([['en', 'English'], ['te', 'తెలుగు'], ['hi', 'हिन्दी']] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={language === k} onClick={() => setLanguage(k)} className={seg(language === k)}>{l}</button>)}</div>
          </fieldset>
          <fieldset><legend className="block text-sm font-bold text-slate-800">5 · Channel</legend>
            <div className="mt-1 flex flex-wrap gap-2">{([['WHATSAPP', 'WhatsApp', MessageSquare], ['SMS', 'SMS', Smartphone], ['EMAIL', 'Email', Mail]] as const).map(([k, l, I]) => <button key={k} type="button" aria-pressed={channel === k} onClick={() => setChannel(k)} className={`${seg(channel === k)} inline-flex items-center gap-1.5`}><I className="w-4 h-4" aria-hidden />{l}</button>)}</div>
          </fieldset>
          <div>
            <label htmlFor="sim-contact" className="block text-sm font-bold text-slate-800">6 · Demo contact <span className="font-normal text-slate-500">(optional, opted-in)</span></label>
            <input id="sim-contact" value={contact} onChange={e => setContact(e.target.value)} inputMode={channel === 'EMAIL' ? 'email' : 'tel'} autoComplete="off"
              placeholder={channel === 'EMAIL' ? 'demo@example.com' : '+919876543210'} className="mt-1 w-full border-2 border-slate-300 rounded-lg px-3 py-2" />
            <p className="mt-1 text-xs text-slate-500">Only a masked version is stored and displayed.</p>
          </div>
        </div>

        {/* Preview */}
        <div>
          <p className="text-sm font-bold text-slate-800">7 · Preview</p>
          <div className="mt-2 rounded-xl border border-slate-200 bg-slate-100 p-4 min-h-[200px]" aria-live="polite">
            {previewErr && <p className="text-sm text-red-700">{previewErr}</p>}
            {!pv && !previewErr && <p className="text-sm text-slate-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden />Preparing preview…</p>}
            {pv && pv.channel === 'WHATSAPP' && (
              <div>
                <div className="ml-auto max-w-[92%] rounded-2xl rounded-tr-sm bg-[#dcf8c6] px-4 py-3 text-[15px] text-slate-900 shadow-sm whitespace-pre-line">{pv.body}
                  <div className="mt-1 text-right text-[11px] text-slate-500">demo · ✓✓ not sent</div></div>
                <p className="mt-2 text-xs text-slate-600">{pv.metrics.characters} characters</p>
              </div>
            )}
            {pv && pv.channel === 'SMS' && (
              <div>
                <div className="max-w-[92%] rounded-2xl rounded-tl-sm bg-white px-4 py-3 text-[15px] text-slate-900 shadow-sm border border-slate-200 whitespace-pre-line">{pv.body}</div>
                <p className="mt-2 text-xs text-slate-700"><b>{pv.metrics.sms.encoding}</b> · {pv.metrics.sms.units} units · about <b>{pv.metrics.sms.segments}</b> segment{pv.metrics.sms.segments === 1 ? '' : 's'} ({pv.metrics.sms.per_segment_limit} per segment)</p>
                <p className="text-xs text-slate-500">{pv.metrics.sms.note}</p>
              </div>
            )}
            {pv && pv.channel === 'EMAIL' && (
              <div className="rounded-lg bg-white border border-slate-200 shadow-sm">
                <div className="border-b border-slate-200 px-4 py-2 text-sm"><span className="text-slate-500">Subject: </span><b>{pv.subject}</b></div>
                <div className="px-4 py-3 text-sm text-slate-900 whitespace-pre-line">{pv.body}</div>
              </div>
            )}
          </div>

          <button type="button" onClick={run} disabled={busy || !pv} className="mt-4 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 text-base font-bold text-white hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed">
            {busy ? <Loader2 className="w-5 h-5 animate-spin motion-reduce:animate-none" aria-hidden /> : <CheckCircle2 className="w-5 h-5" aria-hidden />}
            8 · {busy ? 'Running simulation…' : 'Run simulation'}
          </button>
          {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
          {result && (
            <div role="status" className="mt-4 rounded-xl border-2 border-emerald-500 bg-emerald-50 p-4 text-sm text-emerald-950">
              <p className="font-bold">{result.message}{result.replayed ? ' (repeat request: no new record created)' : ''}</p>
              <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1">
                <dt className="text-emerald-800">Simulation ID</dt><dd className="font-mono break-all">{result.simulation_id}</dd>
                <dt className="text-emerald-800">Time</dt><dd>{fmtIst(result.created_at)}</dd>
                <dt className="text-emerald-800">District</dt><dd>{result.district}</dd>
                <dt className="text-emerald-800">Channel / language</dt><dd>{result.channel} · {result.language}</dd>
                <dt className="text-emerald-800">Severity</dt><dd>{result.severity_used}{result.severity_override ? ' (manual override)' : ''}</dd>
                <dt className="text-emerald-800">Contact</dt><dd>{result.contact_masked ?? 'none entered'}</dd>
                <dt className="text-emerald-800">Result</dt><dd>{result.result} (not delivered)</dd>
              </dl>
            </div>
          )}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-bold text-slate-800">Recent simulations</h3>
        {history.length === 0 ? <p className="mt-1 text-sm text-slate-500">None yet.</p> : (
          <div className="mt-2 overflow-x-auto"><table className="w-full text-sm">
            <thead><tr className="text-left text-slate-600 border-b-2 border-slate-200"><th className="py-1.5 pr-3">Time (IST)</th><th className="pr-3">District</th><th className="pr-3">Channel</th><th className="pr-3">Severity</th><th>Status</th></tr></thead>
            <tbody>{history.map(h => <tr key={h.id} className="border-b border-slate-100"><td className="py-1.5 pr-3 whitespace-nowrap">{fmtIst(h.timestamp)}</td><td className="pr-3">{h.district_name}</td><td className="pr-3">{h.channel}</td><td className="pr-3">{h.alert_level}{h.metadata?.severity_override ? ' ⚑' : ''}</td><td>{h.status}</td></tr>)}</tbody>
          </table></div>
        )}
      </div>
    </section>
  );
};
export default NotificationSimulator;
