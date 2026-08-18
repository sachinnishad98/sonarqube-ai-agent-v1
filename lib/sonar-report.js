/* ═══════════════════════════════════════════════════════════════════════════
   lib/sonar-report.js — renders a SonarQube analysis into HTML and XML.

   Input is the object fetchSonarReport() returns:
     { projectKey, metrics: {...}, issues: [ ...raw Sonar issues... ], totalIssues }

   HTML — every section is a real <table>, styled inline so it survives an email
   client, plus a small vanilla-JS layer (sort / search / severity filter) that
   activates only in a browser. Progressive enhancement on purpose: strip the
   script and the document is still a complete, readable report.

   XML — uniform <row> elements with attribute columns rather than nested prose.
   That shape imports straight into Excel or a database staging table; a reader
   that wants one section gets a rectangle, not a tree walk.
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const BRAND = {
  pink: '#E82276', pinkDark: '#b8195c',
  ink: '#111827', body: '#374151', muted: '#6b7280',
  line: '#e5e7eb', panel: '#f9fafb', zebra: '#fcfcfd'
};

const SEVERITY_ORDER = ['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'INFO'];
const SEVERITY_COLOR = {
  BLOCKER: '#7f1d1d', CRITICAL: '#dc2626', MAJOR: '#ea580c',
  MINOR: '#2563eb', INFO: '#6b7280'
};
// SonarQube returns letter ratings as the strings "1".."5".
const RATING_LETTER = { 1: 'A', 2: 'B', 3: 'C', 4: 'D', 5: 'E' };
const RATING_COLOR = { A: '#059669', B: '#65a30d', C: '#d97706', D: '#ea580c', E: '#dc2626' };

const METRIC_LABEL = {
  bugs: 'Bugs', vulnerabilities: 'Vulnerabilities', code_smells: 'Code Smells',
  security_hotspots: 'Security Hotspots', ncloc: 'Lines of Code',
  coverage: 'Coverage', duplicated_lines_density: 'Duplicated Lines',
  reliability_rating: 'Reliability Rating', security_rating: 'Security Rating',
  sqale_rating: 'Maintainability Rating'
};
const METRIC_UNIT = { coverage: '%', duplicated_lines_density: '%' };

/* ── helpers ─────────────────────────────────────────────────────────────── */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// XML 1.0 forbids most control characters outright — they cannot be escaped,
// only dropped, or the document fails to parse.
function xmlEsc(s) {
  return esc(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function rating(v) {
  const letter = RATING_LETTER[String(Math.round(Number(v) || 0))] || '—';
  return { letter, color: RATING_COLOR[letter] || BRAND.muted };
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Strips the "projectKey:" prefix Sonar puts on every component path. */
function fileOf(issue, projectKey) {
  const c = String(issue.component || '');
  return c.startsWith(`${projectKey}:`) ? c.slice(projectKey.length + 1) : c;
}

function sevRank(s) {
  const i = SEVERITY_ORDER.indexOf(String(s || '').toUpperCase());
  return i === -1 ? SEVERITY_ORDER.length : i;
}

function summarise(report) {
  const issues = Array.isArray(report.issues) ? report.issues : [];
  const bySeverity = {};
  const byType = {};
  const byFile = {};
  const byRule = {};

  for (const i of issues) {
    const sev = String(i.severity || 'INFO').toUpperCase();
    const type = String(i.type || 'CODE_SMELL').toUpperCase();
    const file = fileOf(i, report.projectKey) || '(project level)';
    const rule = String(i.rule || '(unknown)');

    bySeverity[sev] = (bySeverity[sev] || 0) + 1;
    byType[type] = (byType[type] || 0) + 1;
    byRule[rule] = (byRule[rule] || 0) + 1;

    if (!byFile[file]) byFile[file] = { total: 0 };
    byFile[file].total++;
    byFile[file][sev] = (byFile[file][sev] || 0) + 1;
  }
  return { issues, bySeverity, byType, byFile, byRule };
}

/* ── HTML building blocks ────────────────────────────────────────────────── */

const TH = `padding:10px 12px;text-align:left;font-size:10.5px;font-weight:700;color:${BRAND.muted};text-transform:uppercase;letter-spacing:.06em;background:${BRAND.panel};border-bottom:2px solid ${BRAND.line};white-space:nowrap`;
const TD = `padding:9px 12px;font-size:12.5px;color:${BRAND.body};border-bottom:1px solid ${BRAND.line};vertical-align:top`;
const MONO = `font-family:'SFMono-Regular',Consolas,'Liberation Mono',monospace`;

function sevChip(sev) {
  const s = String(sev || 'INFO').toUpperCase();
  return `<span style="display:inline-block;background:${SEVERITY_COLOR[s] || BRAND.muted};color:#fff;font-size:9.5px;font-weight:700;letter-spacing:.04em;padding:3px 8px;border-radius:4px;white-space:nowrap">${esc(s)}</span>`;
}

/** A section wrapper: heading, optional caption, then the table. */
function section(id, title, caption, inner) {
  return `<section id="${id}" style="margin:0 0 30px">
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px"><tr>
      <td style="border-left:4px solid ${BRAND.pink};padding-left:11px">
        <div style="font-size:15px;font-weight:700;color:${BRAND.ink};letter-spacing:-.01em">${esc(title)}</div>
        ${caption ? `<div style="font-size:11.5px;color:${BRAND.muted};margin-top:2px">${caption}</div>` : ''}
      </td>
    </tr></table>
    ${inner}
  </section>`;
}

/**
 * @param {string[]} headers  column labels; a leading '#' renders right-aligned
 * @param {string[][]} rows   pre-escaped cell HTML
 */
function table(headers, rows, opts = {}) {
  if (!rows.length) {
    return `<div style="padding:18px;border:1px dashed ${BRAND.line};border-radius:8px;text-align:center;color:${BRAND.muted};font-size:12.5px">Nothing to report here.</div>`;
  }
  const sortable = opts.sortable ? ' data-sortable="1"' : '';
  const head = headers.map((h, idx) =>
    `<th style="${TH}${opts.numeric?.includes(idx) ? ';text-align:right' : ''}"${sortable} data-col="${idx}">${esc(h)}${opts.sortable ? '<span style="opacity:.35;margin-left:5px;font-size:9px">&#9650;&#9660;</span>' : ''}</th>`
  ).join('');
  const body = rows.map((r, n) =>
    `<tr style="background:${n % 2 ? BRAND.zebra : '#fff'}"${opts.rowAttrs ? ' ' + opts.rowAttrs(r, n) : ''}>${
      r.map((c, idx) => `<td style="${TD}${opts.numeric?.includes(idx) ? `;text-align:right;font-weight:600;${MONO}` : ''}">${c}</td>`).join('')
    }</tr>`
  ).join('');
  // class="dt" marks this as a DATA table. The whole document is built out of
  // nested layout tables (masthead, stat tiles, section headings), so an
  // unscoped `tbody tr:hover` rule repaints those too — which is what made the
  // pink header wash out to near-white on hover.
  return `<table class="dt" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid ${BRAND.line};border-radius:8px;overflow:hidden"${opts.tableAttrs || ''}>
    <thead><tr>${head}</tr></thead><tbody${opts.bodyId ? ` id="${opts.bodyId}"` : ''}>${body}</tbody></table>`;
}

/** Big number tiles across the top — the only non-table element, by design. */
function statStrip(cells) {
  return `<table width="100%" cellpadding="0" cellspacing="8" style="margin:0 0 26px"><tr>${
    cells.map(c => `<td width="${Math.floor(100 / cells.length)}%" align="center" style="background:${BRAND.panel};border:1px solid ${BRAND.line};border-radius:10px;padding:16px 8px">
      <div style="font-size:27px;font-weight:800;color:${c.color};${MONO};line-height:1">${esc(c.value)}</div>
      <div style="font-size:10px;color:${BRAND.muted};font-weight:700;text-transform:uppercase;letter-spacing:.07em;margin-top:6px">${esc(c.label)}</div>
    </td>`).join('')
  }</tr></table>`;
}

/* ── HTML report ─────────────────────────────────────────────────────────── */

/**
 * @param {object} report  fetchSonarReport() output
 * @param {object} meta    { repoName, branch, sonarUrl, generatedAt, aiSummary }
 * @param {object} [opts]  { maxIssues = 500 }
 */
function generateSonarHtml(report, meta = {}, opts = {}) {
  const maxIssues = opts.maxIssues || 500;
  const { issues, bySeverity, byType, byFile, byRule } = summarise(report);
  const m = report.metrics || {};
  const generatedAt = meta.generatedAt ? new Date(meta.generatedAt) : new Date();
  const total = report.totalIssues || issues.length;
  const projectHref = meta.sonarUrl
    ? `${String(meta.sonarUrl).replace(/\/+$/, '')}/dashboard?id=${encodeURIComponent(report.projectKey)}`
    : null;

  /* — Overview table — */
  const overviewRows = [
    ['Project', `<span style="${MONO};font-size:11.5px">${esc(report.projectKey)}</span>`],
    ['Repository', esc(meta.repoName || '—')],
    ['Branch', `<strong>${esc(meta.branch || '—')}</strong>`],
    ['Generated', esc(generatedAt.toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'short' }))],
    ['Total issues', `<strong>${total}</strong>`],
    ['Issues in this report', String(Math.min(issues.length, maxIssues))],
    ['Files affected', String(Object.keys(byFile).length)],
    ['Distinct rules triggered', String(Object.keys(byRule).length)]
  ].map(([k, v]) => [`<strong style="color:${BRAND.ink}">${esc(k)}</strong>`, v]);

  /* — Ratings table — */
  const ratingRows = [
    ['Reliability', m.reliability_rating, 'Driven by the number and severity of bugs'],
    ['Security', m.security_rating, 'Driven by open vulnerabilities'],
    ['Maintainability', m.sqale_rating, 'Technical debt against the size of the codebase']
  ].map(([label, val, why]) => {
    const r = rating(val);
    return [
      `<strong style="color:${BRAND.ink}">${esc(label)}</strong>`,
      `<span style="display:inline-block;min-width:26px;text-align:center;background:${r.color};color:#fff;font-weight:800;font-size:13px;padding:3px 9px;border-radius:5px">${r.letter}</span>`,
      `<span style="color:${BRAND.muted};font-size:12px">${esc(why)}</span>`
    ];
  });

  /* — Metrics table — */
  const metricRows = Object.keys(METRIC_LABEL)
    .filter(k => m[k] !== undefined && !k.endsWith('_rating'))
    .map(k => [
      `<strong style="color:${BRAND.ink}">${esc(METRIC_LABEL[k])}</strong>`,
      `<span style="${MONO};font-size:11px;color:${BRAND.muted}">${esc(k)}</span>`,
      `${esc(num(m[k]))}${METRIC_UNIT[k] || ''}`
    ]);

  /* — Severity table with an inline proportion bar — */
  const sevRows = SEVERITY_ORDER.filter(s => bySeverity[s]).map(s => {
    const n = bySeverity[s];
    const pct = issues.length ? (n / issues.length) * 100 : 0;
    return [
      sevChip(s),
      String(n),
      `${pct.toFixed(1)}%`,
      `<table width="100%" cellpadding="0" cellspacing="0"><tr><td width="${Math.max(1, Math.round(pct))}%" style="background:${SEVERITY_COLOR[s]};height:12px;border-radius:3px;font-size:0">&nbsp;</td><td>&nbsp;</td></tr></table>`
    ];
  });

  /* — Type table — */
  const typeRows = Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([t, n]) => [
    `<strong style="color:${BRAND.ink}">${esc(t.replace(/_/g, ' '))}</strong>`,
    String(n),
    `${issues.length ? ((n / issues.length) * 100).toFixed(1) : '0.0'}%`
  ]);

  /* — Per-file table, split by severity — */
  const fileRows = Object.entries(byFile)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 40)
    .map(([f, c]) => [
      `<span style="${MONO};font-size:11.5px;color:${BRAND.ink}">${esc(f)}</span>`,
      String(c.total),
      String(c.BLOCKER || 0), String(c.CRITICAL || 0), String(c.MAJOR || 0),
      String(c.MINOR || 0), String(c.INFO || 0)
    ]);

  /* — Rule table — */
  const ruleRows = Object.entries(byRule).sort((a, b) => b[1] - a[1]).slice(0, 25)
    .map(([r, n]) => [`<span style="${MONO};font-size:11.5px">${esc(r)}</span>`, String(n)]);

  /* — The issue register — */
  const sorted = issues.slice().sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
  const shown = sorted.slice(0, maxIssues);
  const issueRows = shown.map((i, n) => {
    const sev = String(i.severity || 'INFO').toUpperCase();
    return [
      String(n + 1),
      sevChip(sev),
      esc(String(i.type || '').replace(/_/g, ' ')),
      `<span style="${MONO};font-size:11.5px;color:${BRAND.ink}">${esc(fileOf(i, report.projectKey))}</span>`,
      i.line == null ? '—' : String(i.line),
      esc(i.message),
      `<span style="${MONO};font-size:11px;color:${BRAND.muted}">${esc(i.rule)}</span>`,
      esc(i.effort || i.debt || '—')
    ];
  });

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SonarQube Report — ${esc(meta.repoName || report.projectKey)} (${esc(meta.branch || 'main')})</title>
<style>
  /* Only enhancements live here. Every layout rule is inline so that an email
     client stripping this block still renders the full report correctly. */
  body { margin:0; }
  .ctl { font:inherit; }
  /* Scoped to .dt — data tables only. Unscoped, this also repaints the layout
     tables the masthead and stat tiles are built from. */
  .dt tbody tr:hover { background:#fff7fb !important; }
  th[data-sortable] { cursor:pointer; user-select:none; }
  th[data-sortable]:hover { color:${BRAND.pink}; }
  #q { transition:width .18s ease, border-color .18s ease; }
  #q:focus { width:250px; border-color:${BRAND.pink}; }
  .chip { cursor:pointer; }
  .chip[aria-pressed="false"] { opacity:.35; }
  @media print {
    .noprint { display:none !important; }
    body { background:#fff !important; }
    .sheet { box-shadow:none !important; border:none !important; }
    section { break-inside:avoid; }
  }
  @media (max-width:720px) {
    .scroller { overflow-x:auto; -webkit-overflow-scrolling:touch; }
  }
</style>
</head>
<body style="margin:0;padding:24px 16px;background:#eef1f6;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.body};-webkit-font-smoothing:antialiased">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table class="sheet" width="100%" cellpadding="0" cellspacing="0" style="max-width:1080px;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 10px 40px rgba(16,24,40,.10)">

  <!-- ── Masthead ─────────────────────────────────────────────────────── -->
  <tr><td style="background:linear-gradient(135deg,${BRAND.pink} 0%,${BRAND.pinkDark} 100%);padding:30px 34px;color:#fff">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td>
        <div style="font-size:11px;font-weight:700;letter-spacing:.14em;opacity:.85">SONARQUBE AI AGENT &nbsp;·&nbsp; BUSINESSNEXT CDG</div>
        <div style="font-size:25px;font-weight:800;margin-top:7px;letter-spacing:-.02em">Code Quality Report</div>
        <div style="font-size:13.5px;margin-top:5px;opacity:.95">${esc(meta.repoName || report.projectKey)} &nbsp;·&nbsp; branch <strong>${esc(meta.branch || 'main')}</strong></div>
      </td>
      <td align="right" valign="top">
        <div style="background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.28);border-radius:9px;padding:11px 15px;text-align:center">
          <div style="font-size:26px;font-weight:800;${MONO};line-height:1">${total}</div>
          <div style="font-size:9.5px;letter-spacing:.09em;opacity:.9;margin-top:4px">TOTAL ISSUES</div>
        </div>
      </td>
    </tr></table>
  </td></tr>

  <tr><td style="padding:28px 34px 34px">

    ${statStrip([
      { label: 'Bugs', value: num(m.bugs), color: num(m.bugs) ? '#dc2626' : '#059669' },
      { label: 'Vulnerabilities', value: num(m.vulnerabilities), color: num(m.vulnerabilities) ? '#ea580c' : '#059669' },
      { label: 'Code Smells', value: num(m.code_smells), color: '#2563eb' },
      { label: 'Hotspots', value: num(m.security_hotspots), color: '#7c3aed' },
      { label: 'Lines', value: num(m.ncloc).toLocaleString('en-IN'), color: BRAND.ink },
      { label: 'Coverage', value: `${num(m.coverage)}%`, color: num(m.coverage) >= 60 ? '#059669' : '#d97706' }
    ])}

    ${meta.aiSummary ? `<table width="100%" cellpadding="0" cellspacing="0" style="background:#faf5ff;border:1px solid #e9d5ff;border-left:4px solid #7c3aed;border-radius:9px;margin:0 0 26px">
      <tr><td style="padding:16px 18px">
        <div style="font-size:10.5px;font-weight:700;color:#7c3aed;letter-spacing:.07em;margin-bottom:6px">AI SUMMARY</div>
        <div style="font-size:13px;line-height:1.68;color:#4c1d95">${esc(meta.aiSummary)}</div>
      </td></tr></table>` : ''}

    ${section('overview', 'Report Overview', 'Identity and scope of this analysis',
      table(['Field', 'Value'], overviewRows))}

    ${section('ratings', 'Quality Ratings', 'SonarQube grades each dimension from A (best) to E',
      table(['Dimension', 'Grade', 'What drives it'], ratingRows))}

    ${section('metrics', 'Measured Metrics', 'Raw values as reported by the SonarQube measures API',
      table(['Metric', 'API key', 'Value'], metricRows, { numeric: [2] }))}

    ${section('severity', 'Issues by Severity', `Distribution across the ${issues.length} issue(s) in this report`,
      table(['Severity', 'Count', 'Share', 'Proportion'], sevRows, { numeric: [1, 2] }))}

    ${section('types', 'Issues by Type', 'What kind of problem each finding represents',
      table(['Type', 'Count', 'Share'], typeRows, { numeric: [1, 2] }))}

    ${section('files', 'Issues by File', `Top ${Math.min(40, Object.keys(byFile).length)} files, worst first — click a column heading to re-sort`,
      `<div class="scroller">${table(['File', 'Total', 'Blocker', 'Critical', 'Major', 'Minor', 'Info'], fileRows,
        { numeric: [1, 2, 3, 4, 5, 6], sortable: true })}</div>`)}

    ${section('rules', 'Most Triggered Rules', 'Fixing a single rule often clears many findings at once',
      table(['Rule', 'Occurrences'], ruleRows, { numeric: [1], sortable: true }))}

    ${section('issues', 'Issue Register',
      `All ${shown.length} issue(s), highest severity first${sorted.length > shown.length ? ` — ${sorted.length - shown.length} more in the XML report` : ''}`,
      `<div class="noprint" style="margin-bottom:12px">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="white-space:nowrap">
            ${SEVERITY_ORDER.filter(s => bySeverity[s]).map(s =>
              `<button class="chip ctl" data-sev="${s}" aria-pressed="true" style="background:${SEVERITY_COLOR[s]};color:#fff;border:0;font-size:10px;font-weight:700;padding:6px 11px;border-radius:5px;margin-right:6px">${s} ${bySeverity[s]}</button>`).join('')}
          </td>
          <td align="right" style="white-space:nowrap">
            <span id="count" style="font-size:11px;color:${BRAND.muted};margin-right:10px"></span>
            <input id="q" class="ctl" type="search" placeholder="Search…" title="Filter by file, message or rule"
              style="width:150px;height:30px;padding:0 10px;border:1px solid ${BRAND.line};border-radius:7px;font-size:12px;outline:none;vertical-align:middle">
          </td>
        </tr></table>
      </div>
      <div class="scroller">${table(['#', 'Severity', 'Type', 'File', 'Line', 'Message', 'Rule', 'Effort'], issueRows,
        { numeric: [0, 4], sortable: true, bodyId: 'rows', tableAttrs: ' id="issueTable"' })}</div>`)}

    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid ${BRAND.line};margin-top:8px">
      <tr><td style="padding-top:16px;font-size:11px;color:${BRAND.muted};line-height:1.8">
        Generated by <strong style="color:${BRAND.ink}">SonarQube AI Agent</strong> on ${esc(generatedAt.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }))}.
        ${projectHref ? `<a href="${esc(projectHref)}" style="color:${BRAND.pink};font-weight:700;text-decoration:none">Open in SonarQube &rarr;</a>` : ''}
        <div style="margin-top:5px">This report contains issue metadata only — no source code was transmitted or stored.</div>
      </td></tr>
    </table>

  </td></tr>
