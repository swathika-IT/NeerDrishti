/** Single definition of the flood-risk formula and rainfall reference classes. */
export const RISK_WEIGHTS = {
  rainfall: 0.35,
  flood_history: 0.25,
  terrain: 0.15,
  citizen_reports: 0.15,
  drainage: 0.10,
} as const;

export type RiskFactor = keyof typeof RISK_WEIGHTS;

/** Risk-category cut-offs on the 0-100 score (strictly greater-than). */
export const RISK_CATEGORY_CUTOFFS = { MODERATE: 25, HIGH: 50, CRITICAL: 75 } as const;

/**
 * IMD 24-hour rainfall classes (mm). Reference values taken from the commonly
 * published IMD classification; verify against the current IMD publication
 * before any operational use (see DATA_SOURCES.md).
 */
export const IMD_RAINFALL_CLASSES = [
  { name: 'Very Light', min: 0.1, max: 2.4 },
  { name: 'Light', min: 2.5, max: 15.5 },
  { name: 'Moderate', min: 15.6, max: 64.4 },
  { name: 'Heavy', min: 64.5, max: 115.5 },
  { name: 'Very Heavy', min: 115.6, max: 204.4 },
  { name: 'Extremely Heavy', min: 204.5, max: Infinity },
] as const;

export function classifyRainfall24h(mm: number): string {
  if (!(mm >= 0.1)) return 'No Rain';
  return IMD_RAINFALL_CLASSES.find(c => mm >= c.min && mm <= c.max + 0.05)?.name ?? 'Extremely Heavy';
}
