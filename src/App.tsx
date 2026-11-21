import React, { useState, useEffect, lazy, Suspense } from 'react';
import { Navbar, type ViewMode } from './components/Navbar';
import { CitizenHomeView } from './components/citizen/CitizenHomeView';
import type { AuthUser } from './components/AccountView';

// Heavy views are code-split so the first paint only downloads what it needs.
const named = <T extends Record<string, any>>(loader: () => Promise<T>, key: keyof T) =>
  lazy(() => loader().then(m => ({ default: m[key] as React.ComponentType<any> })));
const HomeView = named(() => import('./components/HomeView'), 'HomeView');
const LiveDashboardView = named(() => import('./components/LiveDashboardView'), 'LiveDashboardView');
const RiskMapView = named(() => import('./components/RiskMapView'), 'RiskMapView');
const CitizenReportView = named(() => import('./components/CitizenReportView'), 'CitizenReportView');
const AIAssistantView = named(() => import('./components/AIAssistantView'), 'AIAssistantView');
const SituationFusionView = named(() => import('./components/SituationFusionView'), 'SituationFusionView');
const AlertCenterView = named(() => import('./components/AlertCenterView'), 'AlertCenterView');
const DataSourcesIoTView = named(() => import('./components/DataSourcesIoTView'), 'DataSourcesIoTView');
const AuthView = named(() => import('./components/AuthView'), 'AuthView');
const AccountView = named(() => import('./components/AccountView'), 'AccountView');
const OfficialWorkspaceView = named(() => import('./components/OfficialWorkspaceView'), 'OfficialWorkspaceView');
const AdminConsoleView = named(() => import('./components/AdminConsoleView'), 'AdminConsoleView');
const NotificationSimulator = named(() => import('./components/NotificationSimulator'), 'NotificationSimulator');
const PipelineStatusPanel = named(() => import('./components/PipelineStatusPanel'), 'PipelineStatusPanel');
const PlaygroundView = named(() => import('./components/PlaygroundView'), 'PlaygroundView');
import { DistrictStatus, SimulationScenarioName } from './types';