</table>
</td></tr></table>

<script>
/* Enhancement layer. Absent (email, print-to-PDF) the tables above are already
   complete and sorted by severity — nothing here is required to read them. */
(function () {
  var q = document.getElementById('q');
  var rows = document.getElementById('rows');
  var count = document.getElementById('count');
  if (!rows) return;

  var all = Array.prototype.slice.call(rows.rows);
  var off = Object.create(null);   // severities the user has toggled off

  function apply() {
    var term = (q && q.value || '').toLowerCase();
    var shown = 0;
    all.forEach(function (tr) {
      var sev = (tr.cells[1].textContent || '').trim().toUpperCase();
      var hit = !term || tr.textContent.toLowerCase().indexOf(term) !== -1;
      var on = hit && !off[sev];
      tr.style.display = on ? '' : 'none';
      if (on) shown++;
    });
    // Re-stripe what is actually visible, or the zebra breaks up under a filter.
    var n = 0;
    all.forEach(function (tr) {
      if (tr.style.display !== 'none') { tr.style.background = (n++ % 2) ? '${BRAND.zebra}' : '#fff'; }
    });
    if (count) count.textContent = 'Showing ' + shown + ' of ' + all.length + ' issues';
  }

  if (q) q.addEventListener('input', apply);

  Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (b) {
    b.addEventListener('click', function () {
      var sev = b.getAttribute('data-sev');
      off[sev] = !off[sev];
      b.setAttribute('aria-pressed', off[sev] ? 'false' : 'true');
      apply();
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('th[data-sortable]'), function (th) {
    th.addEventListener('click', function () {
      var table = th.closest('table');
      var body = table.tBodies[0];
      var col = +th.getAttribute('data-col');
      var dir = th.getAttribute('data-dir') === 'asc' ? -1 : 1;
      th.setAttribute('data-dir', dir === 1 ? 'asc' : 'desc');

      var trs = Array.prototype.slice.call(body.rows);
      trs.sort(function (a, b) {
        var x = a.cells[col].textContent.trim();
        var y = b.cells[col].textContent.trim();
        var nx = parseFloat(x), ny = parseFloat(y);
        // Numeric when both sides are numbers, lexical otherwise.
        if (!isNaN(nx) && !isNaN(ny)) return (nx - ny) * dir;
        return x.localeCompare(y) * dir;
      });
      trs.forEach(function (tr) { body.appendChild(tr); });
      if (body === rows) { all = Array.prototype.slice.call(rows.rows); apply(); }
      else {
        Array.prototype.forEach.call(body.rows, function (tr, i) {
          tr.style.background = (i % 2) ? '${BRAND.zebra}' : '#fff';
        });
      }
    });
  });

  apply();
})();
</script>
</body></html>`;
}

/* ── XML report ──────────────────────────────────────────────────────────── */

/** Serialises an attribute map, skipping empty values to keep rows readable. */
function attrs(map) {
  return Object.entries(map)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}="${xmlEsc(v)}"`)
    .join(' ');
}

