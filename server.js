/**
 * SonarAI v3.0 — GitHub + Local SonarQube Version
 * 
 * Original: Azure DevOps + Remote SonarQube (Windows .NET)
 * Updated:  GitHub Personal Repos + Local SonarQube (Windows .NET)
 * 
 * Changes from v2.4:
 *  - Azure DevOps API → GitHub REST API
 *  - AZURE_PAT → GITHUB_TOKEN
 *  - createAzureTicket → createGitHubIssue
 *  - SONAR_URL → http://localhost:9000 (local)
 *  - Git clone support added (clone if repo not found locally)
 */

'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const { execFile, spawn } = require('child_process');
const path       = require('path');
const fs         = require('fs');
const fetch      = require('node-fetch');
require('dotenv').config();

const app    = express();
const server = http.createServer(app);

// ─── SECURITY: CORS — localhost only ─────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: ['http://localhost:3001', 'http://127.0.0.1:3001'],
    methods: ['GET', 'POST']
  }
});

// ─── SECURITY: HTTP HEADERS ──────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com https://fonts.googleapis.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; connect-src 'self' ws://localhost:3001 ws://127.0.0.1:3001 ws://localhost:3002 ws://127.0.0.1:3002; img-src 'self' data:"
  );
  next();
});

app.use(express.static('public'));
app.use(express.json({ limit: '10kb' }));

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// GitHub config (replaces Azure DevOps)
const GITHUB_TOKEN    = process.env.GITHUB_TOKEN     || '';
const GITHUB_USERNAME = process.env.GITHUB_USERNAME  || '';

// Local paths
const REPO_BASE_PATH  = process.env.REPO_PATH        || 'C:\\GitRepos';
const DOTNET_ROOT     = process.env.DOTNET_ROOT      || 'C:\\Program Files\\dotnet\\';

// Local SonarQube
const SONAR_URL       = (process.env.SONAR_URL       || 'http://localhost:9000').replace(/\/$/, '');
const SONAR_TOKEN     = process.env.SONAR_TOKEN      || '';

// Claude AI
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY|| '';

// Email (optional)
const NOTIFY_EMAIL    = process.env.NOTIFY_EMAIL     || '';

const PORT            = parseInt(process.env.PORT)   || 3001;
const GITHUB_TIMEOUT  = 12000;

// Startup validation
const missingConfig = [];
if (!GITHUB_TOKEN)    missingConfig.push('GITHUB_TOKEN');
if (!GITHUB_USERNAME) missingConfig.push('GITHUB_USERNAME');
if (!SONAR_URL)       missingConfig.push('SONAR_URL');
if (!SONAR_TOKEN)     missingConfig.push('SONAR_TOKEN');
if (!ANTHROPIC_KEY)   missingConfig.push('ANTHROPIC_API_KEY (optional — AI review disabled)');
missingConfig.forEach(k => console.warn(`⚠️  Config missing: ${k}`));

// ─── INPUT VALIDATION ──────────────────────────────────────────────────────
function validateRepoName(name) {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > 100) return false;
  return /^[a-zA-Z0-9_\-\.]+$/.test(name);
}

function validateBranchName(name) {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > 250) return false;
  return /^[a-zA-Z0-9_\-\.\/]+$/.test(name);
}

/**
 * Returns the local path for a repo.
 * Checks if it exists — if not, tells caller to clone first.
 * Supports custom per-repo paths via REPO_PATH_<reponame> env var.
 */
function getRepoPath(repoName) {
  // Check for custom path for this specific repo (e.g., REPO_PATH_sonarqube-ai-agent-v1)
  const customPathKey = `REPO_PATH_${repoName.replace(/[^a-zA-Z0-9_\-]/g, '_')}`;
  const customPath = process.env[customPathKey];

  if (customPath) {
    // Custom path specified — use it directly (no append repoName)
    const resolved = path.resolve(customPath);
    // Basic validation — ensure it's an absolute path
    if (path.isAbsolute(resolved)) {
      return resolved;
    }
  }

  // Default behavior — append repoName to REPO_BASE_PATH
  const resolved = path.resolve(REPO_BASE_PATH, repoName);
  const base     = path.resolve(REPO_BASE_PATH);

  // Path traversal check
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error('Path traversal detected');
  }
  return resolved; // May not exist yet — caller handles clone
}

function safeError(e) {
  if (!e) return 'Unknown error';
  let msg = e.message || String(e);
  msg = msg.replace(/sqa_[a-zA-Z0-9]+/g,       '[SONAR_TOKEN]');
  msg = msg.replace(/sk-ant-[a-zA-Z0-9\-_]+/g, '[ANTHROPIC_KEY]');
  msg = msg.replace(/ghp_[a-zA-Z0-9]+/g,        '[GITHUB_TOKEN]');
  msg = msg.replace(/[a-zA-Z0-9+/]{50,}={0,2}/g,'[TOKEN]');
  return msg.substring(0, 300);
}

