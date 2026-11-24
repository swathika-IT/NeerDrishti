/**
 * Safe JSON fetch for the NeerDrishti API.
 * Never throws "Unexpected token '<'": HTML, empty and non-JSON bodies, network failures and HTTP errors are all
 * converted into a typed ApiError with a human-readable message.
 */
const DEFAULT_PRODUCTION_API_BASE = 'https://neerdrishti-xc01.onrender.com';
const API_BASE_INSTALLED = Symbol.for('neerdrishti.apiFetchBase');

function readApiBase(): string {
  try {
    const configured = (import.meta as any).env.VITE_API_BASE_URL;
    if (typeof configured === 'string' && configured.trim()) {
      return configured.trim().replace(/\/+$/, '');
    }
    return (import.meta as any).env.PROD ? DEFAULT_PRODUCTION_API_BASE : '';
  } catch {
    return '';
  }
}

export const API_BASE_URL = readApiBase();

export function apiUrl(path: string): string {
  if (!API_BASE_URL || /^(https?:|data:|blob:)/i.test(path)) return path;
  return `${API_BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`;
}

function withApiCredentials(init?: RequestInit): RequestInit {
  if (!API_BASE_URL) return init || {};
  return { ...(init || {}), credentials: 'include' };
}

export function installApiFetchBase(): void {
  if (!API_BASE_URL || typeof window === 'undefined' || (window as any)[API_BASE_INSTALLED]) return;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/api/')) {
      return nativeFetch(apiUrl(input), withApiCredentials(init));
    }
    if (input instanceof URL && input.origin === window.location.origin && input.pathname.startsWith('/api/')) {
      return nativeFetch(apiUrl(input.toString()), withApiCredentials(init));
    }
    if (typeof input === 'string' && input.startsWith(`${API_BASE_URL}/`)) {
      return nativeFetch(input, withApiCredentials(init));
    }
    return nativeFetch(input, init);
  }) as typeof fetch;
  (window as any)[API_BASE_INSTALLED] = true;
}

export class ApiError extends Error {
  status: number;
  kind: 'network' | 'html' | 'empty' | 'invalid_json' | 'http';
  constructor(message: string, status: number, kind: ApiError['kind']) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
  }
}

export async function apiFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), withApiCredentials({ credentials: 'same-origin', ...init }));
  } catch {
    throw new ApiError('Cannot reach the NeerDrishti server. Check that it is running and try again.', 0, 'network');
  }
  const text = await res.text();
  const ctype = res.headers.get('content-type') || '';
  if (!text.trim()) {
    if (res.ok) return {} as T;
    throw new ApiError(`Server returned an empty response (HTTP ${res.status}).`, res.status, 'empty');
  }
  if (/^\s*</.test(text) || ctype.includes('text/html')) {
    throw new ApiError(
      'The server returned a web page instead of data. The API server may not be running or the address is wrong.',
      res.status, 'html');
  }
  let data: any;
  try { data = JSON.parse(text); } catch {
    throw new ApiError(`The server returned an unreadable response (HTTP ${res.status}).`, res.status, 'invalid_json');
  }
  if (!res.ok) {
    throw new ApiError(String(data?.error || data?.message || `Request failed (HTTP ${res.status}).`), res.status, 'http');
  }
  return data as T;
}
