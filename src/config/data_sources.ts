import { DataSourceRegistryEntry } from '../types/signals';

/**
 * Central Data Source Registry for NeerDrishti Flood Intelligence
 * Tracks provider priority, base confidence, refresh intervals, health, and fallback modes.
 */
export const DATA_SOURCES: Record<string, DataSourceRegistryEntry> = {
  IMD_AWS_TELANGANA: {
    sourceName: 'IMD Automatic Weather Stations (Telangana)',
    sourceType: 'official_api',
    supportedSignals: ['rainfall', 'weather'],
    enabled: false,
    priority: 1,
    refreshIntervalMinutes: 60,
    baseConfidence: 0.95,
    currentMode: 'UNAVAILABLE',
    health: 'UNAVAILABLE',
    lastSuccessfulUpdate: null,
    integrationStatus: 'NOT_CONFIGURED',
    accessNote: 'IMD public API (api.imd.gov.in) returns HTTP 401 without registered credentials. Not integrated; no live AWS telemetry is flowing.',
    description: 'India Meteorological Department official telemetry. NOT INTEGRATED — requires registered IMD API credentials. Do not present as live.',
  },
  OPEN_METEO_TELEMETRY: {
    sourceName: 'Open-Meteo High-Resolution Telangana Ingestion',
    sourceType: 'weather_service',
    supportedSignals: ['rainfall', 'weather'],
    enabled: true,
    priority: 2,
    refreshIntervalMinutes: 30,
    baseConfidence: 0.90,
    currentMode: 'LIVE',
    health: 'HEALTHY',
    lastSuccessfulUpdate: null,
    integrationStatus: 'CONNECTED',
    accessNote: 'Open API, no key required; NWP model output (not station telemetry). Attribution: Open-Meteo.com. Licence CC BY 4.0.',
    description: 'High-resolution global NWP meteorological data for Telangana coordinates. Real weather-model output, updated hourly; not direct IMD station observations.',
  },
  IMD_CAP_FEED: {
    sourceName: 'IMD CAP Official Warning Feed (WMO Alert Hub)',
    sourceType: 'official_api',
    supportedSignals: ['official_alert'],
    enabled: true,
    priority: 1,
    refreshIntervalMinutes: 15,
    baseConfidence: 0.95,
    currentMode: 'FORECAST',
    health: 'UNKNOWN',
    lastSuccessfulUpdate: null,
    integrationStatus: 'CONNECTED',
    accessNote: 'Public CAP RSS index. Verified endpoint: https://cap-sources.s3.amazonaws.com/in-imd-en/rss.xml (HTTP 200, zero items when no IMD CAP alerts are published). The URL previously supplied by the user, https://mausam.imd.gov.in/imd_latest/contents/cap_rss.xml, returned HTTP 404 and is not used as the default. CAP XML documents must be fetched individually from the RSS links.',
    description: 'Official IMD CAP 1.2 warning index via the WMO Alert Hub S3 mirror. FORECAST warnings, not measured rainfall. Empty feeds are reported as STALE, never as fabricated alerts.',
  },
  SACHET_CAP_FEED: {
    sourceName: 'NDMA SACHET Official CAP Warning Feed',
    sourceType: 'official_api',
    supportedSignals: ['official_alert'],
    enabled: true,
    priority: 2,
    refreshIntervalMinutes: 15,
    baseConfidence: 0.95,
    currentMode: 'FORECAST',
    health: 'UNKNOWN',
    lastSuccessfulUpdate: null,
    integrationStatus: 'CONNECTED',
    accessNote: 'Public NDMA SACHET CAP RSS feeds. Default ingest uses the Telangana state feed plus the all-India feed filtered to Telangana-relevant items: https://sachet.ndma.gov.in/cap_public_website/rss/rss_telangana.xml and https://sachet.ndma.gov.in/cap_public_website/rss/rss_india.xml. SACHET relays alerts from multiple senders, including IMD Hyderabad/TGiCCC and Telangana SDMA; publisher and sender are kept separate.',
    description: 'Official NDMA SACHET CAP 1.2 warning feed for Telangana-relevant alerts. FORECAST warnings, not measured rainfall. Items are deduplicated across the state and all-India feeds.',
  },
  TELANGANA_HISTORICAL_BASELINE: {
    sourceName: 'Telangana State Development Planning Society (TSDPS) Baseline Archive',
    sourceType: 'historical_archive',
    supportedSignals: ['rainfall'],
    enabled: false,
    priority: 3,
    refreshIntervalMinutes: 1440,
    baseConfidence: 0.75,
    currentMode: 'HISTORICAL',
    health: 'UNAVAILABLE',
    lastSuccessfulUpdate: null,
    integrationStatus: 'MANUAL_VERIFICATION',
    accessNote: 'Open historical CSV available at National Water Data Portal (nwdp.nwic.gov.in, IMD district-wise daily rainfall, updated 2026-10-31). Not auto-integrated; manual download and ETL required.',
    description: 'Historical monsoon baselines. NOT AUTO-INTEGRATED — requires manual verification and import of NWDP/IMD district-wise daily rainfall CSV.',
  },
  CWC_TELANGANA_HYDROMET: {
    sourceName: 'Central Water Commission (CWC) Godavari & Krishna River Gauges',
    sourceType: 'official_api',
    supportedSignals: ['river_level', 'river_flow', 'dam_discharge', 'hydrological_alert'],
    enabled: false,
    priority: 1,
    refreshIntervalMinutes: 60,
    baseConfidence: 0.95,
    currentMode: 'UNAVAILABLE',
    health: 'UNAVAILABLE',
    lastSuccessfulUpdate: null,
    integrationStatus: 'NOT_CONFIGURED',
    accessNote: 'CWC/NWDP hydrological telemetry requires registered access (nwdp.nwic.gov.in). Not integrated; no live gauge feed is flowing.',
    description: 'Central Water Commission river gauges. NOT INTEGRATED — requires registered NWDP/CWC access. Do not present as live.',
  },
  TELANGANA_ICAD_RESERVOIRS: {
    sourceName: 'Telangana Irrigation & CAD Department Reservoir Operations',
    sourceType: 'official_api',
    supportedSignals: ['reservoir_level', 'reservoir_storage', 'reservoir_release', 'dam_discharge'],
    enabled: false,
    priority: 1,
    refreshIntervalMinutes: 180,
    baseConfidence: 0.95,
    currentMode: 'UNAVAILABLE',
    health: 'UNAVAILABLE',
    lastSuccessfulUpdate: null,
    integrationStatus: 'NOT_CONFIGURED',
    accessNote: 'Telangana I&CAD reservoir telemetry has no public self-serve API endpoint verified. Requires departmental data-sharing approval. Not integrated.',
    description: 'Reservoir telemetry (FRL, gross storage, inflow/outflow). NOT INTEGRATED — requires departmental approval/access. Do not present as live.',
  },
  TELANGANA_HISTORICAL_HYDROLOGY: {
    sourceName: 'Telangana State Hydrological Historical Archive',
    sourceType: 'historical_archive',
    supportedSignals: ['river_level', 'reservoir_level', 'reservoir_storage', 'reservoir_release'],
    enabled: false,
    priority: 3,
    refreshIntervalMinutes: 1440,
    baseConfidence: 0.80,
    currentMode: 'HISTORICAL',
    health: 'UNAVAILABLE',
    lastSuccessfulUpdate: null,
    integrationStatus: 'MANUAL_VERIFICATION',
    accessNote: 'Historical flood/reservoir datasets available via NWDP (nwdp.nwic.gov.in) and CWC publications. Not auto-integrated; manual verification required.',
    description: 'Historical flood levels and reservoir fills. NOT AUTO-INTEGRATED — requires manual verification and import.',
  },
  NEERDRISHTI_SIMULATION_ENGINE: {
    sourceName: 'NeerDrishti Hydrological Simulation Engine',
    sourceType: 'simulation_engine',
    supportedSignals: ['rainfall', 'river_level', 'river_flow', 'reservoir_level', 'reservoir_storage', 'reservoir_release', 'dam_discharge'],
    enabled: true,
    priority: 4,
    refreshIntervalMinutes: 0,
    baseConfidence: 0.60,
    currentMode: 'SIMULATED',
    health: 'HEALTHY',
    lastSuccessfulUpdate: new Date().toISOString(),
    integrationStatus: 'LOCAL_ENGINE',
    accessNote: 'Local deterministic scenario engine. Output is simulated, never live telemetry.',
    description: 'Deterministic scenario-based hydrodynamic flood propagation simulation. SIMULATED output — for demonstration only.',
  },
};