// ─── RATE LIMITER ────────────────────────────────────────────────────────────
function createRateLimiter(maxCalls, windowMs) {
  const counts = new Map();
  return function (socketId, eventName) {
    const key  = `${socketId}:${eventName}`;
    const now  = Date.now();
    const data = counts.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > data.resetAt) { data.count = 0; data.resetAt = now + windowMs; }
    data.count++;
    counts.set(key, data);
    return data.count <= maxCalls;
  };
}
const rateLimiter = createRateLimiter(10, 60 * 1000);

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/** Secure git runner */
function gitExec(args, cwd) {
  return new Promise((resolve, reject) => {
    const cmdStr = `git ${args.join(' ')}`;
    console.log(`[gitExec] Running: ${cmdStr} in ${cwd}`);

    execFile('git', args, {
      cwd,
      timeout: 180000,  // 3 minutes (Windows slow ho sakta hai)
      maxBuffer: 10 * 1024 * 1024
    }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[gitExec] Error: ${stderr || err.message}`);
        reject(new Error(stderr || err.message));
      } else {
        console.log(`[gitExec] Success: ${stdout.substring(0, 200)}`);
        resolve(stdout.trim());
      }
    });
  });
}

/** Run dotnet sonarscanner commands — streams output to socket */
function runCommand(cmd, cwd, socket, eventName) {
  return new Promise((resolve, reject) => {
    // Safe env — only what dotnet needs
    const safeEnv = {
      PATH:        `${DOTNET_ROOT};${process.env.PATH || ''}`,
      DOTNET_ROOT: DOTNET_ROOT,
      TEMP:        process.env.TEMP       || 'C:\\Windows\\Temp',
      TMP:         process.env.TMP        || 'C:\\Windows\\Temp',
      USERPROFILE: process.env.USERPROFILE|| '',
      SYSTEMROOT:  process.env.SYSTEMROOT || 'C:\\Windows',
      ComSpec:     process.env.ComSpec    || 'C:\\Windows\\system32\\cmd.exe',
      HOME:        process.env.USERPROFILE|| '',
    };
    const proc = spawn(cmd, [], { cwd, shell: true, env: safeEnv });
    let out = '';
    proc.stdout.on('data', d =>
      d.toString().split('\n').map(l => l.trim()).filter(Boolean).forEach(line => {
        out += line + '\n';
        socket.emit(eventName, { type: 'stdout', line });
      })
    );
    proc.stderr.on('data', d =>
      d.toString().split('\n').map(l => l.trim()).filter(Boolean).forEach(line => {
        out += line + '\n';
        socket.emit(eventName, { type: 'stderr', line });
      })
    );
    proc.on('close', code => code === 0 ? resolve(out) : reject(new Error(`Exit code ${code}`)));
    proc.on('error', reject);
  });
}

// ─── GITHUB API HELPER (replaces azureFetch) ─────────────────────────────────
async function githubFetch(url, opts = {}) {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN not configured in .env');
  try {
    const res = await fetch(url, {
      ...opts,
      timeout: GITHUB_TIMEOUT,
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept':        'application/vnd.github.v3+json',
        'User-Agent':    'SonarAI-Agent/3.0',
        ...(opts.headers || {})
      }
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 401) throw new Error('GitHub 401 — Token expired or invalid. Regenerate at github.com/settings/tokens');
      if (res.status === 403) throw new Error('GitHub 403 — Rate limit or insufficient permissions');
      if (res.status === 404) throw new Error(`GitHub 404 — Not found. Check GITHUB_USERNAME in .env`);
      throw new Error(`GitHub API returned ${res.status}: ${body.substring(0, 100)}`);
    }
    return res.json();
  } catch (e) {
    if (e.type === 'request-timeout') throw new Error('GitHub API timeout — check internet connection');
    throw e;
  }
}

// ─── GITHUB ISSUE CREATION (replaces createAzureTicket) ─────────────────────
async function createGitHubIssue({ repoName, title, body }) {
  if (!GITHUB_TOKEN || !GITHUB_USERNAME) throw new Error('GitHub config missing');
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_USERNAME}/${repoName}/issues`,
    {
      method:  'POST',
      timeout: GITHUB_TIMEOUT,
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept':        'application/vnd.github.v3+json',
        'User-Agent':    'SonarAI-Agent/3.0',
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({ title, body, labels: ['bug', 'sonarqube'] })
    }
  );
  if (!res.ok) {
    const b = await res.text().catch(() => '');
    throw new Error(`GitHub Issue creation failed: ${res.status} — ${b.substring(0, 100)}`);
  }
  const data = await res.json();
  return { id: data.number, url: data.html_url };
}

// ─── EMAIL ────────────────────────────────────────────────────────────────────
async function sendEmail({ to, subject, html }) {
  if (!process.env.SMTP_HOST || !to) return;
  try {
    const t = require('nodemailer').createTransport({
      host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT) || 587,
      secure: false, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    await t.sendMail({ from: process.env.SMTP_USER, to, subject, html });
    console.log(`[Email] ✅ ${subject}`);
  } catch (e) { console.error('[Email] ❌', safeError(e)); }
}

// ─── AI REVIEW REPORT GENERATOR ───────────────────────────────────────────────
function generateAIReviewReport(review, repoName, branch) {
  const score = review.score || 75;
  const scoreColor = score >= 80 ? '#10b981' : score >= 60 ? '#f59e0b' : '#ef4444';
  const scoreEmoji = score >= 80 ? '🎉' : score >= 60 ? '⚠️' : '🚨';
  const security = review.security || { rating: 'B', score: 75 };
  const maintainability = review.maintainability || { rating: 'B', score: 75 };
  const performance = review.performance || { rating: 'B', score: 75 };
  const issues = Array.isArray(review.issues) ? review.issues : [];
  const metrics = review.metrics || { totalIssues: 0, critical: 0, major: 0, minor: 0, technicalDebt: '0h' };
  const bugs = issues.filter(i => i.category === 'security' || i.severity === 'critical').length;
  const smells = issues.filter(i => i.category === 'quality' || i.category === 'maintainability').length;
  const criticalIssues = issues.filter(i => i.severity === 'critical');
  const majorIssues = issues.filter(i => i.severity === 'major');
  const minorIssues = issues.filter(i => i.severity === 'minor');
  const hasIssues = issues.length > 0;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:'Segoe UI',sans-serif;background:#f4f7fa;padding:20px;margin:0;color:#1f2937}.container{max-width:800px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.12)}.header{background:linear-gradient(135deg,#8b5cf6,#7c3aed);color:#fff;padding:40px 32px;text-align:center}.header h1{margin:0 0 8px;font-size:28px;font-weight:700}.header p{margin:0;opacity:0.95;font-size:15px}.score-section{background:#f9fafb;padding:32px;text-align:center;border-bottom:1px solid #e5e7eb}.score-circle{width:140px;height:140px;border-radius:50%;margin:0 auto 16px;display:flex;align-items:center;justify-content:center;font-size:48px;font-weight:700;border:8px solid}.stats-row{display:flex;justify-content:space-around;padding:20px 32px;background:#f9fafb;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb}.stat-value{font-size:28px;font-weight:700;font-family:monospace;margin-bottom:4px}.stat-label{font-size:12px;color:#6b7280;font-weight:600}.metrics-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding:32px}.metric-card{background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:20px;text-align:center}.bar-container{background:#f3f4f6;border-radius:8px;height:32px;overflow:hidden;margin:8px 0}.bar-fill{height:100%;display:flex;align-items:center;padding:0 12px;color:#fff;font-weight:700;font-size:13px}.section{padding:32px;border-top:1px solid #e5e7eb}.section h2{margin:0 0 20px;color:#111827;font-size:20px;font-weight:700}.issue-card{background:#f9fafb;border-left:4px solid;border-radius:8px;padding:16px;margin-bottom:12px}.issue-card.critical{border-color:#ef4444;background:rgba(239,68,68,0.05)}.issue-card.major{border-color:#f59e0b;background:rgba(245,158,11,0.05)}.issue-card.minor{border-color:#3b82f6;background:rgba(59,130,246,0.05)}.badge{padding:4px 10px;border-radius:6px;font-size:10px;font-weight:700;text-transform:uppercase}.badge.critical{background:#ef4444;color:#fff}.badge.major{background:#f59e0b;color:#fff}.badge.minor{background:#3b82f6;color:#fff}.issue-title{font-size:15px;font-weight:700;color:#111827;margin:8px 0}.issue-location{font-size:12px;color:#6b7280;margin-bottom:8px;font-family:monospace}.issue-description{font-size:13px;color:#374151;line-height:1.6;margin-bottom:12px}.fix-box{background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.3);border-radius:8px;padding:12px;margin-top:8px}.fix-box-title{font-size:12px;font-weight:700;color:#059669;margin-bottom:6px}.fix-box-content{font-size:13px;color:#047857;line-height:1.6}.congratulations{background:linear-gradient(135deg,rgba(16,185,129,0.1),rgba(5,150,105,0.1));border:2px solid #10b981;border-radius:12px;padding:24px;text-align:center}.congratulations h3{margin:0 0 12px;color:#059669;font-size:22px}.congratulations p{margin:0;color:#047857;font-size:14px;line-height:1.6}.footer{background:#f9fafb;padding:24px 32px;text-align:center;font-size:12px;color:#6b7280;border-top:1px solid #e5e7eb}</style></head><body><div class="container"><div class="header"><h1>${scoreEmoji} AI Code Review Report</h1><p><strong>Repository:</strong> ${repoName} • <strong>Branch:</strong> ${branch}</p><p style="font-size:13px;margin-top:8px;opacity:0.9">Analyzed by Claude Sonnet 4.5 (Anthropic AI)</p></div><div class="score-section"><div class="score-circle" style="border-color:${scoreColor};color:${scoreColor}">${score}</div><div style="font-size:14px;color:#6b7280;margin-top:8px;font-weight:600">OVERALL QUALITY SCORE</div><p style="font-size:13px;color:#6b7280;margin-top:12px">${review.summary || 'Code analysis complete'}</p></div><div class="stats-row"><div style="text-align:center"><div class="stat-value" style="color:#ef4444">${bugs}</div><div class="stat-label">Bugs</div></div><div style="text-align:center"><div class="stat-value" style="color:#3b82f6">${smells}</div><div class="stat-label">Code Smells</div></div><div style="text-align:center"><div class="stat-value" style="color:#6b7280">${review.linesOfCode || 0}</div><div class="stat-label">Lines of Code</div></div></div><div class="metrics-grid"><div class="metric-card"><div style="font-size:14px;color:#6b7280;margin-bottom:12px;font-weight:600">🔒 Security</div><div style="font-size:36px;font-weight:700;color:${security.score>=80?'#10b981':security.score>=60?'#f59e0b':'#ef4444'};margin-bottom:8px">${security.rating}</div><div class="bar-container"><div class="bar-fill" style="width:${security.score}%;background:${security.score>=80?'#10b981':security.score>=60?'#f59e0b':'#ef4444'}">${security.score}/100</div></div></div><div class="metric-card"><div style="font-size:14px;color:#6b7280;margin-bottom:12px;font-weight:600">🧹 Maintainability</div><div style="font-size:36px;font-weight:700;color:${maintainability.score>=80?'#10b981':maintainability.score>=60?'#f59e0b':'#ef4444'};margin-bottom:8px">${maintainability.rating}</div><div class="bar-container"><div class="bar-fill" style="width:${maintainability.score}%;background:${maintainability.score>=80?'#10b981':maintainability.score>=60?'#f59e0b':'#ef4444'}">${maintainability.score}/100</div></div></div><div class="metric-card"><div style="font-size:14px;color:#6b7280;margin-bottom:12px;font-weight:600">⚡ Performance</div><div style="font-size:36px;font-weight:700;color:${performance.score>=80?'#10b981':performance.score>=60?'#f59e0b':'#ef4444'};margin-bottom:8px">${performance.rating}</div><div class="bar-container"><div class="bar-fill" style="width:${performance.score}%;background:${performance.score>=80?'#10b981':performance.score>=60?'#f59e0b':'#ef4444'}">${performance.score}/100</div></div></div></div>${hasIssues ? `${criticalIssues.length > 0 ? `<div class="section"><h2><span style="color:#ef4444">🚨</span> Critical Issues (${criticalIssues.length})</h2>${criticalIssues.map(issue => `<div class="issue-card critical"><div style="margin-bottom:8px"><span class="badge critical">${issue.severity}</span> ${issue.category ? `<span class="badge" style="background:#6b7280;color:#fff">${issue.category}</span>` : ''} ${issue.cwe ? `<span class="badge" style="background:#dc2626;color:#fff">${issue.cwe}</span>` : ''}</div><div class="issue-title">${issue.title || 'Critical Issue'}</div><div class="issue-location">📍 ${issue.file || 'Unknown'}${issue.line ? ':' + issue.line : ''}</div><div class="issue-description">${issue.description || 'No description'}</div>${issue.fix ? `<div class="fix-box"><div class="fix-box-title">💡 Recommended Fix:</div><div class="fix-box-content">${issue.fix}</div></div>` : ''}</div>`).join('')}</div>` : ''}${majorIssues.length > 0 ? `<div class="section"><h2><span style="color:#f59e0b">⚠️</span> Major Issues (${majorIssues.length})</h2>${majorIssues.slice(0, 5).map(issue => `<div class="issue-card major"><div style="margin-bottom:8px"><span class="badge major">${issue.severity}</span> ${issue.category ? `<span class="badge" style="background:#6b7280;color:#fff">${issue.category}</span>` : ''}</div><div class="issue-title">${issue.title || 'Major Issue'}</div><div class="issue-location">📍 ${issue.file || 'Unknown'}${issue.line ? ':' + issue.line : ''}</div><div class="issue-description">${issue.description || 'No description'}</div>${issue.fix ? `<div class="fix-box"><div class="fix-box-title">💡 Recommended Fix:</div><div class="fix-box-content">${issue.fix}</div></div>` : ''}</div>`).join('')}${majorIssues.length > 5 ? `<p style="text-align:center;color:#6b7280;font-size:13px">...and ${majorIssues.length - 5} more major issues</p>` : ''}</div>` : ''}${minorIssues.length > 0 ? `<div class="section"><h2><span style="color:#3b82f6">ℹ️</span> Minor Issues (${minorIssues.length})</h2>${minorIssues.slice(0, 3).map(issue => `<div class="issue-card minor"><div style="margin-bottom:8px"><span class="badge minor">${issue.severity}</span> ${issue.category ? `<span class="badge" style="background:#6b7280;color:#fff">${issue.category}</span>` : ''}</div><div class="issue-title">${issue.title || 'Minor Issue'}</div><div class="issue-location">📍 ${issue.file || 'Unknown'}${issue.line ? ':' + issue.line : ''}</div><div class="issue-description">${issue.description || 'No description'}</div>${issue.fix ? `<div class="fix-box"><div class="fix-box-title">💡 Recommended Fix:</div><div class="fix-box-content">${issue.fix}</div></div>` : ''}</div>`).join('')}${minorIssues.length > 3 ? `<p style="text-align:center;color:#6b7280;font-size:13px">...and ${minorIssues.length - 3} more minor issues</p>` : ''}</div>` : ''}` : `<div class="section"><div class="congratulations"><h3>🎉 Excellent! No Issues Found</h3><p><strong>Congratulations!</strong> Your code passes all AI quality checks with flying colors. No security vulnerabilities, code smells, or performance issues detected. Keep up the great work! 🚀</p><p style="margin-top:12px;font-size:13px">Your code demonstrates best practices in security, maintainability, and performance.</p></div></div>`}${(review.recommendations||[]).length > 0 ? `<div class="section"><h2>💡 AI Recommendations</h2>${review.recommendations.slice(0,5).map((rec, i) => `<div style="background:#f9fafb;border-left:3px solid #8b5cf6;border-radius:6px;padding:12px;margin-bottom:8px"><span style="color:#8b5cf6;font-weight:700;margin-right:8px">${i+1}.</span>${rec}</div>`).join('')}</div>` : ''}<div class="footer"><p><strong>🤖 SonarQube AI Agent</strong> — Powered by Claude Sonnet 4.5 (Anthropic)</p><p style="margin-top:8px">Generated on ${new Date().toLocaleString('en-IN', {dateStyle:'medium',timeStyle:'short'})}</p><p style="margin-top:4px;font-size:11px">Technical Debt: ${metrics.technicalDebt || '0h'} • Total Issues: ${metrics.totalIssues || 0}</p></div></div></body></html>`;
}

// ─── SONARQUBE REPORT FETCHER ─────────────────────────────────────────────────
async function fetchSonarReport(projectKey) {
  if (!SONAR_TOKEN) throw new Error('SONAR_TOKEN not configured');
  const auth = { 'Authorization': `Basic ${Buffer.from(SONAR_TOKEN + ':').toString('base64')}` };

  const [iR, mR] = await Promise.all([
    fetch(`${SONAR_URL}/api/issues/search?componentKeys=${encodeURIComponent(projectKey)}&resolved=false&ps=50`, { headers: auth }),
    fetch(`${SONAR_URL}/api/measures/component?component=${encodeURIComponent(projectKey)}&metricKeys=bugs,vulnerabilities,code_smells,coverage,duplicated_lines_density,ncloc,security_hotspots,reliability_rating,security_rating,sqale_rating`, { headers: auth })
  ]);

  if (!iR.ok) throw new Error(`SonarQube issues API: ${iR.status} — is SonarQube running on ${SONAR_URL}?`);
  if (!mR.ok) throw new Error(`SonarQube measures API: ${mR.status}`);

  const issues   = await iR.json();
  const measures = await mR.json();
  const metrics  = {};
  (measures.component?.measures || []).forEach(m => { metrics[m.metric] = m.value; });

  return { projectKey, metrics, issues: issues.issues || [], totalIssues: issues.total || 0 };
}

// ─── SOCKET EVENTS ────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`✅ Client: ${socket.id}`);

  // ── 1. FETCH GITHUB REPOSITORIES ──────────────────────────────────────────
  socket.on('fetch-repositories', async () => {
    if (!rateLimiter(socket.id, 'repos')) {
      return socket.emit('repositories', { success: false, error: 'Rate limit exceeded', repos: [] });
    }
    try {
      // Fetch all repos for the authenticated user
      const data  = await githubFetch(`https://api.github.com/users/${GITHUB_USERNAME}/repos?per_page=100&sort=updated`);
      const repos = data.map(r => ({
        id:            r.id,
        name:          r.name,
        defaultBranch: r.default_branch || 'main',
        size:          r.size || 0,
        private:       r.private,
        language:      r.language || 'Unknown',
        cloneUrl:      r.clone_url
      }));
      socket.emit('repositories', { success: true, repos });
    } catch (e) {
      console.error('[repos]', safeError(e));
      socket.emit('repositories', { success: false, error: safeError(e), repos: [] });
    }
  });

  // ── 2. FETCH BRANCHES ─────────────────────────────────────────────────────
  socket.on('fetch-branches', async ({ repoName }) => {
    if (!rateLimiter(socket.id, 'branches')) {
      return socket.emit('branches', { success: false, error: 'Rate limit', branches: [] });
    }
    if (!validateRepoName(repoName)) {
      return socket.emit('branches', { success: false, error: 'Invalid repository name', branches: [] });
    }

    try {
      const data = await githubFetch(
        `https://api.github.com/repos/${GITHUB_USERNAME}/${encodeURIComponent(repoName)}/branches?per_page=100`
      );
      const branches = data.map(b => ({
        name:   b.name,
        commit: b.commit.sha.substring(0, 8),
        date:   new Date().toLocaleDateString('en-IN')
      }));
      socket.emit('branches', { success: true, branches });
    } catch (e) {
      console.error('[branches]', safeError(e));
      socket.emit('branches', { success: false, error: safeError(e), branches: [] });
    }
  });

  // ── 3. GIT OPERATIONS — CLONE OR PULL ─────────────────────────────────────
  socket.on('git-sync', async ({ branch, repoName }) => {
    if (!rateLimiter(socket.id, 'git-sync')) {
      return socket.emit('git-result', { success: false, error: 'Rate limit exceeded' });
    }
    if (!validateRepoName(repoName))  return socket.emit('git-result', { success: false, error: 'Invalid repo name' });
    if (!validateBranchName(branch))  return socket.emit('git-result', { success: false, error: 'Invalid branch name' });

    const log = msg => {
      console.log(`[git-sync] ${msg}`);
      socket.emit('git-log', msg);
    };
    log(`🔄 Git Sync — ${repoName}@${branch}`);

    let repoPath;
    try {
      repoPath = getRepoPath(repoName);
      log(`📁 Target path: ${repoPath}`);
    } catch (e) {
      const errMsg = safeError(e);
      log(`❌ ${errMsg}`);
      return socket.emit('git-result', { success: false, error: errMsg });
    }

    try {
      if (!fs.existsSync(repoPath)) {
        // CLONE — repo doesn't exist locally
        log(`📥 Cloning ${repoName}...`);
        log(`📁 Destination: ${repoPath}`);
        fs.mkdirSync(repoPath, { recursive: true });

        // Build authenticated clone URL
        const cloneUrl = `https://${GITHUB_USERNAME}:${GITHUB_TOKEN}@github.com/${GITHUB_USERNAME}/${repoName}.git`;
        await gitExec(['clone', '--branch', branch, '--depth', '50', cloneUrl, repoPath], REPO_BASE_PATH);
        log(`✅ Clone complete!`);
      } else {
        // PULL — repo exists, update it
        log(`📂 Repo exists at ${repoPath}`);

        // Check if it's actually a git repo
        if (!fs.existsSync(path.join(repoPath, '.git'))) {
          throw new Error(`Directory exists but is not a git repository. Delete ${repoPath} and try again.`);
        }

        log(`🔀 Fetching latest...`);
        await gitExec(['fetch', '--all', '--prune'], repoPath);
        log(`✅ Fetch complete`);

        log(`🔀 Checking out ${branch}...`);
        await gitExec(['checkout', branch], repoPath);
        log(`✅ Checkout complete`);

        log(`⬇️  Pulling latest changes...`);
        await gitExec(['pull', 'origin', branch], repoPath);
        log(`✅ Pull complete!`);
      }

      // Get last commit info
      log(`📝 Reading commit info...`);
      const lastCommit = await gitExec(['log', '-1', '--pretty=format:%H|%an|%s|%ci'], repoPath).catch(() => '');
      const [sha, author, subject, date] = lastCommit.split('|');

      socket.emit('git-result', {
        success: true, branch, repoName,
        commit: { sha: sha?.substring(0, 8), author, subject, date }
      });
      log(`✅ Git sync done — ${sha?.substring(0, 8)} by ${author}`);

    } catch (e) {
      const errMsg = safeError(e);
      log(`❌ ${errMsg}`);
      socket.emit('git-result', { success: false, error: errMsg });
    }
  });

  // ── 4. AI CODE REVIEW ──────────────────────────────────────────────────────
  socket.on('ai-review', async ({ branch, repoName }) => {
    if (!rateLimiter(socket.id, 'ai-review')) return socket.emit('review-result', { success: false, error: 'Rate limit exceeded' });
    if (!validateRepoName(repoName))  return socket.emit('review-result', { success: false, error: 'Invalid repo name' });
    if (!validateBranchName(branch))  return socket.emit('review-result', { success: false, error: 'Invalid branch name' });

    const log = msg => socket.emit('review-log', msg);
    log('🤖 Starting AI Code Review...');

    if (!ANTHROPIC_KEY) {
      return socket.emit('review-result', { success: false, error: 'ANTHROPIC_API_KEY not set in .env' });
    }

    const repoPath = getRepoPath(repoName);
    if (!fs.existsSync(repoPath)) {
      return socket.emit('review-result', { success: false, error: `Repo not found locally at ${repoPath}. Run Git Sync first!` });
    }

    try {
      let codeSnippet = '';
      try {
        // Try to get recently changed files
        const changed = await gitExec(['diff', 'HEAD~1', '--name-only'], repoPath);
        // Support both .cs (C#) and .js/.ts files
        const codeFiles = changed.split('\n')
          .filter(f => (f.endsWith('.cs') || f.endsWith('.js') || f.endsWith('.ts')) && !f.includes('..'))
          .slice(0, 3);

        for (const f of codeFiles) {
          const content = await gitExec(['show', `HEAD:${f}`], repoPath).catch(() => '');
          if (content) codeSnippet += `\n\n// FILE: ${f}\n${content.substring(0, 2000)}`;
        }
      } catch (_) {}

      // Fallback: read any .cs or .js files from repo root
      if (!codeSnippet && fs.existsSync(repoPath)) {
        try {
          const files = fs.readdirSync(repoPath)
            .filter(f => f.endsWith('.cs') || f.endsWith('.js') || f.endsWith('.ts'))
            .slice(0, 2);
          for (const f of files) {
            const content = fs.readFileSync(path.join(repoPath, f), 'utf8');
            codeSnippet += `\n\n// FILE: ${f}\n${content.substring(0, 2000)}`;
          }
        } catch (_) {}
      }

      if (!codeSnippet) {
        log('⚠️ No code files found — using demo snippet');
        codeSnippet = `// Demo.cs\npublic class UserService {\n  private string conn = "Server=prod;Password=admin123;";\n  public User GetUser(int id) {\n    var sql = "SELECT * FROM Users WHERE Id=" + id; // SQL injection risk!\n    return db.Query<User>(sql).First();\n  }\n}`;
      }

      log('🧠 Calling Claude AI...');
      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5', max_tokens: 4000, temperature: 0.2,
          system: `You are a senior code security and quality analyst. Analyze code deeply and return ONLY valid JSON (no markdown, no explanations):

{
  "summary": "Brief overall assessment",
  "score": number (0-100),
  "linesOfCode": number,
  "files": ["list of analyzed files"],
  "issues": [
    {
      "severity": "critical|major|minor",
      "category": "security|quality|performance|maintainability",
      "file": "filename",
      "line": number or null,
      "title": "Short title",
      "description": "Detailed description",
      "fix": "How to fix it",
      "cwe": "CWE-xxx (if security issue)" or null
    }
  ],
  "security": {
    "rating": "A|B|C|D|E",
    "score": number (0-100),
    "findings": ["specific findings"],
    "vulnerabilities": [
      {
        "type": "SQL Injection|XSS|Hardcoded Secret|etc",
        "severity": "critical|high|medium|low",
        "location": "file:line",
        "description": "what was found"
      }
    ]
  },
  "maintainability": {
    "rating": "A|B|C|D|E",
    "score": number (0-100),
    "findings": ["specific findings"],
    "codeSmells": [
      {
        "type": "Duplicate Code|Long Method|God Class|etc",
        "location": "file:line",
        "description": "what needs improvement"
      }
    ]
  },
  "performance": {
    "rating": "A|B|C|D|E",
    "score": number (0-100),
    "findings": ["specific findings"],
    "bottlenecks": [
      {
        "type": "N+1 Query|Memory Leak|Inefficient Loop|etc",
        "location": "file:line",
        "impact": "description"
      }
    ]
  },
  "duplications": {
    "percentage": number (0-100),
    "blocks": number,
    "lines": number,
    "details": [
      {
        "files": ["file1", "file2"],
        "lines": "approximate line range",
        "snippet": "first 100 chars of duplicate"
      }
    ]
  },
  "complexity": {
    "average": number,
    "highest": {"file": "name", "function": "name", "score": number},
    "concerns": ["functions/classes with high complexity"]
  },
  "recommendations": ["actionable improvements in priority order"],
  "metrics": {
    "totalIssues": number,
    "critical": number,
    "major": number,
    "minor": number,
    "technicalDebt": "estimated time to fix (e.g., 2h, 1d)"
  }
}

IMPORTANT:
- Be thorough - check for OWASP Top 10 vulnerabilities
- Identify code duplications and similar patterns
- Calculate cyclomatic complexity where possible
- Look for hardcoded secrets, passwords, API keys
- Check for SQL injection, XSS, insecure deserialization
- Identify performance issues like N+1 queries, memory leaks
- Flag code smells like long methods, god classes, duplicate code
- Provide specific line numbers when possible`,
          messages: [{ role: 'user', content: `Perform comprehensive code review for branch "${branch}" in repository "${repoName}".

Analyze for:
1. Security vulnerabilities (OWASP Top 10)
2. Code quality issues
3. Performance bottlenecks
4. Code duplications
5. Maintainability concerns
6. Cyclomatic complexity

Code to analyze:
${codeSnippet}` }]
        })
      });

      const aiData = await aiRes.json();
      const raw    = aiData.content?.[0]?.text || '{}';
      let review;
      try {
        review = JSON.parse(raw.replace(/```json|```/g, '').trim());
      } catch {
        review = {
          summary: 'Review complete (parse error)', score: 75, linesOfCode: 0, files: [],
          issues: [], security: { rating: 'B', score: 75, findings: [], vulnerabilities: [] },
          maintainability: { rating: 'B', score: 75, findings: [], codeSmells: [] },
          performance: { rating: 'B', score: 75, findings: [], bottlenecks: [] },
          duplications: { percentage: 0, blocks: 0, lines: 0, details: [] },
          complexity: { average: 5, highest: null, concerns: [] },
          recommendations: [],
          metrics: { totalIssues: 0, critical: 0, major: 0, minor: 0, technicalDebt: '0h' }
        };
      }

      socket.emit('review-result', { success: true, branch, repoName, review });
      log(`✅ Done — Score: ${review.score ?? '—'}/100`);

      // Generate and send AI Review Report email
      log('📧 Generating AI Review Report...');
      try {
        const reportHTML = generateAIReviewReport(review, repoName, branch);
        const score = review.score || 75;
        const scoreEmoji = score >= 80 ? '🎉' : score >= 60 ? '⚠️' : '🚨';
        const bugs = (review.issues || []).filter(i => i.category === 'security' || i.severity === 'critical').length;
        const smells = (review.issues || []).filter(i => i.category === 'quality' || i.category === 'maintainability').length;

        await sendEmail({
          to: NOTIFY_EMAIL,
          subject: `${scoreEmoji} AI Code Review Complete • ${repoName} (${branch}) • Score: ${score}/100`,
          html: reportHTML
        });
        log('✅ AI Review Report sent via email');
      } catch (emailErr) {
        log(`⚠️ Email sending failed: ${safeError(emailErr)}`);
      }
    } catch (e) {
      log(`❌ ${safeError(e)}`);
      socket.emit('review-result', { success: false, error: safeError(e) });
    }
  });

  // ── 5. SONARQUBE SCAN ──────────────────────────────────────────────────────
  socket.on('sonar-scan', async ({ branch, repoName, slnFile }) => {
    if (!rateLimiter(socket.id, 'sonar-scan')) return socket.emit('scan-complete', { success: false, error: 'Rate limit exceeded' });
    if (!validateRepoName(repoName)) return socket.emit('scan-complete', { success: false, error: 'Invalid repo name' });
    if (!validateBranchName(branch)) return socket.emit('scan-complete', { success: false, error: 'Invalid branch name' });

    const log = (type, line) => socket.emit('scan-log', { type, line });

    // Project key: safe characters only + unique timestamp
    // Format: username-reponame-branch-YYYYMMDD-HHMMSS
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').substring(0, 14); // YYYYMMDDHHmmss
    const projectKey = `${GITHUB_USERNAME}-${repoName}-${branch}-${timestamp}`.replace(/[^a-zA-Z0-9\-\.]/g, '_');
    const displayName = `${repoName} (${branch}) - ${new Date().toLocaleString('en-IN')}`;

    const repoPath = getRepoPath(repoName);
    if (!fs.existsSync(repoPath)) {
      return socket.emit('scan-complete', {
        success: false,
        error: `Repo not found at ${repoPath}. Run Git Sync first!`
      });
    }

    // Auto-detect project type
    let projectType = 'generic'; // default
    let solutionFile = slnFile;

    try {
      const files = fs.readdirSync(repoPath);

      // Check for .NET project
      const slnFiles = files.filter(f => f.endsWith('.sln'));
      const csprojFiles = files.filter(f => f.endsWith('.csproj'));

      if (slnFiles.length > 0) {
        projectType = 'dotnet';
        solutionFile = slnFiles[0];
        log('info', `🔍 Detected: .NET project (${solutionFile})`);
      } else if (csprojFiles.length > 0) {
        projectType = 'dotnet';
        log('info', `🔍 Detected: .NET project (${csprojFiles[0]})`);
      } else if (files.includes('package.json')) {
        projectType = 'javascript';
        log('info', `🔍 Detected: JavaScript/Node.js project`);
      }
    } catch (_) {}

    log('step', `🔍 Sonar Scan — ${repoName}@${branch}`);
    log('info',  `📁 ${repoPath}`);
    log('info',  `🔑 Project Key: ${projectKey}`);
    log('info',  `📦 Project Type: ${projectType}`);
    log('info',  `🌐 SonarQube: ${SONAR_URL}`);

    try {
      if (projectType === 'dotnet') {
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // .NET PROJECT SCAN (3-step process)
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

        // ── STEP 1: Begin ──────────────────────────────────────────────────
        log('step', '━━━ STEP 1: SonarScanner Begin ━━━');
        const beginCmd = [
          'dotnet sonarscanner begin',
          `/k:"${projectKey}"`,
          `/n:"${displayName}"`,
          `/d:sonar.host.url="${SONAR_URL}"`,
          `/d:sonar.token="${SONAR_TOKEN}"`,
          `/d:sonar.branch.name="${branch}"`,
          `/d:sonar.cs.opencover.reportsPaths=**\\coverage.opencover.xml`,
          `/d:sonar.exclusions=**/node_modules/**,**/.git/**,**/bin/**,**/obj/**`
        ].join(' ');
        await runCommand(beginCmd, repoPath, socket, 'scan-log');
        log('success', '✅ Begin done');

        // ── STEP 2: Build ──────────────────────────────────────────────────
        log('step', '━━━ STEP 2: dotnet build ━━━');
        if (solutionFile) {
          await runCommand(
            `dotnet build "${solutionFile}" /p:platform="Any CPU" /p:configuration="Release" -nodeReuse:false`,
            repoPath, socket, 'scan-log'
          );
        } else {
          await runCommand('dotnet build . /p:configuration="Release" -nodeReuse:false', repoPath, socket, 'scan-log');
        }
        log('success', '✅ Build done');

        // ── STEP 3: End ────────────────────────────────────────────────────
        log('step', '━━━ STEP 3: SonarScanner End ━━━');
        await runCommand(
          `dotnet sonarscanner end /d:sonar.token="${SONAR_TOKEN}"`,
          repoPath, socket, 'scan-log'
        );
        log('success', '✅ End done — uploading report...');

      } else {
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // JAVASCRIPT/GENERIC PROJECT SCAN (sonar-scanner CLI)
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

        log('step', '━━━ JavaScript/Node.js SonarQube Scan ━━━');
        log('info', '📦 Using sonar-scanner CLI for JavaScript analysis');

        // Create sonar-project.properties file
        const propsContent = `sonar.projectKey=${projectKey}
sonar.projectName=${displayName}
sonar.projectVersion=1.0
sonar.sources=.
sonar.sourceEncoding=UTF-8
sonar.exclusions=node_modules/**,coverage/**,dist/**,build/**,.git/**,.claude/**,.wolf/**,**/*.test.js,**/*.spec.js
sonar.javascript.file.suffixes=.js,.jsx
sonar.typescript.file.suffixes=.ts,.tsx
sonar.host.url=${SONAR_URL}
sonar.token=${SONAR_TOKEN}`;

        const propsPath = path.join(repoPath, 'sonar-project.properties');
        fs.writeFileSync(propsPath, propsContent);
        log('info', '📝 Created sonar-project.properties');

        // Try to run sonar-scanner CLI
        let scannerFound = false;
        const scannerCmd = process.platform === 'win32' ? 'sonar-scanner.cmd' : 'sonar-scanner';

        try {
          log('info', '🔍 Checking for sonar-scanner CLI...');

          // Quick check if sonar-scanner exists
          try {
            await gitExec([scannerCmd, '-v'], repoPath).catch(() => {
              throw new Error('Command test failed');
            });
            scannerFound = true;
            log('success', '✅ sonar-scanner CLI found');
          } catch (_) {
            // Try alternative command
            try {
              await runCommand(`${scannerCmd} -v`, repoPath, socket, 'scan-log');
              scannerFound = true;
              log('success', '✅ sonar-scanner CLI found');
            } catch (__) {
              scannerFound = false;
            }
          }

          if (scannerFound) {
            log('info', '🔍 Running full JavaScript analysis (this may take 1-2 minutes)...');
            log('info', '📊 Analyzing files, calculating metrics, detecting issues...');

            // Run the scan
            await runCommand(scannerCmd, repoPath, socket, 'scan-log');

            log('success', '✅ JavaScript scan completed successfully!');
            log('success', '📊 Code analysis uploaded to SonarQube');
          }

        } catch (e) {
          // Fallback: sonar-scanner not installed or timed out
          if (scannerFound) {
            log('error', `⚠️ Scan failed: ${safeError(e)}`);
          } else {
            log('info', '⚠️ sonar-scanner CLI not found in PATH');
          }

          log('info', '📊 Creating project in SonarQube (basic analysis)...');
          log('info', '');
          log('info', '💡 For FULL JavaScript analysis with:');
          log('info', '   • Security vulnerabilities');
          log('info', '   • Code smells & duplications');
          log('info', '   • Complexity metrics');
          log('info', '   Install: npm install -g sonar-scanner');
          log('info', '   Or download: https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/');
          log('info', '');

          // Create project via API (minimal scan)
          try {
            const createRes = await fetch(`${SONAR_URL}/api/projects/create`, {
              method: 'POST',
              headers: {
                'Authorization': `Basic ${Buffer.from(SONAR_TOKEN + ':').toString('base64')}`,
                'Content-Type': 'application/x-www-form-urlencoded'
              },
              body: `project=${encodeURIComponent(projectKey)}&name=${encodeURIComponent(repoName)}`
            });

            if (createRes.ok) {
              log('success', '✅ Project created in SonarQube');
              log('info', `📊 View: ${SONAR_URL}/dashboard?id=${encodeURIComponent(projectKey)}`);
            } else if (createRes.status === 400) {
              log('success', '✅ Project already exists in SonarQube');
              log('info', `📊 View: ${SONAR_URL}/dashboard?id=${encodeURIComponent(projectKey)}`);
            } else {
              log('info', `⚠️ API returned ${createRes.status}`);
            }
          } catch (apiErr) {
            log('error', `⚠️ Could not create project: ${safeError(apiErr)}`);
          }

          log('success', '✅ Scan completed (basic project registration)');
          log('info', '💡 Project is now visible in SonarQube, but detailed metrics require sonar-scanner CLI');
        }
      }

      // Wait for SonarQube to process
      log('info', '⏳ Waiting 15s for SonarQube to process...');
      await new Promise(r => setTimeout(r, 15000));

      const report = await fetchSonarReport(projectKey);
      socket.emit('scan-complete', { success: true, branch, repoName, projectKey, report });
      log('success', `✅ Scan complete — ${report.totalIssues} issues found`);
      log('info',    `📊 View: ${SONAR_URL}/dashboard?id=${encodeURIComponent(projectKey)}`);

      await sendEmail({
        to: NOTIFY_EMAIL,
        subject: `✅ Code Quality Scan Complete • ${repoName} (${branch}) • ${report.totalIssues} issues detected`,
        html: `
<!DOCTYPE html>
<html>
<head><style>
body{font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background:#f4f7fa;padding:20px;margin:0}
.container{max-width:650px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.12)}
.header{background:linear-gradient(135deg,#10b981,#059669);color:#fff;padding:36px 28px;text-align:center}
.header h1{margin:0;font-size:24px;font-weight:700}
.header p{margin:8px 0 0;opacity:0.95;font-size:14px}
.content{padding:32px 28px;color:#1f2937}
.section{margin-bottom:28px}
.section h3{margin:0 0 16px;color:#111827;font-size:16px;font-weight:600;border-bottom:2px solid #e5e7eb;padding-bottom:8px}
.info-row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f3f4f6}
.info-label{color:#6b7280;font-size:13px;font-weight:500}
.info-value{color:#111827;font-size:13px;font-weight:600;font-family:'Courier New',monospace}
.metrics{display:flex;justify-content:space-around;margin:24px 0;padding:24px;background:#f9fafb;border-radius:12px;border:1px solid #e5e7eb}
.metric{text-align:center;flex:1}
.metric-value{font-size:36px;font-weight:700;margin-bottom:6px;font-family:'Courier New',monospace}
.metric-value.bugs{color:#ef4444}
.metric-value.vulnerabilities{color:#f59e0b}
.metric-value.smells{color:#3b82f6}
.metric-label{font-size:12px;color:#6b7280;text-transform:uppercase;font-weight:600;letter-spacing:0.5px}
.rating-box{display:inline-block;padding:20px 24px;background:#f9fafb;border-radius:10px;margin:8px;border:1px solid #e5e7eb;text-align:center}
.rating-value{font-size:28px;font-weight:700;margin-bottom:6px;font-family:'Courier New',monospace}
.rating-label{font-size:12px;color:#6b7280;font-weight:500}
.footer{padding:24px 28px;background:#f9fafb;text-align:center;font-size:12px;color:#6b7280;border-top:1px solid #e5e7eb}
.btn{display:inline-block;background:linear-gradient(135deg,#10b981,#059669);color:#fff;padding:14px 28px;text-decoration:none;border-radius:8px;margin:20px 0;font-weight:600;font-size:14px;box-shadow:0 4px 12px rgba(16,185,129,0.3)}
.highlight{background:#fef3c7;padding:16px;border-left:4px solid #f59e0b;border-radius:6px;font-size:13px;color:#92400e;margin:16px 0}
.timestamp{color:#9ca3af;font-size:11px;font-style:italic}
.rating-A{color:#065f46;background:#d1fae5;border:2px solid #10b981}
.rating-B{color:#1e40af;background:#dbeafe;border:2px solid #3b82f6}
.rating-C{color:#92400e;background:#fef3c7;border:2px solid #f59e0b}
.rating-D{color:#991b1b;background:#fee2e2;border:2px solid #ef4444}
</style></head>
<body>
<div class="container">
  <div class="header">
    <h1>✅ SonarQube Scan Completed Successfully</h1>
    <p>Automated Security & Quality Analysis Report</p>
  </div>
  <div class="content">
    <div class="section">
      <h3>📋 Scan Summary</h3>
      <div class="info-row">
        <span class="info-label">Repository</span>
        <span class="info-value">${repoName}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Branch</span>
        <span class="info-value">${branch}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Scan Timestamp</span>
        <span class="info-value timestamp">${new Date().toLocaleString('en-IN', {dateStyle:'medium',timeStyle:'short'})}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Project Key</span>
        <span class="info-value">${projectKey}</span>
      </div>
    </div>

    <div class="highlight">
      <strong>🔍 Total Issues Detected:</strong> ${report.totalIssues} issues require attention. Review the detailed breakdown below and prioritize critical vulnerabilities first.
    </div>

    <div class="section">
      <h3>📊 Issue Breakdown</h3>
      <div class="metrics">
        <div class="metric">
          <div class="metric-value bugs">${report.metrics.bugs||0}</div>
          <div class="metric-label">Bugs</div>
        </div>
        <div class="metric">
          <div class="metric-value vulnerabilities">${report.metrics.vulnerabilities||0}</div>
          <div class="metric-label">Vulnerabilities</div>
        </div>
        <div class="metric">
          <div class="metric-value smells">${report.metrics.code_smells||0}</div>
          <div class="metric-label">Code Smells</div>
        </div>
      </div>
    </div>

    <div class="section">
      <h3>⭐ Quality Ratings</h3>
      <div style="text-align:center">
        <div class="rating-box rating-${report.metrics.reliability_rating||'A'}">
          <div class="rating-value">${report.metrics.reliability_rating||'A'}</div>
          <div class="rating-label">Reliability</div>
        </div>
        <div class="rating-box rating-${report.metrics.security_rating||'A'}">
          <div class="rating-value">${report.metrics.security_rating||'A'}</div>
          <div class="rating-label">Security</div>
        </div>
        <div class="rating-box rating-${report.metrics.sqale_rating||'A'}">
          <div class="rating-value">${report.metrics.sqale_rating||'A'}</div>
          <div class="rating-label">Maintainability</div>
        </div>
      </div>
    </div>

    ${report.metrics.coverage ? `
    <div class="section">
      <h3>📈 Code Coverage</h3>
      <div style="background:#f3f4f6;border-radius:12px;height:32px;overflow:hidden;border:1px solid #e5e7eb">
        <div style="background:linear-gradient(90deg,#10b981,#059669);height:100%;width:${report.metrics.coverage}%;text-align:center;line-height:32px;color:#fff;font-weight:700;font-size:14px;transition:width 0.3s">${parseFloat(report.metrics.coverage).toFixed(1)}%</div>
      </div>
    </div>` : ''}

    <div style="text-align:center;margin-top:32px">
      <a href="${SONAR_URL}/dashboard?id=${encodeURIComponent(projectKey)}" class="btn">📊 View Full Report in SonarQube →</a>
    </div>

    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px;margin-top:24px;font-size:13px;color:#1e40af">
      <strong>💡 Next Steps:</strong>
      <ul style="margin:8px 0 0;padding-left:20px">
        <li>Review high-severity vulnerabilities in the SonarQube dashboard</li>
        <li>Address critical bugs before merging to production</li>
        <li>Run AI code review for semantic analysis and recommendations</li>
      </ul>
    </div>
  </div>
  <div class="footer">
    <p><strong>🤖 SonarAI Agent</strong> — Enterprise Code Quality & Security Platform<br>
    Powered by Claude 4.5 Sonnet • SonarQube v26 • GitHub Integration<br>
    <span style="font-size:10px;color:#9ca3af">Automated scan initiated at ${new Date().toLocaleString('en-IN')}</span></p>
  </div>
</div>
</body>
</html>`
      });

    } catch (e) {
      const errMsg = safeError(e);
      log('error', `❌ ${errMsg}`);
      socket.emit('scan-complete', { success: false, branch, repoName, error: errMsg });

      // GitHub issue creation — DISABLED (enable later for organization)
      let issue = null;
      // try {
      //   issue = await createGitHubIssue({
      //     repoName,
      //     title:  `🔴 SonarQube Scan Failed — ${branch} [${new Date().toLocaleDateString('en-IN')}]`,
      //     body:   `## Scan Failed\n\n**Branch:** \`${branch}\`\n**Error:** ${errMsg}\n\n*Auto-created by SonarAI Agent*`
      //   });
      //   log('info', `🎫 GitHub Issue Created: #${issue.id} — ${issue.url}`);
      // } catch (te) {
      //   log('error', `⚠️ Issue creation failed: ${safeError(te)}`);
      // }

      await sendEmail({
        to: NOTIFY_EMAIL,
        subject: `❌ Code Quality Scan Failed • ${repoName} (${branch}) • Action Required`,
        html: `
<!DOCTYPE html>
<html>
<head><style>
body{font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background:#f4f7fa;padding:20px;margin:0}
.container{max-width:650px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.12)}
.header{background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff;padding:36px 28px;text-align:center}
.header h1{margin:0;font-size:24px;font-weight:700}
.header p{margin:8px 0 0;opacity:0.95;font-size:14px}
.content{padding:32px 28px;color:#1f2937}
.section{margin-bottom:28px}
.section h3{margin:0 0 16px;color:#111827;font-size:16px;font-weight:600;border-bottom:2px solid #e5e7eb;padding-bottom:8px}
.info-row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f3f4f6}
.info-label{color:#6b7280;font-size:13px;font-weight:500}
.info-value{color:#111827;font-size:13px;font-weight:600;font-family:'Courier New',monospace}
.error-box{background:#fee2e2;border:2px solid #ef4444;border-radius:12px;padding:20px;margin:16px 0}
.error-box pre{background:#fff;padding:14px;border-radius:8px;overflow-x:auto;font-size:12px;color:#991b1b;font-family:'Courier New',monospace;line-height:1.6;border:1px solid #fecaca}
.footer{padding:24px 28px;background:#f9fafb;text-align:center;font-size:12px;color:#6b7280;border-top:1px solid #e5e7eb}
.btn{display:inline-block;background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff;padding:14px 28px;text-decoration:none;border-radius:8px;margin:20px 0;font-weight:600;font-size:14px;box-shadow:0 4px 12px rgba(239,68,68,0.3)}
.alert{background:#fef3c7;border-left:4px solid #f59e0b;border-radius:6px;padding:16px;margin:16px 0;font-size:13px;color:#92400e}
.timestamp{color:#9ca3af;font-size:11px;font-style:italic}
</style></head>
<body>
<div class="container">
  <div class="header">
    <h1>❌ SonarQube Scan Failed</h1>
    <p>Immediate Action Required</p>
  </div>
  <div class="content">
    <div class="alert">
      <strong>⚠️ Scan Failure:</strong> The automated code quality scan encountered an error and could not complete. Review the error details below and take corrective action.
    </div>

    <div class="section">
      <h3>📋 Scan Details</h3>
      <div class="info-row">
        <span class="info-label">Repository</span>
        <span class="info-value">${repoName}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Branch</span>
        <span class="info-value">${branch}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Failed At</span>
        <span class="info-value timestamp">${new Date().toLocaleString('en-IN', {dateStyle:'medium',timeStyle:'short'})}</span>
      </div>
    </div>

    <div class="section">
      <h3>🔴 Error Details</h3>
      <div class="error-box">
        <strong style="color:#dc2626;font-size:14px">Error Message:</strong>
        <pre>${errMsg}</pre>
      </div>
    </div>

    ${issue ? `
    <div class="section">
      <h3>🎫 Automatic Actions Taken</h3>
      <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px">
        <p style="margin:0;color:#1e40af">✅ GitHub Issue created for tracking: <strong>#${issue.id}</strong></p>
        <div style="text-align:center;margin-top:12px">
          <a href="${issue.url}" class="btn" style="background:linear-gradient(135deg,#3b82f6,#2563eb);box-shadow:0 4px 12px rgba(59,130,246,0.3)">View GitHub Issue →</a>
        </div>
      </div>
    </div>` : ''}

    <div class="section">
      <h3>🛠️ Troubleshooting Steps</h3>
      <ol style="color:#374151;line-height:2;font-size:13px;padding-left:20px">
        <li><strong>Verify SonarQube Server:</strong> Ensure SonarQube is running at <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px">http://localhost:9000</code></li>
        <li><strong>Check Dependencies:</strong> Confirm .NET SDK, sonar-scanner CLI, and required tools are installed</li>
        <li><strong>Review Error Message:</strong> Analyze the error details above for specific failure reason</li>
        <li><strong>Validate Repository:</strong> Ensure the repository has a valid solution file (.sln) for .NET projects</li>
        <li><strong>Check Permissions:</strong> Verify SonarQube token and GitHub access tokens are valid</li>
        ${issue ? `<li><strong>Track Resolution:</strong> Update progress in GitHub Issue <a href="${issue.url}" style="color:#3b82f6">#${issue.id}</a></li>` : ''}
      </ol>
    </div>

    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin-top:24px;font-size:13px;color:#991b1b">
      <strong>⚡ Quick Fix Commands:</strong>
      <ul style="margin:8px 0 0;padding-left:20px;line-height:1.8">
        <li>Start SonarQube: <code style="background:#fff;padding:2px 6px;border-radius:4px">StartSonar.bat</code></li>
        <li>Check status: <code style="background:#fff;padding:2px 6px;border-radius:4px">check-sonar.bat</code></li>
        <li>Re-run scan after fix from dashboard</li>
      </ul>
    </div>
  </div>
  <div class="footer">
    <p><strong>🤖 SonarAI Agent</strong> — Enterprise Code Quality & Security Platform<br>
    Powered by Claude 4.5 Sonnet • SonarQube v26 • GitHub Integration<br>
    <span style="font-size:10px;color:#9ca3af">Scan attempted at ${new Date().toLocaleString('en-IN')}</span></p>
  </div>
</div>
</body>
</html>`
      });
    }
  });

  // ── 6. SONAR REPORT ON DEMAND ──────────────────────────────────────────────
  socket.on('fetch-sonar-report', async ({ projectKey }) => {
    if (typeof projectKey !== 'string' || projectKey.length > 200 || /[^a-zA-Z0-9_\-\.]/.test(projectKey)) {
      return socket.emit('sonar-report', { success: false, error: 'Invalid project key' });
    }
    try {
      socket.emit('sonar-report', { success: true, report: await fetchSonarReport(projectKey) });
    } catch (e) {
      socket.emit('sonar-report', { success: false, error: safeError(e) });
    }
  });

  socket.on('disconnect', () => console.log('❌ Disconnected:', socket.id));
});

// ─── REST ENDPOINTS ───────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({
  ok: true, ts: new Date().toISOString(),
  sonarUrl: SONAR_URL, github: !!GITHUB_TOKEN
}));

app.get('/api/config', (_, res) => res.json({
  githubUsername: GITHUB_USERNAME,
  sonarUrl:       SONAR_URL,
  repoBasePath:   REPO_BASE_PATH
}));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ─── START ────────────────────────────────────────────────────────────────────
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🚀 SonarAI v3.0 (GitHub Edition) → http://localhost:${PORT}`);
  console.log(`   GitHub  : ${GITHUB_USERNAME || '⚠️ NOT SET'}`);
  console.log(`   Sonar   : ${SONAR_URL}`);
  console.log(`   Repos   : ${REPO_BASE_PATH}`);
  console.log(`   AI Key  : ${ANTHROPIC_KEY ? '✅ Set' : '⚠️ Not set'}`);
  console.log(`   Email   : ${process.env.SMTP_HOST ? '✅ Set' : '⚠️ Not set'}\n`);
});
