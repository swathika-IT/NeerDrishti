import test from 'node:test';
import assert from 'node:assert/strict';
import { apiFetch, ApiError } from '../src/lib/api';

const mockFetch = (body: string, init: { status?: number; type?: string } = {}) => {
  (globalThis as any).fetch = async () => new Response(body, { status: init.status ?? 200, headers: { 'Content-Type': init.type ?? 'application/json' } });
};

test('HTML body (SPA fallback / proxy error) becomes a friendly ApiError, not a JSON SyntaxError', async () => {
  mockFetch('<html><head></head><body>Cannot POST</body></html>', { type: 'text/html', status: 404 });
  await assert.rejects(() => apiFetch('/api/auth/register', { method: 'POST' }), (e: any) => e instanceof ApiError && e.kind === 'html' && !/Unexpected token/.test(e.message));
});

test('HTML served with a JSON content-type is still detected', async () => {
  mockFetch('<!DOCTYPE html><html></html>', { type: 'application/json' });
  await assert.rejects(() => apiFetch('/x'), (e: any) => e.kind === 'html');
});

test('empty error response, network failure and invalid JSON are handled', async () => {
  mockFetch('', { status: 502 });
  await assert.rejects(() => apiFetch('/x'), (e: any) => e.kind === 'empty' && e.status === 502);
  (globalThis as any).fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(() => apiFetch('/x'), (e: any) => e.kind === 'network');
  mockFetch('{oops', { status: 200 });
  await assert.rejects(() => apiFetch('/x'), (e: any) => e.kind === 'invalid_json');
});

test('server JSON errors surface their message; success returns parsed data', async () => {
  mockFetch(JSON.stringify({ error: 'Email already registered.' }), { status: 409 });
  await assert.rejects(() => apiFetch('/x'), (e: any) => e.kind === 'http' && e.message === 'Email already registered.' && e.status === 409);
  mockFetch(JSON.stringify({ ok: 1 }));
  assert.deepEqual(await apiFetch('/x'), { ok: 1 });
});
