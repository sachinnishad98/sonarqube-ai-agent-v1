/* ═══════════════════════════════════════════════════════════════════════════
   lib/ai-providers.js — one chat() interface over several LLM vendors.

   Three of the four are OpenAI-compatible (Groq, OpenRouter, and any custom
   base URL), so they share a single code path. Anthropic has its own request
   and response shape and is handled separately.

   Nothing here reads process.env — credentials are passed in by the caller,
   which gets them from the UI-managed settings store. That is what lets a user
   switch provider without editing .env or restarting the agent.
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const ANTHROPIC_VERSION = '2023-06-01';

/* Claude Opus 4.7 and later reject temperature/top_p/top_k outright (HTTP 400).
   Older models still accept them. Rather than maintain an exhaustive list,
   match the families that removed sampling parameters. */
const ANTHROPIC_NO_SAMPLING = /^claude-(opus-(4-7|4-8|5)|sonnet-5|fable-5|mythos-5)/;

const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com',
    keyPlaceholder: 'sk-ant-...',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    defaultModel: 'claude-opus-5',
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5', 'claude-sonnet-4-5'],
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyPlaceholder: 'gsk_...',
    keyUrl: 'https://console.groq.com/keys',
    // Groq retires model names often — these are only a starting suggestion.
    // "Fetch" in AI Settings replaces them with what the key can actually use.
    defaultModel: 'openai/gpt-oss-120b',
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.6-27b', 'groq/compound'],
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyPlaceholder: 'sk-or-v1-...',
    keyUrl: 'https://openrouter.ai/keys',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-4o-mini', 'google/gemini-2.0-flash-001', 'meta-llama/llama-3.3-70b-instruct'],
  },
  custom: {
    label: 'Custom (OpenAI-compatible)',
    baseUrl: '',
    keyPlaceholder: 'your API key',
    keyUrl: '',
    defaultModel: '',
    models: [],
  },
};

function providerList() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id, label: p.label, defaultModel: p.defaultModel, models: p.models,
    keyPlaceholder: p.keyPlaceholder, keyUrl: p.keyUrl,
    needsBaseUrl: id === 'custom', defaultBaseUrl: p.baseUrl,
  }));
}

function resolveBaseUrl(provider, baseUrl) {
  const url = (baseUrl || PROVIDERS[provider]?.baseUrl || '').trim().replace(/\/+$/, '');
  if (!url) throw new Error('No API base URL configured for this provider.');
  return url;
}

/** Turns a vendor error body into one line worth showing a user. */
function readError(status, body) {
  const msg = body?.error?.message || body?.message || body?.error || '';
  const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
  if (text) return text;
  return `HTTP ${status}`;
}

/** Maps common failures onto advice, so a billing problem doesn't read like a bug. */
function hintFor(provider, status, message) {
  const m = String(message || '');
  if (/credit balance is too low|insufficient|quota|billing/i.test(m)) {
    const where = provider === 'anthropic' ? 'https://console.anthropic.com/settings/billing'
      : provider === 'openrouter' ? 'https://openrouter.ai/credits' : 'your provider dashboard';
    return `The key is valid but the account has no usable credit. Top up at ${where}, or switch to another provider in AI Settings.`;
  }
  if (status === 401 || status === 403 || /invalid.*(api|key)|unauthor/i.test(m)) {
    return 'The API key was rejected. Re-enter it in AI Settings — keys are provider-specific and cannot be reused across vendors.';
  }
  if (status === 404 && /model/i.test(m)) {
    return 'That model name is not available on this provider. Open AI Settings and press "Fetch" to load the models this key can actually use — vendors retire model names regularly.';
  }
  // Groq's free tier meters input + output against one per-minute budget, so an
  // otherwise valid request is rejected outright rather than queued.
  if (status === 413 || /tokens per minute|TPM|request too large/i.test(m)) {
    const limit = /Limit (\d+)/.exec(m)?.[1];
    return `The request exceeded the provider's per-minute token budget${limit ? ` (${limit} tokens/min, counting both the prompt and the reply)` : ''}. Lower "Max output tokens" in AI Settings — that also shrinks how many findings are sent — or upgrade the plan.`;
  }
  if (status === 429) return 'Rate limited by the provider. Wait a moment and run the review again.';
  return '';
}

async function withTimeout(ms, fn) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fn(ac.signal); }
  finally { clearTimeout(t); }
}

/* ── Anthropic ─────────────────────────────────────────────────────────── */
async function anthropicChat({ apiKey, model, system, user, maxTokens, baseUrl, timeoutMs }) {
  const url = `${resolveBaseUrl('anthropic', baseUrl)}/v1/messages`;
  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  };
  // Only send temperature to models that still accept it.
  if (!ANTHROPIC_NO_SAMPLING.test(model)) body.temperature = 0.2;

  const res = await withTimeout(timeoutMs, signal => fetch(url, {
    method: 'POST', signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  }));

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const message = readError(res.status, data);
    const err = new Error(message);
    err.status = res.status;
    err.hint = hintFor('anthropic', res.status, message);
    throw err;
  }
  if (data.stop_reason === 'refusal') {
    const err = new Error('The model declined to answer this request (safety refusal).');
    err.status = 200; err.hint = 'Try a different provider or model in AI Settings.';
    throw err;
  }
  const text = (data.content || [])
    .filter(b => b.type === 'text').map(b => b.text).join('');
  return { text, model: data.model || model, usage: data.usage || null, stopReason: data.stop_reason };
}

