#!/usr/bin/env node
/**
 * TwinMind -> OpenAI-compatible proxy  (PATCHED)
 * ------------------------------------------------------------------
 * Differences from upstream twinmind-proxy:
 *   [PATCH-1] System prompt is preserved in FULL. Upstream replaced any
 *             system prompt >3000 chars with a generic one-liner, which
 *             destroyed the operator's persona. Removed.
 *   [PATCH-2] OpenAI `tools` are forwarded to TwinMind. TwinMind's schema
 *             currently rejects an unknown `tools` key (422 extra_forbidden),
 *             so on 422 we retry once WITHOUT tools and degrade gracefully
 *             instead of failing the request.
 *   [PATCH-3] `tool_calls` emitted by upstream are surfaced as OpenAI
 *             tool_calls deltas when present.
 *
 * Exposes /v1/chat/completions and /v1/models in OpenAI wire format.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

function loadDotEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* no .env */ }
}
loadDotEnv(path.join(__dirname, '.env'));

const CFG = {
  refreshToken: process.env.TWINMIND_REFRESH_TOKEN || '',
  staticIdToken: process.env.TWINMIND_ID_TOKEN || '',
  apiKey: process.env.TWINMIND_API_KEY || '',
  tenant: process.env.TWINMIND_TENANT || 'PRODTwinMind-dcnoy',
  base: 'https://api2.twinmind.com',
  port: parseInt(process.env.PORT || '8790', 10),
  proxyKey: process.env.PROXY_KEY || '',
};

let tokenCache = { idToken: '', expiresAt: 0 };

async function refreshFirebaseToken() {
  if (CFG.staticIdToken) return CFG.staticIdToken;
  if (!CFG.refreshToken) throw new Error('TWINMIND_REFRESH_TOKEN not set');
  if (!CFG.apiKey) throw new Error('TWINMIND_API_KEY not set');
  const res = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(CFG.apiKey)}`,
    { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: CFG.refreshToken,
      }).toString() });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.id_token) {
    throw new Error(`Firebase token refresh failed: ${res.status} ${JSON.stringify(j)}`);
  }
  tokenCache = { idToken: j.id_token,
                 expiresAt: Date.now() + (parseInt(j.expires_in || '3600', 10) - 60) * 1000 };
  return tokenCache.idToken;
}

async function getIdToken() {
  if (CFG.staticIdToken) return CFG.staticIdToken;
  if (tokenCache.idToken && Date.now() < tokenCache.expiresAt) return tokenCache.idToken;
  return refreshFirebaseToken();
}

// [PATCH-1] full system prompt preserved; no length-based substitution.
function buildTwinMindRequest(body, includeTools) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const systemParts = [];
  const turns = [];
  for (const m of msgs) {
    let text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.filter(c => c && c.type === 'text').map(c => c.text).join('\n')
        : '';
    if (m.role === 'system') {
      if (text) systemParts.push(text);
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const names = m.tool_calls.map(t => t.function && t.function.name).filter(Boolean).join(', ');
      turns.push(`Assistant: [called tool: ${names}]`);
      if (text) turns.push(`Assistant: ${text}`);
      continue;
    }
    if (m.role === 'tool') {
      turns.push(`Tool(${m.name || m.tool_call_id || 'result'}): ${text}`);
      continue;
    }
    if (!text) continue;
    if (m.role === 'user') turns.push(`User: ${text}`);
    else if (m.role === 'assistant') turns.push(`Assistant: ${text}`);
  }
  let query = turns.join('\n\n');
  if (systemParts.length) query = `[System]\n${systemParts.join('\n')}\n\n${query}`;
  if (!query) query = 'Hello';

  const model = (body.model && body.model !== 'auto')
    ? { model_name: body.model }
    : 'auto';

  const out = {
    type: 'app', version: 1, response_version: 1,
    query, model, context: null,
    client: { platform: 'web',
              timezone: body.timezone || 'UTC',
              client_time: new Date().toISOString(),
              locale: 'en-US' },
    mode: 'default',
  };
  // [PATCH-2] forward tools when asked; caller retries without on 422.
  if (includeTools && Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools;
  }
  return out;
}

function sseLine(obj) { return `data: ${JSON.stringify(obj)}\n\n`; }

function openAiChunk(model, delta, finish) {
  return { id: 'chatcmpl-twinmind-' + Date.now().toString(36),
           object: 'chat.completion.chunk',
           created: Math.floor(Date.now() / 1000),
           model,
           choices: [{ index: 0, delta, finish_reason: finish || null }] };
}

async function callUpstream(idToken, tmReq) {
  return fetch(`${CFG.base}/api/v3/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json',
               Authorization: `Bearer ${idToken}`,
               Accept: 'text/event-stream' },
    body: JSON.stringify(tmReq),
  });
}

