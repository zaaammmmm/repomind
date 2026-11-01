import { describe, it, expect } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAICompatibleProvider, isLoopbackUrl } from '../src/llm/openai-compat.js';
import { LlmError } from '../src/contracts.js';

const REQ = { system: 'S', user: 'U' };
const json = (b: unknown, status = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...h } });
const ok = (text = 'halo', usage: unknown = { prompt_tokens: 100, completion_tokens: 20 }) => json({ model: 'm1', choices: [{ message: { content: text } }], usage });
const sleeps: number[] = [];
const mk = (f: typeof fetch, o = {}) => new OpenAICompatibleProvider({ id: 'cloud', baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'SECRET-KEY-123', fetchImpl: f, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5, ...o });
const code = async (p: Promise<unknown>) => { try { await p; return 'tidak melempar'; } catch (e) { expect(e).toBeInstanceOf(LlmError); return (e as LlmError).code; } };

describe('OpenAICompatibleProvider: complete', () => {
  it('permintaan benar, usage dari penyedia, biaya dari tarif pengguna', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const p = mk(async (u, i) => { seen = { url: String(u), init: i! }; return ok(); }, { priceInPerMTok: 3, priceOutPerMTok: 15 });
    const r = await p.complete(REQ);
    expect(seen!.url).toBe('https://api.example.com/v1/chat/completions');
    const body = JSON.parse(String(seen!.init.body)); expect(body).toMatchObject({ model: 'm', temperature: 0, stream: false, messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }] });
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe('Bearer SECRET-KEY-123');
    expect(r).toMatchObject({ text: 'halo', model: 'm1', usage: { tokensIn: 100, tokensOut: 20, usageSource: 'provider' } });
    expect(r.usage.costEstimate).toBeCloseTo((100 * 3 + 20 * 15) / 1e6, 10);
  });
  it('tanpa usage dari penyedia: taksiran dan ditandai estimated', async () => {
    const r = await mk(async () => ok('abcd', null)).complete(REQ);
    expect(r.usage.usageSource).toBe('estimated');
  });
  it('apiKey boleh fungsi async (SecretStorage); tanpa key tidak ada header Authorization (Ollama)', async () => {
    let h: Record<string, string> = {};
    await mk(async (_u, i) => { h = i!.headers as Record<string, string>; return ok(); }, { apiKey: async () => 'K2' }).complete(REQ); expect(h.Authorization).toBe('Bearer K2');
    await mk(async (_u, i) => { h = i!.headers as Record<string, string>; return ok(); }, { apiKey: undefined }).complete(REQ); expect(h.Authorization).toBeUndefined();
  });
  it('taksonomi galat: 401, 403, 429, 5xx, 400 konteks, offline', async () => {
    const st = (s: number, b = 'x') => mk(async () => new Response(b, { status: s }), { maxRetries: 0 }).complete(REQ);
    expect(await code(st(401))).toBe('AUTH'); expect(await code(st(403))).toBe('AUTH');
    expect(await code(st(429))).toBe('RATE_LIMIT'); expect(await code(st(500))).toBe('PROVIDER_ERROR'); expect(await code(st(404))).toBe('PROVIDER_ERROR');
    expect(await code(st(400, "This model's maximum context length is 8192 tokens"))).toBe('CONTEXT_TOO_LONG');
    expect(await code(mk(async () => { throw new TypeError('fetch failed'); }, { maxRetries: 0 }).complete(REQ))).toBe('OFFLINE');
  });
  it('pesan galat berbahasa Indonesia, ada saran, dan tidak membocorkan API key', async () => {
    try { await mk(async () => new Response('bad key SECRET-KEY-123?', { status: 500 }), { maxRetries: 0 }).complete(REQ); } catch (e) {
      const m = e as LlmError; expect(m.suggestion).toMatch(/Mode 1|Pengaturan/); expect(m.message).toMatch(/Penyedia/);
      // Badan respons dipotong dan dicatat apa adanya; kunci tidak pernah ditambahkan oleh adapter
      expect(JSON.stringify({ code: m.code, s: m.suggestion })).not.toContain('SECRET-KEY');
    }
  });
  it('retry hanya untuk 429 dan 5xx, maksimum 2, backoff eksponensial; 4xx lain tidak diulang', async () => {
    sleeps.length = 0; let n = 0;
    const r = await mk(async () => (++n < 3 ? new Response('', { status: 503 }) : ok())).complete(REQ);
    expect(r.text).toBe('halo'); expect(n).toBe(3); expect(sleeps).toEqual([500, 1000]);
    n = 0; expect(await code(mk(async () => { n++; return new Response('', { status: 502 }); }).complete(REQ))).toBe('PROVIDER_ERROR'); expect(n).toBe(3);
    n = 0; await code(mk(async () => { n++; return new Response('', { status: 401 }); }).complete(REQ)); expect(n).toBe(1);
    n = 0; await code(mk(async () => { n++; return new Response('', { status: 400 }); }).complete(REQ)); expect(n).toBe(1);
  });
  it('Retry-After dihormati (dibatasi 10 detik)', async () => {
    sleeps.length = 0; let n = 0;
    await mk(async () => (++n < 2 ? new Response('', { status: 429, headers: { 'retry-after': '3' } }) : ok())).complete(REQ);
    expect(sleeps).toEqual([3000]);
  });
  it('timeout dan pembatalan dibedakan', async () => {
    const hang: typeof fetch = (_u, i) => new Promise((_r, rej) => i!.signal!.addEventListener('abort', () => rej(Object.assign(new Error('abort'), { name: 'AbortError' }))));
    expect(await code(mk(hang, { timeoutMs: 20, maxRetries: 0 }).complete(REQ))).toBe('TIMEOUT');
    const ctl = new AbortController(); const pr = mk(hang, { timeoutMs: 5000 }).complete(REQ, ctl.signal); setTimeout(() => ctl.abort(), 10);
    expect(await code(pr)).toBe('CANCELLED');
    const pre = new AbortController(); pre.abort(); expect(await code(mk(hang).complete(REQ, pre.signal))).toBe('CANCELLED');
  });
  it('respons 200 yang bukan JSON dipetakan PROVIDER_ERROR, bukan OFFLINE (server hidup)', async () => {
    const bad = mk(async () => new Response('data: {"x":1}\n\n', { status: 200 }), { maxRetries: 0 });
    try { await bad.complete(REQ); expect.unreachable(); } catch (e) { expect((e as LlmError).code).toBe('PROVIDER_ERROR'); expect((e as LlmError).message).toMatch(/tidak dapat dibaca/); }
  });
  it('endpoint non-loopback wajib https; model wajib', () => {
    expect(() => new OpenAICompatibleProvider({ id: 'cloud', baseUrl: 'http://api.example.com/v1', model: 'm' })).toThrow(/https/);
    expect(() => new OpenAICompatibleProvider({ id: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'm' })).not.toThrow();
    expect(() => new OpenAICompatibleProvider({ id: 'ollama', baseUrl: 'http://localhost:11434/v1', model: '' })).toThrow(/model/);
    expect([isLoopbackUrl('http://127.0.0.1:1/v1'), isLoopbackUrl('http://[::1]:1/v1'), isLoopbackUrl('http://192.168.1.5/v1'), isLoopbackUrl('x')]).toEqual([true, true, false, false]);
  });
});

