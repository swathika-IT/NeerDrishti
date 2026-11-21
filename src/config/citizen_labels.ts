/** Citizen-facing risk labels shared by server and UI. */
export type RiskCategory = 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';
export type Lang = 'en' | 'te' | 'hi';

export const CITIZEN_LABEL: Record<RiskCategory, Record<Lang, string>> = {
  LOW: { en: 'SAFE', te: 'సురక్షితం', hi: 'सुरक्षित' },
  MODERATE: { en: 'BE CAREFUL', te: 'జాగ్రత్తగా ఉండండి', hi: 'सावधान रहें' },
  HIGH: { en: 'HIGH FLOOD RISK', te: 'అధిక వరద ప్రమాదం', hi: 'उच्च बाढ़ जोखिम' },
  CRITICAL: { en: 'EMERGENCY INFORMATION', te: 'అత్యవసర సమాచారం', hi: 'आपातकालीन जानकारी' },
};

export const RAIN_CLASS_LABEL: Record<string, Record<Lang, string>> = {
  'No Rain': { en: 'no rain', te: 'వర్షం లేదు', hi: 'वर्षा नहीं' },
  'Very Light': { en: 'very light', te: 'చాలా తేలికపాటి', hi: 'बहुत हल्की' },
  Light: { en: 'light', te: 'తేలికపాటి', hi: 'हल्की' },
  Moderate: { en: 'moderate', te: 'మోస్తరు', hi: 'मध्यम' },
  Heavy: { en: 'heavy', te: 'భారీ', hi: 'भारी' },
  'Very Heavy': { en: 'very heavy', te: 'అతి భారీ', hi: 'बहुत भारी' },
  'Extremely Heavy': { en: 'extremely heavy', te: 'అత్యంత భారీ', hi: 'अत्यंत भारी' },
};
