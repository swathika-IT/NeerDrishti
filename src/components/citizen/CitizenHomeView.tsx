import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, CheckCircle2, AlertCircle, AlertTriangle, Siren, Volume2, VolumeX,
  MapPin, Bot, FilePlus2, Clock, ChevronLeft, Info, Phone,
} from 'lucide-react';
import type { DistrictStatus } from '../../types';
import { CITIZEN_LABEL, type Lang, type RiskCategory } from '../../config/citizen_labels';
import { RISK_WEIGHTS, RISK_CATEGORY_CUTOFFS } from '../../config/risk_model';
import { t } from '../../i18n';
import { RainfallThresholdBar } from './RainfallThresholdBar';

const LEVEL_STYLE: Record<RiskCategory, { bg: string; ring: string; text: string; bar: string; Icon: any }> = {
  LOW: { bg: 'bg-emerald-50', ring: 'border-emerald-600', text: 'text-emerald-900', bar: 'bg-emerald-600', Icon: CheckCircle2 },
  MODERATE: { bg: 'bg-amber-50', ring: 'border-amber-500', text: 'text-amber-900', bar: 'bg-amber-500', Icon: AlertCircle },
  HIGH: { bg: 'bg-orange-50', ring: 'border-orange-600', text: 'text-orange-900', bar: 'bg-orange-600', Icon: AlertTriangle },
  CRITICAL: { bg: 'bg-red-50', ring: 'border-red-700', text: 'text-red-900', bar: 'bg-red-700', Icon: Siren },
};

const levelFromScore = (s: number): RiskCategory =>
  s > RISK_CATEGORY_CUTOFFS.CRITICAL ? 'CRITICAL' : s > RISK_CATEGORY_CUTOFFS.HIGH ? 'HIGH' : s > RISK_CATEGORY_CUTOFFS.MODERATE ? 'MODERATE' : 'LOW';

const SPEECH_LANG: Record<Lang, string> = { en: 'en-IN', te: 'te-IN', hi: 'hi-IN' };
const HORIZONS = [
  { key: 'now', label: 'NOW' }, { key: 'h3', label: '+3H' }, { key: 'h6', label: '+6H' },
  { key: 'h12', label: '+12H' }, { key: 'h24', label: '+24H' },
] as const;

interface Brief { text: string; source: 'llm' | 'deterministic' }

interface Props {
  districts: DistrictStatus[];
  scenario: string;
  onNavigate: (tab: string) => void;
}