async function streamChat(req, res, body) {
  const idToken = await getIdToken();
  const wantStream = body.stream !== false;
  const model = body.model || 'auto';

  // [PATCH-2] try with tools; on 422 retry without them.
  let upstream = await callUpstream(idToken, buildTwinMindRequest(body, true));
  if (upstream.status === 422 && Array.isArray(body.tools) && body.tools.length) {
    const txt = await upstream.text().catch(() => '');
    console.error('[twinmind-proxy] tools rejected upstream (422), retrying without:', txt.slice(0, 200));
    upstream = await callUpstream(idToken, buildTwinMindRequest(body, false));
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: {
      message: `TwinMind ${upstream.status}: ${text.slice(0, 500)}`,
      type: 'upstream_error' } }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': wantStream ? 'text/event-stream' : 'application/json',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let thinking = '';

  const emit = (evt) => {
    switch (evt.type) {
      case 'text_delta':
      case 'text_start':
        if (evt.content) {
          full += evt.content;
          if (wantStream) res.write(sseLine(openAiChunk(model, { content: evt.content }, null)));
        }
        break;
      case 'thinking_delta':
      case 'thinking_start':
        if (evt.content) {
          thinking += evt.content;
          if (wantStream) res.write(sseLine(openAiChunk(model, { reasoning_content: evt.content }, null)));
        }
        break;
      case 'tool_call':
      case 'tool_calls':
        if (wantStream) {
          const tc = evt.tool_calls || (evt.tool_call ? [evt.tool_call] : []);
          if (tc.length) res.write(sseLine(openAiChunk(model, { tool_calls: tc }, null)));
        }
        break;
      case 'done':
        break;
      case 'error':
        if (wantStream) res.write(sseLine({ error: { message: evt.error || 'twinmind error', code: evt.code } }));
        break;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { emit(JSON.parse(payload)); } catch { /* partial */ }
    }
  }

  if (wantStream) {
    res.write(sseLine(openAiChunk(model, {}, 'stop')));
    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    res.end(JSON.stringify({
      id: 'chatcmpl-twinmind-' + Date.now().toString(36),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0,
                  message: { role: 'assistant', content: full,
                             reasoning_content: thinking || undefined },
                  finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }));
  }
}

const FALLBACK_MODELS = [
  { id: 'auto', object: 'model', owned_by: 'twinmind', context_length: 1000000, max_tokens: 128000 },
];

async function listModels() {
  try {
    const idToken = await getIdToken();
    const res = await fetch(`${CFG.base}/api/v3/chat/models`, {
      headers: { Authorization: `Bearer ${idToken}` } });
    if (!res.ok) throw new Error(String(res.status));
    const j = await res.json();
    const ids = new Set();
    if (j.default_model && j.default_model.name) ids.add(j.default_model.name);
    for (const p of j.providers || [])
      for (const m of p.models || []) if (m.name) ids.add(m.name);
    return [...ids].map(id => ({ id, object: 'model', owned_by: 'twinmind',
      context_length: 1000000, max_tokens: 128000,
      capabilities: { contextWindow: 1000000, maxOutput: 128000,
                      tools: false, vision: true, reasoning: true } }));
  } catch {
    return FALLBACK_MODELS;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 20e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (CFG.proxyKey) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${CFG.proxyKey}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'proxy key required', type: 'auth_error' } }));
    }
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    const models = await listModels();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: models }));
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      return await streamChat(req, res, body);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: e.message, type: 'proxy_error' } }));
    }
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok',
      has_refresh_token: !!CFG.refreshToken, tenant: CFG.tenant,
      patched: ['full-system-prompt', 'tools-passthrough', 'tool-call-deltas'] }));
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

server.listen(CFG.port, () => {
  console.log(`[twinmind-proxy] listening on :${CFG.port}`);
  console.log(`[twinmind-proxy] tenant=${CFG.tenant} refresh_token=${CFG.refreshToken ? 'set' : 'MISSING'}`);
  console.log('[twinmind-proxy] PATCHED: full system prompt + tools passthrough');
});
