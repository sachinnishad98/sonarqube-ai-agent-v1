#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   db-check.js — prove that a scan really landed in the SonarQube database.

   Reads SONARQUBE_DB_* from .env. Nothing here touches the agent at runtime;
   it is a standalone verification tool.

     node db-check.js                    # summary report (default)
     node db-check.js projects           # just the project list
     node db-check.js runs               # every analysis run, newest first
     node db-check.js issues             # issue counts by severity + type
     node db-check.js metrics            # ncloc / bugs / code smells etc.
     node db-check.js tables             # table count — proves the schema is here
     node db-check.js reports            # generated reports stored by the agent
     node db-check.js save 18            # pull report #18 out of the DB to a file
     node db-check.js save 18 xml        # ...as XML instead of HTML
     node db-check.js sql "SELECT ..."   # run your own read-only query

   Schema notes for SonarQube 26.x, which trips people up:
     - snapshots.root_component_uuid points at a PROJECT BRANCH, not a project,
       so joins go snapshots -> project_branches -> projects.
     - `live_measures` no longer exists. Metrics live in `measures.json_value`
       as one JSON blob per component; the project-level row is the one whose
       component_uuid equals the branch uuid.
     - snapshots.status: 'P' = processed, 'U' = unprocessed.
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

// Resolve .env against this file, not the working directory — the tool is
// meant to be runnable from anywhere (`node D:\...\db-check.js save 18`), and
// a cwd-relative lookup silently falls back to localhost instead.
require('dotenv').config({ override: true, path: require('path').join(__dirname, '.env') });
const { Client } = require('pg');

const CFG = {
  host:     process.env.SONARQUBE_DB_HOST     || '127.0.0.1',
  port:     Number(process.env.SONARQUBE_DB_PORT || 5432),
  database: process.env.SONARQUBE_DB_NAME     || 'sonarqube',
  user:     process.env.SONARQUBE_DB_USER     || 'postgres',
  password: process.env.SONARQUBE_DB_PASSWORD || '',
  connectionTimeoutMillis: 10000,
};

const ts = ms => (ms == null ? '—' : new Date(Number(ms)).toLocaleString());
const line = t => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`);

async function projects(c) {
  line('PROJECTS');
  const { rows } = await c.query(
    `select kee, name, created_at from projects order by created_at desc nulls last limit 20`);
  if (!rows.length) return console.log('  (none — no scan has been stored yet)');
  rows.forEach(r => {
    console.log(`  ${r.name}`);
    console.log(`     key     : ${r.kee}`);
    console.log(`     created : ${ts(r.created_at)}`);
  });
}

async function runs(c) {
  line('ANALYSIS RUNS  (one row per scan)');
  const { rows } = await c.query(
    `select p.name, b.kee as branch, s.status, s.islast, s.analysis_date, s.version
     from snapshots s
     join project_branches b on b.uuid = s.root_component_uuid
     join projects p         on p.uuid = b.project_uuid
     order by s.analysis_date desc limit 20`);
  if (!rows.length) return console.log('  (none)');
  rows.forEach(r => console.log(
    `  ${ts(r.analysis_date)}  |  ${r.name} [${r.branch}]  |  status=${r.status}${r.islast ? '  (latest)' : ''}`));
}

async function issues(c) {
  line('ISSUES');
  const total = await c.query(`select count(*)::int n from issues`);
  console.log(`  total rows stored : ${total.rows[0].n}`);
  const sev = await c.query(
    `select severity, count(*)::int n from issues where status <> 'CLOSED'
     group by severity order by n desc`);
  if (sev.rows.length) {
    console.log('  open by severity  :');
    sev.rows.forEach(r => console.log(`     ${String(r.severity).padEnd(10)} ${r.n}`));
  }
  const typ = await c.query(
    `select issue_type, count(*)::int n from issues where status <> 'CLOSED'
     group by issue_type order by n desc`).catch(() => null);
  if (typ && typ.rows.length) {
    const NAME = { 1: 'CODE_SMELL', 2: 'BUG', 3: 'VULNERABILITY', 4: 'SECURITY_HOTSPOT' };
    console.log('  open by type      :');
    typ.rows.forEach(r => console.log(`     ${(NAME[r.issue_type] || r.issue_type).padEnd(18)} ${r.n}`));
  }
}

async function metrics(c) {
  line('HEADLINE METRICS  (measures.json_value, project level)');
  const { rows } = await c.query(
    `select p.name, m.json_value::json as v
     from measures m
     join project_branches b on b.uuid = m.branch_uuid
     join projects p         on p.uuid = b.project_uuid
     where m.component_uuid = b.uuid
     order by m.updated_at desc limit 5`);
  if (!rows.length) return console.log('  (no project-level measures yet)');
  const KEYS = ['ncloc', 'files', 'functions', 'bugs', 'vulnerabilities', 'code_smells',
                'security_hotspots', 'duplicated_lines_density', 'coverage', 'sqale_index'];
  rows.forEach(r => {
    console.log(`  ${r.name}`);
    const v = r.v || {};
    KEYS.filter(k => v[k] !== undefined).forEach(k => console.log(`     ${k.padEnd(26)} ${v[k]}`));
  });
}

async function reports(c) {
  line('STORED REPORTS  (sonarai_reports)');
  const { rows } = await c.query(
    `select id, repo_name, branch, generated_at, total_issues, ai_provider,
            length(html) html_len, length(xml) xml_len
     from sonarai_reports order by id desc limit 20`);
  if (!rows.length) return console.log('  (none stored yet)');
  const kb = n => (n ? `${Math.round(n / 1024)} kB` : '—');
  rows.forEach(r => {
    console.log(`  #${String(r.id).padEnd(4)} ${r.repo_name || '—'} [${r.branch || '—'}]`);
    console.log(`        ${new Date(r.generated_at).toLocaleString()}  ·  ${r.total_issues ?? '?'} issues  ·  ${r.ai_provider || 'no AI'}`);
    console.log(`        html ${kb(r.html_len)}   xml ${kb(r.xml_len)}   →  node db-check.js save ${r.id}`);
  });
}

