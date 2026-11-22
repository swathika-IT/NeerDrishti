import express from 'express';
import { fileURLToPath } from 'url';
import compression from 'compression';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import { initDatabase, getDb as getMongoDb, closeDb, getAlertsHistoryForDistrict, insertAlertRecord, updateAlertStatus as updateDbAlertStatus, insertReportWithClassification, getReports, getReportById, insertReportAttachment, updateReportStatus, getDistrictAggregation, getAllDistrictAggregations, getLatestRainfallSignal, getDistrictSignals, insertExternalSignal, getAllAlertsHistory, recordModerationTransition, getModerationHistory } from './src/db/mongo';
import {
  REPORT_CATEGORIES,
  REPORT_SEVERITIES,
  normalizeCategory,
  sanitizeText,
  validateCoordinates,
  validateReportedAt,
  validateAttachment,
  findPrivilegedFields,
} from './src/services/reports/report_validation';
import { 
  classifyCitizenReport, 
  ALLOWED_INCIDENT_TYPES, 
  ALLOWED_SEVERITIES 
} from './src/classifier';
import { rainfallService } from './src/services/rainfall_service';
import { openMeteoService } from './src/services/open_meteo_service';
import { 
  getDistrictHydrologicalSummary, 
  getAllDistrictsHydrologicalSummaries, 
  getHydrologicalStations, 
  getStationById,
  ingestHydrologicalObservation
} from './src/services/hydrology_service';
import { situationFusionService } from './src/services/situation_fusion_service';
import { 
  projectDistrictTimeline, 
  projectAllDistricts, 
  projectDistrictRisk 
} from './src/services/forecast_service';
import { 
  calculateBasinInfluence, 
  loadBasinConnections, 
  getUpstreamConnections, 
  getDownstreamConnections 
} from './src/services/basin_routing_service';
import { AlertEngine } from './src/services/alert_engine';
import { DATA_SOURCES } from './src/config/data_sources';
import { normalizeDistrict } from './src/services/district_normalizer';
import { aiIntelligenceService } from './src/services/ai_intelligence_service';
import { knowledgeService } from './src/services/knowledge_service';
import { intentService } from './src/services/intent_service';
import { centralDataCoordinator } from './src/services/data/data_connector';
import { assessFreshness } from './src/services/data/provenance';
import { iotDeviceRegistry } from './src/services/data/iot_device_registry';
import { dataValidator } from './src/services/data/data_validator';
import { notificationService } from './src/services/notification_service';
import { NotificationDeliveryService } from './src/services/notifications/delivery_service';
import { getNotificationDeliveryConfig } from './src/services/notifications/config';
import type { NotificationAlertLevel, NotificationDeliveryChannel } from './src/services/notifications/types';
import { imdCapService } from './src/services/cap/imd_cap_service';
import { DistrictStatus } from './src/types';
import { generate24HourRainfallTrend } from './src/utils/rainfall_history';
import {
  getLlamaConfig,
  callLlamaChat,
  pingLlama,
  extractJsonFromText
} from './src/services/llama_client';
import {
  attachAuth,
  requireAuth,
  requireRole,
  requireApprovedOfficial,
  hasJurisdiction,
  type AuthenticatedRequest,
} from './src/services/auth/middleware';
import { registerAuthRoutes } from './src/routes/auth_routes';
import { registerAdminRoutes } from './src/routes/admin_routes';
import { initializeAdminSetup } from './src/services/auth/setup';
import { checkRateLimit } from './src/services/auth/rate_limit';
import { writeAuditLog } from './src/services/auth/audit';
import { validateEnvironment } from './src/config/env_validation';
import { createSecurityHeadersMiddleware } from './src/middleware/security_headers';
import { createCorsMiddleware } from './src/middleware/cors';
import { createRequestLogger } from './src/middleware/request_logging';
import { buildLivenessPayload, buildReadinessPayload, type ReadinessChecks } from './src/services/health_service';
import { createGracefulShutdown, toSafeError } from './src/services/graceful_shutdown';
import { RISK_WEIGHTS, RISK_CATEGORY_CUTOFFS, IMD_RAINFALL_CLASSES } from './src/config/risk_model';
import { buildPreview, validateContact, maskContact, severityFromRisk, SEVERITIES, type Channel, type Severity } from './src/services/notifications/preview';
import { randomUUID } from 'crypto';
import { getMapConfig } from './src/config/map_config';
import * as pipe from './src/services/pipeline_data';
import { buildCitizenContext, generateCitizenBrief } from './src/services/ai_citizen_brief';
import { getDistrictFeatures, loadDistrictFeatures, provenanceToStatus, FEATURE_LABELS } from './src/services/district_features';

dotenv.config();

const envValidation = validateEnvironment();
for (const warning of envValidation.warnings) {
  console.warn(JSON.stringify({ type: 'env_validation', severity: 'warning', ...warning }));
}
if (!envValidation.valid) {
  for (const error of envValidation.errors) {
    console.error(JSON.stringify({ type: 'env_validation', severity: 'error', ...error }));
  }
  console.error(JSON.stringify({ type: 'startup', event: 'refused', reason: 'invalid_environment' }));
  process.exit(1);
}

const RUNTIME = envValidation.config;
const app = express();
const PORT = RUNTIME.port;
app.disable('x-powered-by');

// Citizen report submission rate limits (per hour). Configurable for testing/deployment tuning.
const REPORT_RATE_LIMIT_IP_MAX = Number(process.env.REPORT_RATE_LIMIT_MAX) || 10;
const REPORT_RATE_LIMIT_USER_MAX = Number(process.env.REPORT_RATE_LIMIT_USER_MAX) || 20;

app.use(compression());
app.use(createSecurityHeadersMiddleware(RUNTIME.security));
app.use(createRequestLogger({ enabled: RUNTIME.requestLogging.enabled }));
app.use(createCorsMiddleware(RUNTIME.cors));

// Middleware for parsing JSON with increased limit for optional image uploads
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(attachAuth);

// Initialize MongoDB Database schema & seed data (async; awaited in startServer before listening)

// Authentication & administration routes (Phase 5)
registerAuthRoutes(app);
registerAdminRoutes(app);

// District Metadata Interface
interface DistrictMetadataFile {
  district_id: string;
  district_name: string;
  latitude: number;
  longitude: number;
  monitoring_category: 'Priority Flood Monitoring' | 'Standard Monitoring' | 'Limited Data';
  category_basis: string;
  data_source_mode: 'Live Data' | 'Historical Data' | 'Simulated Data' | 'Prototype Baseline' | 'Limited Data';
  data_confidence: 'High' | 'Medium' | 'Low' | 'Prototype';
  data_provenance: string;
  last_verified?: string;
  region_zone: string;
  simulation_zone: string;
  river_basin_context?: string;
  terrain_context?: string;
  historical_flood_context?: string;
  prototype_vulnerability_score?: number;
  data_limitation_notes?: string;
}

// Dynamic District Metadata Loader
function loadDistrictMetadata(): DistrictMetadataFile[] {
  const candidatePaths = [
    path.join(process.cwd(), 'data', 'telangana_districts.json'),
    path.join(process.cwd(), '..', 'data', 'telangana_districts.json'),
  ];
  for (const filePath of candidatePaths) {
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (err) {
      console.warn(`Failed reading district metadata from ${filePath}:`, err);
    }
  }
  return [];
}

function getDistrictByName(nameOrId: string): DistrictMetadataFile | undefined {
  const districts = loadDistrictMetadata();
  const query = nameOrId.trim().toLowerCase();
  return districts.find(
    d => d.district_name.toLowerCase() === query || d.district_id.toLowerCase() === query
  );
}

// Regional simulation zones & modifiers
const REGION_ZONE_MODIFIERS: Record<string, number> = {
  'Godavari Influence Region': 1.22,
  'Hyderabad Urban Region': 1.15,
  'North Telangana': 1.08,
  'Central Telangana': 0.96,
  'Krishna Influence Region': 0.92,
  'South Telangana': 0.84,
};

// Base parameters for simulation scenarios
const SCENARIO_BASE_CONFIG: Record<string, { baseRainfall: number; baseReportsMultiplier: number; description: string }> = {
  'Normal Conditions': {
    baseRainfall: 8.0,
    baseReportsMultiplier: 0.2,
    description: 'Dry to light localized precipitation across Telangana. Reservoir levels normal, urban storm drains clear.',
  },
  'Heavy Rainfall': {
    baseRainfall: 68.0,
    baseReportsMultiplier: 1.0,
    description: 'Widespread monsoon depression with heavy rainfall over Godavari & Musi basins. Low-lying waterlogging expected.',
  },
  'Flood Warning': {
    baseRainfall: 118.0,
    baseReportsMultiplier: 2.5,
    description: 'Severe weather alert. Major river surges along Godavari, Pranhita & Musi. Sluice gates open at major reservoirs.',
  },
  'Critical Flood Event': {
    baseRainfall: 185.0,
    baseReportsMultiplier: 4.0,
    description: 'Extreme cloudburst event (>150mm/24h). Severe flash flooding, urban inundation, and riverbank overtopping.',
  },
};

// Priority district calibrated overrides per scenario for demonstration accuracy
const PRIORITY_DISTRICT_CALIBRATED_RAIN: Record<string, Record<string, number>> = {
  'Normal Conditions': {
    'Hyderabad': 6.0,
    'Warangal': 4.0,
    'Nirmal': 12.0,
    'Mancherial': 8.0,
    'Bhadradri Kothagudem': 14.0,
  },
  'Heavy Rainfall': {
    'Hyderabad': 85.4,
    'Warangal': 45.2,
    'Nirmal': 115.0,
    'Mancherial': 62.0,
    'Bhadradri Kothagudem': 130.5,
  },
  'Flood Warning': {
    'Hyderabad': 120.0,
    'Warangal': 90.0,
    'Nirmal': 140.0,
    'Mancherial': 110.0,
    'Bhadradri Kothagudem': 165.0,
  },
  'Critical Flood Event': {
    'Hyderabad': 195.0,
    'Warangal': 160.0,
    'Nirmal': 225.0,
    'Mancherial': 185.0,
    'Bhadradri Kothagudem': 245.0,
  },
};

let currentScenario = 'Heavy Rainfall';
let customRainfall: Record<string, number> = {};

function computeDistrictSimulationRainfall(
  meta: DistrictMetadataFile,
  scenarioName: string,
  rainfallOverride: Record<string, number> = customRainfall
): number {
  const name = meta.district_name;
  if (rainfallOverride[name] !== undefined) {
    return rainfallOverride[name];
  }

  const priorityMap = PRIORITY_DISTRICT_CALIBRATED_RAIN[scenarioName];
  if (priorityMap && priorityMap[name] !== undefined) {
    return priorityMap[name];
  }

  const scenarioConfig = SCENARIO_BASE_CONFIG[scenarioName] || SCENARIO_BASE_CONFIG['Heavy Rainfall'];
  const zoneMod = REGION_ZONE_MODIFIERS[meta.simulation_zone] || REGION_ZONE_MODIFIERS[meta.region_zone] || 1.0;
  const vuln = meta.prototype_vulnerability_score ?? 50.0;
  const vulnFactor = 0.8 + (vuln / 250.0);

  const calculated = scenarioConfig.baseRainfall * zoneMod * vulnFactor;
  return Math.round(calculated * 10) / 10;
}

// Helper: Calculate Rainfall Score
function calculateRainfallScore(rainfall24h: number, rainfall3h: number = 0): number {
  const rf = Math.max(0, rainfall24h);
  let baseScore = 0;
  if (rf <= 15.5) {
    baseScore = (rf / 15.5) * 20.0;
  } else if (rf <= 64.4) {
    baseScore = 20.0 + ((rf - 15.5) / (64.4 - 15.5)) * 30.0;
  } else if (rf <= 115.5) {
    baseScore = 50.0 + ((rf - 64.4) / (115.5 - 64.4)) * 25.0;
  } else if (rf <= 204.4) {
    baseScore = 75.0 + ((rf - 115.5) / (204.4 - 115.5)) * 15.0;
  } else {
    baseScore = 90.0 + Math.min(10.0, ((rf - 204.4) / 100.0) * 10.0);
  }

  if (rainfall3h > 35.0) {
    baseScore = Math.min(100.0, baseScore + 10.0);
  } else if (rainfall3h > 20.0) {
    baseScore = Math.min(100.0, baseScore + 5.0);
  }

  return Math.max(0, Math.min(100, Math.round(baseScore * 10) / 10));
}

