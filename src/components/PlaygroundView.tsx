import React, { useEffect, useMemo, useState } from 'react';
import { FlaskConical, RotateCcw, AlertTriangle, CheckCircle2, Lock, Table2, Sigma, Timer } from 'lucide-react';
import type { DistrictStatus } from '../types';
import { RISK_WEIGHTS, RISK_CATEGORY_CUTOFFS } from '../config/risk_model';

type FK = 'rainfall' | 'flood_history' | 'terrain' | 'citizen_reports' | 'drainage';
const FACTORS: Array<{ key: FK; label: string; field: keyof DistrictStatus['components'] }> = [
  { key: 'rainfall', label: 'Rainfall', field: 'rainfall_score' },
  { key: 'flood_history', label: 'Historical flood frequency', field: 'flood_history_score' },
  { key: 'terrain', label: 'Terrain vulnerability', field: 'location_risk_score' },
  { key: 'citizen_reports', label: 'Citizen reports', field: 'citizen_report_score' },
  { key: 'drainage', label: 'Drainage vulnerability', field: 'drainage_vulnerability_score' },
];
const OPERATIONAL: Record<FK, number> = Object.fromEntries(FACTORS.map(f => [f.key, RISK_WEIGHTS[f.key] * 100])) as Record<FK, number>;

const cat = (s: number) => (s > RISK_CATEGORY_CUTOFFS.CRITICAL ? 'CRITICAL' : s > RISK_CATEGORY_CUTOFFS.HIGH ? 'HIGH' : s > RISK_CATEGORY_CUTOFFS.MODERATE ? 'MODERATE' : 'LOW');
const CAT_BG: Record<string, string> = { LOW: 'bg-emerald-100 text-emerald-900', MODERATE: 'bg-amber-100 text-amber-900', HIGH: 'bg-orange-100 text-orange-900', CRITICAL: 'bg-red-100 text-red-900' };

function pearson(a: number[], b: number[]): number | null {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da === 0 || db === 0 ? null : num / Math.sqrt(da * db);
}

const STATUS_STYLE: Record<string, { cls: string; ch: string }> = {
  OBSERVED: { cls: 'bg-emerald-600 text-white', ch: 'O' },
  ESTIMATED: { cls: 'bg-sky-600 text-white', ch: 'E' },
  IMPUTED: { cls: 'bg-amber-500 text-slate-900', ch: 'I' },
  SIMULATED: { cls: 'bg-violet-600 text-white', ch: 'S' },
  MISSING: { cls: 'bg-slate-300 text-slate-700', ch: '—' },
};

interface Props { districts: DistrictStatus[]; scenario: string }

