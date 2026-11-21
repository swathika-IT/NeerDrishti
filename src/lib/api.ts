/**
 * Safe JSON fetch for the NeerDrishti API.
 * Never throws "Unexpected token '<'": HTML, empty and non-JSON bodies, network failures and HTTP errors are all
 * converted into a typed ApiError with a human-readable message.
 */
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
    res = await fetch(path, { credentials: 'same-origin', ...init });
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