/**
 * Tabular XML: every section is a list of uniform <row> elements whose
 * attributes are the columns. Opens directly as a table in Excel and maps
 * cleanly onto a staging table in SQL, which nested prose-shaped XML does not.
 */
function generateSonarXml(report, meta = {}) {
  const { issues, bySeverity, byType, byFile, byRule } = summarise(report);
  const m = report.metrics || {};
  const generatedAt = meta.generatedAt ? new Date(meta.generatedAt) : new Date();
  const total = report.totalIssues || issues.length;

  const overview = [
    ['project', report.projectKey], ['repository', meta.repoName || ''],
    ['branch', meta.branch || ''], ['serverUrl', meta.sonarUrl || ''],
    ['generatedAt', generatedAt.toISOString()],
    ['totalIssues', total], ['reportedIssues', issues.length],
    ['filesAffected', Object.keys(byFile).length],
    ['rulesTriggered', Object.keys(byRule).length]
  ].map(([field, value]) => `      <row ${attrs({ field, value })}/>`).join('\n');

  const ratings = [
    ['reliability', m.reliability_rating], ['security', m.security_rating],
    ['maintainability', m.sqale_rating]
  ].map(([dimension, raw]) =>
    `      <row ${attrs({ dimension, grade: rating(raw).letter, raw: raw ?? '' })}/>`).join('\n');

  const metrics = Object.keys(m).sort().map(key =>
    `      <row ${attrs({ key, label: METRIC_LABEL[key] || key, value: m[key], unit: METRIC_UNIT[key] || '' })}/>`).join('\n');

  const severities = SEVERITY_ORDER.filter(s => bySeverity[s]).map(severity =>
    `      <row ${attrs({
      severity, count: bySeverity[severity],
      percentage: issues.length ? ((bySeverity[severity] / issues.length) * 100).toFixed(2) : '0.00'
    })}/>`).join('\n');

  const types = Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([type, count]) =>
    `      <row ${attrs({
      type, count,
      percentage: issues.length ? ((count / issues.length) * 100).toFixed(2) : '0.00'
    })}/>`).join('\n');

  const files = Object.entries(byFile).sort((a, b) => b[1].total - a[1].total).map(([file, c]) =>
    `      <row ${attrs({
      file, total: c.total,
      blocker: c.BLOCKER || 0, critical: c.CRITICAL || 0, major: c.MAJOR || 0,
      minor: c.MINOR || 0, info: c.INFO || 0
    })}/>`).join('\n');

  const rules = Object.entries(byRule).sort((a, b) => b[1] - a[1]).map(([rule, count]) =>
    `      <row ${attrs({ rule, count })}/>`).join('\n');

  const register = issues.slice()
    .sort((a, b) => sevRank(a.severity) - sevRank(b.severity))
    .map((i, n) => `      <row ${attrs({
      index: n + 1,
      key: i.key,
      severity: String(i.severity || '').toUpperCase(),
      type: String(i.type || '').toUpperCase(),
      rule: i.rule,
      file: fileOf(i, report.projectKey),
      line: i.line ?? '',
      status: i.status,
      effort: i.effort || i.debt || '',
      author: i.author || '',
      createdAt: i.creationDate || '',
      message: i.message
    })}/>`).join('\n');

  const empty = '      <!-- no rows -->';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!--
  SonarQube Code Quality Report — tabular format.
  Every <table> below holds uniform <row> elements whose attributes are the
  columns, so each section can be read as a flat rectangle (Excel: Data >
  From XML; SQL: load straight into a staging table).