export const PlaygroundView: React.FC<Props> = ({ districts, scenario }) => {
  const [w, setW] = useState<Record<FK, number>>({ ...OPERATIONAL });
  const [completeness, setCompleteness] = useState<any>(null);
  const [connections, setConnections] = useState<any[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [catFilter, setCatFilter] = useState('All');

  useEffect(() => {
    const ac = new AbortController();
    Promise.all([
      fetch(`/api/data/completeness?scenario=${encodeURIComponent(scenario)}`, { signal: ac.signal }).then(r => r.json()),
      fetch('/api/basin/connections', { signal: ac.signal }).then(r => r.json()),
    ]).then(([c, b]) => { setCompleteness(c); setConnections(b.connections || []); })
      .catch(e => { if (e?.name !== 'AbortError') setLoadErr(String(e?.message || e)); });
    return () => ac.abort();
  }, [scenario]);

  const wVals = FACTORS.map(f => w[f.key]);
  const sum: number = wVals.reduce((a: number, b: number) => a + b, 0);
  const valid = sum > 0 && wVals.every((v: number) => v >= 0);
  const eff = useMemo(() => Object.fromEntries(FACTORS.map(f => [f.key, valid ? w[f.key] / sum : 0])) as Record<FK, number>, [w, sum, valid]);

  const rows = useMemo(() => {
    const calc = (d: DistrictStatus, weights: Record<FK, number>) =>
      FACTORS.reduce((acc, f) => acc + weights[f.key] * (d.components[f.field] as number), 0);
    const opWeights = Object.fromEntries(FACTORS.map(f => [f.key, RISK_WEIGHTS[f.key]])) as Record<FK, number>;
    const list = districts.map(d => {
      const base = calc(d, opWeights);
      const exp = calc(d, eff);
      return { d, server: d.flood_risk_score, base, exp, delta: exp - d.flood_risk_score };
    });
    const byOp = [...list].sort((a, b) => b.server - a.server).map((r, i) => [r.d.district_id, i + 1] as const);
    const byExp = [...list].sort((a, b) => b.exp - a.exp).map((r, i) => [r.d.district_id, i + 1] as const);
    const opRank = new Map(byOp), expRank = new Map(byExp);
    return list.map(r => ({ ...r, opRank: opRank.get(r.d.district_id)!, expRank: expRank.get(r.d.district_id)! }))
      .sort((a, b) => a.expRank - b.expRank);
  }, [districts, eff]);

  const maxDrift = rows.reduce((m, r) => Math.max(m, Math.abs(r.base - r.server)), 0);
  const changedCat = rows.filter(r => cat(r.exp) !== cat(r.server)).length;
  const isOperational = FACTORS.every(f => Math.abs(w[f.key] - OPERATIONAL[f.key]) < 0.01);

  // Correlation matrix on factor scores + final score
  const corr = useMemo(() => {
    const cols = [...FACTORS.map(f => ({ label: f.label.replace(' vulnerability', '').replace('Historical flood frequency', 'Flood history'), v: districts.map(d => d.components[f.field] as number) })),
      { label: 'Final score', v: districts.map(d => d.flood_risk_score) }];
    return { labels: cols.map(c => c.label), m: cols.map(a => cols.map(b => pearson(a.v, b.v))) };
  }, [districts]);
  const proxyCount = completeness ? completeness.rows.filter((r: any) => r.cells.flood_history.provenance === 'PROXY_DERIVED').length : 0;

  const shownRows = completeness ? completeness.rows.filter((r: any) => catFilter === 'All' || r.monitoring_category === catFilter) : [];

  return (
    <div className="space-y-8 pb-12">
      <header>
        <div className="flex items-center gap-3">
          <FlaskConical className="w-8 h-8 text-indigo-600" aria-hidden />
          <h1 className="text-3xl font-extrabold">Data Science Playground</h1>
        </div>
        <p className="mt-2 text-slate-600 max-w-3xl">
          Explore how the flood-risk score is built. Everything below is computed from the live district inputs of the current view
          (<span className="font-semibold">{scenario}</span>). Nothing here changes operational scores or alerts.
        </p>
      </header>

      {/* A. Weight explorer */}
      <section className="rounded-2xl bg-white border border-slate-300 p-5 sm:p-6" aria-labelledby="pg-weights">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="pg-weights" className="text-xl font-bold flex items-center gap-2"><Sigma className="w-5 h-5" aria-hidden />Feature weight explorer</h2>
          <button onClick={() => setW({ ...OPERATIONAL })} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-sm font-semibold hover:bg-slate-100">
            <RotateCcw className="w-4 h-4" aria-hidden />Reset to operational
          </button>
        </div>
        <div role="note" className="mt-3 flex gap-2 rounded-lg bg-amber-50 border border-amber-300 p-3 text-sm text-amber-950">
          <AlertTriangle className="w-5 h-5 shrink-0" aria-hidden />
          <span><b>EXPERIMENTAL weights.</b> These are for exploration only and are not official operational thresholds. Operational weights: 35 / 25 / 15 / 15 / 10.</span>
        </div>
        <div className="mt-4 grid md:grid-cols-2 gap-x-8 gap-y-4">
          {FACTORS.map(f => (
            <div key={f.key}>
              <label htmlFor={`w-${f.key}`} className="flex justify-between text-sm font-semibold">
                <span>{f.label}</span>
                <span className="tabular-nums">raw {w[f.key].toFixed(0)} → <b>{(eff[f.key] * 100).toFixed(1)}%</b> <span className="text-slate-500">(op. {OPERATIONAL[f.key].toFixed(0)}%)</span></span>
              </label>
              <input id={`w-${f.key}`} type="range" min={0} max={100} step={1} value={w[f.key]}
                onChange={e => setW(p => ({ ...p, [f.key]: Math.max(0, Number(e.target.value)) }))} className="w-full accent-indigo-600" />
            </div>
          ))}
        </div>
        <div className={`mt-4 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm rounded-lg p-3 ${valid ? 'bg-slate-50' : 'bg-red-50 text-red-900'}`}>
          <span>Total raw weight: <b className="tabular-nums">{sum.toFixed(0)}</b>{sum !== 100 && valid && ' (normalised to 100%)'}</span>
          {!valid && <span className="font-bold">Total must be above 0 — scores not computed.</span>}
          <span className="flex items-center gap-1"><CheckCircle2 className={`w-4 h-4 ${maxDrift < 0.1 ? 'text-emerald-600' : 'text-red-600'}`} aria-hidden />
            Recomputing with operational weights matches server scores (max drift {maxDrift.toFixed(2)} pts)</span>
          <span>{isOperational ? 'Showing operational weights' : `${changedCat} district(s) change risk category`}</span>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">District scores: operational versus experimental weights</caption>
            <thead><tr className="text-left text-slate-600 border-b-2 border-slate-200">
              <th className="py-2 pr-3">#</th><th className="pr-3">District</th><th className="pr-3">Operational</th><th className="pr-3 min-w-[200px]">Experimental</th><th className="pr-3">Change</th><th>Category</th>
            </tr></thead>
            <tbody>
              {rows.map(r => {
                const moved = r.opRank - r.expRank;
                return (
                  <tr key={r.d.district_id} className="border-b border-slate-100">
                    <td className="py-1.5 pr-3 tabular-nums">{r.expRank}{moved !== 0 && <span className={`ml-1 text-xs ${moved > 0 ? 'text-red-600' : 'text-emerald-700'}`}>{moved > 0 ? `▲${moved}` : `▼${-moved}`}</span>}</td>
                    <td className="pr-3 font-semibold">{r.d.district}</td>
                    <td className="pr-3 tabular-nums">{r.server.toFixed(1)}</td>
                    <td className="pr-3">
                      <div className="flex items-center gap-2">
                        <div className="h-2.5 flex-1 rounded bg-slate-200 overflow-hidden"><div className="h-full bg-indigo-600 transition-all motion-reduce:transition-none" style={{ width: `${Math.min(100, r.exp)}%` }} /></div>
                        <span className="tabular-nums w-12 text-right">{valid ? r.exp.toFixed(1) : '—'}</span>
                      </div>
                    </td>
                    <td className={`pr-3 tabular-nums ${r.delta > 0.05 ? 'text-red-600' : r.delta < -0.05 ? 'text-emerald-700' : 'text-slate-500'}`}>{valid ? `${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(1)}` : '—'}</td>
                    <td><span className={`px-2 py-0.5 rounded text-xs font-bold ${CAT_BG[cat(r.exp)]}`}>{valid ? cat(r.exp) : '—'}</span>{valid && cat(r.exp) !== cat(r.server) && <span className="ml-1 text-xs text-slate-500">was {cat(r.server)}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* B. Correlation */}
      <section className="rounded-2xl bg-white border border-slate-300 p-5 sm:p-6" aria-labelledby="pg-corr">
        <h2 id="pg-corr" className="text-xl font-bold">Factor correlation (current inputs, {districts.length} districts)</h2>
        <p className="text-sm text-slate-600 mt-1 max-w-3xl">
          Pearson correlation between factor scores across districts. This shows how the model inputs <i>co-vary</i> today. It is not evidence that rainfall causes floods:
          rainfall–flood correlation needs the historical flood-event dataset, which is not yet loaded.
        </p>
        {proxyCount > 0 && (
          <div role="note" className="mt-3 flex gap-2 rounded-lg bg-amber-50 border border-amber-300 p-3 text-sm text-amber-950">
            <AlertTriangle className="w-5 h-5 shrink-0" aria-hidden />
            <span><b>Finding:</b> flood history, terrain and drainage correlate almost perfectly because {proxyCount} of {districts.length} districts derive all three from one proxy score.
              Replacing them with real datasets (see DATA_SOURCES.md) will remove this artefact.</span>
          </div>
        )}
        <div className="mt-4 overflow-x-auto">
          <table className="text-sm border-collapse">
            <thead><tr><th />{corr.labels.map(l => <th key={l} className="px-2 py-1 text-xs font-semibold text-slate-600 text-center min-w-[80px]">{l}</th>)}</tr></thead>
            <tbody>
              {corr.labels.map((rl, i) => (
                <tr key={rl}>
                  <th className="pr-3 py-1 text-xs font-semibold text-slate-600 text-right whitespace-nowrap">{rl}</th>
                  {corr.m[i].map((v, j) => {
                    const a = v === null ? 0 : Math.abs(v);
                    const bg = v === null ? '#f1f5f9' : v >= 0 ? `rgba(79,70,229,${0.12 + a * 0.75})` : `rgba(220,38,38,${0.12 + a * 0.75})`;
                    return <td key={j} className="text-center tabular-nums w-[80px] h-9 font-semibold" style={{ background: bg, color: a > 0.55 ? '#fff' : '#0f172a' }}>{v === null ? 'n/a' : v.toFixed(2)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* C. Lag analysis */}
      <section className="rounded-2xl bg-white border border-slate-300 p-5 sm:p-6" aria-labelledby="pg-lag">
        <h2 id="pg-lag" className="text-xl font-bold flex items-center gap-2"><Timer className="w-5 h-5" aria-hidden />Rainfall → runoff lag analysis</h2>
        <div className="mt-3 flex gap-3 rounded-xl bg-slate-100 border border-slate-300 p-4">
          <Lock className="w-6 h-6 shrink-0 text-slate-600" aria-hidden />
          <div className="text-sm text-slate-800">
            <p className="font-bold">Blocked: no observed rainfall–discharge series are loaded.</p>
            <p className="mt-1">Estimating a lag (e.g. +3 / +6 / +12 / +24 h) needs paired hourly rainfall and river level/discharge data from CWC or India-WRIS.
              Until that is imported, no lag is estimated and none is claimed. The routing used by the engine today is a <b>prototype assumption</b>:</p>
          </div>
        </div>
        {connections.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-slate-600 border-b-2 border-slate-200"><th className="py-2 pr-3">River / link</th><th className="pr-3">Upstream → Downstream</th><th className="pr-3">Assumed travel (h)</th><th>Basis</th></tr></thead>
              <tbody>
                {connections.map(c => (
                  <tr key={c.connection_id} className="border-b border-slate-100">
                    <td className="py-1.5 pr-3">{c.water_body_name}</td>
                    <td className="pr-3">{c.upstream_district_id} → {c.downstream_district_id}</td>
                    <td className="pr-3 tabular-nums">{c.estimated_travel_window_hours}</td>
                    <td className="text-xs text-slate-600">{c.data_mode} · assumed, not estimated from data</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* D. Completeness */}
      <section className="rounded-2xl bg-white border border-slate-300 p-5 sm:p-6" aria-labelledby="pg-comp">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="pg-comp" className="text-xl font-bold flex items-center gap-2"><Table2 className="w-5 h-5" aria-hidden />Data completeness matrix</h2>
          <select aria-label="Filter by monitoring category" value={catFilter} onChange={e => setCatFilter(e.target.value)} className="border border-slate-300 rounded-lg px-3 py-2 text-sm">
            {['All', 'Priority Flood Monitoring', 'Standard Monitoring', 'Limited Data'].map(c => <option key={c}>{c}</option>)}
          </select>
        </div>
        {loadErr && <p className="mt-3 text-red-700 text-sm">Could not load completeness data: {loadErr}</p>}
        {completeness && (
          <>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {Object.entries(completeness.legend).map(([k, v]) => (
                <span key={k} className="inline-flex items-center gap-1.5"><span className={`inline-flex w-5 h-5 items-center justify-center rounded font-bold ${STATUS_STYLE[k].cls}`}>{STATUS_STYLE[k].ch}</span><b>{k}</b> <span className="text-slate-500">{String(v)}</span></span>
              ))}
            </div>
            <p className="mt-2 text-sm text-slate-700">Totals: {Object.entries(completeness.totals).map(([k, v]) => `${k} ${v}`).join(' · ')}</p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-slate-600 border-b-2 border-slate-200">
                  <th className="py-2 pr-3">District</th>
                  {completeness.columns.map((c: string) => <th key={c} className="px-2 text-center">{completeness.column_labels[c]}</th>)}
                </tr></thead>
                <tbody>
                  {shownRows.map((r: any) => (
                    <tr key={r.district_id} className="border-b border-slate-100">
                      <td className="py-1 pr-3 font-semibold whitespace-nowrap">{r.district}</td>
                      {completeness.columns.map((c: string) => {
                        const cell = r.cells[c]; const st = STATUS_STYLE[cell.status];
                        return (
                          <td key={c} className="px-2 text-center">
                            <span title={`${cell.status} · ${cell.provenance} · ${cell.source}${cell.updated ? ` · ${cell.updated}` : ''}`}
                              className={`inline-flex w-8 h-7 items-center justify-center rounded font-bold ${st.cls}`}>{st.ch}</span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-slate-500">Hover a cell for its source, provenance and timestamp. Generated {new Date(completeness.generated_at).toLocaleString()}.</p>
          </>
        )}
      </section>
    </div>
  );
};

export default PlaygroundView;