export default function App() {
  const [currentTab, setCurrentTab] = useState<string>('home');
  const [scenario, setScenario] = useState<SimulationScenarioName>('Heavy Rainfall');
  const [districts, setDistricts] = useState<DistrictStatus[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [customRainfallOverride, setCustomRainfallOverride] = useState<Record<string, number>>({});
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState<boolean>(false);
  // Presentation mode only. Access control is enforced by the backend, never by this toggle.
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try { return (localStorage.getItem('nd_view') as ViewMode) === 'engineer' ? 'engineer' : 'simple'; } catch { return 'simple'; }
  });
  const handleViewModeChange = (m: ViewMode) => {
    setViewMode(m);
    try { localStorage.setItem('nd_view', m); } catch { /* ignore */ }
    const simpleTabs = ['home', 'map', 'reports', 'assistant', 'account', 'auth'];
    if (m === 'simple' && !simpleTabs.includes(currentTab)) setCurrentTab('home');
  };

  // Resilient Fetch with automatic retry. Scenario and rainfall overrides are
  // read-only view parameters — the public dashboard no longer mutates global state.
  const fetchDistricts = async (retryCount = 3, delayMs = 600): Promise<void> => {
    setIsLoading(true);
    setFetchError(null);

    const params = new URLSearchParams({ scenario });
    const overrides = Object.entries(customRainfallOverride);
    if (overrides.length > 0) {
      params.set('rain_override', overrides.map(([d, v]) => `${d}:${v}`).join(','));
    }

    for (let attempt = 1; attempt <= retryCount; attempt++) {
      try {
        const res = await fetch(`/api/districts?${params.toString()}`);
        if (!res.ok) {
          throw new Error(`Server responded with status ${res.status}`);
        }
        const data = await res.json();
        if (data && Array.isArray(data.districts)) {
          setDistricts(data.districts);
          setFetchError(null);
          setIsLoading(false);
          return;
        } else {
          throw new Error('Invalid district payload structure received');
        }
      } catch (err: any) {
        console.warn(`Attempt ${attempt}/${retryCount} - Failed to fetch districts:`, err?.message || err);
        if (attempt < retryCount) {
          await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
        } else {
          setFetchError(err?.message || 'Unable to connect to NeerDrishti backend service.');
          setIsLoading(false);
        }
      }
    }
  };

  const refreshAuth = async (): Promise<void> => {
    try {
      const res = await fetch('/api/auth/me');
      const data = await res.json();
      setAuthUser(data?.user || null);
    } catch {
      setAuthUser(null);
    } finally {
      setAuthChecked(true);
    }
  };

  useEffect(() => {
    refreshAuth();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('verify_email') || params.has('reset_password')) {
      setCurrentTab('auth');
    }
  }, []);

  useEffect(() => {
    fetchDistricts();
  }, [scenario, customRainfallOverride]);

  // Scenario selection is a view-only override for public users; the global
  // mutation endpoint is admin-only and is not called from the public UI.
  const handleScenarioChange = async (newScenario: SimulationScenarioName) => {
    setScenario(newScenario);
  };

  // Custom rainfall adjustment (view-only override for the current session)
  const handleCustomRainfall = async (districtName: string, val: number) => {
    setCustomRainfallOverride(prev => ({ ...prev, [districtName]: val }));
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      /* ignore */
    }
    setAuthUser(null);
    setCurrentTab('home');
  };

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 flex flex-col font-sans">
      {/* Navigation */}
      <Navbar
        currentTab={currentTab}
        setCurrentTab={setCurrentTab}
        scenario={scenario}
        onScenarioChange={handleScenarioChange}
        authUser={authUser}
        onLogout={handleLogout}
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 pt-6">
        {isLoading && !authChecked ? (
          <div className="py-24 flex flex-col items-center justify-center space-y-4">
            <div className="w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm font-semibold text-slate-600">Initializing NeerDrishti Flood Intelligence Engine...</p>
          </div>
        ) : fetchError && districts.length === 0 ? (
          <div className="py-16 flex flex-col items-center justify-center max-w-lg mx-auto text-center bg-white border border-rose-200 rounded-2xl p-8 shadow-sm">
            <div className="w-12 h-12 bg-rose-100 rounded-full flex items-center justify-center mb-4 text-rose-600 font-bold text-xl">
              !
            </div>
            <h2 className="text-lg font-bold text-slate-800 mb-2">Telemetry Service Connection Error</h2>
            <p className="text-sm text-slate-600 mb-6">{fetchError}</p>
            <button
              id="retry-connection-btn"
              onClick={() => fetchDistricts(3, 500)}
              className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-sm font-semibold rounded-lg shadow transition-colors"
            >
              Retry Connection
            </button>
          </div>
        ) : (
          <>
            <Suspense fallback={<div className="py-16 text-center text-slate-600" role="status">Loading…</div>}>
            {currentTab === 'home' && (
              viewMode === 'simple' ? (
                <CitizenHomeView
                  districts={districts}
                  scenario={scenario}
                  onNavigate={(tab) => setCurrentTab(tab)}
                />
              ) : (
                <HomeView
                  districts={districts}
                  onNavigate={(tab) => setCurrentTab(tab)}
                />
              )
            )}

            {currentTab === 'playground' && viewMode === 'engineer' && (
              <PlaygroundView districts={districts} scenario={scenario} />
            )}

            {currentTab === 'dashboard' && (
              <LiveDashboardView
                districts={districts}
                scenario={scenario}
                onScenarioChange={handleScenarioChange}
                onCustomRainfallChange={handleCustomRainfall}
                onRefresh={fetchDistricts}
              />
            )}

            {currentTab === 'situation' && (
              <SituationFusionView
                districts={districts}
                scenario={scenario}
                onScenarioChange={handleScenarioChange}
                onRefresh={fetchDistricts}
              />
            )}

            {currentTab === 'alerts' && (
              <>
                <AlertCenterView
                  districts={districts}
                  scenario={scenario}
                  onScenarioChange={handleScenarioChange}
                  onRefresh={fetchDistricts}
                />
                <NotificationSimulator districts={districts} user={authUser} />
              </>
            )}

            {currentTab === 'map' && (
              <RiskMapView
                districts={districts}
                scenario={scenario}
                onScenarioChange={handleScenarioChange}
              />
            )}

            {currentTab === 'iot' && (
              <>
                <DataSourcesIoTView
                  districts={districts}
                  onRefreshDistricts={fetchDistricts}
                />
                <PipelineStatusPanel />
              </>
            )}

            {currentTab === 'reports' && (
              <CitizenReportView
                districts={districts.map((d) => d.district)}
                onReportSubmitted={fetchDistricts}
              />
            )}

            {currentTab === 'assistant' && (
              <AIAssistantView
                districts={districts}
              />
            )}

            {currentTab === 'auth' && (
              <AuthView
                onAuthenticated={(user) => {
                  setAuthUser(user);
                  setCurrentTab(user?.role === 'ADMIN' ? 'admin' : user?.role === 'OFFICIAL' ? 'official' : 'account');
                }}
              />
            )}

            {currentTab === 'account' && (
              <AccountView user={authUser} onLogout={handleLogout} onGoToAuth={() => setCurrentTab('auth')} />
            )}

            {currentTab === 'official' && (
              <OfficialWorkspaceView
                user={authUser}
                onRequireLogin={() => setCurrentTab('auth')}
                onLogout={handleLogout}
              />
            )}

            {currentTab === 'admin' && (
              <AdminConsoleView
                user={authUser}
                onRequireLogin={() => setCurrentTab('auth')}
                onLogout={handleLogout}
              />
            )}
            </Suspense>
          </>
        )}
      </main>

      {/* Footer */}
      <footer className="bg-white border-t border-slate-200 py-6 text-center text-xs text-slate-500 mt-auto">
        <div className="max-w-7xl mx-auto px-4 space-y-1">
          <p className="font-semibold text-slate-700">
            NeerDrishti (నీర్ దృష్టి) — AI Urban Flood Intelligence & Advisory System for Telangana
          </p>
          <p>
            Statewide Coverage: All 33 Districts (5 Priority Flood Monitoring, 15 Standard Monitoring, 13 Limited Data).
          </p>
          <p className="text-slate-400">
            {viewMode === 'simple'
              ? 'Flood Risk Assessment (0–100) • AI Flood Safety Assistant • Prototype for information only'
              : 'Weighted 5-factor risk model (0–100) • Grounded LLM layer with deterministic fallback • Prototype'}
          </p>
          <p className="text-slate-400">
            Weather data by{' '}
            <a
              href="https://open-meteo.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              Open-Meteo.com
            </a>{' '}
            (CC BY 4.0, non-commercial). Open-Meteo is not an official government flood warning source.
          </p>
        </div>
      </footer>
    </div>
  );
}
