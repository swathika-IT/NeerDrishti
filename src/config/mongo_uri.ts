export interface MongoUriCheck {
  ok: boolean;
  database?: string;
  srv?: boolean;
  reason?: string;
}

const PROTOCOL_RE = /^(mongodb|mongodb\+srv):\/\//i;
const HOST_RE = /^(\[[^\]]+\]|[^:\s/]+)(:\d+)?$/;

/**
 * Validates a MongoDB connection string without using WHATWG URL parsing,
 * which rejects valid replica-set host lists such as
 * mongodb://host1:27017,host2:27017/db.
 *
 * Rules preserved from the previous implementation:
 * - only mongodb:// and mongodb+srv:// are accepted
 * - a database name is required in the path
 * - embedded credentials are allowed (Atlas requires them)
 * Additional safety:
 * - mongodb+srv:// must use exactly one host and no explicit port
 * - explicit TLS disabling (tls=false / ssl=false) is rejected
 */
export function validateMongoConnectionString(uri: string): MongoUriCheck {
  const trimmed = (uri || '').trim();
  if (!trimmed) return { ok: false, reason: 'MONGODB_URI is missing' };

  const protocolMatch = PROTOCOL_RE.exec(trimmed);
  if (!protocolMatch) {
    return { ok: false, reason: 'MONGODB_URI must use the mongodb:// or mongodb+srv:// protocol' };
  }
  const srv = protocolMatch[1].toLowerCase() === 'mongodb+srv';

  const rest = trimmed.slice(protocolMatch[0].length);
  const authorityEnd = rest.search(/[/?]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const afterAuthority = authorityEnd === -1 ? '' : rest.slice(authorityEnd);

  const at = authority.lastIndexOf('@');
  const hostPart = at === -1 ? authority : authority.slice(at + 1);
  if (!hostPart) return { ok: false, reason: 'MONGODB_URI must include a host' };

  const hosts = hostPart.split(',');
  if (srv && hosts.length !== 1) {
    return { ok: false, reason: 'mongodb+srv:// must specify exactly one host' };
  }
  for (const rawHost of hosts) {
    const host = rawHost.trim();
    if (!host) return { ok: false, reason: 'MONGODB_URI contains an empty host' };
    if (!HOST_RE.test(host)) {
      return { ok: false, reason: `MONGODB_URI contains an invalid host: ${host}` };
    }
    if (srv && /:\d+$/.test(host)) {
      return { ok: false, reason: 'mongodb+srv:// hosts must not include a port' };
    }
  }

  const pathPart = afterAuthority.startsWith('/') ? afterAuthority.slice(1) : '';
  const dbSegment = pathPart.split('?')[0].split('/')[0];
  let database = '';
  try {
    database = decodeURIComponent(dbSegment);
  } catch {
    return { ok: false, reason: 'MONGODB_URI has an invalid database name encoding' };
  }
  if (!database) return { ok: false, reason: 'MONGODB_URI must include a database name in the path' };

  const query = afterAuthority.includes('?') ? afterAuthority.slice(afterAuthority.indexOf('?') + 1) : '';
  const params = new URLSearchParams(query);
  if (params.get('tls') === 'false' || params.get('ssl') === 'false') {
    return { ok: false, reason: 'MONGODB_URI must not disable TLS (tls=false/ssl=false)' };
  }

  return { ok: true, database, srv };
}