// Composite Status Computation for Any District (combining hydro data + SQLite citizen report aggregation)
async function computeDistrictStatus(
  meta: DistrictMetadataFile,
  scenarioName: string = currentScenario,
  rainfallOverride: Record<string, number> = customRainfall
): Promise<any> {
  const name = meta.district_name;
  const simRainfall24h = computeDistrictSimulationRainfall(meta, scenarioName, rainfallOverride);
  const simRainfall3h = Math.round((simRainfall24h * 0.28) * 10) / 10;

  // Authoritative Phase D1 Rainfall Selection:
  // Evaluates Live SQLite Signals -> Aging Signals -> Simulation Fallback
  const rainCtx = await rainfallService.selectRainfallForDistrict(
    meta.district_id,
    name,
    simRainfall24h,
    simRainfall3h,
    scenarioName
  );

  const activeDataMode = centralDataCoordinator.getActiveMode();
  let rainfall24h = rainCtx.rainfall_mm_24h;
  let rainfall3h = rainCtx.rainfall_mm_3h;
  let rainfallSource = rainCtx.sourceName;
  let rainfallDataMode = rainCtx.dataMode;

  const iotDevices = iotDeviceRegistry.getDevicesByDistrict(meta.district_id);
  const iotRain = iotDevices.find(d => d.sensor_type === 'rainfall');
  const iotDrain = iotDevices.find(d => d.sensor_type === 'drainage_status');

  if (activeDataMode === 'IOT' && iotRain) {
    rainfall24h = iotRain.current_value;
    rainfall3h = Math.round((rainfall24h * 0.28) * 10) / 10;
    rainfallSource = `${iotRain.device_name} (Virtual IoT Node: ${iotRain.device_id})`;
    rainfallDataMode = 'SIMULATED';
  }

  const rainfallScore = calculateRainfallScore(rainfall24h, rainfall3h);

  // Retrieve actual aggregated citizen reports from SQLite
  const repAgg = await getDistrictAggregation(name);
  const citizenReportScore = repAgg.citizen_report_score;

  // Static factors come from data/district_features.json (single source of truth,
  // each value carries provenance). Legacy in-code logic remains as a fallback
  // only if that file is absent.
  const featureRec = getDistrictFeatures(meta.district_id);
  let floodHistoryScore = featureRec?.flood_history.score ?? 40.0;
  let locationRiskScore = featureRec?.terrain.score ?? 40.0;
  let drainageVulnerabilityScore = featureRec?.drainage.score ?? 40.0;
  if (!featureRec) {
    const vuln = meta.prototype_vulnerability_score ?? 45.0;
    floodHistoryScore = Math.round(vuln * 0.95);
    locationRiskScore = Math.round(vuln * 0.90);
    drainageVulnerabilityScore = Math.round(vuln * 0.85);
  }

  if (activeDataMode === 'IOT' && iotDrain) {
    drainageVulnerabilityScore = Math.max(10, Math.min(95, 100 - iotDrain.current_value));
  }

  // Exact 5-factor weighted formula (35% rainfall, 25% hist, 15% terrain, 15% citizen, 10% drainage)
  const rainfallPts = Math.round((rainfallScore * RISK_WEIGHTS.rainfall) * 100) / 100;
  const historyPts = Math.round((floodHistoryScore * RISK_WEIGHTS.flood_history) * 100) / 100;
  const locationPts = Math.round((locationRiskScore * RISK_WEIGHTS.terrain) * 100) / 100;
  const citizenPts = Math.round((citizenReportScore * RISK_WEIGHTS.citizen_reports) * 100) / 100;
  const drainagePts = Math.round((drainageVulnerabilityScore * RISK_WEIGHTS.drainage) * 100) / 100;

  const totalScore = Math.min(100.0, Math.round((rainfallPts + historyPts + locationPts + citizenPts + drainagePts) * 100) / 100);

  let riskCategory: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL' = 'LOW';
  if (totalScore > 75.0) riskCategory = 'CRITICAL';
  else if (totalScore > 50.0) riskCategory = 'HIGH';
  else if (totalScore > 25.0) riskCategory = 'MODERATE';

  let completeness = 85;
  if (meta.monitoring_category === 'Priority Flood Monitoring') completeness = 98;
  else if (meta.monitoring_category === 'Limited Data') completeness = 65;

  const baseStatus: DistrictStatus = {
    district: name,
    district_id: meta.district_id,
    lat: meta.latitude,
    lng: meta.longitude,
    terrain_type: meta.terrain_context || 'Deccan Plateau Terrain',
    river_basin: meta.river_basin_context || 'Godavari / Krishna Sub-Basin',
    monitoring_category: meta.monitoring_category,
    data_source_mode: rainCtx.dataMode === 'LIVE' ? 'Live Data' : meta.data_source_mode,
    data_confidence: rainCtx.dataMode === 'LIVE' ? (rainCtx.confidence >= 0.8 ? 'High' : 'Medium') : meta.data_confidence,
    data_provenance: rainCtx.dataMode === 'LIVE' ? `${rainCtx.sourceName} (Observation: ${rainCtx.recordedAt})` : meta.data_provenance,
    data_limitation_notes: meta.data_limitation_notes,
    category_basis: meta.category_basis,
    region_zone: meta.region_zone,
    simulation_zone: meta.simulation_zone,
    last_updated: new Date().toISOString().replace('T', ' ').slice(0, 19),
    is_simulated: rainCtx.isSimulated,
    feature_provenance: featureRec ? { flood_history: featureRec.flood_history.provenance, terrain: featureRec.terrain.provenance, drainage: featureRec.drainage.provenance } : undefined,
    risk_confidence: meta.data_confidence,
    risk_data_completeness: completeness,
    rainfall_mm_24h: rainfall24h,
    rainfall_mm_3h: rainfall3h,
    rainfall_score: rainfallScore,
    rainfall_source: rainfallSource,
    rainfall_data_mode: rainfallDataMode,
    rainfall_freshness: rainCtx.freshness,
    rainfall_confidence: rainCtx.confidence,
    rainfall_recorded_at: rainCtx.recordedAt,
    rainfall_selection_reason: rainCtx.selectionReason,
    flood_history_score: floodHistoryScore,
    location_risk_score: locationRiskScore,
    drainage_vulnerability_score: drainageVulnerabilityScore,
    citizen_reports_count: repAgg.total_reports,
    citizen_reports_24h: repAgg.reports_24h,
    citizen_reports_high_severity: repAgg.high_severity_reports,
    citizen_reports_critical: repAgg.critical_reports,
    citizen_report_score: citizenReportScore,
    citizen_reports_trend: repAgg.recent_trend,
    citizen_explainability: repAgg.explainability,
    flood_risk_score: totalScore,
    risk_category: riskCategory,
    contributions: {
      rainfall: rainfallPts,
      flood_history: historyPts,
      location_risk: locationPts,
      citizen_reports: citizenPts,
      drainage_vulnerability: drainagePts,
    },
    components: {
      rainfall_score: rainfallScore,
      flood_history_score: floodHistoryScore,
      location_risk_score: locationRiskScore,
      citizen_report_score: citizenReportScore,
      drainage_vulnerability_score: drainageVulnerabilityScore,
    },
    major_past_events: meta.historical_flood_context || 'Monsoon seasonal runoff and drainage surges.',
    vulnerable_hotspots: name === 'Hyderabad' ? 'Nadeem Colony, Moosarambagh, Falaknuma, Alwal' : 'Low-lying culverts and municipal drain channels',
    primary_nala_network: name === 'Hyderabad' ? 'Musi River, Kukatpally Nala, Murki Nala' : 'Regional Stormwater Runoff Channels',
    hydrological_summary: await getDistrictHydrologicalSummary(meta.district_id, scenarioName),
  };

  const situation = situationFusionService.synthesizeDistrictSituation(baseStatus);
  baseStatus.situation_summary = situation;

  const timeline = await projectDistrictTimeline(baseStatus);
  baseStatus.forecast_timeline = timeline;
  baseStatus.forecast_summary = timeline.timeline.h6;

  const alert = AlertEngine.evaluateDistrictAlert(baseStatus);
  baseStatus.alert_intelligence = alert;

  return baseStatus;
}

async function computeAllDistrictStatus(
  scenarioName: string = currentScenario,
  rainfallOverride: Record<string, number> = customRainfall
): Promise<any[]> {
  const allDistricts = loadDistrictMetadata();
  const baseList = await Promise.all(allDistricts.map(meta => computeDistrictStatus(meta, scenarioName, rainfallOverride)));
  const statusMap: Record<string, any> = {};
  for (const item of baseList) {
    if (item.district_id) statusMap[item.district_id] = item;
  }
  for (const item of baseList) {
    const timeline = await projectDistrictTimeline(item, statusMap);
    item.forecast_timeline = timeline;
    item.forecast_summary = timeline.timeline.h6;
    const alert = AlertEngine.evaluateDistrictAlert(item);
    item.alert_intelligence = alert;
  }
  return baseList;
}

// Knowledge Base Loader
function getKnowledgeDoc(districtName: string): string {
  const kbPath = path.join(process.cwd(), 'knowledge_base', `${districtName.toLowerCase().replace(/ /g, '_')}_knowledge.json`);
  try {
    if (fs.existsSync(kbPath)) {
      return fs.readFileSync(kbPath, 'utf-8');
    }
  } catch (err) {
    console.warn(`Could not read KB for ${districtName}`);
  }
  return `General hydrological and meteorological profile for ${districtName}, Telangana.`;
}

// ==========================================
// API ROUTES
// ==========================================

async function probeReadiness(): Promise<ReadinessChecks> {
  const db = getMongoDb();
  await db.command({ ping: 1 });
  const districtCount = await db.collection('districts').countDocuments();
  return {
    database: 'ok',
    migrations: districtCount > 0 ? 'ok' : 'error',
  };
}

// 1. Health checks
app.get('/api/health', async (req, res) => {
  const config = getLlamaConfig();
  res.json({
    status: 'ok',
    app: 'NeerDrishti Flood Intelligence Engine',
    phase: 'Phase C - Persistent Citizen Flood Intelligence',
    database: 'MongoDB',
    llm_provider: 'Meta Llama (OpenAI-Compatible)',
    llm_model: config.model,
    districts_loaded: loadDistrictMetadata().length,
  });
});

app.get('/api/health/live', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(buildLivenessPayload());
});

app.get('/api/health/ready', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  let checks: ReadinessChecks;
  try {
    checks = await probeReadiness();
  } catch {
    checks = { database: 'error', migrations: 'unknown' };
  }
  const payload = buildReadinessPayload(() => checks);
  res.status(payload.status === 'ready' ? 200 : 503).json(payload);
});

// Read-only scenario/rainfall view overrides via query params (public dashboard, no global mutation).
function getScenarioViewOverrides(req: express.Request): {
  scenario: string;
  rainfallOverride: Record<string, number>;
} {
  const validScenarios = Object.keys(SCENARIO_BASE_CONFIG);
  let scenario = currentScenario;
  const qScenario = typeof req.query.scenario === 'string' ? req.query.scenario : null;
  if (qScenario && validScenarios.includes(qScenario)) {
    scenario = qScenario;
  }

  const rainfallOverride: Record<string, number> = {};
  const raw = typeof req.query.rain_override === 'string' ? req.query.rain_override : null;
  if (raw) {
    for (const pair of raw.split(',')) {
      const [districtName, valueStr] = pair.split(':');
      const value = Number(valueStr);
      if (districtName && Number.isFinite(value) && value >= 0 && value <= 500) {
        rainfallOverride[districtName.trim()] = value;
      }
    }
  }
  return { scenario, rainfallOverride };
}


// ---- Risk model transparency + data completeness (read-only, public) ----
app.get('/api/risk/model', (_req, res) => {
  res.json({
    formula: 'score = Σ(weight × factor_score), each factor_score normalised to 0-100',
    weights: RISK_WEIGHTS,
    weights_sum: Object.values(RISK_WEIGHTS).reduce((a, b) => a + b, 0),
    category_cutoffs: RISK_CATEGORY_CUTOFFS,
    rainfall_classes_mm_24h: IMD_RAINFALL_CLASSES.map(c => ({ name: c.name, min: c.min, max: Number.isFinite(c.max) ? c.max : null })),
    status: 'Operational weights. Playground weights are experimental and never change operational scores.',
  });
});

app.get('/api/data/completeness', async (req, res) => {
  try {
    const view = getScenarioViewOverrides(req);
    const all = await computeAllDistrictStatus(view.scenario, view.rainfallOverride);
    const features = loadDistrictFeatures();
    const rows = all.map((d: any) => {
      const f = features?.districts[d.district_id];
      const featCell = (k: 'flood_history' | 'terrain' | 'drainage') => ({
        status: f ? provenanceToStatus(f[k].provenance) : 'MISSING',
        provenance: f ? f[k].provenance : 'MISSING',
        source: f ? f[k].source : 'none',
        score: f ? f[k].score : null,
        updated: features?.generated_at ?? null,
      });
      const rainMode = d.rainfall_data_mode || 'SIMULATED';
      const hydro = d.hydrological_summary;
      return {
        district_id: d.district_id,
        district: d.district,
        monitoring_category: d.monitoring_category,
        cells: {
          rainfall: {
            status: rainMode === 'LIVE' ? 'ESTIMATED' : rainMode === 'SIMULATED' ? 'SIMULATED' : 'MISSING',
            provenance: rainMode,
            source: d.rainfall_source,
            score: d.rainfall_score,
            updated: d.rainfall_recorded_at ?? null,
          },
          flood_history: featCell('flood_history'),
          terrain: featCell('terrain'),
          drainage: featCell('drainage'),
          citizen_reports: {
            status: 'OBSERVED',
            provenance: 'CITIZEN_VERIFIED_ONLY',
            source: 'NeerDrishti citizen reports (verified only)',
            score: d.citizen_report_score,
            updated: d.last_updated,
          },
          river_gauges: {
            status: !hydro || hydro.active_stations_count === 0 ? 'MISSING' : hydro.data_mode === 'LIVE' ? 'OBSERVED' : 'SIMULATED',
            provenance: hydro?.data_mode ?? 'NONE',
            source: hydro?.source_attribution ?? 'none',
            score: null,
            updated: hydro?.last_updated ?? null,
          },
        },
      };
    });
    const totals: Record<string, number> = {};
    rows.forEach(r => Object.values(r.cells).forEach((c: any) => { totals[c.status] = (totals[c.status] || 0) + 1; }));
    res.json({
      generated_at: new Date().toISOString(),
      scenario: view.scenario,
      columns: ['rainfall', 'flood_history', 'terrain', 'drainage', 'citizen_reports', 'river_gauges'],
      column_labels: { rainfall: 'Rainfall', ...FEATURE_LABELS, citizen_reports: 'Citizen reports', river_gauges: 'River gauges' },
      legend: {
        OBSERVED: 'Measured or verified input',
        ESTIMATED: 'Modelled value (e.g. weather model) or expert prior',
        IMPUTED: 'Derived from a proxy / neighbouring information — not a measurement',
        SIMULATED: 'Synthetic scenario value for demonstration',
        MISSING: 'No data',
      },
      totals,
      rows,
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to build completeness matrix' });
  }
});

// 2. Districts Metadata and Live Overview
app.get('/api/districts', async (req, res) => {
  try {
    const { category, zone, search, slim } = req.query;
    const view = getScenarioViewOverrides(req);
    let districts = await computeAllDistrictStatus(view.scenario, view.rainfallOverride);

    if (category && typeof category === 'string' && category.toLowerCase() !== 'all') {
      const catLower = category.toLowerCase();
      districts = districts.filter(d => d.monitoring_category.toLowerCase().includes(catLower));
    }

    if (zone && typeof zone === 'string' && zone.toLowerCase() !== 'all') {
      const zoneLower = zone.toLowerCase();
      districts = districts.filter(d => d.region_zone.toLowerCase().includes(zoneLower));
    }

    if (search && typeof search === 'string' && search.trim()) {
      const s = search.trim().toLowerCase();
      districts = districts.filter(d =>
        d.district.toLowerCase().includes(s) ||
        d.river_basin.toLowerCase().includes(s) ||
        d.terrain_type.toLowerCase().includes(s)
      );
    }

    const allDistricts = await computeAllDistrictStatus(view.scenario, view.rainfallOverride);
    const priorityCount = allDistricts.filter(d => d.monitoring_category === 'Priority Flood Monitoring').length;
    const standardCount = allDistricts.filter(d => d.monitoring_category === 'Standard Monitoring').length;
    const limitedCount = allDistricts.filter(d => d.monitoring_category === 'Limited Data').length;
    const highRiskCount = allDistricts.filter(d => d.risk_category === 'HIGH').length;
    const criticalRiskCount = allDistricts.filter(d => d.risk_category === 'CRITICAL').length;

    const highestRiskDistrict = allDistricts.reduce((max, d) => (d.flood_risk_score > max.flood_risk_score ? d : max), allDistricts[0]);

    res.json({
      scenario: view.scenario,
      is_simulation: true,
      data_source_mode: 'Simulated Data',
      overview: {
        total_districts: allDistricts.length,
        priority_count: priorityCount,
        standard_count: standardCount,
        limited_count: limitedCount,
        high_risk_count: highRiskCount,
        critical_risk_count: criticalRiskCount,
        highest_risk_district: highestRiskDistrict?.district,
        highest_risk_score: highestRiskDistrict?.flood_risk_score,
        highest_risk_category: highestRiskDistrict?.risk_category,
      },
      total_count: districts.length,
      // ?slim=1 drops the large nested forecast/situation/alert/hydrology blocks
      // (used by the Simple View) to cut payload size.
      districts: slim === '1'
        ? districts.map((d: any) => {
            const { forecast_timeline, situation_summary, alert_intelligence, hydrological_summary, ...rest } = d;
            return rest;
          })
        : districts,
    });
  } catch (error: any) {
    console.error('Error in /api/districts:', error);
    res.status(500).json({
      error: error?.message || 'Failed to compute districts status',
      districts: [],
    });
  }
});

// 2b. District 24-Hour Historical Rainfall Trend (Last 24 Hours)
app.get('/api/districts/:district/rainfall-history', async (req, res) => {
  try {
    const { district } = req.params;
    const allDistricts = await computeAllDistrictStatus();
    const dLower = district.toLowerCase().trim();
    const matched = allDistricts.find(d => 
      d.district.toLowerCase() === dLower || 
      (d.district_id && d.district_id.toLowerCase() === dLower)
    );

    if (!matched) {
      return res.status(404).json({ error: `District '${district}' not found among the 33 Telangana districts.` });
    }

    const trendSummary = generate24HourRainfallTrend(
      matched.rainfall_mm_24h,
      matched.rainfall_mm_3h,
      matched.district
    );

    res.json({
      district_id: matched.district_id,
      district_name: matched.district,
      river_basin: matched.river_basin,
      data_mode: matched.data_source_mode,
      monitoring_category: matched.monitoring_category,
      risk_category: matched.risk_category,
      flood_risk_score: matched.flood_risk_score,
      summary: trendSummary,
    });
  } catch (error: any) {
    console.error('Error in /api/districts/:district/rainfall-history:', error);
    res.status(500).json({ error: error?.message || 'Failed to generate rainfall history' });
  }
});

// 3. Update Simulation Scenario
app.post('/api/simulation/set-scenario', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    const { scenario, custom_rainfall } = req.body;

    if (!scenario || typeof scenario !== 'string') {
      return res.status(400).json({
        error: 'Invalid request: "scenario" field is required and must be a string.',
        allowed_scenarios: Object.keys(SCENARIO_BASE_CONFIG),
      });
    }

    const validScenarios = Object.keys(SCENARIO_BASE_CONFIG);
    if (!validScenarios.includes(scenario)) {
      return res.status(400).json({
        error: `Invalid scenario '${scenario}'. Allowed values: ${validScenarios.join(', ')}.`,
        allowed_scenarios: validScenarios,
      });
    }

    currentScenario = scenario;
    if (custom_rainfall && typeof custom_rainfall === 'object') {
      customRainfall = { ...custom_rainfall };
    } else {
      customRainfall = {};
    }

    // Sync virtual IoT device mesh with the selected scenario
    iotDeviceRegistry.syncWithScenario(currentScenario);

    const districts = await computeAllDistrictStatus();
    const scenarioConfig = SCENARIO_BASE_CONFIG[currentScenario];

    res.json({
      success: true,
      scenario: currentScenario,
      is_simulation: true,
      data_source_mode: 'Simulated Data',
      simulation_summary: `Scaled regional simulation across all 33 Telangana districts for '${currentScenario}': ${scenarioConfig.description}`,
      timestamp: new Date().toISOString(),
      districts,
    });
  } catch (error: any) {
    console.error('Error in /api/simulation/set-scenario:', error);
    res.status(500).json({
      error: error?.message || 'Failed to update simulation scenario',
      scenario: currentScenario,
    });
  }
});

