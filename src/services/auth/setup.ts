import crypto from 'crypto';
import { countAdmins } from './auth_service';

/**
 * First-admin bootstrap.
 *
 * A one-time setup token is generated in memory at process start ONLY while zero
 * administrators exist. The token is printed to the server console (never to the
 * browser, never hardcoded, never persisted). Creating the first admin disables
 * the setup endpoint. A restart before setup rotates the token.
 */

let setupTokenHash: string | null = null;
let setupTokenIssuedAt: number | null = null;
const SETUP_TOKEN_TTL_MINUTES = 60;

export function initializeAdminSetup(): void {
  try {
    if (countAdmins() > 0) {
      setupTokenHash = null;
      setupTokenIssuedAt = null;
      return;
    }
    const token = crypto.randomBytes(24).toString('base64url');
    setupTokenHash = crypto.createHash('sha256').update(token).digest('hex');
    setupTokenIssuedAt = Date.now();
    console.log('==============================================================');
    console.log(' NeerDrishti first-admin setup token (valid 60 minutes):');
    console.log(`   ${token}`);
    console.log(' Use it once at POST /api/auth/setup-admin to create the first');
    console.log(' administrator. This token is never logged again after setup.');
    console.log('==============================================================');
  } catch (err) {
    console.error('[auth] Could not initialize first-admin setup:', err);
  }
}

export function verifySetupToken(token: string): { valid: boolean; error?: string } {
  if (!setupTokenHash || !setupTokenIssuedAt) {
    return { valid: false, error: 'Administrator setup is not available. An admin may already exist.' };
  }
  if (Date.now() - setupTokenIssuedAt > SETUP_TOKEN_TTL_MINUTES * 60 * 1000) {
    return { valid: false, error: 'Setup token has expired. Restart the server to issue a new one.' };
  }
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'Setup token is required.' };
  }
  const given = crypto.createHash('sha256').update(token).digest('hex');
  const a = Buffer.from(given);
  const b = Buffer.from(setupTokenHash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false, error: 'Invalid setup token.' };
  }
  return { valid: true };
}

export function invalidateSetupToken(): void {
  setupTokenHash = null;
  setupTokenIssuedAt = null;
}

export function isSetupAvailable(): boolean {
  return setupTokenHash !== null;
}