export const CitizenHomeView: React.FC<Props> = ({ districts, scenario, onNavigate }) => {
  const [lang, setLang] = useState<Lang>(() => (localStorage.getItem('nd_lang') as Lang) || 'en');
  const [selectedId, setSelectedId] = useState<string | null>(() => localStorage.getItem('nd_district'));
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => { try { localStorage.setItem('nd_lang', lang); } catch { /* ignore */ } }, [lang]);
  useEffect(() => {
    try { selectedId ? localStorage.setItem('nd_district', selectedId) : localStorage.removeItem('nd_district'); } catch { /* ignore */ }
  }, [selectedId]);

  const selected = useMemo(() => districts.find(d => d.district_id === selectedId) || null, [districts, selectedId]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (q ? districts.filter(d => d.district.toLowerCase().includes(q)) : districts)
      .slice().sort((a, b) => a.district.localeCompare(b.district)).slice(0, 12);
  }, [districts, query]);

  const simulatedCount = districts.filter(d => (d.rainfall_data_mode || 'SIMULATED') === 'SIMULATED').length;
  const liveCount = districts.filter(d => d.rainfall_data_mode === 'LIVE').length;
  const counts = useMemo(() => {
    const c: Record<RiskCategory, number> = { LOW: 0, MODERATE: 0, HIGH: 0, CRITICAL: 0 };
    districts.forEach(d => { c[d.risk_category] = (c[d.risk_category] || 0) + 1; });
    return c;
  }, [districts]);
  const top = useMemo(() => districts.slice().sort((a, b) => b.flood_risk_score - a.flood_risk_score).slice(0, 5), [districts]);

  const pick = (d: DistrictStatus) => { setSelectedId(d.district_id || null); setQuery(''); setOpen(false); };

  return (
    <div className="max-w-3xl mx-auto pb-10 text-slate-900" lang={lang}>
      {/* Data honesty banner */}
      {simulatedCount > 0 && (
        <div role="status" className="mb-4 flex gap-3 rounded-xl border-2 border-amber-500 bg-amber-50 p-4 text-amber-950">
          <Info className="w-6 h-6 shrink-0 mt-0.5" aria-hidden />
          <p className="text-base font-semibold leading-snug">
            {t(lang, 'simBanner')}
            <span className="block text-sm font-normal mt-1">
              {simulatedCount}/{districts.length} · {scenario}{liveCount > 0 ? ` · ${liveCount} live` : ''}
            </span>
          </p>
        </div>
      )}
      {simulatedCount === 0 && liveCount > 0 && (
        <p className="mb-4 text-sm text-slate-700 bg-sky-50 border border-sky-200 rounded-lg p-3">{t(lang, 'liveBanner')}</p>
      )}

      {/* Language */}
      <div className="flex items-center justify-end gap-2 mb-3" role="group" aria-label={t(lang, 'language')}>
        {(['en', 'te', 'hi'] as Lang[]).map(l => (
          <button
            key={l}
            onClick={() => setLang(l)}
            aria-pressed={lang === l}
            className={`min-w-[3.5rem] px-3 py-2 rounded-lg text-base font-bold border-2 ${lang === l ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-800 border-slate-300 hover:border-slate-500'}`}
          >
            {l === 'en' ? 'EN' : l === 'te' ? 'తెలుగు' : 'हिन्दी'}
          </button>
        ))}
      </div>

      {/* Hero + search */}
      <section className="rounded-2xl bg-slate-900 text-white p-6 sm:p-8 shadow-lg">
        <h1 className="text-3xl sm:text-4xl font-extrabold leading-tight">{t(lang, 'title')}</h1>
        <p className="mt-2 text-lg text-slate-200">{t(lang, 'subtitle')}</p>
        <div className="relative mt-5">
          <label htmlFor="district-search" className="block text-base font-bold mb-2">{t(lang, 'searchLabel')}</label>
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-6 h-6 text-slate-500" aria-hidden />
            <input
              id="district-search"
              role="combobox"
              aria-expanded={open}
              aria-controls="district-listbox"
              autoComplete="off"
              value={query}
              onChange={e => { setQuery(e.target.value); setOpen(true); }}
              onFocus={() => setOpen(true)}
              onKeyDown={e => { if (e.key === 'Enter' && matches[0]) pick(matches[0]); if (e.key === 'Escape') setOpen(false); }}
              placeholder={t(lang, 'searchPlaceholder')}
              className="w-full rounded-xl pl-13 pr-4 py-4 text-lg text-slate-900 placeholder-slate-500 bg-white border-4 border-transparent focus:border-sky-400 focus:outline-none"
              style={{ paddingLeft: '3.25rem' }}
            />
          </div>
          {open && (
            <ul id="district-listbox" role="listbox" className="absolute z-20 mt-2 w-full max-h-72 overflow-auto rounded-xl bg-white text-slate-900 shadow-2xl border border-slate-300">
              {matches.length === 0 && <li className="px-4 py-3 text-base text-slate-600">{t(lang, 'noMatch')}</li>}
              {matches.map(d => (
                <li key={d.district_id} role="option" aria-selected={d.district_id === selectedId}>
                  <button onClick={() => pick(d)} className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left text-lg hover:bg-slate-100 focus:bg-slate-100 focus:outline-none">
                    <span className="font-semibold">{d.district}</span>
                    <span className={`text-sm font-bold px-2 py-0.5 rounded ${LEVEL_STYLE[d.risk_category].bg} ${LEVEL_STYLE[d.risk_category].text}`}>
                      {CITIZEN_LABEL[d.risk_category][lang]}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {selected ? (
        <DistrictPanel key={selected.district_id} d={selected} lang={lang} scenario={scenario} onBack={() => setSelectedId(null)} onNavigate={onNavigate} />
      ) : (
        <section className="mt-6">
          <h2 className="text-2xl font-extrabold">{t(lang, 'statewide')}</h2>
          <div className="grid grid-cols-2 gap-3 mt-3">
            {(['CRITICAL', 'HIGH', 'MODERATE', 'LOW'] as RiskCategory[]).map(lv => {
              const S = LEVEL_STYLE[lv];
              return (
                <div key={lv} className={`rounded-xl border-l-8 ${S.ring} ${S.bg} p-4`}>
                  <div className={`flex items-center gap-2 ${S.text}`}>
                    <S.Icon className="w-6 h-6" aria-hidden />
                    <span className="text-sm font-extrabold">{CITIZEN_LABEL[lv][lang]}</span>
                  </div>
                  <p className={`text-4xl font-extrabold mt-1 tabular-nums ${S.text}`}>{counts[lv]}</p>
                </div>
              );
            })}
          </div>
          <h3 className="text-xl font-bold mt-6 mb-2">{t(lang, 'topRisk')}</h3>
          <ul className="space-y-2">
            {top.map(d => {
              const S = LEVEL_STYLE[d.risk_category];
              return (
                <li key={d.district_id}>
                  <button onClick={() => pick(d)} className={`w-full flex items-center justify-between rounded-xl border-2 ${S.ring} bg-white p-4 text-left hover:shadow-md`}>
                    <span className="text-lg font-bold">{d.district}</span>
                    <span className={`flex items-center gap-2 font-extrabold ${S.text}`}>
                      <S.Icon className="w-5 h-5" aria-hidden />
                      {CITIZEN_LABEL[d.risk_category][lang]}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <footer className="mt-8 rounded-xl bg-white border border-slate-300 p-4 text-base text-slate-800 space-y-2">
        <p className="flex items-start gap-2"><Phone className="w-5 h-5 mt-0.5 shrink-0" aria-hidden /><span className="font-bold">{t(lang, 'emergency')}</span></p>
        <p className="text-sm text-slate-600">{t(lang, 'notOfficial')}</p>
      </footer>
    </div>
  );
};

/* ------------------------------------------------------------------ */

const DistrictPanel: React.FC<{
  d: DistrictStatus; lang: Lang; scenario: string; onBack: () => void; onNavigate: (tab: string) => void;
}> = ({ d, lang, scenario, onBack, onNavigate }) => {
  const level = d.risk_category as RiskCategory;
  const S = LEVEL_STYLE[level];
  const [horizon, setHorizon] = useState<(typeof HORIZONS)[number]['key']>('now');
  const [brief, setBrief] = useState<Brief | null>(null);
  const [briefLoading, setBriefLoading] = useState(true);
  const [speaking, setSpeaking] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setBriefLoading(true);
    fetch(`/api/ai/citizen-brief?scenario=${encodeURIComponent(scenario)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ac.signal,
      body: JSON.stringify({ district_id: d.district_id, language: lang }),
    })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(j => { setBrief({ text: j.text, source: j.source }); setBriefLoading(false); })
      .catch(err => { if (err?.name !== 'AbortError') { setBrief(null); setBriefLoading(false); } });
    return () => ac.abort();
  }, [d.district_id, lang, scenario]);

  useEffect(() => () => { window.speechSynthesis?.cancel(); }, []);

  const speak = () => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    if (speaking) { synth.cancel(); setSpeaking(false); return; }
    const text = brief?.text || `${d.district}. ${CITIZEN_LABEL[level][lang]}.`;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = SPEECH_LANG[lang];
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    setSpeaking(true);
    synth.speak(u);
  };

  const tl: any = d.forecast_timeline?.timeline;
  const pt = tl?.[horizon];
  const hScore: number = horizon === 'now' ? d.flood_risk_score : pt?.projectedRiskScore ?? d.flood_risk_score;
  const hLevel: RiskCategory = horizon === 'now' ? level : levelFromScore(hScore);
  const HS = LEVEL_STYLE[hLevel];

  const factors: Array<{ key: keyof typeof d.contributions; max: number; prov: string }> = [
    { key: 'rainfall', max: RISK_WEIGHTS.rainfall * 100, prov: `p_${d.rainfall_data_mode === 'LIVE' ? 'LIVE' : 'SIMULATED'}` },
    { key: 'flood_history', max: RISK_WEIGHTS.flood_history * 100, prov: `p_${d.feature_provenance?.flood_history ?? 'EXPERT_PRIOR'}` },
    { key: 'location_risk', max: RISK_WEIGHTS.terrain * 100, prov: `p_${d.feature_provenance?.terrain ?? 'EXPERT_PRIOR'}` },
    { key: 'citizen_reports', max: RISK_WEIGHTS.citizen_reports * 100, prov: 'p_VERIFIED' },
    { key: 'drainage_vulnerability', max: RISK_WEIGHTS.drainage * 100, prov: `p_${d.feature_provenance?.drainage ?? 'EXPERT_PRIOR'}` },
  ];
  const updated = d.rainfall_recorded_at ? new Date(d.rainfall_recorded_at).toLocaleString() : '—';

  return (
    <article className="mt-6 space-y-5" aria-label={d.district}>
      <button onClick={onBack} className="inline-flex items-center gap-1 text-base font-semibold text-slate-700 hover:text-slate-900">
        <ChevronLeft className="w-5 h-5" aria-hidden /> {t(lang, 'back')}
      </button>

      {/* Status card */}
      <section className={`rounded-2xl border-4 ${S.ring} ${S.bg} p-6`} aria-live="polite">
        <p className="text-lg font-bold text-slate-700">{d.district}</p>
        <div className={`flex items-center gap-3 mt-1 ${S.text}`}>
          <S.Icon className="w-10 h-10 shrink-0" aria-hidden />
          <h2 className="text-3xl sm:text-4xl font-extrabold leading-tight">{CITIZEN_LABEL[level][lang]}</h2>
        </div>
        <p className={`mt-2 text-lg font-semibold ${S.text}`}>
          {t(lang, 'score')}: <span className="tabular-nums">{d.flood_risk_score.toFixed(1)}</span> / 100
        </p>
        <div className="mt-3 h-3 rounded-full bg-white/80 overflow-hidden border border-slate-300" aria-hidden>
          <div className={`${S.bar} h-full transition-all duration-700 motion-reduce:transition-none`} style={{ width: `${Math.min(100, d.flood_risk_score)}%` }} />
        </div>

        <div className="mt-4 rounded-xl bg-white/90 p-4 border border-slate-200">
          {briefLoading ? (
            <p className="text-lg text-slate-600">{t(lang, 'loadingBrief')}</p>
          ) : brief ? (
            <>
              <p className="text-lg leading-relaxed whitespace-pre-line text-slate-900">{brief.text}</p>
              <p className="mt-2 text-xs text-slate-500">
                {t(lang, 'briefSource')}: {brief.source === 'llm' ? t(lang, 'sourceLlm') : t(lang, 'sourceDet')}
              </p>
            </>
          ) : (
            <p className="text-lg text-slate-800">{CITIZEN_LABEL[level][lang]} — {t(lang, 'emergency')}</p>
          )}
          <button onClick={speak} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-slate-900 text-white px-4 py-3 text-base font-bold hover:bg-slate-700">
            {speaking ? <VolumeX className="w-5 h-5" aria-hidden /> : <Volume2 className="w-5 h-5" aria-hidden />}
            {speaking ? t(lang, 'stop') : t(lang, 'readAloud')}
          </button>
        </div>
      </section>

      {/* Rainfall */}
      <section className="rounded-2xl bg-white border border-slate-300 p-5">
        <h3 className="text-xl font-extrabold">{t(lang, 'rain24')}</h3>
        <div className="mt-3"><RainfallThresholdBar mm={d.rainfall_mm_24h ?? null} lang={lang} unit={t(lang, 'mm')} /></div>
        <p className="text-sm text-slate-600 mt-2">{t(lang, 'rainSub')}</p>
        <p className="text-sm text-slate-600 mt-1 flex items-center gap-1"><Clock className="w-4 h-4" aria-hidden />{t(lang, 'updated')}: {updated} · {d.rainfall_source}</p>
      </section>

      {/* Outlook */}
      {tl && (
        <section className="rounded-2xl bg-white border border-slate-300 p-5">
          <h3 className="text-xl font-extrabold">{t(lang, 'outlookTitle')}</h3>
          <div className="mt-3 flex flex-wrap gap-2" role="tablist" aria-label={t(lang, 'outlookTitle')}>
            {HORIZONS.map(h => (
              <button
                key={h.key}
                role="tab"
                aria-selected={horizon === h.key}
                onClick={() => setHorizon(h.key)}
                className={`min-w-[4rem] px-4 py-3 rounded-lg text-base font-extrabold border-2 ${horizon === h.key ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-800 border-slate-300 hover:border-slate-500'}`}
              >
                {h.key === 'now' ? t(lang, 'now') : h.label}
              </button>
            ))}
          </div>
          <div className={`mt-4 rounded-xl border-2 ${HS.ring} ${HS.bg} p-4 transition-colors motion-reduce:transition-none`}>
            <div className={`flex items-center gap-2 text-xl font-extrabold ${HS.text}`}>
              <HS.Icon className="w-6 h-6" aria-hidden /> {CITIZEN_LABEL[hLevel][lang]}
              <span className="ml-auto tabular-nums">{hScore.toFixed(1)}</span>
            </div>
            {horizon !== 'now' && pt && (
              <p className="text-base mt-1 text-slate-800">
                {typeof pt.projectedRainfall_mm === 'number' && <>~{pt.projectedRainfall_mm} {t(lang, 'mm')} · </>}
                {t(lang, 'confidence')}: {pt.confidence}
              </p>
            )}
          </div>
          <p className="text-sm text-slate-600 mt-2">{t(lang, 'outlookNote')} <span className="font-semibold">({pt?.forecastDataMode ?? 'SIMULATED_FORECAST'})</span></p>
        </section>
      )}

      {/* Why */}
      <section className="rounded-2xl bg-white border border-slate-300 p-5">
        <h3 className="text-xl font-extrabold">{t(lang, 'whyTitle')}</h3>
        <p className="text-sm text-slate-600">{t(lang, 'whySub')}</p>
        <ul className="mt-4 space-y-4">
          {factors.map(f => {
            const v = d.contributions[f.key];
            const w = Math.min(100, (v / f.max) * 100);
            return (
              <li key={f.key}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-lg font-bold">{t(lang, `f_${String(f.key)}`)}</span>
                  <span className="text-base tabular-nums text-slate-700">{v.toFixed(1)} / {f.max.toFixed(0)}</span>
                </div>
                <div className="mt-1 h-4 rounded-full bg-slate-200 overflow-hidden">
                  <div className="h-full bg-slate-800 transition-all duration-700 motion-reduce:transition-none" style={{ width: `${w}%` }} />
                </div>
                <span className="inline-block mt-1 text-xs font-semibold px-2 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-300">{t(lang, f.prov)}</span>
              </li>
            );
          })}
        </ul>
      </section>

      {/* Tips */}
      <section className="rounded-2xl bg-sky-50 border border-sky-200 p-5">
        <h3 className="text-xl font-extrabold">{t(lang, 'tipsTitle')}</h3>
        <ul className="mt-3 space-y-2 list-disc pl-6 text-lg">
          {[1, 2, 3, 4, 5].map(i => <li key={i}>{t(lang, `tip${i}`)}</li>)}
        </ul>
      </section>

      {/* Actions */}
      <div className="grid sm:grid-cols-3 gap-3">
        <button onClick={() => onNavigate('reports')} className="flex items-center justify-center gap-2 rounded-xl bg-blue-700 text-white px-4 py-4 text-lg font-bold hover:bg-blue-800"><FilePlus2 className="w-6 h-6" aria-hidden />{t(lang, 'report')}</button>
        <button onClick={() => onNavigate('assistant')} className="flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white px-4 py-4 text-lg font-bold hover:bg-slate-700"><Bot className="w-6 h-6" aria-hidden />{t(lang, 'ask')}</button>
        <button onClick={() => onNavigate('map')} className="flex items-center justify-center gap-2 rounded-xl bg-white text-slate-900 border-2 border-slate-900 px-4 py-4 text-lg font-bold hover:bg-slate-100"><MapPin className="w-6 h-6" aria-hidden />{t(lang, 'map')}</button>
      </div>
    </article>
  );
};
