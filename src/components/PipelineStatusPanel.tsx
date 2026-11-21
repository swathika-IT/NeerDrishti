import React, { useEffect, useState } from 'react';
import { Database } from 'lucide-react';
import { apiFetch } from '../lib/api';

const IST = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
const fmt = (s?: string | null) => { if (!s) return '—'; const d = new Date(s); return Number.isNaN(d.getTime()) ? s : `${IST.format(d)} IST`; };
const BADGE: Record<string, string> = {
  LIVE: 'bg-emerald-100 text-emerald-900', STALE: 'bg-amber-100 text-amber-900', HISTORICAL: 'bg-sky-100 text-sky-900',
  UNAVAILABLE: 'bg-slate-200 text-slate-700', UNVERIFIED: 'bg-violet-100 text-violet-900', FORECAST: 'bg-indigo-100 text-indigo-900',
};

/** Data-pipeline status from /api/pipeline/registry: what is actually stored, how fresh it is, and the last ingestion run. */
export const PipelineStatusPanel: React.FC = () => {
  const [reg, setReg] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { apiFetch('/api/pipeline/registry').then(setReg).catch(e => setErr(e.message)); }, []);
  return (
    <section className="mt-8 rounded-2xl border border-slate-300 bg-white p-5 sm:p-6" aria-labelledby="pipe-title">
      <div className="flex items-center gap-3">
        <Database className="w-6 h-6 text-indigo-600" aria-hidden />
        <div>
          <h2 id="pipe-title" className="text-xl font-bold text-slate-900">Data pipeline status</h2>
          <p className="text-sm text-slate-600">Datasets loaded into the database by the ingestion scripts. Freshness is computed from the newest observation time.</p>
        </div>
      </div>
      {err && <p className="mt-3 text-sm text-red-700">{err}</p>}
      {reg && !reg.available && <p className="mt-3 text-sm text-slate-600">Pipeline tables not found. Run <code>npm run bootstrap</code>.</p>}
      {reg?.available && reg.datasets.length === 0 && (
        <p className="mt-3 text-sm text-slate-700 rounded-lg bg-slate-50 border border-slate-200 p-3">
          No datasets have been ingested yet, so none is shown as available. Run <code>python -m scripts.pipeline.cli registry</code>, then the ingestion commands in DATA_INGESTION_GUIDE.md.
        </p>
      )}
      {reg?.available && reg.datasets.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-slate-600 border-b-2 border-slate-200">
              <th className="py-2 pr-3">Dataset</th><th className="pr-3">Type</th><th className="pr-3">Records</th><th className="pr-3">Latest observation</th><th className="pr-3">Freshness</th><th className="pr-3">Identity verified</th><th>Last run</th>
            </tr></thead>
            <tbody>
              {reg.datasets.map((d: any) => (
                <tr key={d.dataset_id} className="border-b border-slate-100 align-top">
                  <td className="py-2 pr-3"><p className="font-semibold">{d.name}</p><p className="text-xs text-slate-500">{d.provider}</p></td>
                  <td className="pr-3">{d.data_type}</td>
                  <td className="pr-3 tabular-nums">{d.stored_records.toLocaleString()}</td>
                  <td className="pr-3 whitespace-nowrap">{fmt(d.latest_observation)}</td>
                  <td className="pr-3"><span className={`px-2 py-0.5 rounded text-xs font-bold ${BADGE[d.freshness] || BADGE.UNVERIFIED}`}>{d.freshness}</span></td>
                  <td className="pr-3">{d.verified ? 'Yes' : 'No'}</td>
                  <td className="text-xs">{d.last_run ? <>{d.last_run.status} · {fmt(d.last_run.finished_at || d.last_run.started_at)}<br />{d.last_run.records_inserted} new / {d.last_run.records_fetched} read{d.last_run.error_message ? <span className="text-red-700"><br />{d.last_run.error_message}</span> : null}</> : 'never run'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
export default PipelineStatusPanel;