// 3b. Real-Time Rainfall Signal Query & Telemetry Ingestion (Phase D1)
app.get('/api/signals/rainfall', async (req, res) => {
  try {
    const { district } = req.query;
    const allDistricts = loadDistrictMetadata();

    if (district && typeof district === 'string') {
      const norm = normalizeDistrict(district);
      if (!norm.resolved || !norm.districtId) {
        return res.status(404).json({
          error: `District '${district}' not found. Please provide one of the 33 canonical Telangana districts.`,
        });
      }
      const meta = allDistricts.find(d => d.district_id.toLowerCase() === norm.districtId.toLowerCase());
      if (!meta) {
        return res.status(404).json({ error: `Metadata missing for district '${district}'` });
      }
      const status = await computeDistrictStatus(meta);
      return res.json({
        district_id: status.district_id,
        district_name: status.district,
        rainfall_mm_24h: status.rainfall_mm_24h,
        rainfall_mm_3h: status.rainfall_mm_3h,
        unit: 'mm',
        source: status.rainfall_source || DATA_SOURCES.NEERDRISHTI_SIMULATION_ENGINE.sourceName,
        data_mode: status.rainfall_data_mode || 'SIMULATED',
        freshness: status.rainfall_freshness || 'FRESH',
        confidence: status.rainfall_confidence ?? 0.60,
        recorded_at: status.rainfall_recorded_at || status.last_updated,
        selection_reason: status.rainfall_selection_reason,
        is_simulated: status.is_simulated,
        rainfall_score: status.rainfall_score,
        rainfall_contribution_pts: status.contributions.rainfall,
      });
    }

    // Return all 33 districts' rainfall telemetry overview
    const signals = await Promise.all(allDistricts.map(async (meta) => {
      const status = await computeDistrictStatus(meta);
      return {
        district_id: status.district_id,
        district_name: status.district,
        rainfall_mm_24h: status.rainfall_mm_24h,
        rainfall_mm_3h: status.rainfall_mm_3h,
        unit: 'mm',
        source: status.rainfall_source || DATA_SOURCES.NEERDRISHTI_SIMULATION_ENGINE.sourceName,
        data_mode: status.rainfall_data_mode || 'SIMULATED',
        freshness: status.rainfall_freshness || 'FRESH',
        confidence: status.rainfall_confidence ?? 0.60,
        recorded_at: status.rainfall_recorded_at || status.last_updated,
        is_simulated: status.is_simulated,
        rainfall_score: status.rainfall_score,
      rainfall_contribution_pts: status.contributions.rainfall,
       };
     }));

     res.json({
      total_count: signals.length,
      signals,
    });
  } catch (error: any) {
    console.error('Error in /api/signals/rainfall:', error);
    res.status(500).json({ error: error?.message || 'Failed to fetch rainfall signals' });
  }
});

// 3c. Ingest Live External Observation
app.post('/api/signals/ingest', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    const { district, rainfall_mm, burst_3h_mm, source_name, source_type, data_mode, recorded_at } = req.body;
    if (!district || rainfall_mm === undefined) {
      return res.status(400).json({
        error: 'Invalid payload: "district" and "rainfall_mm" fields are required.',
      });
    }

    const result = await rainfallService.ingestObservation({
      rawDistrict: district,
      rainfall_mm: Number(rainfall_mm),
      burst_3h_mm: burst_3h_mm !== undefined ? Number(burst_3h_mm) : undefined,
      sourceName: source_name,
      sourceType: source_type,
      dataMode: data_mode || 'LIVE',
      timestamp: recorded_at || new Date().toISOString(),
    });

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.status(201).json({
      success: true,
      message: 'External rainfall signal successfully ingested and ledgered.',
      signal: result.signal,
    });
  } catch (error: any) {
    console.error('Error in /api/signals/ingest:', error);
    res.status(500).json({ error: error?.message || 'Failed to ingest external signal' });
  }
});

// 3c-1. Open-Meteo Live Rainfall Refresh & Status (Item 1)
app.post('/api/rainfall/refresh-live', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    const { district_id } = req.body || {};
    const allDistricts = loadDistrictMetadata();

    if (district_id && typeof district_id === 'string') {
      const target = allDistricts.find(
        d => d.district_id.toLowerCase() === district_id.toLowerCase() || d.district_name.toLowerCase() === district_id.toLowerCase()
      );
      if (!target) {
        return res.status(404).json({ error: `District '${district_id}' not found among canonical districts.` });
      }

      const result = await openMeteoService.fetchLiveRainfallForDistrict(target);
      return res.json({
        success: result.success,
        district: target.district_name,
        result,
        timestamp: new Date().toISOString(),
      });
    }

    // Refresh all 33 districts
    const refreshResult = await openMeteoService.refreshAllDistricts(allDistricts);
    res.json({
      success: true,
      message: `Open-Meteo live refresh completed for ${refreshResult.success_count}/${refreshResult.total} districts.`,
      refresh_summary: refreshResult,
      data_mode: 'LIVE',
      source_name: DATA_SOURCES.OPEN_METEO_TELEMETRY.sourceName,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Error in /api/rainfall/refresh-live:', error);
    res.status(500).json({ error: error?.message || 'Failed to refresh live rainfall from Open-Meteo' });
  }
});