-->
<sonarQubeReport generator="SonarQube AI Agent" version="2" generatedAt="${xmlEsc(generatedAt.toISOString())}">

  <table name="overview" columns="field,value" rows="9">
${overview || empty}
  </table>

  <table name="ratings" columns="dimension,grade,raw" rows="3">
${ratings || empty}
  </table>

  <table name="metrics" columns="key,label,value,unit" rows="${Object.keys(m).length}">
${metrics || empty}
  </table>

  <table name="severitySummary" columns="severity,count,percentage" rows="${Object.keys(bySeverity).length}">
${severities || empty}
  </table>

  <table name="typeSummary" columns="type,count,percentage" rows="${Object.keys(byType).length}">
${types || empty}
  </table>

  <table name="fileSummary" columns="file,total,blocker,critical,major,minor,info" rows="${Object.keys(byFile).length}">
${files || empty}
  </table>

  <table name="ruleSummary" columns="rule,count" rows="${Object.keys(byRule).length}">
${rules || empty}
  </table>
${meta.aiSummary ? `
  <table name="aiSummary" columns="text" rows="1">
      <row ${attrs({ text: meta.aiSummary })}/>
  </table>
` : ''}
  <table name="issues" columns="index,key,severity,type,rule,file,line,status,effort,author,createdAt,message" rows="${issues.length}">
${register || empty}
  </table>

</sonarQubeReport>
`;
}

module.exports = { generateSonarHtml, generateSonarXml, summarise, esc, xmlEsc };