export const FRESHNESS_THRESHOLDS = {
  FRESH_MAX_HOURS: 3,     // 0 to 3 hours -> FRESH (1.0 factor)
  AGING_MAX_HOURS: 12,    // 3 to 12 hours -> AGING (0.8 factor)
  STALE_MAX_HOURS: 24,    // 12 to 24 hours -> STALE (0.5 factor)
  EXPIRED_MIN_HOURS: 24,  // > 24 hours -> EXPIRED (0.0 factor)
};

export const HYDROLOGY_FRESHNESS_THRESHOLDS = {
  RIVER_FRESH_MAX_HOURS: 3,
  RIVER_AGING_MAX_HOURS: 12,
  RIVER_STALE_MAX_HOURS: 24,
  RESERVOIR_FRESH_MAX_HOURS: 6,
  RESERVOIR_AGING_MAX_HOURS: 24,
  RESERVOIR_STALE_MAX_HOURS: 48,
};

export const RAINFALL_PLAUSIBLE_BOUNDS = {
  MIN_MM: 0.0,
  MAX_MM_24H: 500.0, // Plausible upper bound for 24h extreme tropical cloudburst in Telangana
  MAX_MM_BURST_3H: 250.0,
};

export const HYDROLOGICAL_PLAUSIBLE_BOUNDS = {
  RIVER_LEVEL_METERS: { MIN: 0.0, MAX: 1000.0 }, // Covers river gauge heights across Godavari/Krishna & MSL datum
  RIVER_LEVEL_FEET: { MIN: 0.0, MAX: 3500.0 },  // Covers gauge heights in feet (e.g. Osman Sagar ~1790 ft)
  RESERVOIR_STORAGE_TMC: { MIN: 0.0, MAX: 1000.0 }, // Nagarjuna Sagar, Srisailam, Kaleshwaram complex
  RESERVOIR_STORAGE_PERCENT: { MIN: 0.0, MAX: 100.0 },
  DISCHARGE_CUSECS: { MIN: 0.0, MAX: 3000000.0 }, // Max Godavari historical flood discharge ~2.5 million cusecs
  DISCHARGE_CUMECS: { MIN: 0.0, MAX: 85000.0 },
};