/* ── OpenAI-compatible: Groq, OpenRouter, custom ───────────────────────── */
async function openAiChat({ provider, apiKey, model, system, user, maxTokens, baseUrl, timeoutMs }) {
  const url = `${resolveBaseUrl(provider, baseUrl)}/chat/completions`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  // OpenRouter asks callers to identify themselves; harmless elsewhere.
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/sachinnishad98/sonarqube-ai-agent';
    headers['X-Title'] = 'SonarQube AI Agent';
  }

  const res = await withTimeout(timeoutMs, signal => fetch(url, {
    method: 'POST', signal, headers,
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0.2,
      // Ask for raw JSON where the vendor supports it; ignored otherwise.
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  }));

  let data = await res.json().catch(() => ({}));
  // Some OpenAI-compatible servers reject response_format outright; others
  // accept it and then fail the response against their own JSON validator when
  // the model is truncated mid-object. Both are recoverable — retry once
  // without the hint rather than failing the whole review over it.
  if (!res.ok && /response_format|failed to validate json/i.test(JSON.stringify(data))) {
    const retry = await withTimeout(timeoutMs, signal => fetch(url, {
      method: 'POST', signal, headers,
      body: JSON.stringify({
        model, max_tokens: maxTokens, temperature: 0.2,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    }));
    data = await retry.json().catch(() => ({}));
    if (!retry.ok || data.error) {
      const message = readError(retry.status, data);
      const err = new Error(message);
      err.status = retry.status; err.hint = hintFor(provider, retry.status, message);
      throw err;
    }
  } else if (!res.ok || data.error) {
    const message = readError(res.status, data);
    const err = new Error(message);
    err.status = res.status; err.hint = hintFor(provider, res.status, message);
    throw err;
  }

  const choice = (data.choices || [])[0] || {};
  const text = choice.message?.content || '';
  return { text, model: data.model || model, usage: data.usage || null, stopReason: choice.finish_reason };
}

/**
 * Single entry point used by the review flow.
 * @returns {Promise<{text:string, model:string, usage:object|null, stopReason:string}>}
 */
async function chat({ provider, apiKey, model, system, user, maxTokens = 8000, baseUrl = '', timeoutMs = 120000 }) {
  if (!PROVIDERS[provider]) throw new Error(`Unknown AI provider: ${provider}`);
  if (!apiKey) {
    const err = new Error('No API key configured for the selected AI provider.');
    err.hint = 'Open AI Settings in the dashboard and paste a key for this provider.';
    throw err;
  }
  if (!model) throw new Error('No model selected for the current AI provider.');

  const args = { provider, apiKey, model, system, user, maxTokens, baseUrl, timeoutMs };
  return provider === 'anthropic' ? anthropicChat(args) : openAiChat(args);
}

/** Cheap round-trip used by the "Test Connection" button. */
async function testConnection({ provider, apiKey, model, baseUrl }) {
  const started = Date.now();
  const r = await chat({
    provider, apiKey, model, baseUrl,
    system: 'You are a connectivity check. Reply with exactly: OK',
    user: 'Reply with exactly: OK',
    maxTokens: provider === 'anthropic' ? 1024 : 16,
    timeoutMs: 30000,
  });
  return { ok: true, model: r.model, ms: Date.now() - started, reply: (r.text || '').trim().slice(0, 40) };
}

/** Live model list, so the UI can offer real names instead of a stale array. */
async function listModels({ provider, apiKey, baseUrl }) {
  if (!PROVIDERS[provider]) throw new Error(`Unknown AI provider: ${provider}`);
  const root = resolveBaseUrl(provider, baseUrl);
  const url = provider === 'anthropic' ? `${root}/v1/models` : `${root}/models`;
  const headers = provider === 'anthropic'
    ? { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION }
    : { Authorization: `Bearer ${apiKey}` };

  const res = await withTimeout(20000, signal => fetch(url, { headers, signal }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = readError(res.status, data);
    const err = new Error(message);
    err.status = res.status; err.hint = hintFor(provider, res.status, message);
    throw err;
  }
  // Vendors list every model on the account, including ones that cannot hold a
  // chat conversation — speech-to-text, text-to-speech, safety classifiers,
  // embeddings. Offering those in a model picker just invites a confusing 400
  // at review time, so drop them.
  const NON_CHAT = /whisper|orpheus|prompt-guard|embed|tts|stt|moderation|rerank|guard/i;
  const ids = (data.data || [])
    .map(m => m.id)
    .filter(id => id && !NON_CHAT.test(id))
    .sort();
  return ids.length ? ids : PROVIDERS[provider].models;
}

module.exports = { chat, testConnection, listModels, providerList, PROVIDERS };
