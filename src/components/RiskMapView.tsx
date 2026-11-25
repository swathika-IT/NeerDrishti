import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import {
  Circle,
  CircleMarker,
  GeoJSON,
  MapContainer,
  Marker,
  Popup,
  TileLayer,
  Tooltip,
  useMap,
} from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import {
  AlertCircle,
  CheckCircle2,
  Droplets,
  Layers,
  MapPin,
  Radio,
  Search,
  ShieldAlert,
  Waves,
} from 'lucide-react';
import type { DistrictSummary, SimulationScenarioName } from '../types';
import type { IoTDevice } from '../types/iot';
import type { Lang } from '../config/citizen_labels';
import { t } from '../i18n';
import { apiFetch } from '../lib/api';
import {
  buildTelanganaTelemetryGeoJson,
  getRiskColor,
  type TelemetryFeature,
  type TelemetryFeatureCollection,
} from '../lib/geojsonBuilder';
import { DistrictDetailModal } from './DistrictDetailModal';

interface RiskMapViewProps {
  districts: DistrictSummary[];
  scenario: SimulationScenarioName;
  onScenarioChange: (scenario: SimulationScenarioName) => void;
}

interface MapConfigResponse {
  provider: 'none' | 'custom';
  url: string | null;
  attribution: string;
  maxZoom: number;
  subdomains: string;
  warning?: string;
}

type BoundaryState = 'loading' | 'loaded' | 'missing' | 'error';
type LayerMode = 'both' | 'risk' | 'iot';

const TELANGANA_BOUNDS: L.LatLngBoundsExpression = [[15.8, 77.2], [19.95, 81.35]];
const SCENARIOS: SimulationScenarioName[] = [
  'Normal Conditions',
  'Heavy Rainfall',
  'Flood Warning',
  'Critical Flood Event',
];
const LANGUAGES: { code: Lang; label: string }[] = [
  { code: 'en', label: 'EN' },
  { code: 'te', label: 'తె' },
  { code: 'hi', label: 'हि' },
];

function districtId(district: DistrictSummary): string {
  return String((district as any).district_id || district.district).trim().toLowerCase();
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function districtCenter(district: DistrictSummary): [number, number] | null {
  const lat = finiteNumber((district as any).lat ?? (district as any).latitude);
  const lng = finiteNumber((district as any).lng ?? (district as any).longitude);
  if (lat === null || lng === null) return null;
  return [lat, lng];
}

function toLatLng(coordinates: unknown): [number, number] | null {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const lng = finiteNumber(coordinates[0]);
  const lat = finiteNumber(coordinates[1]);
  if (lng === null || lat === null) return null;
  return [lat, lng];
}

function template(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''));
}

function statusLabel(status: string, language: Lang): string {
  const key = status.toUpperCase();
  if (key === 'VERIFIED') return t(language, 'mapVerified');
  if (key === 'REPORTED' || key === 'PENDING') return t(language, 'mapReported');
  if (key === 'REFERENCE') return t(language, 'mapReference');
  if (key === 'DERIVED') return t(language, 'mapDerived');
  return t(language, 'mapUnavailable');
}

function modeLabel(mode: string | undefined, language: Lang): string {
  const value = String(mode || '').toUpperCase();
  if (value.includes('SIMULATED')) return t(language, 'mapSimulated');
  if (value.includes('FORECAST') || value.includes('MODEL') || value.includes('LIVE') || value === 'IOT') return t(language, 'mapLive');
  if (value.includes('HISTORICAL')) return t(language, 'mapHistorical');
  if (value.includes('PROTOTYPE')) return t(language, 'mapPrototype');
  if (value.includes('LIMITED')) return t(language, 'mapLimitedData');
  if (value.includes('VERIFIED')) return t(language, 'mapVerified');
  return mode || t(language, 'mapUnavailable');
}

function tooltipElement(lines: string[]): HTMLElement {
  const container = document.createElement('div');
  container.style.fontFamily = 'system-ui, sans-serif';
  container.style.fontSize = '11px';
  container.style.lineHeight = '1.5';
  for (const line of lines) {
    const row = document.createElement('div');
    row.textContent = line;
    container.appendChild(row);
  }
  return container;
}