app.get('/api/rainfall/live-status', async (req, res) => {
  try {
    const status = openMeteoService.getStatus();
    res.json({
      ...status,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to get Open-Meteo status' });
  }
});

// 3c-2. Official CAP warning feeds (Epic 4)
app.get('/api/cap/status', async (req, res) => {
  try {
    res.json({
      ...imdCapService.getStatus(),
      summary: imdCapService.getAlertSummary(),
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to get CAP feed status' });
  }
});

app.get('/api/cap/summary', async (req, res) => {
  try {
    res.json(await imdCapService.getAlertSummary());
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to summarize CAP alerts' });
  }
});

app.get('/api/cap/alerts', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const telanganaOnly = req.query.telangana !== 'false';
    const activeOnly = req.query.active !== 'false';
    const alerts = await imdCapService.getStoredAlerts(limit, telanganaOnly, activeOnly);
    res.json({
      total: alerts.length,
      filters: {
        limit,
        telangana_only: telanganaOnly,
        active_only: activeOnly,
      },
      alerts,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to fetch CAP alerts' });
  }
});

app.post('/api/cap/refresh', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    const clientIp = req.socket?.remoteAddress || 'unknown';
    if (!checkRateLimit(`cap-refresh:${clientIp}`, 4, 60).allowed) {
      return res.status(429).json({ error: 'Too many CAP refresh requests. Try again shortly.' });
    }
    const result = await imdCapService.refresh();
    res.json({
      success: result.status !== 'OFFLINE',
      refresh_summary: result,
      summary: imdCapService.getAlertSummary(),
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Error in /api/cap/refresh:', error);
    res.status(500).json({ error: error?.message || 'Failed to refresh CAP feeds' });
  }
});

// 3d. Central Data Sources Registry
app.get('/api/sources', async (req, res) => {
  try {
    const sourcesList = Object.entries(DATA_SOURCES).map(([key, source]) => ({
      registry_key: key,
      provider_name: source.sourceName,
      provider_type: source.sourceType,
      supported_signals: source.supportedSignals,
      enabled: source.enabled,
      priority: source.priority,
      refresh_interval_minutes: source.refreshIntervalMinutes,
      base_confidence: source.baseConfidence,
      current_mode: source.currentMode,
      health_status: source.health,
      last_successful_update: source.lastSuccessfulUpdate,
      integration_status: source.integrationStatus || 'NOT_CONFIGURED',
      access_note: source.accessNote || null,
      freshness: assessFreshness(source.lastSuccessfulUpdate),
      description: source.description,
    }));

    res.json({
      total_sources: sourcesList.length,
      sources: sourcesList,
    });
  } catch (error: any) {
    console.error('Error in /api/sources:', error);
    res.status(500).json({ error: error?.message || 'Failed to fetch data source registry' });
  }
});

// ==========================================
// HYDROLOGICAL SIGNAL INTELLIGENCE (PHASE D2)
// ==========================================

// 3e. GET /api/hydrology/stations - Station Registry
app.get('/api/hydrology/stations', async (req, res) => {
  try {
    const { district_id, basin, active } = req.query;
    let stations = await getHydrologicalStations(typeof district_id === 'string' ? district_id : undefined);

    if (basin && typeof basin === 'string') {
      stations = stations.filter(s => (s.basin || '').toLowerCase().includes(basin.toLowerCase()));
    }
    if (active !== undefined) {
      const activeBool = active === 'true' || active === '1';
      stations = stations.filter(s => s.active === activeBool);
    }

    res.json({
      total_count: stations.length,
      stations,
    });
  } catch (error: any) {
    console.error('Error in /api/hydrology/stations:', error);
    res.status(500).json({ error: error?.message || 'Failed to fetch hydrological stations' });
  }
});

// 3f. GET /api/hydrology/district/:districtId - District Hydrological Summary
app.get('/api/hydrology/district/:districtId', async (req, res) => {
  try {
    const { districtId } = req.params;
    const summary = await getDistrictHydrologicalSummary(districtId, currentScenario);
    res.json(summary);
  } catch (error: any) {
    console.error('Error in /api/hydrology/district/:districtId:', error);
    res.status(500).json({ error: error?.message || 'Failed to fetch district hydrological summary' });
  }
});

// 3g. GET /api/signals/hydrology - Hydrological Observations & Ledger
app.get('/api/signals/hydrology', async (req, res) => {
  try {
    const { district_id, signal_type, status } = req.query;

    if (district_id && typeof district_id === 'string') {
      const summary = await getDistrictHydrologicalSummary(district_id, currentScenario);
      let observations = summary.latest_observations;
      if (signal_type && typeof signal_type === 'string') {
        observations = observations.filter(o => o.signal_type === signal_type);
      }
      if (status && typeof status === 'string') {
        observations = observations.filter(o => o.status.toLowerCase() === status.toLowerCase());
      }
      return res.json({
        district_id: summary.district_id,
        district_name: summary.district_name,
        dominant_status: summary.dominant_status,
        dominant_trend: summary.dominant_trend,
        data_mode: summary.data_mode,
        freshness: summary.freshness,
        overall_confidence: summary.overall_confidence,
        source_attribution: summary.source_attribution,
        total_observations: observations.length,
        observations,
        anomalies: summary.anomalies,
      });
    }

    // Return summaries across all districts
    const summaries = await getAllDistrictsHydrologicalSummaries(currentScenario);
    const summaryList = Object.values(summaries);

    res.json({
      total_districts: summaryList.length,
      active_warnings_count: summaryList.filter(s => s.has_active_warning).length,
      active_dangers_count: summaryList.filter(s => s.has_active_danger).length,
      summaries: summaryList,
    });
  } catch (error: any) {
    console.error('Error in /api/signals/hydrology:', error);
    res.status(500).json({ error: error?.message || 'Failed to fetch hydrological signals' });
  }
});

// 3h. POST /api/signals/hydrology/ingest - Ingest Gauge / Water Telemetry
app.post('/api/signals/hydrology/ingest', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    const {
      station_id,
      district,
      signal_type,
      value,
      unit,
      source_name,
      source_type,
      data_mode,
      recorded_at,
      metadata,
    } = req.body;

    if (!station_id || value === undefined || !signal_type) {
      return res.status(400).json({
        error: 'Invalid payload: "station_id", "signal_type", and numeric "value" are required.',
      });
    }

    const result = await ingestHydrologicalObservation({
      stationId: String(station_id),
      rawDistrict: district,
      signalType: signal_type,
      value: Number(value),
      unit,
      sourceName: source_name,
      sourceType: source_type,
      dataMode: data_mode || 'LIVE',
      timestamp: recorded_at || new Date().toISOString(),
      metadata,
    });

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.status(201).json({
      success: true,
      message: 'Hydrological observation successfully ingested and ledgered.',
      observation: result.observation,
    });
  } catch (error: any) {
    console.error('Error in /api/signals/hydrology/ingest:', error);
    res.status(500).json({ error: error?.message || 'Failed to ingest hydrological observation' });
  }
});

// ==========================================
// MULTI-SIGNAL SITUATION FUSION API (PHASE D3)
// ==========================================

// 3i. GET /api/situation/districts - Multi-Signal Situation Overview for all 33 Districts
app.get('/api/situation/districts', async (req, res) => {
  try {
    const allDistricts = await computeAllDistrictStatus();
    const situations = allDistricts.map(d => d.situation_summary || situationFusionService.synthesizeDistrictSituation(d));

    const operationalCounts = {
      CRITICAL_INFORMATIONAL: situations.filter(s => s.operationalSituation === 'CRITICAL_INFORMATIONAL').length,
      HIGH_CONCERN: situations.filter(s => s.operationalSituation === 'HIGH_CONCERN').length,
      ELEVATED_ATTENTION: situations.filter(s => s.operationalSituation === 'ELEVATED_ATTENTION').length,
      MONITORING: situations.filter(s => s.operationalSituation === 'MONITORING').length,
      NORMAL: situations.filter(s => s.operationalSituation === 'NORMAL').length,
    };

    res.json({
      total_districts: situations.length,
      scenario: currentScenario,
      operational_counts: operationalCounts,
      situations,
    });
  } catch (error: any) {
    console.error('Error in /api/situation/districts:', error);
    res.status(500).json({ error: error?.message || 'Failed to fetch district situations' });
  }
});

// 3j. GET /api/situation/district/:districtId - Detailed Situation for One District
app.get('/api/situation/district/:districtId', async (req, res) => {
  try {
    const { districtId } = req.params;
    const allDistricts = await computeAllDistrictStatus();
    const norm = normalizeDistrict(districtId);
    const targetId = norm.resolved ? norm.districtId : districtId.toLowerCase().trim();

    const matched = allDistricts.find(
      d => (d.district_id && d.district_id.toLowerCase() === targetId) ||
           d.district.toLowerCase() === districtId.toLowerCase()
    );

    if (!matched) {
      return res.status(404).json({
        error: `District '${districtId}' not found. Please provide a valid 33-district identifier.`,
      });
    }

    const situation = matched.situation_summary || situationFusionService.synthesizeDistrictSituation(matched);
    res.json(situation);
  } catch (error: any) {
    console.error(`Error in /api/situation/district/${req.params.districtId}:`, error);
    res.status(500).json({ error: error?.message || 'Failed to fetch district situation' });
  }
});

// 3k. GET /api/situation/district/:districtId/explain - Explainable Multi-Signal Breakdown
app.get('/api/situation/district/:districtId/explain', async (req, res) => {
  try {
    const { districtId } = req.params;
    const allDistricts = await computeAllDistrictStatus();
    const norm = normalizeDistrict(districtId);
    const targetId = norm.resolved ? norm.districtId : districtId.toLowerCase().trim();

    const matched = allDistricts.find(
      d => (d.district_id && d.district_id.toLowerCase() === targetId) ||
           d.district.toLowerCase() === districtId.toLowerCase()
    );

    if (!matched) {
      return res.status(404).json({
        error: `District '${districtId}' not found. Please provide a valid 33-district identifier.`,
      });
    }

    const situation = matched.situation_summary || situationFusionService.synthesizeDistrictSituation(matched);
    const primaryDriverText = situation.primaryDrivers.length > 0
      ? situation.primaryDrivers.map(d => d.evidence).join('; ')
      : 'Baseline environmental conditions within normal tolerance thresholds.';

    const explanation = `District ${situation.districtName} is categorized under ${situation.operationalSituation.replace(/_/g, ' ')} with an authoritative 5-factor composite flood risk score of ${situation.compositeRiskScore}/100 (${situation.compositeRiskLevel}). Data confidence is ${situation.dataConfidence} (${Math.round(situation.dataConfidenceScore * 100)}%) with ${situation.signalCoverage.available}/${situation.signalCoverage.total} signal domains active. Primary drivers: ${primaryDriverText}`;

    res.json({
      districtId: situation.districtId,
      districtName: situation.districtName,
      compositeRiskScore: situation.compositeRiskScore,
      compositeRiskLevel: situation.compositeRiskLevel,
      operationalSituation: situation.operationalSituation,
      dataConfidence: situation.dataConfidence,
      dataConfidenceScore: situation.dataConfidenceScore,
      signalCoverage: situation.signalCoverage,
      freshnessSummary: situation.freshnessSummary,
      primaryDrivers: situation.primaryDrivers,
      supportingSignals: situation.supportingSignals,
      dataLimitations: situation.dataLimitations,
      recentAnomalies: situation.recentAnomalies,
      recommendedActions: situation.recommendedActions,
      explanation,
      generatedAt: situation.generatedAt,
    });
  } catch (error: any) {
    console.error(`Error in /api/situation/district/${req.params.districtId}/explain:`, error);
    res.status(500).json({ error: error?.message || 'Failed to explain district situation' });
  }
});

// ==========================================
// PHASE E: PREDICTIVE FLOOD RISK & FORECAST INTELLIGENCE API
// ==========================================

// 1. GET /api/forecast/districts - Forecast projections for all 33 districts
app.get('/api/forecast/districts', async (req, res) => {
  try {
    const { horizon, outlook } = req.query;
    const allDistricts = await computeAllDistrictStatus();
    const forecastMap = await projectAllDistricts(allDistricts);

    let list = Object.values(forecastMap);

    if (outlook && typeof outlook === 'string' && outlook.toUpperCase() !== 'ALL') {
      list = list.filter(f => f.overallForecastOutlook === outlook.toUpperCase());
    }

    const criticalCount = list.filter(f => f.overallForecastOutlook === 'CRITICAL_PROJECTION').length;
    const highCount = list.filter(f => f.overallForecastOutlook === 'HIGH_PROJECTION').length;
    const elevatingCount = list.filter(f => f.overallForecastOutlook === 'ELEVATING_RISK').length;
    const risingTrendCount = list.filter(f => f.dominantTrend === 'RISING').length;

    res.json({
      total_districts: list.length,
      overview: {
        critical_projections: criticalCount,
        high_projections: highCount,
        elevating_risk: elevatingCount,
        rising_trend_districts: risingTrendCount,
      },
      forecasts: list,
      disclaimer: 'Informational model projections for decision support. Not an official government flood forecast.',
      generated_at: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Error in /api/forecast/districts:', error);
    res.status(500).json({ error: error?.message || 'Failed to fetch forecasts' });
  }
});

// 2. GET /api/forecast/district/:districtId - Specific district forecast timeline
app.get('/api/forecast/district/:districtId', async (req, res) => {
  try {
    const { districtId } = req.params;
    const allDistricts = await computeAllDistrictStatus();
    const norm = normalizeDistrict(districtId);
    const targetId = norm.resolved ? norm.districtId : districtId.toLowerCase().trim();

    const matched = allDistricts.find(
      d => (d.district_id && d.district_id.toLowerCase() === targetId) ||
           d.district.toLowerCase() === districtId.toLowerCase()
    );

    if (!matched) {
      return res.status(404).json({
        error: `District '${districtId}' not found. Please provide a valid 33-district identifier.`,
      });
    }

    const statusMap: Record<string, any> = {};
    for (const d of allDistricts) {
      if (d.district_id) statusMap[d.district_id] = d;
    }

    const timeline = await projectDistrictTimeline(matched, statusMap);
    res.json(timeline);
  } catch (error: any) {
    console.error(`Error in /api/forecast/district/${req.params.districtId}:`, error);
    res.status(500).json({ error: error?.message || 'Failed to fetch district forecast' });
  }
});

// 3. GET /api/forecast/district/:districtId/timeline - Dedicated timeline payload
app.get('/api/forecast/district/:districtId/timeline', async (req, res) => {
  try {
    const { districtId } = req.params;
    const allDistricts = await computeAllDistrictStatus();
    const norm = normalizeDistrict(districtId);
    const targetId = norm.resolved ? norm.districtId : districtId.toLowerCase().trim();

    const matched = allDistricts.find(
      d => (d.district_id && d.district_id.toLowerCase() === targetId) ||
           d.district.toLowerCase() === districtId.toLowerCase()
    );

    if (!matched) {
      return res.status(404).json({ error: `District '${districtId}' not found.` });
    }

    const statusMap: Record<string, any> = {};
    for (const d of allDistricts) {
      if (d.district_id) statusMap[d.district_id] = d;
    }

    const forecast = await projectDistrictTimeline(matched, statusMap);
    res.json({
      districtId: forecast.districtId,
      districtName: forecast.districtName,
      dominantTrend: forecast.dominantTrend,
      overallForecastOutlook: forecast.overallForecastOutlook,
      maxProjectedRisk: forecast.maxProjectedRisk,
      maxRiskHorizonHours: forecast.maxRiskHorizonHours,
      timeline: forecast.timeline,
      basinInfluence: forecast.basinInfluence,
      dataConfidence: forecast.dataConfidence,
      confidenceReason: forecast.confidenceReason,
      generatedAt: forecast.generatedAt,
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to fetch forecast timeline' });
  }
});

// 4. GET /api/forecast/district/:districtId/explain - Textual explanation of projection drivers
app.get('/api/forecast/district/:districtId/explain', async (req, res) => {
  try {
    const { districtId } = req.params;
    const allDistricts = await computeAllDistrictStatus();
    const norm = normalizeDistrict(districtId);
    const targetId = norm.resolved ? norm.districtId : districtId.toLowerCase().trim();

    const matched = allDistricts.find(
      d => (d.district_id && d.district_id.toLowerCase() === targetId) ||
           d.district.toLowerCase() === districtId.toLowerCase()
    );

    if (!matched) {
      return res.status(404).json({ error: `District '${districtId}' not found.` });
    }

    const statusMap: Record<string, any> = {};
    for (const d of allDistricts) {
      if (d.district_id) statusMap[d.district_id] = d;
    }

    const forecast = await projectDistrictTimeline(matched, statusMap);
    const h6 = forecast.timeline.h6;

    const primaryDriverText = h6.primaryProjectedDrivers.length > 0
      ? h6.primaryProjectedDrivers.map(d => `${d.driverName} (${d.evidence})`).join('; ')
      : 'Baseline multi-factor environmental risk persistence.';

    const upstreamText = forecast.basinInfluence.has_upstream_influence
      ? `Upstream hydrological propagation contributes +${forecast.basinInfluence.total_projected_basin_surge.toFixed(1)} points from upstream river channels.`
      : 'No significant upstream river surges projected to propagate downstream within this window.';

    const explanation = `District ${forecast.districtName} is projected to experience a ${h6.riskTrend} risk trend over the next 6-12 hours, with projected composite risk reaching ${h6.projectedRiskScore}/100 (${h6.outlookCategory.replace(/_/g, ' ')}). Forecast confidence is ${h6.confidence} (${Math.round(h6.confidenceScore * 100)}%). ${upstreamText} Primary drivers: ${primaryDriverText}`;

    res.json({
      districtId: forecast.districtId,
      districtName: forecast.districtName,
      currentRiskScore: forecast.currentRiskScore,
      projectedRiskScore_6h: h6.projectedRiskScore,
      projectedRiskChange_6h: h6.projectedRiskChange,
      riskTrend: h6.riskTrend,
      outlookCategory: h6.outlookCategory,
      confidence: h6.confidence,
      confidenceScore: h6.confidenceScore,
      confidenceReason: h6.confidenceReason,
      primaryDrivers: h6.primaryProjectedDrivers,
      supportingSignals: h6.supportingSignals,
      basinInfluence: forecast.basinInfluence,
      explanation,
      limitations: h6.limitations,
      sourcesAttribution: h6.forecastSources,
      generatedAt: forecast.generatedAt,
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to explain forecast' });
  }
});

// 5. GET /api/forecast/sources - Metadata for NWP, AWS, CWC, and Basin propagation sources
app.get('/api/forecast/sources', async (req, res) => {
  res.json({
    forecast_sources: [
      {
        id: 'imd-nwp-ensemble',
        name: 'India Meteorological Department (IMD) NWP Grid',
        organization: 'Ministry of Earth Sciences (MoES)',
        model: 'WRF / GFS High-Resolution Multi-Model Ensemble',
        horizons_supported: ['+3H', '+6H', '+12H', '+24H'],
        data_mode: 'SIMULATED_FORECAST',
        update_frequency: 'Every 3 Hours',
      },
      {
        id: 'tsdps-telemetry-aws',
        name: 'Telangana State Development Planning Society (TSDPS)',
        organization: 'Planning Dept, Government of Telangana',
        telemetry: 'Real-time Automatic Weather Station (AWS) Network',
        data_mode: 'LIVE / SIMULATED',
        update_frequency: 'Every 15-60 Minutes',
      },
      {
        id: 'cwc-basin-telemetry',
        name: 'Central Water Commission (CWC)',
        organization: 'Ministry of Jal Shakti',
        telemetry: 'Godavari & Krishna Basin River Gauging & Dam Outflow Records',
        data_mode: 'LIVE / CURATED',
        update_frequency: 'Hourly / Synoptic',
      },
      {
        id: 'neerdrishti-basin-routing',
        name: 'NeerDrishti Upstream-Downstream Basin Propagation Model',
        organization: 'Telangana Flood Decision Support Engine',
        description: 'Deterministic river travel window and upstream surge attenuation matrix across 5 major river basins',
        data_mode: 'HISTORICAL_BASELINE',
        update_frequency: 'Continuous Reactive',
      },
    ],
    governance_disclaimer: 'NeerDrishti forecast intelligence is synthesized strictly for decision support and scenario evaluation. Follow official SDMA announcements for public safety instructions.',
  });
});

// 6. GET /api/basin/connections - All hydrological basin connections
app.get('/api/basin/connections', async (req, res) => {
  try {
    const connections = loadBasinConnections();
    res.json({ total: connections.length, connections });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to load basin connections' });
  }
});

// 7. GET /api/basin/district/:districtId - Upstream and downstream connections for a district
app.get('/api/basin/district/:districtId', async (req, res) => {
  try {
    const { districtId } = req.params;
    const norm = normalizeDistrict(districtId);
    const upstream = getUpstreamConnections(norm.canonical_id);
    const downstream = getDownstreamConnections(norm.canonical_id);
    const allDistricts = await computeAllDistrictStatus();
    const statusMap: Record<string, any> = {};
    for (const d of allDistricts) {
      if (d.district_id) statusMap[d.district_id] = d;
    }
    const influence = calculateBasinInfluence(norm.canonical_id, statusMap, 6);

    res.json({
      districtId: norm.canonical_id,
      districtName: norm.district_name,
      upstream_connections: upstream,
      downstream_connections: downstream,
      basin_influence: influence,
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to fetch basin connections' });
  }
});

// ==========================================
// ALERT INTELLIGENCE API (PHASE F)
// ==========================================

// 1. GET /api/alerts - All alerts for 33 districts with composable filtering
app.get('/api/alerts', async (req, res) => {
  try {
    const { level, type, zone, data_mode, search } = req.query;
    const allDistricts = await computeAllDistrictStatus();
    const { alerts, summary } = AlertEngine.evaluateAllDistrictsAlerts(allDistricts);

    let filtered = alerts;

    if (level && typeof level === 'string' && level.toLowerCase() !== 'all') {
      const targetLevel = level.toUpperCase();
      filtered = filtered.filter(a => a.alert_level === targetLevel);
    }

    if (type && typeof type === 'string' && type.toLowerCase() !== 'all') {
      const typeLower = type.toLowerCase();
      filtered = filtered.filter(a => a.primary_alert_type.toLowerCase().includes(typeLower));
    }

    if (zone && typeof zone === 'string' && zone.toLowerCase() !== 'all') {
      const zoneLower = zone.toLowerCase();
      filtered = filtered.filter(a => a.region_zone.toLowerCase().includes(zoneLower));
    }

    if (data_mode && typeof data_mode === 'string' && data_mode.toLowerCase() !== 'all') {
      const modeLower = data_mode.toLowerCase();
      filtered = filtered.filter(a => a.data_mode.toLowerCase().includes(modeLower));
    }

    if (search && typeof search === 'string' && search.trim()) {
      const q = search.trim().toLowerCase();
      filtered = filtered.filter(a => 
        a.district_name.toLowerCase().includes(q) ||
        a.district_id.toLowerCase().includes(q) ||
        a.headline.toLowerCase().includes(q) ||
        a.region_zone.toLowerCase().includes(q)
      );
    }

    res.json({
      total: filtered.length,
      summary,
      alerts: filtered,
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to generate alert intelligence' });
  }
});

// 2. GET /api/alerts/active - Active non-normal alerts
app.get('/api/alerts/active', async (req, res) => {
  try {
    const allDistricts = await computeAllDistrictStatus();
    const { alerts, summary } = AlertEngine.evaluateAllDistrictsAlerts(allDistricts);
    const activeAlerts = alerts.filter(a => a.alert_level !== 'NORMAL');

    res.json({
      total: activeAlerts.length,
      summary,
      alerts: activeAlerts,
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to fetch active alerts' });
  }
});

// 3. GET /api/alerts/summary - Statewide summary metrics
app.get('/api/alerts/summary', async (req, res) => {
  try {
    const allDistricts = await computeAllDistrictStatus();
    const { summary } = AlertEngine.evaluateAllDistrictsAlerts(allDistricts);
    res.json({ summary });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to fetch alert summary' });
  }
});

// 4. GET /api/alerts/district/:districtId - Specific district alert payload
app.get('/api/alerts/district/:districtId', async (req, res) => {
  try {
    const { districtId } = req.params;
    const norm = normalizeDistrict(districtId);
    const allDistricts = await computeAllDistrictStatus();
    const matched = allDistricts.find(
      d => (d.district_id && d.district_id.toLowerCase() === norm.canonical_id) ||
           d.district.toLowerCase() === norm.district_name.toLowerCase() ||
           d.district.toLowerCase() === districtId.toLowerCase()
    );

    if (!matched) {
      return res.status(404).json({ error: `District '${districtId}' not found.` });
    }

    const alert = matched.alert_intelligence || AlertEngine.evaluateDistrictAlert(matched);
    res.json({ alert });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to evaluate district alert' });
  }
});

// 5. GET /api/alerts/district/:districtId/history - Historic alert records
app.get('/api/alerts/district/:districtId/history', async (req, res) => {
  try {
    const { districtId } = req.params;
    const norm = normalizeDistrict(districtId);
    const history = await getAlertsHistoryForDistrict(norm.canonical_id, 20);
    res.json({
      districtId: norm.canonical_id,
      districtName: norm.district_name,
      total: history.length,
      history,
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to fetch alert history' });
  }
});

// 6. POST /api/alerts/recalculate - Force recalculation and snapshot archiving
app.post('/api/alerts/recalculate', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    const allDistricts = await computeAllDistrictStatus();
    const { alerts, summary } = AlertEngine.evaluateAllDistrictsAlerts(allDistricts);

    // Save active non-normal alerts to MongoDB for audit history
    for (const a of alerts) {
      if (a.alert_level !== 'NORMAL') {
        try {
          await insertAlertRecord(a);
        } catch (e) {
          // Ignore duplicate alert_id logs
        }
      }
    }

    res.json({
      message: 'Successfully recalculated alert intelligence across 33 Telangana districts.',
      summary,
      total_alerts: alerts.length,
      active_alerts_count: summary.total_active_alerts,
      alerts,
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to recalculate alerts' });
  }
});

// 7. POST /api/alerts/:alertId/status - Update alert status
app.post('/api/alerts/:alertId/status', requireAuth, requireApprovedOfficial, async (req, res) => {
  try {
    const { alertId } = req.params;
    const { status } = req.body;
    if (!status || !['Active', 'Acknowledged', 'Resolved', 'Expired'].includes(status)) {
      return res.status(400).json({ error: 'Valid status required: Active | Acknowledged | Resolved | Expired' });
    }
    const updated = await updateDbAlertStatus(alertId, status);
    res.json({ success: updated, alert_id: alertId, status });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to update alert status' });
  }
});

// 8. POST /api/alerts/district/:districtId/ai-explain - Meta Llama LLM Bilingual Advisory Expansion
app.post('/api/alerts/district/:districtId/ai-explain', async (req, res) => {
  try {
    const { districtId } = req.params;
    const norm = normalizeDistrict(districtId);
    const allDistricts = await computeAllDistrictStatus();
    const matched = allDistricts.find(
      d => (d.district_id && d.district_id.toLowerCase() === norm.canonical_id) ||
           d.district.toLowerCase() === norm.district_name.toLowerCase()
    );

    if (!matched) {
      return res.status(404).json({ error: `District '${districtId}' not found.` });
    }

    const alert = matched.alert_intelligence || AlertEngine.evaluateDistrictAlert(matched);
    const kbContext = getKnowledgeDoc(matched.district);

    const fallbackResponse = {
      district: matched.district,
      alert_level: alert.alert_level,
      primary_alert_type: alert.primary_alert_type,
      current_risk: alert.current_risk,
      projected_risk: alert.projected_risk,
      peak_horizon: alert.peak_horizon,
      english_advisory: alert.advisories.english,
      telugu_advisory: alert.advisories.telugu,
      trigger_reasons: alert.trigger_reasons,
      basin_propagation_notes: alert.basin_signal.summary,
      citizen_reports_notes: alert.citizen_signal.summary,
      data_mode: alert.data_mode,
      confidence: alert.confidence,
    };

    const config = getLlamaConfig();
    const systemPrompt = `You are the NeerDrishti AI Flood Advisory Specialist for Telangana powered by Meta Llama.
Provide a clear, bilingual (English & Telugu) explanation for the active alert in ${matched.district}.

INSTRUCTIONS:
1. Explain WHY this alert level was determined based on the multi-horizon data and deterministic thresholds.
2. Provide practical, non-alarmist public safety guidance.
3. DO NOT order evacuations or claim government emergency decrees. Frame as prototype decision support.
4. Output JSON strictly with structure:
{
  "situation_analysis": "...",
  "primary_driver_breakdown": ["...", "..."],
  "english_title": "...",
  "english_summary": "...",
  "english_precautions": ["...", "..."],
  "telugu_title": "...",
  "telugu_summary": "...",
  "telugu_precautions": ["...", "..."],
  "disclaimer": "..."
}`;

    const userPrompt = `DETERMINISTIC ALERT DATA:
- District: ${matched.district}
- Alert Level: ${alert.alert_level}
- Primary Alert Type: ${alert.primary_alert_type}
- Headline: ${alert.headline}
- Current Risk Score: ${alert.current_risk}/100
- Projected Peak Risk Score: ${alert.projected_risk}/100 at horizon ${alert.peak_horizon}
- Trend: ${alert.trend} (${alert.rate_of_change})
- Triggers: ${alert.trigger_reasons.join('; ')}
- Citizen Signal: ${alert.citizen_signal.summary}
- Basin Signal: ${alert.basin_signal.summary}
- Data Mode: ${alert.data_mode}
- Data Confidence: ${alert.confidence} (${Math.round(alert.confidence_score * 100)}%)

KNOWLEDGE BASE:
${kbContext}`;

    try {
      const chatResult = await callLlamaChat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        {
          temperature: 0.2,
          jsonMode: true,
          timeoutMs: 12000,
        }
      );

      if (chatResult && chatResult.text) {
        const parsed = extractJsonFromText(chatResult.text);
        return res.json({
          district: matched.district,
          alert_level: alert.alert_level,
          primary_alert_type: alert.primary_alert_type,
          current_risk: alert.current_risk,
          projected_risk: alert.projected_risk,
          peak_horizon: alert.peak_horizon,
          llm_explanation: parsed,
          fallback_advisories: alert.advisories,
          model_provider: 'Meta Llama',
          model_name: config.model,
          reasoning_source: 'Meta Llama',
          fallback_used: false,
        });
      }
    } catch (llamaErr) {
      console.warn('Meta Llama AI advisory generation failed, serving deterministic fallback:', llamaErr);
    }

    res.json({
      ...fallbackResponse,
      model_provider: 'Rule Engine',
      model_name: 'Deterministic Fallback Engine',
      reasoning_source: 'Deterministic Fallback',
      fallback_used: true,
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to explain alert' });
  }
});


// ==========================================
// CITIZEN REPORTS API (PHASE C)
// ==========================================

// 4. GET /api/reports - Paginated & Filtered
app.get('/api/reports', async (req, res) => {
  try {
    const { district, severity, status, page, limit } = req.query;
    const result = await getReports({
      district: typeof district === 'string' ? district : undefined,
      severity: typeof severity === 'string' ? severity : undefined,
      status: typeof status === 'string' ? status : undefined,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 50,
    });
    res.json(result);
  } catch (error) {
    console.error('Error fetching reports from SQLite:', error);
    res.status(500).json({ error: 'Internal database error while fetching reports.' });
  }
});

// 5. GET /api/reports/:id - Single Report with Classification
app.get('/api/reports/:id', async (req, res) => {
  try {
    const reportId = Number(req.params.id);
    if (isNaN(reportId)) {
      return res.status(400).json({ error: 'Invalid report ID.' });
    }

    const report = await getReportById(reportId);
    if (!report) {
      return res.status(404).json({ error: `Report #${reportId} not found.` });
    }

    res.json({ report });
  } catch (error) {
    console.error(`Error fetching report #${req.params.id}:`, error);
    res.status(500).json({ error: 'Internal database error.' });
  }
});

// 6. POST /api/reports - Submit Citizen Report + Meta Llama AI Classification + Transactional SQLite Persistence
app.post('/api/reports', async (req, res) => {
  try {
    // Anonymous submission remains supported for backward compatibility (documented in README).
    // Rate limited per IP; authenticated citizens additionally get an account-based limit.
    const reporterIp = req.socket?.remoteAddress || 'unknown';
    if (!checkRateLimit(`submit-report:${reporterIp}`, REPORT_RATE_LIMIT_IP_MAX, 3600).allowed) {
      return res.status(429).json({ error: 'Too many report submissions from this network. Please try again later.' });
    }
    const reporterUserId = (req as AuthenticatedRequest).auth?.user.id ?? null;
    if (reporterUserId !== null) {
      if (!checkRateLimit(`submit-report-user:${reporterUserId}`, REPORT_RATE_LIMIT_USER_MAX, 3600).allowed) {
        return res.status(429).json({ error: 'Too many report submissions for this account. Please try again later.' });
      }
    }

    const body = req.body || {};

    // Never trust client-supplied privileged/state fields.
    const privileged = findPrivilegedFields(body);
    if (privileged.length > 0) {
      return res.status(400).json({
        error: `Report submission must not include privileged field(s): ${privileged.join(', ')}.`,
      });
    }

    const {
      district,
      location_description,
      location,
      incident_type,
      severity,
      description,
      image_reference,
      image_url,
      image_data,
      locality,
      lat,
      lng,
      reported_at,
    } = body;

    // District: validate against canonical Telangana districts (never trust free text).
    if (!district || typeof district !== 'string' || !district.trim()) {
      return res.status(400).json({ error: 'District is required.' });
    }
    const normDistrict = normalizeDistrict(district);
    if (!normDistrict.resolved || !normDistrict.districtId) {
      return res.status(400).json({ error: `District '${String(district).slice(0, 60)}' is not a recognized Telangana district.` });
    }
    const matchedMeta = getDistrictByName(normDistrict.districtId);
    if (!matchedMeta) {
      return res.status(400).json({ error: 'District is not present in the canonical district table.' });
    }

    // Description
    if (!description || typeof description !== 'string') {
      return res.status(400).json({ error: 'Description is required.' });
    }
    const trimmedDesc = String(description).trim();
    if (trimmedDesc.length < 10) {
      return res.status(400).json({
        error: 'Description is too short. Minimum length is 10 characters to ensure actionable hazard context.',
      });
    }
    if (trimmedDesc.length > 1000) {
      return res.status(400).json({
        error: 'Description exceeds maximum allowed length of 1000 characters.',
      });
    }

    // Category (canonical Phase 6 set; legacy values accepted and mapped)
    const category = normalizeCategory(incident_type ?? undefined);
    if (incident_type !== undefined && incident_type !== null && String(incident_type).trim() !== '' && !category) {
      return res.status(400).json({
        error: `Invalid incident category. Allowed: ${REPORT_CATEGORIES.join(', ')}.`,
      });
    }
    const incType = category || 'Other';

    // Severity
    let sev = 'Moderate';
    if (severity !== undefined && severity !== null && String(severity).trim() !== '') {
      const matched = REPORT_SEVERITIES.find(s => s.toLowerCase() === String(severity).trim().toLowerCase());
      if (!matched) {
        return res.status(400).json({ error: `Invalid severity. Allowed: ${REPORT_SEVERITIES.join(', ')}.` });
      }
      sev = matched;
    }

    // Locality / location text
    const locDesc = sanitizeText(location_description || locality || location || '', 200);

    // Coordinates (optional; validated when provided)
    const coords = validateCoordinates(lat, lng);
    if (!coords.ok) {
      return res.status(400).json({ error: coords.error });
    }

    // Server-authoritative timestamp (client value, if any, must be recent and valid)
    const ts = validateReportedAt(reported_at);
    if (!ts.ok) {
      return res.status(400).json({ error: ts.error });
    }

    // Attachment (optional; structural validation only — no image content analysis exists)
    const attachment = validateAttachment(image_reference ?? image_url ?? image_data ?? undefined);
    if (!attachment.ok) {
      return res.status(400).json({ error: attachment.error });
    }
    const imageRef = attachment.kind === 'data_uri' || attachment.kind === 'url' ? attachment.value! : null;

    // AI Classification (rule-based fallback when LLM unavailable; no image analysis)
    const aiResult = await classifyCitizenReport({
      district: matchedMeta.district_name,
      location_description: locDesc,
      user_incident_type: incType,
      user_severity: sev,
      description: trimmedDesc,
      image_data: imageRef,
    });

    // Transactional Save into SQLite — status is always PENDING (server-controlled).
    const inserted = await insertReportWithClassification({
      district_id: normDistrict.districtId,
      location_description: locDesc,
      incident_type: incType,
      severity: sev as any,
      description: trimmedDesc,
      image_reference: imageRef,
      reported_at: ts.reportedAt,
      classification_source: aiResult.source,
      classification_confidence: aiResult.confidence,
      status: 'PENDING',
      reporter_user_id: reporterUserId,
      classification: aiResult.classification,
    });

    // Persist validated attachment metadata (no file bytes are written to disk; data URIs stay inline)
    if (attachment.kind) {
      try {
        await insertReportAttachment({
          report_id: inserted.id,
          storage_path: attachment.kind === 'url' ? attachment.value! : 'inline:data-uri',
          mime_type: attachment.mimeType || 'image/*',
          size_bytes: attachment.sizeBytes || 0,
          sha256: attachment.sha256 || '',
        });
      } catch (attErr) {
        console.warn('Attachment metadata persist failed (non-blocking):', attErr);
      }
    }

    // Locality/coordinates are stored on the report row when provided (additive Phase 4 columns)
    if (coords.lat !== undefined || locDesc) {
      try {
        await getMongoDb().collection('citizen_reports').updateOne(
          { _id: inserted.id },
          { $set: { locality: locDesc || null, lat: coords.lat ?? null, lng: coords.lng ?? null } }
        );
      } catch (locErr) {
        console.warn('Locality/coordinate persist failed (non-blocking):', locErr);
      }
    }

    // Compute updated district state
    const updatedDistrict = await computeDistrictStatus(matchedMeta);

    res.status(201).json({
      success: true,
      report: (await getReportById(inserted.id)) || inserted,
      classification: aiResult.classification,
      classification_source: aiResult.source,
      updated_district: updatedDistrict,
      message: `Report #${inserted.id} recorded (status PENDING, pending official verification) and classified via ${aiResult.source}.`,
    });
  } catch (error: any) {
    console.error('Error submitting citizen report:', error);
    res.status(500).json({
      error: 'Failed to process citizen report.',
    });
  }
});

// 7. PATCH /api/reports/:id/status - Status update (Demo Review Panel)
app.patch('/api/reports/:id/status', requireAuth, requireApprovedOfficial, async (req, res) => {
  try {
    const reportId = Number(req.params.id);
    const { status, reason } = req.body;

    if (isNaN(reportId)) {
      return res.status(400).json({ error: 'Invalid report ID.' });
    }

    if (!status || typeof status !== 'string') {
      return res.status(400).json({ error: 'Status is required.' });
    }

    const existing = await getReportById(reportId);
    if (!existing) {
      return res.status(404).json({ error: `Report #${reportId} not found.` });
    }

    const authReq = req as AuthenticatedRequest;
    const isAdmin = authReq.auth!.user.role === 'ADMIN';
    const reportDistrict = normalizeDistrict(existing.district_id).resolved
      ? normalizeDistrict(existing.district_id).districtId
      : String(existing.district_id || '').toLowerCase();
    if (!hasJurisdiction(authReq, reportDistrict)) {
      return res.status(403).json({ error: 'This report is outside your assigned jurisdiction.' });
    }

    // Normalise legacy vocabulary and validate the requested target status.
    const aliasMap: Record<string, string> = { New: 'PENDING', Reviewed: 'UNDER_REVIEW', Validated: 'VERIFIED', Resolved: 'RESOLVED', Rejected: 'REJECTED' };
    const targetStatus = aliasMap[status.trim()] || status.trim().toUpperCase();
    const validStatuses = ['PENDING', 'UNDER_REVIEW', 'VERIFIED', 'RESOLVED', 'REJECTED'];
    if (!validStatuses.includes(targetStatus)) {
      return res.status(400).json({ error: `Invalid status. Allowed: ${validStatuses.join(', ')}.` });
    }

    const fromStatus = aliasMap[existing.status] || String(existing.status || '').toUpperCase();

    // Lifecycle transition rules (officials have a restricted set; admins may set any valid status).
    const officialTransitions: Record<string, string[]> = {
      PENDING: ['UNDER_REVIEW', 'VERIFIED', 'REJECTED'],
      UNDER_REVIEW: ['VERIFIED', 'REJECTED', 'PENDING'],
      VERIFIED: ['RESOLVED', 'REJECTED', 'UNDER_REVIEW'],
      REJECTED: ['UNDER_REVIEW', 'PENDING'],
      RESOLVED: ['UNDER_REVIEW', 'PENDING'],
    };
    if (!isAdmin && fromStatus !== targetStatus) {
      const allowed = officialTransitions[fromStatus] || [];
      if (!allowed.includes(targetStatus)) {
        return res.status(400).json({ error: `Invalid status transition from ${fromStatus} to ${targetStatus}.` });
      }
    }

    const updated = await updateReportStatus(reportId, targetStatus);
    if (!updated) {
      return res.status(404).json({ error: `Report #${reportId} not found.` });
    }

    // Record the moderation transition (append-only history) with actor, timestamp and reason.
    await recordModerationTransition({
      report_id: reportId,
      from_status: fromStatus,
      to_status: targetStatus,
      actor_user_id: authReq.auth!.user.id,
      actor_role: authReq.auth!.user.role,
      reason: typeof reason === 'string' ? reason.slice(0, 300) : null,
    });

    await writeAuditLog({
      actorUserId: authReq.auth!.user.id,
      actorRole: authReq.auth!.user.role,
      action: 'REPORT_STATUS_UPDATED',
      entityType: 'citizen_report',
      entityId: reportId,
      details: { from_status: fromStatus, to_status: targetStatus, district_id: reportDistrict, reason: reason || null },
      ip: req.socket?.remoteAddress || null,
    });

    // Return updated report + refreshed district metrics
    const meta = getDistrictByName(updated.district_id);
    const updatedDistrict = meta ? await computeDistrictStatus(meta) : null;

    res.json({
      success: true,
      report: updated,
      updated_district: updatedDistrict,
      message: `Report #${reportId} status updated from ${fromStatus} to ${targetStatus}.`,
    });
  } catch (error: any) {
    console.error(`Error updating report status:`, error);
    res.status(400).json({ error: 'Failed to update report status.' });
  }
});

// 7b. GET /api/reports/:id/history - Moderation history (officials: jurisdiction-scoped; admins: all)
app.get('/api/reports/:id/history', requireAuth, requireApprovedOfficial, async (req, res) => {
  try {
    const reportId = Number(req.params.id);
    if (isNaN(reportId)) return res.status(400).json({ error: 'Invalid report ID.' });
    const existing = await getReportById(reportId);
    if (!existing) return res.status(404).json({ error: `Report #${reportId} not found.` });

    const authReq = req as AuthenticatedRequest;
    const reportDistrict = normalizeDistrict(existing.district_id).resolved
      ? normalizeDistrict(existing.district_id).districtId
      : String(existing.district_id || '').toLowerCase();
    if (!hasJurisdiction(authReq, reportDistrict)) {
      return res.status(403).json({ error: 'This report is outside your assigned jurisdiction.' });
    }

    res.json({ report_id: reportId, history: await getModerationHistory(reportId) });
  } catch (error: any) {
    console.error('Error fetching moderation history:', error);
    res.status(500).json({ error: 'Failed to fetch moderation history.' });
  }
});

// 8. GET /api/reports/district/:district - District Reports List
app.get('/api/reports/district/:district', async (req, res) => {
  try {
    const { district } = req.params;
    const result = await getReports({ district, limit: 100 });
    res.json({ district, total: result.total, reports: result.reports });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch district reports.' });
  }
});

// 9. GET /api/reports/district/:district/summary - Reusable District Report Aggregation
app.get('/api/reports/district/:district/summary', async (req, res) => {
  try {
    const { district } = req.params;
    const meta = getDistrictByName(district);
    if (!meta) {
      return res.status(404).json({ error: `District '${district}' not found.` });
    }

    const summary = await getDistrictAggregation(meta.district_name);
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch district aggregation.' });
  }
});

// ============================================================================
// PHASE G: GROUNDED AI ASSISTANT & RAG INTELLIGENCE API ENDPOINTS
// ============================================================================

// 1. Unified Grounded AI Chat Assistant
app.post('/api/ai/chat', async (req, res) => {
  try {
    const aiIp = req.socket?.remoteAddress || 'unknown';
    if (!checkRateLimit(`ai-chat:${aiIp}`, 30, 60).allowed) {
      return res.status(429).json({ error: 'Too many AI requests. Please slow down.' });
    }
    const { message, language, districtContext } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Field "message" is required.' });
    }

    const allDistricts = await computeAllDistrictStatus();
    const aiResponse = await aiIntelligenceService.answer_question(
      message,
      language,
      districtContext,
      allDistricts
    );

    // Keep backwards compatibility fields (reply, district, risk_score, risk_category) alongside full GroundedAIResponse
    const primaryDistrictName = aiResponse.districtsInvolved[0];
    const targetDistrict = allDistricts.find(d => d.district === primaryDistrictName) || allDistricts[0];

    res.json({
      reply: aiResponse.answer,
      district: targetDistrict?.district || 'Telangana',
      risk_score: targetDistrict?.flood_risk_score ?? 50,
      risk_category: targetDistrict?.risk_category ?? 'MODERATE',
      ...aiResponse,
    });
  } catch (error: any) {
    console.error('Error in /api/ai/chat:', error);
    res.status(500).json({ error: error.message || 'Failed to generate AI response.' });
  }
});



// ==========================================
// DATA PIPELINE READ APIs (migration 004 tables; empty until ingestion scripts are run)
// ==========================================
app.get('/api/map/config', (_req, res) => res.json(getMapConfig()));
app.get('/api/pipeline/registry', async (_req, res) => res.json(await pipe.getRegistry()));
app.get('/api/pipeline/completeness', async (_req, res) => res.json({ rows: await pipe.getTelemetryCompleteness() }));
app.get('/api/telemetry/river', async (req, res) => res.json({ stations: await pipe.getRiverTelemetry(typeof req.query.district === 'string' ? req.query.district : undefined) }));
app.get('/api/telemetry/hydrology-features', async (_req, res) => res.json({ districts: await pipe.getHydrologyFeatures() }));
app.get('/api/terrain', async (_req, res) => res.json({ districts: await pipe.getTerrain() }));
app.get('/api/weather/forecast/:districtId', async (req, res) => res.json(await pipe.getDistrictForecast(req.params.districtId)));
app.get('/api/weather/history/:districtId', async (req, res) => res.json({ daily: await pipe.getDistrictHistory(req.params.districtId, req.query.from as string, req.query.to as string) }));
app.get('/api/geo/districts', (_req, res) => {
  const g = pipe.getBoundariesGeoJson();
  if (!g) return res.json({ type: 'FeatureCollection', features: [], available: false, hint: 'District boundary file not loaded. Run: python -m scripts.pipeline.cli boundaries <District_NWIC.geojson>' });
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json(g);
});

// Grounded, validated citizen/engineer brief (never invents numbers; deterministic fallback).
app.post('/api/ai/citizen-brief', async (req, res) => {
  try {
    const ip = req.socket?.remoteAddress || 'unknown';
    if (!checkRateLimit(`ai-brief:${ip}`, 30, 60).allowed) {
      return res.status(429).json({ error: 'Too many AI requests. Please slow down.' });
    }
    const { district_id, language, question, audience } = req.body || {};
    const lang = (['en', 'te', 'hi'] as const).includes(language) ? language : 'en';
    if (typeof district_id !== 'string' || !district_id) {
      return res.status(400).json({ error: 'Field "district_id" is required.' });
    }
    const view = getScenarioViewOverrides(req);
    const all = await computeAllDistrictStatus(view.scenario, view.rainfallOverride);
    const d: any = all.find((x: any) => x.district_id === district_id || x.district.toLowerCase() === String(district_id).toLowerCase());
    if (!d) return res.status(404).json({ error: 'Unknown district.' });
    const ctx = buildCitizenContext(d);
    const brief = await generateCitizenBrief(ctx, lang, typeof question === 'string' ? question : undefined);
    const body: any = { ...brief, language: lang, scenario: view.scenario };
    if (audience === 'engineer') {
      body.engineer = {
        score: d.flood_risk_score,
        weights: RISK_WEIGHTS,
        contributions: d.contributions,
        factor_scores: d.components,
        feature_provenance: d.feature_provenance,
        rainfall: { mm_24h: d.rainfall_mm_24h, mm_3h: d.rainfall_mm_3h, mode: d.rainfall_data_mode, source: d.rainfall_source, recorded_at: d.rainfall_recorded_at, confidence: d.rainfall_confidence },
        data_completeness_pct: d.risk_data_completeness,
        uncertainty_note: 'Static factors are prototype priors/proxies unless provenance is DATASET. No forecast accuracy metrics are claimed.',
      };
    }
    res.json(body);
  } catch (error: any) {
    console.error('Error in /api/ai/citizen-brief:', error);
    res.status(500).json({ error: 'Failed to generate brief.' });
  }
});

// 2. Explain Specific District Risk
app.post('/api/ai/district/:districtId/explain', async (req, res) => {
  try {
    const { districtId } = req.params;
    const { language } = req.body || {};
    const allDistricts = await computeAllDistrictStatus();
    const aiResponse = await aiIntelligenceService.explain_district_risk(districtId, language, allDistricts);
    res.json(aiResponse);
  } catch (error: any) {
    console.error(`Error explaining risk for district ${req.params.districtId}:`, error);
    res.status(500).json({ error: error.message || 'Failed to explain district risk.' });
  }
});

// 3. Compare Two Districts
app.post('/api/ai/district/compare', async (req, res) => {
  try {
    const { district1, district2, language } = req.body;
    if (!district1 || !district2) {
      return res.status(400).json({ error: 'Both "district1" and "district2" are required for comparison.' });
    }

    const allDistricts = await computeAllDistrictStatus();
    const aiResponse = await aiIntelligenceService.compare_districts(district1, district2, language, allDistricts);
    res.json(aiResponse);
  } catch (error: any) {
    console.error('Error in /api/ai/district/compare:', error);
    res.status(500).json({ error: error.message || 'Failed to compare districts.' });
  }
});

// 4. Explain Forecast Projections & Matrix
app.post('/api/ai/forecast/explain', async (req, res) => {
  try {
    const { districtOrHorizon, language } = req.body || {};
    const allDistricts = await computeAllDistrictStatus();
    const aiResponse = await aiIntelligenceService.explain_forecast(districtOrHorizon || '', language, allDistricts);
    res.json(aiResponse);
  } catch (error: any) {
    console.error('Error in /api/ai/forecast/explain:', error);
    res.status(500).json({ error: error.message || 'Failed to explain forecast.' });
  }
});

// 5. Explain Alert Intelligence & Trigger Signals
app.post('/api/ai/alert/:districtId/explain', async (req, res) => {
  try {
    const { districtId } = req.params;
    const { language } = req.body || {};
    const allDistricts = await computeAllDistrictStatus();
    const aiResponse = await aiIntelligenceService.explain_alert(districtId, language, allDistricts);
    res.json(aiResponse);
  } catch (error: any) {
    console.error(`Error explaining alert for district ${req.params.districtId}:`, error);
    res.status(500).json({ error: error.message || 'Failed to explain alert.' });
  }
});

// 6. Generate Public Safety Advisory
app.post('/api/ai/advisory/:districtId', async (req, res) => {
  try {
    const { districtId } = req.params;
    const { language } = req.body || {};
    const allDistricts = await computeAllDistrictStatus();
    const aiResponse = await aiIntelligenceService.generate_public_advisory(districtId, language, allDistricts);
    res.json(aiResponse);
  } catch (error: any) {
    console.error(`Error generating advisory for district ${req.params.districtId}:`, error);
    res.status(500).json({ error: error.message || 'Failed to generate advisory.' });
  }
});

// 7. Search Knowledge Base (RAG Endpoint)
app.get('/api/knowledge/search', async (req, res) => {
  try {
    const query = String(req.query.q || '');
    const district = req.query.district ? String(req.query.district) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 3;

    const results = knowledgeService.searchKnowledge(query, district, limit);
    res.json({
      query,
      district,
      count: results.length,
      results,
    });
  } catch (error: any) {
    console.error('Error searching knowledge base:', error);
    res.status(500).json({ error: 'Failed to search knowledge base.' });
  }
});

// 8. List Knowledge Base Documents
app.get('/api/knowledge/docs', async (req, res) => {
  try {
    const docs = knowledgeService.getAllKnowledgeDocsSummary();
    res.json({ count: docs.length, documents: docs });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list knowledge docs.' });
  }
});

// 9. Structured Reasoning Layer (Backwards-compatible)
app.post('/api/ai/reasoning', async (req, res) => {
  try {
    const aiIp = req.socket?.remoteAddress || 'unknown';
    if (!checkRateLimit(`ai-reasoning:${aiIp}`, 30, 60).allowed) {
      return res.status(429).json({ error: 'Too many AI requests. Please slow down.' });
    }
    const { district, language } = req.body;
    const allDistricts = await computeAllDistrictStatus();
    const targetDistrict = allDistricts.find(d => d.district.toLowerCase() === String(district).toLowerCase()) || allDistricts[0];
    const aiResponse = await aiIntelligenceService.explain_district_risk(targetDistrict.district, language, allDistricts);

    res.json({
      situation_summary: aiResponse.currentSituation || aiResponse.directAnswer,
      main_risk_factors: aiResponse.mainFactors,
      explanation_of_risk: aiResponse.directAnswer,
      recommended_actions: aiResponse.recommendedPrecautions,
      english_advisory: `Official NeerDrishti Advisory for ${targetDistrict.district}: ${targetDistrict.risk_category} flood risk level (${targetDistrict.flood_risk_score}/100). Follow safety protocols.`,
      telugu_advisory: aiResponse.teluguSummary || `${targetDistrict.district} జిల్లాలో వరద ముప్పు ${targetDistrict.risk_category} స్థాయిలో ఉంది. ప్రజలు అప్రమత్తంగా ఉండాలి.`,
      evidence_used: aiResponse.evidenceUsed,
      data_limitation_statement: aiResponse.limitations,
      transparency_badges: aiResponse.transparencyBadges,
      source: aiResponse.source,
    });
  } catch (error) {
    console.error('Error in /api/ai/reasoning:', error);
    res.status(500).json({ error: 'Failed to execute reasoning engine.' });
  }
});

// ==========================================
// PHASE H: DATA CONNECTOR & IOT ENDPOINTS
// ==========================================

// 1. Get All Registered Data Sources
app.get('/api/data/sources', async (req, res) => {
  try {
    const sources = centralDataCoordinator.getAllSources();
    res.json({
      count: sources.length,
      active_mode: centralDataCoordinator.getActiveMode(),
      sources,
    });
  } catch (error: any) {
    console.error('Error in /api/data/sources:', error);
    res.status(500).json({ error: 'Failed to fetch data sources' });
  }
});

// 2. Get Central System & Source Health Assessment
app.get('/api/data/health', async (req, res) => {
  try {
    const health = centralDataCoordinator.getSystemHealth();
    res.json(health);
  } catch (error: any) {
    console.error('Error in /api/data/health:', error);
    res.status(500).json({ error: 'Failed to evaluate data health' });
  }
});

// 3. Get / Set System Active Operational Data Mode
app.get('/api/data/mode', async (req, res) => {
  res.json({
    active_mode: centralDataCoordinator.getActiveMode(),
    available_modes: ['SIMULATION', 'PROTOTYPE', 'LIVE', 'IOT', 'HISTORICAL', 'OFFLINE'],
    description: 'System-wide operational data ingestion mode.',
  });
});

app.post('/api/data/mode', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    const { mode } = req.body;
    const allowed = ['SIMULATION', 'PROTOTYPE', 'LIVE', 'IOT', 'HISTORICAL', 'OFFLINE'];
    if (!mode || !allowed.includes(mode)) {
      return res.status(400).json({
        error: `Invalid mode '${mode}'. Allowed: ${allowed.join(', ')}.`,
      });
    }

    centralDataCoordinator.setActiveMode(mode);
    const updatedDistricts = await computeAllDistrictStatus();

    res.json({
      success: true,
      active_mode: centralDataCoordinator.getActiveMode(),
      message: `System operational data mode switched to ${mode}.`,
      updated_districts_count: updatedDistricts.length,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to set data mode' });
  }
});

// 4. Ingest IoT Telemetry Reading (Compatible with REST & ESP32 HTTP POST)
app.post('/api/iot/reading', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    const result = centralDataCoordinator.ingestReading(req.body);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        status: result.status,
      });
    }

    res.status(201).json({
      success: true,
      status: result.status,
      reading: result.reading,
      message: 'Telemetry successfully validated, normalized, and ingested.',
    });
  } catch (error: any) {
    console.error('Error in /api/iot/reading:', error);
    res.status(500).json({ error: 'Failed to ingest telemetry reading.' });
  }
});

// 5. Batch Ingest Generic Sensor Telemetry
app.post('/api/data/ingest', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    const { readings } = req.body;
    if (!Array.isArray(readings)) {
      // Handle single payload
      const singleRes = centralDataCoordinator.ingestReading(req.body);
      if (!singleRes.success) {
        return res.status(400).json({ success: false, error: singleRes.error });
      }
      return res.status(201).json({ success: true, count: 1, readings: [singleRes.reading] });
    }

    const accepted: any[] = [];
    const rejected: any[] = [];

    for (const r of readings) {
      const itemRes = centralDataCoordinator.ingestReading(r);
      if (itemRes.success && itemRes.reading) {
        accepted.push(itemRes.reading);
      } else {
        rejected.push({ payload: r, error: itemRes.error, status: itemRes.status });
      }
    }

    res.status(accepted.length > 0 ? 201 : 400).json({
      success: accepted.length > 0,
      total_received: readings.length,
      accepted_count: accepted.length,
      rejected_count: rejected.length,
      accepted,
      rejected,
    });
  } catch (error: any) {
    console.error('Error in /api/data/ingest:', error);
    res.status(500).json({ error: 'Failed to process batch ingestion.' });
  }
});

// 6. Get All IoT Devices (with optional filtering)
app.get('/api/iot/devices', async (req, res) => {
  try {
    let devices = iotDeviceRegistry.getAllDevices();
    const { district, type, status, mode } = req.query;

    if (district) {
      const dStr = String(district).toLowerCase();
      devices = devices.filter(
        d => d.district_id.toLowerCase() === dStr || d.district_name.toLowerCase() === dStr
      );
    }
    if (type) {
      devices = devices.filter(d => d.sensor_type === String(type).toLowerCase());
    }
    if (status) {
      devices = devices.filter(d => d.status.toUpperCase() === String(status).toUpperCase());
    }
    if (mode) {
      devices = devices.filter(d => d.mode.toUpperCase() === String(mode).toUpperCase());
    }

    res.json({
      count: devices.length,
      active_mode: centralDataCoordinator.getActiveMode(),
      devices,
    });
  } catch (error: any) {
    console.error('Error in /api/iot/devices:', error);
    res.status(500).json({ error: 'Failed to retrieve IoT devices.' });
  }
});

// 7. Get Device Detail & History by ID
app.get('/api/iot/devices/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const device = iotDeviceRegistry.getDeviceById(deviceId);
    if (!device) {
      return res.status(404).json({ error: `IoT device with ID '${deviceId}' not found.` });
    }

    const readings = iotDeviceRegistry.getDeviceReadings(deviceId);
    res.json({
      device,
      history_count: readings.length,
      readings,
    });
  } catch (error: any) {
    console.error(`Error in /api/iot/devices/${req.params.deviceId}:`, error);
    res.status(500).json({ error: 'Failed to retrieve device details.' });
  }
});

// 8. Get IoT Monitoring Breakdown for District Detail Inspector
app.get('/api/iot/district/:districtId', async (req, res) => {
  try {
    const { districtId } = req.params;
    const breakdown = centralDataCoordinator.getDistrictMonitoringSources(districtId);
    res.json(breakdown);
  } catch (error: any) {
    console.error(`Error in /api/iot/district/${req.params.districtId}:`, error);
    res.status(500).json({ error: 'Failed to retrieve district monitoring sources.' });
  }
});

// 9. Overall IoT Telemetry Statistics
app.get('/api/iot/stats', async (req, res) => {
  try {
    const devices = iotDeviceRegistry.getAllDevices();
    const online = devices.filter(d => d.status === 'ONLINE').length;
    const priorityDistrictDevices = devices.filter(d =>
      ['hyderabad', 'warangal', 'nirmal', 'mancherial', 'bhadradri_kothagudem'].includes(d.district_id)
    );

    res.json({
      total_devices: devices.length,
      online_devices: online,
      active_mode: centralDataCoordinator.getActiveMode(),
      priority_district_coverage: {
        devices_count: priorityDistrictDevices.length,
        districts_covered: 5,
      },
      standard_district_coverage: {
        devices_count: devices.length - priorityDistrictDevices.length,
        districts_covered: 5,
      },
      sensors_by_type: {
        rainfall: devices.filter(d => d.sensor_type === 'rainfall').length,
        water_level: devices.filter(d => d.sensor_type === 'water_level').length,
        drainage_status: devices.filter(d => d.sensor_type === 'drainage_status').length,
      },
      system_confidence: 'Prototype',
      transparency_notice: 'Zero-cost Virtual IoT Demonstration Layer emulating ESP32 sensor hardware.',
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to compute IoT stats.' });
  }
});

// 10. Phase H Transition & Demonstration Sequence
app.get('/api/iot/demonstration-sequence', async (req, res) => {
  res.json({
    title: 'NeerDrishti Phase H: Simulation to Prototype IoT Transition Sequence',
    steps: [
      {
        step_number: 1,
        title: 'Step 1: Regional Simulation Baseline',
        description: 'Observe 33-district hydrodynamic simulation generating baseline precipitation and flood risk scores across Telangana.',
        active_mode: 'SIMULATION',
        recommended_action: 'Select Heavy Rainfall scenario and inspect Hyderabad or Bhadradri Kothagudem.',
      },
      {
        step_number: 2,
        title: 'Step 2: Virtual IoT Mesh Activation',
        description: 'Switch data mode to IOT to activate real-time telemetry from virtual ESP32 rainfall gauges, river ultrasonic sensors, and stormwater sumps.',
        active_mode: 'IOT',
        recommended_action: 'Observe telemetry live values on the Data Sources & IoT view and map overlay.',
      },
      {
        step_number: 3,
        title: 'Step 3: Interactive Telemetry Injection',
        description: 'Inject live telemetry payload for HYD_VIRTUAL_RAIN_01 or BDK_VIRTUAL_WATER_01 to demonstrate real-time validation and risk recalculation.',
        active_mode: 'IOT',
        recommended_action: 'Use the Telemetry Injector to test out-of-bounds rejection and valid updates.',
      },
      {
        step_number: 4,
        title: 'Step 4: AI Assistant Transparency Inspection',
        description: 'Ask the AI Assistant about Hyderabad or Warangal risk to see live IoT telemetry badges and grounded evidence citations.',
        active_mode: 'IOT',
        recommended_action: 'Query AI: "What is the live sensor status in Hyderabad?"',
      },
    ],
  });
});

// 11. AI Provider Status & Health Check Endpoint
app.get('/api/ai/status', async (req, res) => {
  const config = getLlamaConfig();
  const pingResult = await pingLlama(2500);

  res.json({
    ai_configured: Boolean(config.baseUrl && config.model),
    provider: 'Meta Llama',
    provider_format: 'OpenAI-Compatible',
    model: config.model,
    endpoint: config.baseUrl,
    status: pingResult.isHealthy ? 'operational' : 'fallback',
    active_provider: pingResult.isHealthy ? 'Meta Llama' : 'Deterministic Engine',
    active_model: pingResult.isHealthy ? config.model : 'Deterministic Fallback Engine',
    latency_ms: pingResult.latencyMs > 0 ? pingResult.latencyMs : null,
    fallback_available: true,
    deterministic_engine: 'operational',
    offline_safe: true,
    live_refresh_minutes: config.refreshMinutes,
    error: pingResult.error || null,
  });
});

// 12. Manual Refresh Live Rainfall Telemetry (Open-Meteo)
app.post('/api/rainfall/refresh', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    const districts = loadDistrictMetadata();
    const result = await openMeteoService.refreshAllDistricts(districts);
    const updatedDistricts = await computeAllDistrictStatus();

    res.json({
      success: true,
      refreshed_count: result.total,
      success_count: result.success_count,
      failed_count: result.fail_count,
      errors: result.errors,
      timestamp: new Date().toISOString(),
      updated_districts_count: updatedDistricts.length,
    });
  } catch (error: any) {
    console.error('Error refreshing live rainfall:', error);
    res.status(500).json({ error: error.message || 'Failed to refresh live rainfall.' });
  }
});

// 13. Notifications Dispatch & History Ledger Endpoints
app.get('/api/notifications', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const districtId = req.query.district ? String(req.query.district) : undefined;
    const history = await notificationService.getHistory(limit, districtId);
    res.json({ count: history.length, notifications: history });
  } catch (error: any) {
    console.error('Error retrieving notifications:', error);
    res.status(500).json({ error: 'Failed to retrieve notifications.' });
  }
});

app.post('/api/notifications/dispatch', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    const { districtId, districtName, alertLevel, channel, title, message, recommendedAction, signalsTriggered, recipientGroup } = req.body;
    if (!districtId || !districtName || !alertLevel || !title || !message) {
      return res.status(400).json({ error: 'Missing required notification fields: districtId, districtName, alertLevel, title, message.' });
    }

    const notif = await notificationService.dispatchNotification({
      districtId,
      districtName,
      alertLevel,
      channel,
      title,
      message,
      recommendedAction,
      signalsTriggered,
      recipientGroup,
    });

    res.status(201).json({ success: true, notification: notif });
  } catch (error: any) {
    console.error('Error dispatching notification:', error);
    res.status(500).json({ error: 'Failed to dispatch notification.' });
  }
});

app.get('/api/notifications/delivery-config', requireAuth, requireRole('ADMIN'), (_req, res) => {
  try {
    res.json(getNotificationDeliveryConfig());
  } catch (error: any) {
    console.error('Error retrieving notification delivery config:', error);
    res.status(500).json({ error: 'Failed to retrieve notification delivery configuration.' });
  }
});

app.post('/api/notifications/dry-run', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const limit = checkRateLimit(`notification-dry-run:${authReq.auth!.user.id}`, 20, 60);
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfterSeconds));
    return res.status(429).json({ error: 'Too many notification dry-run requests. Please try again later.' });
  }

  const { districtId, districtName, alertLevel, title, message, recommendedAction, signalsTriggered, source, channels } = req.body || {};
  const allowedLevels: NotificationAlertLevel[] = ['NORMAL', 'WATCH', 'ELEVATED', 'HIGH', 'CRITICAL'];
  const allowedChannels: NotificationDeliveryChannel[] = ['EMAIL', 'SMS', 'WHATSAPP'];

  if (!districtId || !districtName || !alertLevel || !title || !message) {
    return res.status(400).json({ error: 'Missing required fields: districtId, districtName, alertLevel, title, message.' });
  }
  if (!allowedLevels.includes(alertLevel)) {
    return res.status(400).json({ error: `alertLevel must be one of: ${allowedLevels.join(', ')}.` });
  }
  if (channels !== undefined && (!Array.isArray(channels) || channels.some((channel: string) => !allowedChannels.includes(channel as NotificationDeliveryChannel)))) {
    return res.status(400).json({ error: `channels must be an array containing only: ${allowedChannels.join(', ')}.` });
  }

  try {
    const delivery = new NotificationDeliveryService();
    const result = await delivery.dispatch({
      districtId: String(districtId),
      districtName: String(districtName),
      alertLevel,
      title: String(title),
      message: String(message),
      recommendedAction: recommendedAction ? String(recommendedAction) : undefined,
      signalsTriggered: Array.isArray(signalsTriggered) ? signalsTriggered.map(String) : undefined,
      source: source ? String(source) : undefined,
      channels,
    });
    res.status(201).json({ success: true, dry_run: true, result });
  } catch (error: any) {
    console.error('Error dispatching notification dry-run:', error);
    res.status(500).json({ error: 'Failed to dispatch notification dry-run.' });
  }
});