/**
 * Writes one report body to a file. A 550 kB text column is unreadable in a
 * SQL client, so this is the practical way to actually look at one.
 */
async function save(c, id, format) {
  const fmt = (format || 'html').toLowerCase();
  if (fmt !== 'html' && fmt !== 'xml') {
    console.error('\nFormat must be html or xml.\n'); process.exit(1);
  }
  if (!/^\d+$/.test(String(id || ''))) {
    console.error('\nUsage: node db-check.js save <id> [html|xml]\n'); process.exit(1);
  }
  const { rows } = await c.query(
    `select ${fmt} as body, repo_name, branch from sonarai_reports where id = $1`, [id]);
  if (!rows.length) { console.error(`\nNo report with id ${id}.\n`); process.exit(1); }
  if (!rows[0].body) { console.error(`\nReport ${id} has no ${fmt} body.\n`); process.exit(1); }

  const safe = String(rows[0].branch || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
  const file = require('path').resolve(`SonarQubeReport-${safe}-${id}.${fmt}`);
  require('fs').writeFileSync(file, rows[0].body, 'utf8');
  line('SAVED');
  console.log(`  ${file}`);
  console.log(`  ${Math.round(rows[0].body.length / 1024)} kB — open it in a browser`);
}

async function tables(c) {
  line('SCHEMA');
  const { rows } = await c.query(
    `select count(*)::int n from information_schema.tables where table_schema='public'`);
  console.log(`  public tables: ${rows[0].n}   (a populated SonarQube schema is ~125)`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const c = new Client(CFG);
  try {
    await c.connect();
  } catch (e) {
    console.error(`\nCannot reach ${CFG.host}:${CFG.port} — ${e.message}`);
    console.error('Check the SONARQUBE_DB_* values in .env, and that the server is reachable.\n');
    process.exit(1);
  }

  const who = await c.query('select version(), current_database() db, current_user usr');
  console.log(`\nConnected to ${CFG.host}:${CFG.port}/${who.rows[0].db} as ${who.rows[0].usr}`);
  console.log(who.rows[0].version.split(',')[0]);

  try {
    switch (cmd) {
      case undefined:
      case 'all':      await tables(c); await projects(c); await runs(c); await issues(c); await metrics(c); break;
      case 'projects': await projects(c); break;
      case 'runs':     await runs(c);     break;
      case 'issues':   await issues(c);   break;
      case 'metrics':  await metrics(c);  break;
      case 'tables':   await tables(c);   break;
      case 'reports':  await reports(c);  break;
      case 'save':     await save(c, arg, process.argv[4]); break;
      case 'sql': {
        if (!arg) { console.error('\nUsage: node db-check.js sql "SELECT ..."'); process.exit(1); }
        if (!/^\s*(select|with)\b/i.test(arg)) {
          console.error('\nRefusing to run: only SELECT / WITH queries are allowed here.');
          console.error('This tool is for verification — use a real client for anything that writes.\n');
          process.exit(1);
        }
        line('QUERY RESULT');
        const r = await c.query(arg);
        console.table(r.rows);
        console.log(`  ${r.rowCount} row(s)`);
        break;
      }
      default:
        console.error(`\nUnknown command: ${cmd}`);
        console.error('Try: projects | runs | issues | metrics | tables | reports | save <id> [html|xml] | sql "SELECT ..."');
        process.exit(1);
    }
    console.log('\nEverything above was read directly from the database server — not from any local file.\n');
  } finally {
    await c.end();
  }
}

main().catch(e => { console.error('\nFAILED:', e.message, '\n'); process.exit(1); });