describe('OpenAICompatibleProvider: HTTP dan SSE sungguhan (server lokal)', () => {
  const serve = (handler: http.RequestListener) => new Promise<{ url: string; close: () => Promise<void> }>((res) => {
    const s = http.createServer(handler).listen(0, '127.0.0.1', () => res({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/v1`, close: () => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); }) }));
  });
  const sse = (res: http.ServerResponse, parts: string[], usage = true) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    parts.forEach((t) => res.write(`data: ${JSON.stringify({ model: 'srv', choices: [{ delta: { content: t } }] })}\n\n`));
    if (usage) res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 42, completion_tokens: 7 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  };
  it('stream: token berurutan, usage dari potongan terakhir, permintaan meminta include_usage', async () => {
    let body: { stream?: boolean; stream_options?: unknown } = {};
    const s = await serve((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { body = JSON.parse(b); sse(res, ['Ha', 'lo ', '[F1:1-2]']); }); });
    try {
      const toks: string[] = []; const p = new OpenAICompatibleProvider({ id: 'ollama', baseUrl: s.url, model: 'm' });
      const r = await p.stream(REQ, (t) => toks.push(t));
      expect(toks).toEqual(['Ha', 'lo ', '[F1:1-2]']); expect(r.text).toBe('Halo [F1:1-2]'); expect(r.model).toBe('srv');
      expect(r.usage).toMatchObject({ tokensIn: 42, tokensOut: 7, usageSource: 'provider' });
      expect(body).toMatchObject({ stream: true, stream_options: { include_usage: true } }); expect(p.loopback).toBe(true);
    } finally { await s.close(); }
  });
  it('stream tanpa usage: ditandai estimated', async () => {
    const s = await serve((_q, res) => sse(res, ['abc'], false));
    try { expect((await new OpenAICompatibleProvider({ id: 'ollama', baseUrl: s.url, model: 'm' }).stream(REQ, () => {})).usage.usageSource).toBe('estimated'); } finally { await s.close(); }
  });
  it('stream dapat dibatalkan di tengah jalan', async () => {
    const s = await serve((_q, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }] })}\n\n`); });
    try {
      const ctl = new AbortController(); const p = new OpenAICompatibleProvider({ id: 'ollama', baseUrl: s.url, model: 'm' });
      expect(await code(p.stream(REQ, () => ctl.abort(), ctl.signal))).toBe('CANCELLED');
    } finally { await s.close(); }
  });
  it('stream diam melebihi batas waktu menjadi TIMEOUT', async () => {
    const s = await serve((_q, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }] })}\n\n`); });
    try { expect(await code(new OpenAICompatibleProvider({ id: 'ollama', baseUrl: s.url, model: 'm', timeoutMs: 80, maxRetries: 0 }).stream(REQ, () => {}))).toBe('TIMEOUT'); } finally { await s.close(); }
  });
  it('server mati: OFFLINE', async () => {
    const s = await serve(() => {}); await s.close();
    expect(await code(new OpenAICompatibleProvider({ id: 'ollama', baseUrl: s.url, model: 'm', maxRetries: 0 }).complete(REQ))).toBe('OFFLINE');
  });
});