// ==========================================
// NOTIFICATION SIMULATOR (DRY-RUN ONLY, ADMIN). Never calls a messaging provider.
// ==========================================
async function resolveSimulationDistrict(req: express.Request, districtId: unknown) {
  const view = getScenarioViewOverrides(req);
  const all = await computeAllDistrictStatus(view.scenario, view.rainfallOverride);
  return all.find((x: any) => x.district_id === districtId) as any;
}

async function parseSimulationInput(req: express.Request) {
  const { district_id, severity, language, channel } = req.body || {};
  if (typeof district_id !== 'string' || !district_id) return { error: 'district_id is required.' } as const;
  if (!(['en', 'te', 'hi'] as const).includes(language)) return { error: 'language must be en, te or hi.' } as const;
  if (!(['WHATSAPP', 'SMS', 'EMAIL'] as const).includes(channel)) return { error: 'channel must be WHATSAPP, SMS or EMAIL.' } as const;
  if (severity !== undefined && !SEVERITIES.includes(severity)) return { error: `severity must be one of ${SEVERITIES.join(', ')}.` } as const;
  const d = await resolveSimulationDistrict(req, district_id);
  if (!d) return { error: 'Unknown district.', status: 404 } as const;
  const actual: Severity = severityFromRisk(d.risk_category);
  const used: Severity = severity ?? actual;
  return { d, language, channel: channel as Channel, actual, used };
}

