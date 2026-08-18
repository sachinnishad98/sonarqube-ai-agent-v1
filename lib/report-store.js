/* ═══════════════════════════════════════════════════════════════════════════
   lib/report-store.js — persists generated reports to PostgreSQL.

   Writes into its own `sonarai_reports` table inside the same database
   SonarQube uses. It never touches SonarQube's own tables — those are managed
   by SonarQube's migrations and writing to them would break on upgrade.

   Everything here degrades gracefully: if SONARQUBE_DB_HOST is unset or the
   server is unreachable, `enabled` is false and every call is a no-op. A scan
   must still succeed when the database is down.
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const DDL = `
CREATE TABLE IF NOT EXISTS sonarai_reports (
  id            BIGSERIAL PRIMARY KEY,
  project_key   TEXT        NOT NULL,
  repo_name     TEXT,
  branch        TEXT,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  total_issues  INTEGER,
  metrics       JSONB,
  ai_summary    TEXT,
  ai_provider   TEXT,
  html          TEXT,
  xml           TEXT
);
CREATE INDEX IF NOT EXISTS sonarai_reports_project_idx
  ON sonarai_reports (project_key, generated_at DESC);
CREATE INDEX IF NOT EXISTS sonarai_reports_generated_idx
  ON sonarai_reports (generated_at DESC);
`;

let Pool = null;
try { ({ Pool } = require('pg')); } catch (_) { /* pg not installed */ }

class ReportStore {
  constructor(env = process.env) {
    this.host = env.SONARQUBE_DB_HOST || '';
    this.enabled = Boolean(Pool && this.host);
    this.ready = false;
    this.lastError = null;
    this.pool = null;

    if (!this.enabled) return;
    this.pool = new Pool({
      host: this.host,
      port: Number(env.SONARQUBE_DB_PORT) || 5432,
      database: env.SONARQUBE_DB_NAME || 'sonarqube',
      user: env.SONARQUBE_DB_USER || 'postgres',
      password: env.SONARQUBE_DB_PASSWORD || '',
      max: 4,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 8000,
    });
    // An idle client erroring (server restart, network blip) emits on the pool.
    // Without this listener node treats it as an unhandled error and exits.
    this.pool.on('error', err => { this.lastError = err.message; });
  }

  /** Creates the table if needed. Safe to call repeatedly. */
  async init() {
    if (!this.enabled) return false;
    try {
      await this.pool.query(DDL);
      this.ready = true;
      this.lastError = null;
      return true;
    } catch (e) {
      this.ready = false;
      this.lastError = e.message;
      return false;
    }
  }

  /**
   * @returns {Promise<{id:number, generatedAt:string}|null>} null when storage
   *          is disabled or the write failed — callers treat that as non-fatal.
   */
  async save({ projectKey, repoName, branch, totalIssues, metrics, aiSummary, aiProvider, html, xml }) {
    if (!this.enabled) return null;
    if (!this.ready && !(await this.init())) return null;
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO sonarai_reports
           (project_key, repo_name, branch, total_issues, metrics, ai_summary, ai_provider, html, xml)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, generated_at`,
        [projectKey, repoName || null, branch || null,
         Number.isFinite(Number(totalIssues)) ? Number(totalIssues) : null,
         metrics ? JSON.stringify(metrics) : null,
         aiSummary || null, aiProvider || null, html || null, xml || null]);
      this.lastError = null;
      return { id: Number(rows[0].id), generatedAt: rows[0].generated_at };
    } catch (e) {
      this.lastError = e.message;
      return null;
    }
  }

  /** Report metadata, newest first — deliberately excludes the html/xml bodies. */
  async list({ limit = 50, projectKey = null } = {}) {
    if (!this.enabled) return [];
    if (!this.ready && !(await this.init())) return [];
    try {
      const params = [];
      let where = '';
      if (projectKey) { params.push(projectKey); where = 'WHERE project_key = $1'; }
      params.push(Math.min(Number(limit) || 50, 200));
      const { rows } = await this.pool.query(
        `SELECT id, project_key, repo_name, branch, generated_at, total_issues,
                metrics, ai_provider, left(ai_summary, 300) AS ai_summary,
                (html IS NOT NULL) AS has_html, (xml IS NOT NULL) AS has_xml,
                length(html) AS html_bytes, length(xml) AS xml_bytes
         FROM sonarai_reports ${where}
         ORDER BY generated_at DESC LIMIT $${params.length}`, params);
      return rows;
    } catch (e) {
      this.lastError = e.message;
      return [];
    }
  }

  /** @param {'html'|'xml'} format */
  async body(id, format) {
    if (!this.enabled) return null;
    if (format !== 'html' && format !== 'xml') return null;
    if (!this.ready && !(await this.init())) return null;
    try {
      const { rows } = await this.pool.query(
        `SELECT ${format} AS body, repo_name, branch, generated_at
         FROM sonarai_reports WHERE id = $1`, [id]);
      return rows[0] && rows[0].body ? rows[0] : null;
    } catch (e) {
      this.lastError = e.message;
      return null;
    }
  }

  async status() {
    const base = { enabled: this.enabled, host: this.host || null, ready: this.ready, error: this.lastError };
    if (!this.enabled) return { ...base, reason: Pool ? 'SONARQUBE_DB_HOST not set in .env' : 'pg package not installed' };
    try {
      const { rows } = await this.pool.query(
        `SELECT count(*)::int n, max(generated_at) latest FROM sonarai_reports`);
      return { ...base, ready: true, reportCount: rows[0].n, latest: rows[0].latest };
    } catch (e) {
      return { ...base, ready: false, error: e.message };
    }
  }

  async close() { if (this.pool) await this.pool.end().catch(() => {}); }
}

module.exports = { ReportStore, DDL };
