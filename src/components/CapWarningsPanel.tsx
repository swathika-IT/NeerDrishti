import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Clock,
  ExternalLink,
  Info,
  Loader2,
  MapPin,
  Radio,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';

interface CapFeedStatus {
  key: string;
  label: string;
  publisher: string;
  url: string;
  enabled: boolean;
  health: string;
  item_count: number;
  relevant_item_count: number;
  latest_item_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
}

interface CapAlert {
  id: number;
  identifier: string;
  sender: string;
  sent: string;
  msgType: string;
  status: string;
  event: string;
  headline: string | null;
  description: string | null;
  instruction: string | null;
  severity: string | null;
  urgency: string | null;
  certainty: string | null;
  onset: string | null;
  expires: string | null;
  web: string | null;
  areaDesc: string;
  matchedDistrictIds: string[];
  areaScope: 'DISTRICT' | 'STATE' | 'OTHER';
  capUrl: string | null;
  feedKey: string | null;
  publisher: string | null;
  sourceName: string;
  lifecycle: 'ACTIVE' | 'EXPIRED' | 'CANCELLED';
}

interface CapStatusResponse {
  health: string;
  last_success_at: string | null;
  last_error: string | null;
  feeds: CapFeedStatus[];
  summary: {
    active_count: number;
    district_count: number;
    state_count: number;
    cancelled_count: number;
    by_severity: Record<string, number>;
  };
}

function formatTime(value: string | null): string {
  if (!value) return 'Not yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function healthClass(health: string): string {
  switch (health) {
    case 'HEALTHY':
      return 'bg-emerald-100 text-emerald-800 border-emerald-200';
    case 'DEGRADED':
      return 'bg-amber-100 text-amber-800 border-amber-200';
    case 'STALE':
      return 'bg-orange-100 text-orange-800 border-orange-200';
    case 'OFFLINE':
      return 'bg-rose-100 text-rose-800 border-rose-200';
    default:
      return 'bg-slate-100 text-slate-700 border-slate-200';
  }
}

function severityClass(severity: string | null): string {
  switch (severity) {
    case 'Extreme':
      return 'bg-rose-600 text-white';
    case 'Severe':
      return 'bg-orange-600 text-white';
    case 'Moderate':
      return 'bg-amber-500 text-slate-950';
    case 'Minor':
      return 'bg-blue-600 text-white';
    default:
      return 'bg-slate-600 text-white';
  }
}