app.post('/api/notifications/preview', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const p = await parseSimulationInput(req);
  if ('error' in p) return res.status(('status' in p && p.status) || 400).json({ error: p.error });
  const preview = buildPreview({ districtName: p.d.district, severity: p.used, language: p.language, channel: p.channel });
  res.json({
    district: { id: p.d.district_id, name: p.d.district, actual_risk_category: p.d.risk_category, actual_risk_score: p.d.flood_risk_score, actual_severity: p.actual },
    severity_used: p.used,
    severity_override: p.used !== p.actual,
    preview,
    dry_run: true,
    notice: 'Preview only. No message is sent.',
  });
});

app.post('/api/notifications/simulate', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  if (process.env.NOTIFICATION_DRY_RUN === 'false' || process.env.NOTIFICATION_LIVE_SEND_ENABLED === 'true') {
    return res.status(409).json({ error: 'Simulation endpoint refuses to run unless NOTIFICATION_DRY_RUN is true and live sending is disabled.' });
  }
  const limit = checkRateLimit(`notification-sim:${authReq.auth!.user.id}`, 20, 60);
  if (!limit.allowed) { res.setHeader('Retry-After', String(limit.retryAfterSeconds)); return res.status(429).json({ error: 'Too many simulations. Please wait.' }); }
  const key = String(req.get('Idempotency-Key') || req.body?.idempotency_key || '').trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) return res.status(400).json({ error: 'An Idempotency-Key (8-80 chars: letters, digits, - or _) is required.' });
  const p = await parseSimulationInput(req);
  if ('error' in p) return res.status(('status' in p && p.status) || 400).json({ error: p.error });
  const contact = validateContact(p.channel, req.body?.contact);
  if (!contact.ok) return res.status(400).json({ error: contact.error });

  const db = getMongoDb();
  const existing = await db.collection('notification_simulation_keys').findOne({ idempotency_key: key });
  if (existing) return res.status(200).json({ ...JSON.parse(existing.response_json), replayed: true });

  const preview = buildPreview({ districtName: p.d.district, severity: p.used, language: p.language, channel: p.channel });
  const simulationId = `SIM-${randomUUID()}`;
  const createdAt = new Date().toISOString();
  const response = {
    simulation_id: simulationId, created_at: createdAt, dry_run: true,
    channel: p.channel, language: p.language, district_id: p.d.district_id, district: p.d.district,
    actual_severity: p.actual, severity_used: p.used, severity_override: p.used !== p.actual,
    contact_masked: maskContact(p.channel, contact.value),
    result: 'SIMULATED',
    message: 'Simulation completed. No external message was sent.',
    preview,
  };
  try {
    await db.collection('notification_simulation_keys').insertOne({
      idempotency_key: key,
      simulation_id: simulationId,
      user_id: authReq.auth!.user.id,
      created_at: createdAt,
      response_json: JSON.stringify(response),
    });
    await db.collection('notification_history').insertOne({
      id: simulationId,
      district_id: p.d.district_id,
      district_name: p.d.district,
      alert_level: p.used,
      channel: p.channel,
      title: preview.subject || `NeerDrishti simulation: ${p.d.district}`,
      message: preview.body,
      recommended_action: null,
      signals_triggered: null,
      status: 'DRY_RUN',
      recipient_group: 'DEMO_CONTACT',
      timestamp: createdAt,
      is_prototype: 1,
      metadata: JSON.stringify({ simulation: true, language: p.language, actual_severity: p.actual, severity_override: p.used !== p.actual, contact_masked: response.contact_masked }),
    });
  } catch (err: any) {
    const again = await db.collection('notification_simulation_keys').findOne({ idempotency_key: key });
    if (again) return res.status(200).json({ ...JSON.parse(again.response_json), replayed: true });
    console.error('Simulation failed:', err);
    return res.status(500).json({ error: 'Could not record the simulation.' });
  }
  res.status(201).json({ ...response, replayed: false });
});

