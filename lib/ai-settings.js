/* ═══════════════════════════════════════════════════════════════════════════
   lib/ai-settings.js — UI-managed AI provider configuration.

   Keys are entered in the dashboard, never in .env. They are stored in
   data/ai-settings.json encrypted with AES-256-GCM, keyed off the same
   per-install secret the session cookies use, and are never sent back to the
   browser — the UI only ever sees a masked preview like "sk-ant-…f3a2".

   This is obfuscation-at-rest with a local key, not a secrets manager: anyone
   who can read data/ can read both the ciphertext and the key. It stops a
   stray screenshot, log line, or API response from leaking a key; it does not
   defend against someone who already has the filesystem.
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PROVIDERS } = require('./ai-providers');

const ALGO = 'aes-256-gcm';

const DEFAULTS = {
  provider: 'anthropic',
  model: PROVIDERS.anthropic.defaultModel,
  baseUrl: '',
  maxTokens: 8000,
  keys: {},          // provider -> { cipher, iv, tag } | legacy plaintext string
  updatedAt: null,
  updatedBy: null,
};

class AiSettings {
  /**
   * @param {string} dataDir  where ai-settings.json lives
   * @param {() => string} getSecret  returns the install secret used to derive
   *        the encryption key. Read lazily — on first boot the auth store
   *        generates its secret after this object is constructed.
   */
  constructor(dataDir, getSecret) {
    this.file = path.join(dataDir, 'ai-settings.json');
    this.dataDir = dataDir;
    this.getSecret = getSecret;
    this.state = this._load();
  }

  _key() {
    const secret = String(this.getSecret() || '');
    if (!secret) throw new Error('Install secret unavailable — cannot encrypt AI credentials.');
    return crypto.createHash('sha256').update(`ai-settings:${secret}`).digest();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { ...DEFAULTS, ...raw, keys: raw.keys || {} };
    } catch (_) {
      return { ...DEFAULTS, keys: {} };
    }
  }

  _persist() {
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2), { mode: 0o600 });
  }

  _encrypt(plain) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv(ALGO, this._key(), iv);
    const cipher = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return { cipher: cipher.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64') };
  }

  _decrypt(rec) {
    if (!rec) return '';
    if (typeof rec === 'string') return rec;   // tolerate a hand-edited plaintext key
    try {
      const d = crypto.createDecipheriv(ALGO, this._key(), Buffer.from(rec.iv, 'base64'));
      d.setAuthTag(Buffer.from(rec.tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(rec.cipher, 'base64')), d.final()]).toString('utf8');
    } catch (_) {
      // Wrong key (data/users.json was regenerated) or tampered file.
      return '';
    }
  }

  /** Last 4 characters only — enough to tell two keys apart, useless if leaked. */
  static mask(key) {
    if (!key) return '';
    return key.length <= 8 ? '••••' : `${key.slice(0, 6)}…${key.slice(-4)}`;
  }

  /** The plaintext key for a provider. Server-side only — never serialise this. */
  keyFor(provider) {
    return this._decrypt(this.state.keys[provider]);
  }

  /** Everything the review flow needs to make a call. */
  active() {
    const provider = this.state.provider;
    return {
      provider,
      model: this.state.model || PROVIDERS[provider]?.defaultModel || '',
      baseUrl: this.state.baseUrl || '',
      maxTokens: Number(this.state.maxTokens) || 8000,
      apiKey: this.keyFor(provider),
    };
  }

  /** Safe to send to the browser — contains no key material. */
  publicView() {
    const configured = {};
    for (const id of Object.keys(PROVIDERS)) {
      const k = this.keyFor(id);
      configured[id] = { hasKey: Boolean(k), preview: AiSettings.mask(k) };
    }
    return {
      provider: this.state.provider,
      model: this.state.model,
      baseUrl: this.state.baseUrl,
      maxTokens: Number(this.state.maxTokens) || 8000,
      updatedAt: this.state.updatedAt,
      updatedBy: this.state.updatedBy,
      configured,
      providers: require('./ai-providers').providerList(),
    };
  }

  /**
   * Partial update. An omitted or blank apiKey keeps the stored one, so the UI
   * can save a model change without the user re-typing their key.
   * @returns {{provider:string, model:string}}
   */
  update({ provider, model, baseUrl, apiKey, maxTokens, clearKey }, actor = null) {
    if (provider !== undefined) {
      if (!PROVIDERS[provider]) throw new Error(`Unknown AI provider: ${provider}`);
      this.state.provider = provider;
    }
    const target = this.state.provider;

    if (model !== undefined) this.state.model = String(model || '').trim();
    if (baseUrl !== undefined) this.state.baseUrl = String(baseUrl || '').trim();
    if (maxTokens !== undefined) {
      const n = Number(maxTokens);
      if (Number.isFinite(n) && n >= 256 && n <= 64000) this.state.maxTokens = Math.round(n);
    }

    if (clearKey) {
      delete this.state.keys[target];
    } else if (apiKey !== undefined && String(apiKey).trim()) {
      this.state.keys[target] = this._encrypt(String(apiKey).trim());
    }

    if (!this.state.model) this.state.model = PROVIDERS[target]?.defaultModel || '';
    if (target === 'custom' && !this.state.baseUrl) {
      throw new Error('A custom provider needs a base URL (for example https://host/v1).');
    }

    this.state.updatedAt = new Date().toISOString();
    this.state.updatedBy = actor || null;
    this._persist();
    return { provider: this.state.provider, model: this.state.model };
  }

  /**
   * One-time import of a key from .env so an existing install keeps working
   * without the user re-entering anything. Never overwrites a UI-set key.
   */
  seedFromEnv(env = process.env) {
    if (this.state.keys.anthropic || !env.ANTHROPIC_API_KEY) return false;
    try {
      this.state.keys.anthropic = this._encrypt(env.ANTHROPIC_API_KEY);
      if (!this.state.model) this.state.model = env.AI_MODEL || PROVIDERS.anthropic.defaultModel;
      this.state.updatedAt = new Date().toISOString();
      this.state.updatedBy = 'env-import';
      this._persist();
      return true;
    } catch (_) {
      return false;
    }
  }
}

module.exports = { AiSettings };