export const CapWarningsPanel: React.FC = () => {
  const [status, setStatus] = useState<CapStatusResponse | null>(null);
  const [alerts, setAlerts] = useState<CapAlert[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [statusRes, alertsRes] = await Promise.all([
        fetch('/api/cap/status'),
        fetch('/api/cap/alerts?limit=20&active=true&telangana=true'),
      ]);
      if (!statusRes.ok) throw new Error(`CAP status HTTP ${statusRes.status}`);
      if (!alertsRes.ok) throw new Error(`CAP alerts HTTP ${alertsRes.status}`);
      const statusPayload = await statusRes.json();
      const alertsPayload = await alertsRes.json();
      setStatus(statusPayload);
      setAlerts(Array.isArray(alertsPayload.alerts) ? alertsPayload.alerts : []);
    } catch (err: any) {
      setError(err?.message || 'Unable to load official CAP warnings');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4 text-rose-600" />
            <h2 className="text-sm font-bold text-slate-900">Official CAP Warnings</h2>
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-900 text-white">
              FORECAST / OFFICIAL
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Reproduced from IMD and NDMA SACHET CAP feeds. These are official warnings, not NeerDrishti risk alerts or measured rainfall.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(status?.feeds || []).map(feed => (
            <span
              key={feed.key}
              title={feed.last_error || feed.url}
              className={`text-[10px] font-semibold px-2 py-1 rounded-full border ${healthClass(feed.health)}`}
            >
              {feed.key.replace('SACHET_', 'SACHET ')}: {feed.health}
            </span>
          ))}
          <button
            onClick={() => void load()}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            Reload
          </button>
        </div>
      </div>

      <div className="p-5">
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-slate-500 py-6">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading official CAP warnings...
          </div>
        )}

        {!isLoading && error && (
          <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
            <AlertTriangle className="w-4 h-4 mt-0.5" />
            <div>
              <p className="font-semibold">CAP warning feed unavailable</p>
              <p className="text-xs mt-0.5">{error}. No warning data is being fabricated.</p>
            </div>
          </div>
        )}

        {!isLoading && !error && alerts.length === 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
            <Info className="w-4 h-4 mt-0.5 text-slate-500" />
            <div>
              <p className="font-semibold">No active Telangana-relevant CAP warnings stored.</p>
              <p className="text-xs text-slate-500 mt-0.5">
                Feed status is shown above. Empty or stale feeds are reported as such, not converted into alerts.
              </p>
            </div>
          </div>
        )}

        {!isLoading && !error && alerts.length > 0 && (
          <div className="space-y-3">
            {alerts.map(alert => (
              <div key={`${alert.identifier}-${alert.id}`} className="rounded-xl border border-slate-200 p-4 hover:border-slate-300 transition-colors">
                <div className="flex flex-col md:flex-row md:items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${severityClass(alert.severity)}`}>
                        {alert.severity || 'Unknown'}
                      </span>
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200">
                        {alert.msgType}
                      </span>
                      {alert.urgency && (
                        <span className="text-[10px] text-slate-500">Urgency: {alert.urgency}</span>
                      )}
                      {alert.certainty && (
                        <span className="text-[10px] text-slate-500">Certainty: {alert.certainty}</span>
                      )}
                    </div>
                    <h3 className="text-sm font-bold text-slate-900 mt-2">
                      {alert.headline || alert.event}
                    </h3>
                    <p className="text-xs text-slate-600 mt-1">
                      {alert.description || 'No description supplied by the official feed.'}
                    </p>
                    {alert.instruction && (
                      <p className="text-xs text-slate-800 mt-2 bg-amber-50 border border-amber-200 rounded-lg p-2">
                        <span className="font-semibold">Official instruction: </span>
                        {alert.instruction}
                      </p>
                    )}
                  </div>
                  {alert.capUrl && (
                    <a
                      href={alert.capUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:text-blue-900 shrink-0"
                    >
                      Source CAP <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 mt-3 pt-3 border-t border-slate-100 text-[11px] text-slate-600">
                  <div className="flex items-start gap-1.5">
                    <MapPin className="w-3.5 h-3.5 mt-0.5 text-slate-400" />
                    <span>
                      {alert.areaScope === 'STATE'
                        ? 'Telangana statewide / unspecified subset'
                        : alert.matchedDistrictIds.length > 0
                        ? `Districts: ${alert.matchedDistrictIds.join(', ')}`
                        : alert.areaDesc}
                    </span>
                  </div>
                  <div className="flex items-start gap-1.5">
                    <Clock className="w-3.5 h-3.5 mt-0.5 text-slate-400" />
                    <span>Sent {formatTime(alert.sent)}</span>
                  </div>
                  <div className="flex items-start gap-1.5">
                    <ShieldAlert className="w-3.5 h-3.5 mt-0.5 text-slate-400" />
                    <span>{alert.publisher || alert.sourceName}</span>
                  </div>
                  <div className="flex items-start gap-1.5">
                    <Radio className="w-3.5 h-3.5 mt-0.5 text-slate-400" />
                    <span>Expires {formatTime(alert.expires)}</span>
                  </div>
                </div>
                <p className="text-[10px] text-slate-400 mt-2">
                  Sender: {alert.sender || 'Not supplied'} · Identifier: {alert.identifier}
                </p>
              </div>
            ))}
          </div>
        )}

        <p className="text-[10px] text-slate-400 mt-4">
          CAP content is reproduced from official feeds. NeerDrishti does not modify, approve, or replace government warnings. Feed health: {status?.health || 'UNKNOWN'}.
        </p>
      </div>
    </div>
  );
};