app.get('/api/notifications/simulations', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const n = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '25'), 10) || 25));
  const rows = await getMongoDb().collection('notification_history').find({ id: { $regex: '^SIM-' } }, { sort: { timestamp: -1 }, limit: n }).toArray();
  res.json({ simulations: rows.map(r => ({ ...r, metadata: (() => { try { return JSON.parse(r.metadata || '{}'); } catch { return {}; } })() })) });
});

app.get('/api/notifications/stats', requireAuth, requireRole('ADMIN'), async (req, res) => {
  try {
    const stats = await notificationService.getStats();
    res.json(stats);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to retrieve notification statistics.' });
  }
});

// ==========================================
// VITE SPA MIDDLEWARE / PRODUCTION STATIC SERVE
// ==========================================
async function startServer() {
  try {
    await initDatabase();
  } catch (err) {
    console.error(JSON.stringify({ type: 'startup', event: 'database_init_failed', error: toSafeError(err) }));
    process.exit(1);
  }
  // Unknown /api routes must NEVER fall through to the SPA (index.html) or Express's default HTML 404:
  // clients call res.json() on API responses and would crash with "Unexpected token '<'".
  app.use('/api', async (req, res) => {
    res.status(404).json({ error: `API route not found: ${req.method} ${req.originalUrl.split('?')[0]}` });
  });
  if (RUNTIME.nodeEnv === 'development') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const candidatePaths = [
      path.join(process.cwd(), 'dist'),
      path.join(process.cwd(), '..', 'dist'),
    ];
    const distPath = candidatePaths.find(p => fs.existsSync(path.join(p, 'index.html'))) || candidatePaths[0];
    app.use(express.static(distPath));
    app.get('*', async (req, res) => {
      const indexPath = path.join(distPath, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(200).send('<!DOCTYPE html><html><head><title>NeerDrishti</title></head><body><div id="root"></div></body></html>');
      }
    });
  }

  // Final error handler: always JSON for API requests (body-parser errors, thrown errors).
  app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = Number(err?.status || err?.statusCode) || 500;
    if (status >= 500) console.error('Unhandled error:', err);
    if (req.path.startsWith('/api')) {
      return res.status(status).json({ error: status >= 500 ? 'Internal server error.' : String(err?.message || 'Bad request.') });
    }
    res.status(status).type('text/plain').send(status >= 500 ? 'Internal server error' : 'Bad request');
  });

  await initializeAdminSetup();

  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`NeerDrishti Phase C Server listening on port ${PORT}`);
    // Start lightweight Open-Meteo live rainfall telemetry scheduled refresh
    if (process.env.NODE_ENV !== 'test' && process.env.NEERDRISHTI_DISABLE_SCHEDULED_REFRESH !== 'true') {
      try {
        const districts = loadDistrictMetadata();
        if (districts && districts.length > 0) {
          openMeteoService.startScheduledRefresh(districts);
        }
      } catch (err) {
        console.error('Failed to initialize Open-Meteo live refresh on server start:', err);
      }
      try {
        imdCapService.startScheduledRefresh();
      } catch (err) {
        console.error('Failed to initialize official CAP refresh on server start:', err);
      }
    }
  });

  const shutdownController = createGracefulShutdown({
    server: httpServer,
    stopBackgroundJobs: () => {
      try {
        imdCapService.stopScheduledRefresh();
      } catch (error) {
        console.error(JSON.stringify({ type: 'shutdown', event: 'background_stop_failed', service: 'imdCapService', error: toSafeError(error) }));
      }
      try {
        openMeteoService.stopScheduledRefresh();
      } catch (error) {
        console.error(JSON.stringify({ type: 'shutdown', event: 'background_stop_failed', service: 'openMeteoService', error: toSafeError(error) }));
      }
    },
    closeDatabase: closeDb,
    timeoutMs: RUNTIME.shutdownTimeoutMs,
    logger: {
      info: line => console.log(line),
      error: line => console.error(line),
    },
  });

  process.once('SIGINT', () => {
    void shutdownController.shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdownController.shutdown('SIGTERM');
  });
  process.once('SIGBREAK', () => {
    void shutdownController.shutdown('SIGBREAK');
  });
  process.on('uncaughtException', error => {
    console.error(JSON.stringify({ type: 'process_error', event: 'uncaught_exception', error: toSafeError(error) }));
    void shutdownController.shutdown('uncaughtException');
  });
  process.on('unhandledRejection', reason => {
    console.error(JSON.stringify({ type: 'process_error', event: 'unhandled_rejection', error: toSafeError(reason) }));
    void shutdownController.shutdown('unhandledRejection');
  });
}

const isMainModule = process.argv[1] ? path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) : false;
if (isMainModule) {
  startServer();
}

export { app, startServer };