function bindTextTooltip(layer: L.Layer, text: string): void {
  layer.bindTooltip(tooltipElement([text]), { sticky: true });
}

function MapController({ fitKey }: { fitKey: number }) {
  const map = useMap();
  useEffect(() => {
    map.invalidateSize();
    map.fitBounds(TELANGANA_BOUNDS, { padding: [16, 16] });
  }, [map, fitKey]);
  return null;
}

const EMPTY_COLLECTION: TelemetryFeatureCollection = { type: 'FeatureCollection', features: [] };

export const RiskMapView: React.FC<RiskMapViewProps> = ({ districts, scenario, onScenarioChange }) => {
  const [language, setLanguage] = useState<Lang>('en');
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'All' | 'Priority' | 'Standard' | 'Limited'>('All');
  const [zoneFilter, setZoneFilter] = useState('All');
  const [layerMode, setLayerMode] = useState<LayerMode>('both');
  const [overlays, setOverlays] = useState({ stations: true, basins: false, reports: true });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [modalDistrict, setModalDistrict] = useState<DistrictSummary | null>(null);
  const [fitKey, setFitKey] = useState(0);
  const [isClient] = useState(() => typeof window !== 'undefined');
  const [mapConfig, setMapConfig] = useState<MapConfigResponse | null>(null);
  const [basemapState, setBasemapState] = useState<'loading' | 'tiles' | 'fallback'>('loading');
  const [basemapNote, setBasemapNote] = useState<string | null>(null);
  const [boundaryPayload, setBoundaryPayload] = useState<unknown>(null);
  const [boundaryState, setBoundaryState] = useState<BoundaryState>('loading');
  const [boundaryError, setBoundaryError] = useState<string | null>(null);
  const [iotDevices, setIotDevices] = useState<IoTDevice[]>([]);
  const [stations, setStations] = useState<unknown[]>([]);
  const [basins, setBasins] = useState<unknown[]>([]);
  const [reports, setReports] = useState<unknown[]>([]);
  const [supplementError, setSupplementError] = useState<string | null>(null);
  const [popupMaxWidth, setPopupMaxWidth] = useState(300);
  const mapRef = useRef<L.Map | null>(null);

  useEffect(() => {
    if (!isClient) return;
    const container = document.querySelector<HTMLElement>('.leaflet-container');
    const update = () => {
      const width = container?.clientWidth || window.innerWidth - 32;
      const nextWidth = Math.max(220, Math.min(320, width - 48));
      container?.style.setProperty('--risk-map-popup-width', `${nextWidth}px`);
      setPopupMaxWidth(nextWidth);
    };
    update();
    if (typeof ResizeObserver !== 'undefined' && container) {
      const observer = new ResizeObserver(update);
      observer.observe(container);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [isClient]);

  useEffect(() => {
    let cancelled = false;
    apiFetch<MapConfigResponse>('/api/map/config')
      .then(config => {
        if (cancelled) return;
        setMapConfig(config);
        if (config.provider === 'custom' && config.url) {
          setBasemapState('tiles');
          if (config.warning) setBasemapNote(config.warning);
        } else {
          setBasemapState('fallback');
          setBasemapNote(config.warning || t(language, 'mapBasemapUnavailable'));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBasemapState('fallback');
          setBasemapNote(t(language, 'mapBasemapUnavailable'));
        }
      });
    return () => { cancelled = true; };
  }, [language]);

  useEffect(() => {
    let cancelled = false;
    setBoundaryState('loading');
    apiFetch<any>('/api/geo/districts')
      .then(data => {
        if (cancelled) return;
        const features = Array.isArray(data?.features) ? data.features : [];
        if (features.length === 0 || data?.available === false) {
          setBoundaryPayload(null);
          setBoundaryState('missing');
        } else {
          setBoundaryPayload(data);
          setBoundaryState('loaded');
          setFitKey(value => value + 1);
        }
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setBoundaryPayload(null);
        setBoundaryError(error?.message || t(language, 'mapError'));
        setBoundaryState('error');
      });
    return () => { cancelled = true; };
  }, [language]);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      apiFetch<any>('/api/iot/devices'),
      apiFetch<any>('/api/hydrology/stations'),
      apiFetch<any>('/api/basin/connections'),
      apiFetch<any>('/api/reports?status=VERIFIED&limit=500'),
    ]).then(results => {
      if (cancelled) return;
      const [iot, hydro, basin, report] = results.map(result => result.status === 'fulfilled' ? result.value : null);
      setIotDevices(Array.isArray(iot?.devices) ? iot.devices : []);
      setStations(Array.isArray(hydro?.stations) ? hydro.stations : []);
      setBasins(Array.isArray(basin?.connections) ? basin.connections : []);
      setReports(Array.isArray(report?.reports) ? report.reports : Array.isArray(report) ? report : []);
      setSupplementError(results.some(result => result.status === 'rejected') ? t(language, 'mapError') : null);
    });
    return () => { cancelled = true; };
  }, [language]);

  const collection = useMemo(
    () => buildTelanganaTelemetryGeoJson({
      districts,
      boundaries: boundaryPayload,
      hydrologicalStations: stations,
      basinConnections: basins,
      citizenReports: reports,
    }),
    [districts, boundaryPayload, stations, basins, reports],
  );

  const districtFeatures = useMemo(
    () => collection.features.filter(feature => feature.properties.feature_type === 'district_boundary'),
    [collection],
  );
  const boundaryCollection = useMemo(
    () => ({ ...collection, features: districtFeatures }),
    [collection, districtFeatures],
  );
  const supplementalFeatures = useMemo(
    () => collection.features.filter(feature => ['hydrological_station', 'verified_citizen_report'].includes(String(feature.properties.feature_type))),
    [collection],
  );
  const basinFeatures = useMemo(
    () => collection.features.filter(feature => feature.properties.feature_type === 'basin_connection'),
    [collection],
  );

  const zones = useMemo(() => {
    const values = new Set<string>();
    for (const district of districts) {
      if (district.region_zone) values.add(district.region_zone);
      if (district.simulation_zone) values.add(district.simulation_zone);
    }
    return [...values].sort();
  }, [districts]);

  const counts = useMemo(() => ({
    all: districts.length,
    priority: districts.filter(d => d.monitoring_category === 'Priority Flood Monitoring').length,
    standard: districts.filter(d => d.monitoring_category === 'Standard Monitoring').length,
    limited: districts.filter(d => d.monitoring_category === 'Limited Data').length,
  }), [districts]);

  const filteredDistricts = useMemo(() => districts.filter(district => {
    const matchesCategory =
      categoryFilter === 'All' ? true :
      categoryFilter === 'Priority' ? district.monitoring_category === 'Priority Flood Monitoring' :
      categoryFilter === 'Standard' ? district.monitoring_category === 'Standard Monitoring' :
      district.monitoring_category === 'Limited Data';
    const matchesZone = zoneFilter === 'All'
      || district.region_zone === zoneFilter
      || district.simulation_zone === zoneFilter;
    const term = searchTerm.trim().toLowerCase();
    const matchesSearch = !term
      || district.district.toLowerCase().includes(term)
      || districtId(district).includes(term.replace(/\s+/g, '_'))
      || String(district.region_zone || '').toLowerCase().includes(term)
      || String(district.river_basin || '').toLowerCase().includes(term);
    return matchesCategory && matchesZone && matchesSearch;
  }), [districts, categoryFilter, zoneFilter, searchTerm]);

  const filteredIds = useMemo(() => new Set(filteredDistricts.map(districtId)), [filteredDistricts]);
  const activeDistrict = districts.find(district => districtId(district) === activeId)
    || filteredDistricts[0]
    || districts[0]
    || null;

  const selectDistrict = (district: DistrictSummary | null) => {
    if (!district) return;
    setActiveId(districtId(district));
  };

  const focusDistrict = (district: DistrictSummary) => {
    selectDistrict(district);
    const center = districtCenter(district);
    if (center && mapRef.current) mapRef.current.flyTo(center, 9.5, { duration: 0.8 });
  };

  const onBoundaryFeature = (feature: any, layer: L.Layer) => {
    const matched = districts.find(district => {
      const props = feature?.properties || {};
      const candidate = String(props.district_id || props.districtId || props.district || props.district_name || '').trim().toLowerCase();
      return districtId(district) === candidate || district.district.toLowerCase() === candidate;
    });
    if (!matched) return;
    const rainfall = finiteNumber(matched.rainfall_mm_24h);
    layer.bindTooltip(tooltipElement([
      matched.district,
      `${matched.risk_category} · ${finiteNumber(matched.flood_risk_score) ?? t(language, 'mapUnavailable')}/100`,
      `${t(language, 'mapRainfall')}: ${rainfall === null ? t(language, 'mapUnavailable') : `${rainfall} mm`}`,
      `${t(language, 'mapStatus')}: ${modeLabel(matched.data_source_mode, language)}`,
    ]), { sticky: true });
    layer.on('click', () => {
      selectDistrict(matched);
      if (layer instanceof L.Polygon && mapRef.current) {
        mapRef.current.flyToBounds(layer.getBounds(), { padding: [24, 24], maxZoom: 10 });
      }
    });
  };

  const onBasinFeature = (feature: any, layer: L.Layer) => {
    bindTextTooltip(layer, `${feature?.properties?.label || t(language, 'mapDerived')} (${t(language, 'mapDerived')})`);
  };

  const boundaryStyle = (feature: any): L.PathOptions => {
    const props = feature?.properties || {};
    const candidate = String(props.district_id || props.districtId || props.district || props.district_name || '').trim().toLowerCase();
    const matched = districts.find(district => districtId(district) === candidate || district.district.toLowerCase() === candidate);
    const visible = matched ? filteredIds.has(districtId(matched)) : false;
    const color = matched ? getRiskColor(matched.risk_category) : '#94a3b8';
    const selected = matched && activeDistrict && districtId(matched) === districtId(activeDistrict);
    return {
      color: selected ? '#1d4ed8' : '#334155',
      weight: selected ? 2.5 : 1,
      fillColor: color,
      fillOpacity: visible ? (selected ? 0.5 : 0.32) : 0.08,
      opacity: visible ? 1 : 0.35,
    };
  };

  const boundaryNotice = boundaryState === 'loading'
    ? t(language, 'mapLoading')
    : boundaryState === 'error'
      ? boundaryError || t(language, 'mapError')
      : boundaryState === 'missing'
        ? t(language, 'mapBoundariesMissing')
        : collection.validation && !collection.validation.valid
          ? t(language, 'mapBoundariesInvalid')
          : null;

  const renderDistrictMarker = (district: DistrictSummary) => {
    const center = districtCenter(district);
    if (!center) return null;
    const score = finiteNumber(district.flood_risk_score);
    const color = getRiskColor(district.risk_category);
    const rainfall = finiteNumber(district.rainfall_mm_24h);
    const icon = L.divIcon({
      className: 'risk-map-pin',
      html: `<div style="width:26px;height:26px;border-radius:9999px;display:flex;align-items:center;justify-content:center;background:${color};border:2px solid #fff;box-shadow:0 2px 6px rgba(15,23,42,.35);color:#fff;font:800 10px system-ui,sans-serif">${score === null ? '?' : Math.round(score)}</div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    });
    return (
      <Marker key={districtId(district)} position={center} icon={icon} eventHandlers={{ click: () => selectDistrict(district) }}>
        <Popup
          autoPan
          keepInView
          autoPanPadding={[12, 12]}
          maxWidth={popupMaxWidth}
          className="risk-map-popup"
        >
          <div className="min-w-0 text-xs text-slate-700">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 font-bold text-slate-900">
              <span className="min-w-0 break-words">{district.district}</span>
              <span className="shrink-0 rounded-full px-2 py-0.5 text-white" style={{ backgroundColor: color }}>{district.risk_category}</span>
            </div>
            <div className="mt-2 break-words">{t(language, 'mapFloodRiskScore')}: {score ?? t(language, 'mapUnavailable')}/100</div>
            <div className="break-words">{t(language, 'mapRainfall')}: {rainfall === null ? t(language, 'mapUnavailable') : `${rainfall} mm`}</div>
            <div className="break-words">{t(language, 'mapStatus')}: {modeLabel(district.data_source_mode, language)}</div>
            <div className="break-words">{t(language, 'mapSource')}: {district.rainfall_source || district.data_provenance || t(language, 'mapUnavailable')}</div>
          </div>
        </Popup>
        <Tooltip sticky>{`${district.district} — ${district.risk_category}`}</Tooltip>
      </Marker>
    );
  };

  const renderSupplementFeature = (feature: TelemetryFeature) => {
    const center = toLatLng(feature.geometry?.coordinates);
    if (!center) return null;
    const props = feature.properties;
    const color = props.feature_type === 'verified_citizen_report' ? '#7c3aed' : '#2563eb';
    return (
      <CircleMarker
        key={String(feature.id || props.feature_id)}
        center={center}
        radius={6}
        pathOptions={{ color: '#ffffff', fillColor: color, fillOpacity: 0.9, weight: 2 }}
      >
        <Popup
          autoPan
          keepInView
          autoPanPadding={[12, 12]}
          maxWidth={popupMaxWidth}
          className="risk-map-popup"
        >
          <div className="min-w-0 text-xs text-slate-700">
            <div className="break-words font-bold text-slate-900">{props.label}</div>
            <div className="break-words">{t(language, 'mapHydrologicalStations')}/{t(language, 'mapVerifiedReports')}: {props.district_name || t(language, 'mapUnavailable')}</div>
            <div className="break-words">{t(language, 'mapStatus')}: {statusLabel(props.data_status, language)}</div>
            <div className="break-words">{t(language, 'mapSource')}: {props.source || t(language, 'mapUnavailable')}</div>
            <div className="break-words">{props.details}</div>
          </div>
        </Popup>
        <Tooltip sticky>{props.label}</Tooltip>
      </CircleMarker>
    );
  };

  if (!isClient) {
    return <div className="rounded-xl border border-slate-200 bg-white p-6" role="status">{t(language, 'mapLoading')}</div>;
  }

  return (
    <div className="space-y-4 pb-12 min-w-0 max-w-full overflow-hidden">
      <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-xs font-semibold text-amber-950 flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2"><ShieldAlert className="h-4 w-4 shrink-0" />{t(language, 'mapSimulationNotice')}</span>
        <span className="rounded bg-white/70 px-2 py-0.5 font-normal">{scenario}</span>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-4 min-w-0">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-xl font-black text-slate-900 sm:text-2xl">
              <MapPin className="h-6 w-6 shrink-0 text-blue-600" />
              <span className="break-words">{t(language, 'mapTitle')}</span>
            </h1>
            <p className="mt-1 text-xs text-slate-500 sm:text-sm">{t(language, 'mapSubtitle')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg bg-slate-100 p-0.5 text-[11px] font-bold">
              {LANGUAGES.map(item => (
                <button
                  key={item.code}
                  type="button"
                  onClick={() => setLanguage(item.code)}
                  aria-pressed={language === item.code}
                  className={`rounded px-2 py-1 ${language === item.code ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600'}`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <select
              aria-label="Scenario"
              value={scenario}
              onChange={event => onScenarioChange(event.target.value as SimulationScenarioName)}
              className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs"
            >
              {SCENARIOS.map(item => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 border-t border-slate-100 pt-3 sm:grid-cols-3">
          <label className="relative block min-w-0">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
            <input
              type="search"
              value={searchTerm}
              onChange={event => setSearchTerm(event.target.value)}
              placeholder={t(language, 'mapSearchPlaceholder')}
              aria-label={t(language, 'mapDistrictSearch')}
              className="w-full min-w-0 rounded-lg border border-slate-300 bg-white py-1.5 pl-8 pr-3 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </label>
          <div className="flex min-w-0 rounded-lg bg-slate-100 p-1 text-[11px] font-semibold">
            {([
              ['All', counts.all],
              ['Priority', counts.priority],
              ['Standard', counts.standard],
              ['Limited', counts.limited],
            ] as const).map(([key, count]) => (
              <button
                key={key}
                type="button"
                onClick={() => setCategoryFilter(key)}
                className={`min-w-0 flex-1 truncate rounded px-1 py-1 ${categoryFilter === key ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600'}`}
              >
                {key} ({count})
              </button>
            ))}
          </div>
          <select
            value={zoneFilter}
            onChange={event => setZoneFilter(event.target.value)}
            aria-label="Region zone"
            className="w-full min-w-0 rounded-lg border border-slate-300 bg-white p-1.5 text-xs"
          >
            <option value="All">All region zones</option>
            {zones.map(zone => <option key={zone} value={zone}>{zone}</option>)}
          </select>
        </div>
      </div>

      {districts.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center" role="status">
          <AlertCircle className="mx-auto mb-3 h-8 w-8 text-slate-400" />
          <p className="text-sm font-semibold text-slate-700">{t(language, 'mapEmptyDistricts')}</p>
        </div>
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm lg:col-span-2">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600">
              <span className="flex items-center gap-2"><Layers className="h-4 w-4 text-blue-600" />{t(language, 'mapRiskLegend')}</span>
              <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-200/80 p-0.5 text-[11px]">
                {([
                  ['both', t(language, 'mapAllLayers')],
                  ['risk', t(language, 'mapRiskLayer')],
                  ['iot', t(language, 'mapIotLayer')],
                ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setLayerMode(key)}
                    className={`rounded px-2 py-0.5 ${layerMode === key ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="min-w-0 overflow-hidden">
              <div className="relative h-[440px] w-full max-w-full overflow-hidden bg-slate-100 sm:h-[520px] lg:h-[560px]">
                <MapContainer
                  ref={instance => { mapRef.current = instance; }}
                  bounds={TELANGANA_BOUNDS}
                  boundsOptions={{ padding: [16, 16] }}
                  minZoom={6}
                  maxZoom={14}
                  scrollWheelZoom
                  className="h-full w-full"
                  style={{ height: '100%', width: '100%', background: '#e8eef3' }}
                >
                  <MapController fitKey={fitKey} />
                  {mapConfig?.provider === 'custom' && mapConfig.url && basemapState === 'tiles' && (
                    <TileLayer
                      url={mapConfig.url}
                      attribution={mapConfig.attribution}
                      subdomains={mapConfig.subdomains}
                      maxZoom={mapConfig.maxZoom}
                      eventHandlers={{
                        tileerror: () => {
                          setBasemapState(current => {
                            if (current === 'tiles') return 'fallback';
                            return current;
                          });
                        },
                      }}
                    />
                  )}
                  {(layerMode === 'both' || layerMode === 'risk') && boundaryState === 'loaded' && districtFeatures.length > 0 && (
                    <GeoJSON
                      key={`boundaries-${fitKey}`}
                      data={boundaryCollection as any}
                      style={boundaryStyle}
                      onEachFeature={onBoundaryFeature}
                    />
                  )}
                  {layerMode !== 'iot' && filteredDistricts.map(renderDistrictMarker)}
                  {(layerMode === 'both' || layerMode === 'risk') && overlays.basins && basinFeatures.length > 0 && (
                    <GeoJSON
                      key="basins"
                      data={{ type: 'FeatureCollection', features: basinFeatures } as any}
                      style={{ color: '#0ea5e9', weight: 2, dashArray: '5 5', opacity: 0.8 }}
                      onEachFeature={onBasinFeature}
                    />
                  )}
                  {(layerMode === 'both' || layerMode === 'iot') && iotDevices.map(device => {
                    const center = toLatLng(
                      device.coordinates
                        ? [device.coordinates.lng, device.coordinates.lat]
                        : [(device as any).lng, (device as any).lat],
                    );
                    if (!center) return null;
                    return (
                      <CircleMarker
                        key={device.device_id}
                        center={center}
                        radius={5}
                        pathOptions={{ color: '#ffffff', fillColor: '#7c3aed', fillOpacity: 0.9, weight: 2 }}
                      >
                        <Popup>
                          <div className="text-xs text-slate-700">
                            <div className="font-bold text-slate-900">{device.device_name}</div>
                            <div>{device.device_id} · {device.status}</div>
                            <div>{device.current_value} {device.unit}</div>
                            <div>{t(language, 'mapStatus')}: {modeLabel(device.mode, language)}</div>
                          </div>
                        </Popup>
                      </CircleMarker>
                    );
                  })}
                  {overlays.stations && supplementalFeatures
                    .filter(feature => feature.properties.feature_type === 'hydrological_station')
                    .map(renderSupplementFeature)}
                  {overlays.reports && supplementalFeatures
                    .filter(feature => feature.properties.feature_type === 'verified_citizen_report')
                    .map(renderSupplementFeature)}
                </MapContainer>
                <button
                  type="button"
                  onClick={() => setFitKey(value => value + 1)}
                  className="absolute right-3 top-3 z-[1100] rounded-lg border border-slate-300 bg-white/95 px-3 py-1.5 text-xs font-bold text-slate-800 shadow hover:bg-white"
                >
                  {t(language, 'mapFlyTo')}
                </button>
                {(boundaryNotice || basemapNote || supplementError) && (
                  <div role="status" className={`absolute bottom-3 left-3 z-[1100] max-w-[88%] rounded-lg border px-3 py-2 text-xs shadow ${boundaryState === 'error' ? 'border-rose-300 bg-rose-50 text-rose-950' : 'border-amber-300 bg-amber-50 text-amber-950'}`}>
                    {boundaryNotice && <p className="font-semibold">{boundaryNotice}</p>}
                    {basemapNote && <p>{basemapNote}</p>}
                    {supplementError && <p>{supplementError}</p>}
                    {collection.validation && boundaryState === 'loaded' && (
                      <p>{template(t(language, 'mapBoundaryCount'), { count: districtFeatures.length })}</p>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-3 border-t border-slate-200 bg-slate-50 p-3">
              <div>
                <span className="block text-[11px] font-bold uppercase tracking-wide text-slate-700">{t(language, 'mapRiskLegend')}</span>
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-600">
                  {[
                    ['LOW', t(language, 'mapLegendSafeLow')],
                    ['MODERATE', t(language, 'mapLegendModerate')],
                    ['HIGH', t(language, 'mapLegendHigh')],
                    ['CRITICAL', t(language, 'mapLegendCritical')],
                  ].map(([category, label]) => (
                    <span key={category} className="flex items-center gap-1.5">
                      <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: getRiskColor(category) }} />{label}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                {([
                  ['stations', `${t(language, 'mapHydrologicalStations')} (${stations.length})`],
                  ['basins', t(language, 'mapDerived')],
                  ['reports', `${t(language, 'mapVerifiedReports')} (${reports.length})`],
                ] as const).map(([key, label]) => (
                  <label key={key} className="flex cursor-pointer items-center gap-1 rounded border border-slate-200 bg-white px-2 py-1 font-semibold text-slate-700">
                    <input
                      type="checkbox"
                      checked={overlays[key]}
                      onChange={event => setOverlays(current => ({ ...current, [key]: event.target.checked }))}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div className="min-w-0 space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2">
              <h2 className="text-base font-bold text-slate-900">{t(language, 'mapDistrictInspector')}</h2>
              <span className="text-[11px] text-slate-500">
                {template(t(language, 'mapShowingDistricts'), { count: filteredDistricts.length, total: districts.length })}
              </span>
            </div>

            <div className="grid max-h-40 grid-cols-2 gap-1.5 overflow-y-auto pr-1">
              {filteredDistricts.map(district => (
                <button
                  key={districtId(district)}
                  type="button"
                  onClick={() => focusDistrict(district)}
                  className={`min-w-0 rounded-lg border px-2 py-1.5 text-left text-xs font-semibold ${activeDistrict && districtId(activeDistrict) === districtId(district) ? 'border-blue-600 bg-blue-50 text-blue-900' : 'border-slate-200 text-slate-700 hover:bg-slate-50'}`}
                >
                  <span className="flex items-center justify-between gap-1">
                    <span className="truncate">{district.district}</span>
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: getRiskColor(district.risk_category) }} />
                  </span>
                  <span className="mt-0.5 block text-[10px] font-normal text-slate-500">
                    {finiteNumber(district.flood_risk_score) ?? t(language, 'mapUnavailable')}
                  </span>
                </button>
              ))}
            </div>

            {activeDistrict ? (
              <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="break-words text-sm font-bold text-slate-900">{activeDistrict.district}</h3>
                    <p className="text-[11px] text-slate-500">{activeDistrict.river_basin || t(language, 'mapUnavailable')}</p>
                  </div>
                  <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold text-white" style={{ backgroundColor: getRiskColor(activeDistrict.risk_category) }}>
                    {activeDistrict.risk_category}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-lg border border-slate-200 bg-white p-2">
                    <span className="block text-[10px] text-slate-400">{t(language, 'mapRainfall')}</span>
                    <span className="font-bold text-blue-700">
                      {finiteNumber(activeDistrict.rainfall_mm_24h) ?? t(language, 'mapUnavailable')}
                      {finiteNumber(activeDistrict.rainfall_mm_24h) !== null ? ' mm' : ''}
                    </span>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-white p-2">
                    <span className="block text-[10px] text-slate-400">{t(language, 'mapFloodRiskScore')}</span>
                    <span className="font-bold text-slate-900">{finiteNumber(activeDistrict.flood_risk_score) ?? t(language, 'mapUnavailable')}/100</span>
                  </div>
                </div>
                <div className="space-y-1 text-[11px] text-slate-600">
                  <div><b>{t(language, 'mapStatus')}:</b> {modeLabel(activeDistrict.data_source_mode, language)}</div>
                  <div><b>{t(language, 'mapRainfall')} {t(language, 'mapStatus')}:</b> {modeLabel(activeDistrict.rainfall_data_mode, language)}</div>
                  <div><b>{t(language, 'mapSource')}:</b> {activeDistrict.rainfall_source || activeDistrict.data_provenance || t(language, 'mapUnavailable')}</div>
                  <div className="flex items-center gap-1"><Waves className="h-3 w-3" />{t(language, 'mapHydrologicalStations')}: {activeDistrict.hydrological_summary?.active_stations_count ?? t(language, 'mapUnavailable')}</div>
                  <div className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3" />{t(language, 'mapVerifiedReports')}: {activeDistrict.citizen_reports_count ?? t(language, 'mapUnavailable')}</div>
                  <div className="flex items-center gap-1"><Radio className="h-3 w-3" />IoT: {iotDevices.filter(device => districtId(activeDistrict) === String(device.district_id).toLowerCase() || activeDistrict.district.toLowerCase() === String(device.district_name).toLowerCase()).length}</div>
                  {activeDistrict.data_limitation_notes && <div className="text-amber-800">{activeDistrict.data_limitation_notes}</div>}
                </div>
                {activeDistrict.alert_intelligence && activeDistrict.alert_intelligence.alert_level !== 'NORMAL' && (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 p-2 text-[11px] text-rose-900">
                    <b>{activeDistrict.alert_intelligence.alert_level}:</b> {activeDistrict.alert_intelligence.headline}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setModalDistrict(activeDistrict)}
                  className="w-full rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-500"
                >
                  {t(language, 'mapSelectedDistrict')} — {activeDistrict.district}
                </button>
              </div>
            ) : (
              <p className="text-xs text-slate-500">{t(language, 'mapNoSelection')}</p>
            )}
          </div>
        </div>
      )}

      {modalDistrict && (
        <DistrictDetailModal district={modalDistrict} onClose={() => setModalDistrict(null)} />
      )}
    </div>
  );
};
