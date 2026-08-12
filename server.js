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
const crypto     = require('crypto');
const fetch      = require('node-fetch');
// override:true — .env must win over any stale OS-level env vars of the same
// name (dotenv otherwise silently keeps whatever the shell/system already has set).
require('dotenv').config({ override: true });

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
const AI_MODEL        = process.env.AI_MODEL         || 'claude-sonnet-4-5';

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

  // Secrets Found
  const secretsFound = review.secretsFound || { detected: false, count: 0, secrets: [] };
  const totalCodeLines = review.totalCodeLines || review.linesOfCode || 0;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:'Segoe UI',sans-serif;background:#f4f7fa;padding:20px;margin:0;color:#1f2937}.container{max-width:800px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.12)}.header{background:linear-gradient(135deg,#8b5cf6,#7c3aed);color:#fff;padding:40px 32px;text-align:center}.header h1{margin:0 0 8px;font-size:28px;font-weight:700}.header p{margin:0;opacity:0.95;font-size:15px}.score-section{background:#f9fafb;padding:32px;text-align:center;border-bottom:1px solid #e5e7eb}.score-circle{width:140px;height:140px;border-radius:50%;margin:0 auto 16px;display:flex;align-items:center;justify-content:center;font-size:48px;font-weight:700;border:8px solid}.stats-row{display:flex;justify-content:space-around;padding:20px 32px;background:#f9fafb;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb}.stat-value{font-size:28px;font-weight:700;font-family:monospace;margin-bottom:4px}.stat-label{font-size:12px;color:#6b7280;font-weight:600}.metrics-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding:32px}.metric-card{background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:20px;text-align:center}.bar-container{background:#f3f4f6;border-radius:8px;height:32px;overflow:hidden;margin:8px 0}.bar-fill{height:100%;display:flex;align-items:center;padding:0 12px;color:#fff;font-weight:700;font-size:13px}.section{padding:32px;border-top:1px solid #e5e7eb}.section h2{margin:0 0 20px;color:#111827;font-size:20px;font-weight:700}.issue-card{background:#f9fafb;border-left:4px solid;border-radius:8px;padding:16px;margin-bottom:12px}.issue-card.critical{border-color:#ef4444;background:rgba(239,68,68,0.05)}.issue-card.major{border-color:#f59e0b;background:rgba(245,158,11,0.05)}.issue-card.minor{border-color:#3b82f6;background:rgba(59,130,246,0.05)}.badge{padding:4px 10px;border-radius:6px;font-size:10px;font-weight:700;text-transform:uppercase}.badge.critical{background:#ef4444;color:#fff}.badge.major{background:#f59e0b;color:#fff}.badge.minor{background:#3b82f6;color:#fff}.issue-title{font-size:15px;font-weight:700;color:#111827;margin:8px 0}.issue-location{font-size:12px;color:#6b7280;margin-bottom:8px;font-family:monospace}.issue-description{font-size:13px;color:#374151;line-height:1.6;margin-bottom:12px}.fix-box{background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.3);border-radius:8px;padding:12px;margin-top:8px}.fix-box-title{font-size:12px;font-weight:700;color:#059669;margin-bottom:6px}.fix-box-content{font-size:13px;color:#047857;line-height:1.6}.congratulations{background:linear-gradient(135deg,rgba(16,185,129,0.1),rgba(5,150,105,0.1));border:2px solid #10b981;border-radius:12px;padding:24px;text-align:center}.congratulations h3{margin:0 0 12px;color:#059669;font-size:22px}.congratulations p{margin:0;color:#047857;font-size:14px;line-height:1.6}.footer{background:#f9fafb;padding:24px 32px;text-align:center;font-size:12px;color:#6b7280;border-top:1px solid #e5e7eb}</style></head><body><div class="container"><div class="header"><h1>${scoreEmoji} AI Code Review Report</h1><p><strong>Repository:</strong> ${repoName} • <strong>Branch:</strong> ${branch}</p><p style="font-size:13px;margin-top:8px;opacity:0.9">Analyzed by Claude Sonnet 4.5 (Anthropic AI)</p></div><div class="score-section"><div class="score-circle" style="border-color:${scoreColor};color:${scoreColor}">${score}</div><div style="font-size:14px;color:#6b7280;margin-top:8px;font-weight:600">OVERALL QUALITY SCORE</div><p style="font-size:13px;color:#6b7280;margin-top:12px">${review.summary || 'Code analysis complete'}</p></div><div class="stats-row"><div style="text-align:center"><div class="stat-value" style="color:#ef4444">${bugs}</div><div class="stat-label">Bugs</div></div><div style="text-align:center"><div class="stat-value" style="color:#3b82f6">${smells}</div><div class="stat-label">Code Smells</div></div><div style="text-align:center"><div class="stat-value" style="color:#6b7280">${totalCodeLines}</div><div class="stat-label">Total Code Lines</div></div><div style="text-align:center"><div class="stat-value" style="color:${secretsFound.detected ? '#dc2626' : '#10b981'}">${secretsFound.detected ? secretsFound.count : '✓'}</div><div class="stat-label">${secretsFound.detected ? 'Secrets Found' : 'No Secrets'}</div></div></div><div class="metrics-grid"><div class="metric-card"><div style="font-size:14px;color:#6b7280;margin-bottom:12px;font-weight:600">🔒 Security</div><div style="font-size:36px;font-weight:700;color:${security.score>=80?'#10b981':security.score>=60?'#f59e0b':'#ef4444'};margin-bottom:8px">${security.rating}</div><div class="bar-container"><div class="bar-fill" style="width:${security.score}%;background:${security.score>=80?'#10b981':security.score>=60?'#f59e0b':'#ef4444'}">${security.score}/100</div></div></div><div class="metric-card"><div style="font-size:14px;color:#6b7280;margin-bottom:12px;font-weight:600">🧹 Maintainability</div><div style="font-size:36px;font-weight:700;color:${maintainability.score>=80?'#10b981':maintainability.score>=60?'#f59e0b':'#ef4444'};margin-bottom:8px">${maintainability.rating}</div><div class="bar-container"><div class="bar-fill" style="width:${maintainability.score}%;background:${maintainability.score>=80?'#10b981':maintainability.score>=60?'#f59e0b':'#ef4444'}">${maintainability.score}/100</div></div></div><div class="metric-card"><div style="font-size:14px;color:#6b7280;margin-bottom:12px;font-weight:600">⚡ Performance</div><div style="font-size:36px;font-weight:700;color:${performance.score>=80?'#10b981':performance.score>=60?'#f59e0b':'#ef4444'};margin-bottom:8px">${performance.rating}</div><div class="bar-container"><div class="bar-fill" style="width:${performance.score}%;background:${performance.score>=80?'#10b981':performance.score>=60?'#f59e0b':'#ef4444'}">${performance.score}/100</div></div></div></div><div class="section" style="background:${secretsFound.detected ? 'rgba(239,68,68,0.05)' : 'rgba(16,185,129,0.05)'};border:2px solid ${secretsFound.detected ? '#ef4444' : '#10b981'};border-radius:12px;margin:32px"><h2><span style="color:${secretsFound.detected ? '#dc2626' : '#059669'}">${secretsFound.detected ? '🔐' : '✅'}</span> Secrets Scan ${secretsFound.detected ? '— Found ' + secretsFound.count : '— Clean'}</h2>${secretsFound.detected ? `<p style="color:#dc2626;font-weight:600;margin-bottom:16px">⚠️ Warning: ${secretsFound.count} potential secret(s) detected in your code (.env files excluded)</p>${secretsFound.secrets.map(secret => `<div class="issue-card critical"><div style="margin-bottom:8px"><span class="badge critical">${secret.severity}</span> <span class="badge" style="background:#dc2626;color:#fff">${secret.type}</span></div><div class="issue-title">🔑 ${secret.type} Detected</div><div class="issue-location">📍 ${secret.file}${secret.line ? ':' + secret.line : ''}</div><div class="issue-description">${secret.description}</div>${secret.pattern ? `<div style="background:rgba(0,0,0,0.05);border-radius:6px;padding:8px;margin-top:8px;font-family:monospace;font-size:12px;color:#374151">${secret.pattern}</div>` : ''}<div class="fix-box"><div class="fix-box-title">💡 Recommended Fix:</div><div class="fix-box-content">Move this credential to environment variables (.env file) and use process.env to access it. Never commit secrets to version control.</div></div></div>`).join('')}` : `<div style="text-align:center;padding:20px"><p style="color:#059669;font-size:15px;font-weight:600">✅ No hardcoded secrets, passwords, or API keys detected</p><p style="color:#047857;font-size:13px;margin-top:8px">Your code is clean! No sensitive credentials found in the scanned files (.env files are excluded from scan).</p></div>`}</div>${hasIssues ? `${criticalIssues.length > 0 ? `<div class="section"><h2><span style="color:#ef4444">🚨</span> Critical Issues (${criticalIssues.length})</h2>${criticalIssues.map(issue => `<div class="issue-card critical"><div style="margin-bottom:8px"><span class="badge critical">${issue.severity}</span> ${issue.category ? `<span class="badge" style="background:#6b7280;color:#fff">${issue.category}</span>` : ''} ${issue.cwe ? `<span class="badge" style="background:#dc2626;color:#fff">${issue.cwe}</span>` : ''}</div><div class="issue-title">${issue.title || 'Critical Issue'}</div><div class="issue-location">📍 ${issue.file || 'Unknown'}${issue.line ? ':' + issue.line : ''}</div><div class="issue-description">${issue.description || 'No description'}</div>${issue.fix ? `<div class="fix-box"><div class="fix-box-title">💡 Recommended Fix:</div><div class="fix-box-content">${issue.fix}</div></div>` : ''}</div>`).join('')}</div>` : ''}${majorIssues.length > 0 ? `<div class="section"><h2><span style="color:#f59e0b">⚠️</span> Major Issues (${majorIssues.length})</h2>${majorIssues.slice(0, 5).map(issue => `<div class="issue-card major"><div style="margin-bottom:8px"><span class="badge major">${issue.severity}</span> ${issue.category ? `<span class="badge" style="background:#6b7280;color:#fff">${issue.category}</span>` : ''}</div><div class="issue-title">${issue.title || 'Major Issue'}</div><div class="issue-location">📍 ${issue.file || 'Unknown'}${issue.line ? ':' + issue.line : ''}</div><div class="issue-description">${issue.description || 'No description'}</div>${issue.fix ? `<div class="fix-box"><div class="fix-box-title">💡 Recommended Fix:</div><div class="fix-box-content">${issue.fix}</div></div>` : ''}</div>`).join('')}${majorIssues.length > 5 ? `<p style="text-align:center;color:#6b7280;font-size:13px">...and ${majorIssues.length - 5} more major issues</p>` : ''}</div>` : ''}${minorIssues.length > 0 ? `<div class="section"><h2><span style="color:#3b82f6">ℹ️</span> Minor Issues (${minorIssues.length})</h2>${minorIssues.slice(0, 3).map(issue => `<div class="issue-card minor"><div style="margin-bottom:8px"><span class="badge minor">${issue.severity}</span> ${issue.category ? `<span class="badge" style="background:#6b7280;color:#fff">${issue.category}</span>` : ''}</div><div class="issue-title">${issue.title || 'Minor Issue'}</div><div class="issue-location">📍 ${issue.file || 'Unknown'}${issue.line ? ':' + issue.line : ''}</div><div class="issue-description">${issue.description || 'No description'}</div>${issue.fix ? `<div class="fix-box"><div class="fix-box-title">💡 Recommended Fix:</div><div class="fix-box-content">${issue.fix}</div></div>` : ''}</div>`).join('')}${minorIssues.length > 3 ? `<p style="text-align:center;color:#6b7280;font-size:13px">...and ${minorIssues.length - 3} more minor issues</p>` : ''}</div>` : ''}` : `<div class="section"><div class="congratulations"><h3>🎉 Excellent! No Issues Found</h3><p><strong>Congratulations!</strong> Your code passes all AI quality checks with flying colors. No security vulnerabilities, code smells, or performance issues detected. Keep up the great work! 🚀</p><p style="margin-top:12px;font-size:13px">Your code demonstrates best practices in security, maintainability, and performance.</p></div></div>`}${(review.recommendations||[]).length > 0 ? `<div class="section"><h2>💡 AI Recommendations</h2>${review.recommendations.slice(0,5).map((rec, i) => `<div style="background:#f9fafb;border-left:3px solid #8b5cf6;border-radius:6px;padding:12px;margin-bottom:8px"><span style="color:#8b5cf6;font-weight:700;margin-right:8px">${i+1}.</span>${rec}</div>`).join('')}</div>` : ''}<div class="footer"><p><strong>🤖 SonarQube AI Agent</strong> — Powered by Claude Sonnet 4.5 (Anthropic)</p><p style="margin-top:8px">Generated on ${new Date().toLocaleString('en-IN', {dateStyle:'medium',timeStyle:'short'})}</p><p style="margin-top:4px;font-size:11px">Technical Debt: ${metrics.technicalDebt || '0h'} • Total Issues: ${metrics.totalIssues || 0}</p></div></div></body></html>`;
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

// ─── SECRETS CLASSIFICATION & REDACTION ──────────────────────────────────────
// SonarQube's "Text Code Quality and Security" plugin flags hardcoded
// credentials as issues with a `secrets:` rule prefix. We also match on the
// issue message as a fallback in case a language-specific rule (not the
// dedicated secrets repo) is what caught it. Neither Sonar's issue payload
// nor our own code ever carries the actual secret value — only file/line/rule.
const SECRET_MESSAGE_PATTERN = /hard-?coded|credential|secret|password|api[\s_-]?key|access[\s_-]?token|private[\s_-]?key|auth[\s_-]?token/i;

function isSecretIssue(issue) {
  const rule = String(issue.rule || '');
  const msg  = String(issue.message || '');
  return rule.toLowerCase().startsWith('secrets:') || SECRET_MESSAGE_PATTERN.test(msg);
}

// Defensive redaction — masks anything token/secret-shaped that might end up
// in AI-generated text, even though the source data (Sonar issue metadata)
// never contains literal secret values.
function redactSecrets(text) {
  if (!text) return text;
  let out = String(text);
  out = out.replace(/sqa_[a-zA-Z0-9]+/g,        '[REDACTED_TOKEN]');
  out = out.replace(/sk-ant-[a-zA-Z0-9\-_]+/g,   '[REDACTED_TOKEN]');
  out = out.replace(/ghp_[a-zA-Z0-9]+/g,         '[REDACTED_TOKEN]');
  out = out.replace(/github_pat_[a-zA-Z0-9_]+/g, '[REDACTED_TOKEN]');
  out = out.replace(/AKIA[0-9A-Z]{16}/g,         '[REDACTED_TOKEN]');
  out = out.replace(/[a-zA-Z0-9+/]{40,}={0,2}/g, '[REDACTED_TOKEN]');
  return out;
}

// ─── LOCAL LANGUAGE DETECTION (filenames only — no file content read) ───────
const LANG_EXT_MAP = {
  cs: { name: 'C#', type: 'backend' }, java: { name: 'Java', type: 'backend' },
  py: { name: 'Python', type: 'backend' }, go: { name: 'Go', type: 'backend' },
  rb: { name: 'Ruby', type: 'backend' }, php: { name: 'PHP', type: 'backend' },
  cpp: { name: 'C++', type: 'backend' }, c: { name: 'C', type: 'backend' },
  js: { name: 'JavaScript', type: 'backend' }, ts: { name: 'TypeScript', type: 'backend' },
  html: { name: 'HTML', type: 'frontend' }, css: { name: 'CSS', type: 'frontend' },
  scss: { name: 'SCSS', type: 'frontend' },
  jsx: { name: 'React JSX', type: 'frontend' }, tsx: { name: 'React TSX', type: 'frontend' },
  vue: { name: 'Vue', type: 'frontend' }
};

function scanLanguages(dir, buckets = { backend: {}, frontend: {} }, depth = 0, maxDepth = 4) {
  if (depth > maxDepth) return buckets;
  let entries;
  try { entries = fs.readdirSync(dir); } catch (_) { return buckets; }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(full); } catch (_) { continue; }
    if (stat.isDirectory()) {
      scanLanguages(full, buckets, depth + 1, maxDepth);
    } else if (stat.isFile()) {
      const ext = name.split('.').pop().toLowerCase();
      const info = LANG_EXT_MAP[ext];
      if (info) buckets[info.type][info.name] = (buckets[info.type][info.name] || 0) + 1;
    }
  }
  return buckets;
}

// ─── AI REVIEW REPORT PERSISTENCE ────────────────────────────────────────────
const DATA_DIR        = path.join(__dirname, 'data');
const AI_REPORTS_FILE = path.join(DATA_DIR, 'ai-reports.json');
const MAX_STORED_REPORTS = 30;

function loadAiReports() {
  try { return JSON.parse(fs.readFileSync(AI_REPORTS_FILE, 'utf8')); }
  catch (_) { return []; }
}

function saveAiReport(entry) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const reports = loadAiReports();
    reports.unshift(entry);
    fs.writeFileSync(AI_REPORTS_FILE, JSON.stringify(reports.slice(0, MAX_STORED_REPORTS), null, 2));
  } catch (e) {
    console.error('[ai-reports] Failed to persist:', safeError(e));
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   AUTHENTICATION & ROLE-BASED AUTHORIZATION

   Local account store in data/users.json. Passwords are scrypt-hashed with a
   per-user salt; sessions are stateless HMAC-signed cookies keyed off a secret
   generated on first boot. No external auth dependencies.
   ═══════════════════════════════════════════════════════════════════════════ */
const USERS_FILE     = path.join(DATA_DIR, 'users.json');
const SESSION_COOKIE = 'sai_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;   // 12 hours
const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days with "remember me"

// Every action the dashboard can gate on.
const ALL_PERMISSIONS = [
  'users.view', 'users.create', 'users.edit', 'users.delete',
  'projects.edit', 'scan.run', 'review.run',
  'repos.view', 'reports.view', 'reports.delete',
  'settings.edit', 'audit.view'
];

// '*' means every permission, present and future — admins get the lot.
const ROLE_PERMISSIONS = {
  admin:    ['*'],
  reviewer: ['repos.view', 'reports.view', 'scan.run', 'review.run', 'projects.edit', 'audit.view'],
  viewer:   ['repos.view', 'reports.view']
};
const ROLES = Object.keys(ROLE_PERMISSIONS);

function permissionsFor(role) {
  const p = ROLE_PERMISSIONS[role];
  if (!p) return [];
  return p[0] === '*' ? ALL_PERMISSIONS.slice() : p.slice();
}

function hasPerm(user, perm) {
  if (!user) return false;
  const p = ROLE_PERMISSIONS[user.role] || [];
  return p[0] === '*' || p.includes(perm);
}

// ── Store ───────────────────────────────────────────────────────────────────
function loadAuthStore() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch (_) { return { secret: '', users: [] }; }
}

function saveAuthStore(store) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function verifyPassword(password, user) {
  if (!user || !user.salt || !user.passwordHash) return false;
  const candidate = Buffer.from(hashPassword(password, user.salt), 'hex');
  const stored    = Buffer.from(user.passwordHash, 'hex');
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

function makeUser({ username, password, name, email, role }) {
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    id: crypto.randomUUID(),
    username: String(username).toLowerCase().trim(),
    name: name || username,
    email: email || '',
    role: ROLES.includes(role) ? role : 'viewer',
    salt,
    passwordHash: hashPassword(password, salt),
    active: true,
    createdAt: new Date().toISOString(),
    lastLogin: null
  };
}

// First boot: create the admin account. Password comes from ADMIN_PASSWORD in
// .env when set, otherwise one is generated and printed once to the console.
function ensureAuthStore() {
  const store = loadAuthStore();
  let changed = false;

  if (!store.secret) { store.secret = crypto.randomBytes(48).toString('hex'); changed = true; }
  if (!Array.isArray(store.users)) { store.users = []; changed = true; }

  if (!store.users.some(u => u.role === 'admin')) {
    const username = (process.env.ADMIN_USERNAME || 'admin').toLowerCase().trim();
    const generated = !process.env.ADMIN_PASSWORD;
    const password  = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
    store.users.push(makeUser({
      username, password, role: 'admin',
      name: process.env.ADMIN_NAME || 'Admin User',
      email: process.env.ADMIN_EMAIL || NOTIFY_EMAIL || ''
    }));
    changed = true;
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║  ADMIN ACCOUNT CREATED                                       ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  Username : ${username.padEnd(48)}║`);
    console.log(`║  Password : ${String(password).padEnd(48)}║`);
    console.log('║                                                              ║');
    console.log(generated
      ? '║  Generated once — save it now, it is not shown again.        ║'
      : '║  Taken from ADMIN_PASSWORD in .env                           ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');
  }

  if (changed) saveAuthStore(store);
  return store;
}

let authStore = ensureAuthStore();

// ── Sessions: base64url(payload).hmac ───────────────────────────────────────
function signSession(userId, ttlMs) {
  const payload = Buffer
    .from(JSON.stringify({ uid: userId, exp: Date.now() + ttlMs }))
    .toString('base64url');
  const sig = crypto.createHmac('sha256', authStore.secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function userFromToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', authStore.secret).update(payload).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!uid || !exp || Date.now() > exp) return null;
    const user = authStore.users.find(u => u.id === uid);
    return user && user.active !== false ? user : null;
  } catch (_) { return null; }
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

const currentUser = req => userFromToken(parseCookies(req.headers.cookie)[SESSION_COOKIE]);

// Public shape — never leaks salt or hash.
const publicUser = u => ({
  id: u.id, username: u.username, name: u.name, email: u.email, role: u.role,
  active: u.active !== false, createdAt: u.createdAt, lastLogin: u.lastLogin,
  permissions: permissionsFor(u.role)
});

// ── Login throttling (per IP) ───────────────────────────────────────────────
const loginAttempts = new Map();
function loginAllowed(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + 15 * 60 * 1000; }
  loginAttempts.set(ip, rec);
  return rec.count < 8;
}
function noteFailedLogin(ip) {
  const rec = loginAttempts.get(ip);
  if (rec) rec.count++;
}

// ── Auth routes (open — registered before the gate) ─────────────────────────
app.get('/login', (req, res) => {
  if (currentUser(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/auth/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!loginAllowed(ip)) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  }
  const { username, password, remember } = req.body || {};
  const user = authStore.users.find(u => u.username === String(username || '').toLowerCase().trim());

  // Same message for unknown user, wrong password and disabled account —
  // never reveal which one it was.
  if (!user || user.active === false || !verifyPassword(password || '', user)) {
    noteFailedLogin(ip);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  user.lastLogin = new Date().toISOString();
  saveAuthStore(authStore);

  const ttl = remember ? REMEMBER_TTL_MS : SESSION_TTL_MS;
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${signSession(user.id, ttl)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(ttl / 1000)}`);
  console.log(`🔐 Login: ${user.username} (${user.role})`);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user: publicUser(user), roles: ROLES, allPermissions: ALL_PERMISSIONS });
});

// ── The gate: everything past here needs a session ──────────────────────────
const PUBLIC_PATHS = new Set(['/login', '/login.html', '/bn-logo.svg', '/favicon.ico']);

app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path) || req.path.startsWith('/socket.io/')) return next();
  const user = currentUser(req);
  if (user) { req.user = user; return next(); }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  return res.redirect('/login');
});

app.use(express.static('public'));

// Changing your own password needs a session, not a permission — otherwise a
// viewer could never rotate their own credentials. Current password required.
app.post('/api/auth/password', (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!verifyPassword(currentPassword || '', req.user)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  if (String(newPassword || '').length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  req.user.salt = crypto.randomBytes(16).toString('hex');
  req.user.passwordHash = hashPassword(newPassword, req.user.salt);
  saveAuthStore(authStore);
  console.log(`🔑 Password changed by ${req.user.username}`);
  res.json({ ok: true });
});

function requirePerm(perm) {
  return (req, res, next) => hasPerm(req.user, perm)
    ? next()
    : res.status(403).json({ error: `Permission denied: ${perm} is not granted to the ${req.user.role} role.` });
}

// ── User management (admin) ─────────────────────────────────────────────────
app.get('/api/users', requirePerm('users.view'), (req, res) => {
  res.json({ users: authStore.users.map(publicUser), roles: ROLES, allPermissions: ALL_PERMISSIONS });
});

app.post('/api/users', requirePerm('users.create'), (req, res) => {
  const { username, password, name, email, role } = req.body || {};
  const uname = String(username || '').toLowerCase().trim();

  if (!/^[a-z0-9._-]{3,32}$/.test(uname)) {
    return res.status(400).json({ error: 'Username must be 3–32 characters: letters, digits, dot, dash or underscore.' });
  }
  if (String(password || '').length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: `Role must be one of: ${ROLES.join(', ')}.` });
  }
  if (authStore.users.some(u => u.username === uname)) {
    return res.status(409).json({ error: 'That username already exists.' });
  }

  const user = makeUser({ username: uname, password, name, email, role });
  authStore.users.push(user);
  saveAuthStore(authStore);
  console.log(`👤 User created: ${uname} (${role}) by ${req.user.username}`);
  res.status(201).json({ user: publicUser(user) });
});

app.patch('/api/users/:id', requirePerm('users.edit'), (req, res) => {
  const user = authStore.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const { name, email, role, active, password } = req.body || {};
  const admins = authStore.users.filter(u => u.role === 'admin' && u.active !== false);
  const lastAdmin = user.role === 'admin' && admins.length === 1 && admins[0].id === user.id;

  // Guard against locking everyone out of the agent.
  if (lastAdmin && ((role && role !== 'admin') || active === false)) {
    return res.status(400).json({ error: 'This is the last active admin — demoting or disabling it would lock everyone out.' });
  }

  if (name !== undefined)  user.name  = String(name).slice(0, 80);
  if (email !== undefined) user.email = String(email).slice(0, 120);
  if (role !== undefined) {
    if (!ROLES.includes(role)) return res.status(400).json({ error: `Role must be one of: ${ROLES.join(', ')}.` });
    user.role = role;
  }
  if (active !== undefined) user.active = !!active;
  if (password) {
    if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    user.salt = crypto.randomBytes(16).toString('hex');
    user.passwordHash = hashPassword(password, user.salt);
  }

  saveAuthStore(authStore);
  console.log(`👤 User updated: ${user.username} by ${req.user.username}`);
  res.json({ user: publicUser(user) });
});

app.delete('/api/users/:id', requirePerm('users.delete'), (req, res) => {
  const user = authStore.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'You cannot delete the account you are signed in with.' });

  const admins = authStore.users.filter(u => u.role === 'admin' && u.active !== false);
  if (user.role === 'admin' && admins.length === 1) {
    return res.status(400).json({ error: 'This is the last active admin — deleting it would lock everyone out.' });
  }

  authStore.users = authStore.users.filter(u => u.id !== user.id);
  saveAuthStore(authStore);
  console.log(`👤 User deleted: ${user.username} by ${req.user.username}`);
  res.json({ ok: true });
});

// ─── SOCKET EVENTS ────────────────────────────────────────────────────────────
// Sockets carry the same session cookie — reject anything unauthenticated.
io.use((socket, next) => {
  const user = userFromToken(parseCookies(socket.handshake.headers.cookie)[SESSION_COOKIE]);
  if (!user) return next(new Error('unauthorized'));
  socket.data.user = user;
  next();
});

// Guard for socket events: replies on `failEvent` instead of silently ignoring.
function socketAllowed(socket, perm, failEvent) {
  if (hasPerm(socket.data.user, perm)) return true;
  socket.emit(failEvent, {
    success: false,
    error: `Permission denied — the ${socket.data.user.role} role cannot perform this action.`
  });
  return false;
}

io.on('connection', (socket) => {
  console.log(`✅ Client: ${socket.id} — ${socket.data.user.username} (${socket.data.user.role})`);

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
    if (!socketAllowed(socket, 'scan.run', 'git-result')) return;
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

        // Inject GitHub auth as a per-command header — don't rely on the OS
        // credential manager (fails silently/hangs for repos not cloned by this tool)
        const authHeader = `AUTHORIZATION: basic ${Buffer.from(`${GITHUB_USERNAME}:${GITHUB_TOKEN}`).toString('base64')}`;
        const authArgs = ['-c', `http.extraheader=${authHeader}`];

        log(`🔀 Fetching latest...`);
        await gitExec([...authArgs, 'fetch', '--all', '--prune'], repoPath);
        log(`✅ Fetch complete`);

        log(`🔀 Checking out ${branch}...`);
        await gitExec(['checkout', branch], repoPath);
        log(`✅ Checkout complete`);

        log(`⬇️  Pulling latest changes...`);
        await gitExec([...authArgs, 'pull', 'origin', branch], repoPath);
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

  // ── 4. AI CODE REVIEW — based on SonarQube findings, NEVER raw source ───────
  socket.on('ai-review', async ({ branch, repoName, projectKey }) => {
    if (!socketAllowed(socket, 'review.run', 'review-result')) return;
    if (!rateLimiter(socket.id, 'ai-review')) return socket.emit('review-result', { success: false, error: 'Rate limit exceeded' });
    if (!validateRepoName(repoName))  return socket.emit('review-result', { success: false, error: 'Invalid repo name' });
    if (!validateBranchName(branch))  return socket.emit('review-result', { success: false, error: 'Invalid branch name' });
    if (typeof projectKey !== 'string' || projectKey.length === 0 || projectKey.length > 200 || /[^a-zA-Z0-9_\-\.]/.test(projectKey)) {
      return socket.emit('review-result', { success: false, error: 'No SonarQube scan found — run Sonar Scan first, then AI Review.' });
    }

    const log = msg => socket.emit('review-log', msg);
    log('🔎 Loading SonarQube findings...');

    if (!ANTHROPIC_KEY) {
      return socket.emit('review-result', { success: false, error: 'ANTHROPIC_API_KEY not set in .env' });
    }

    try {
      const sonarReport = await fetchSonarReport(projectKey);
      const totalCodeLines = parseInt(sonarReport.metrics.ncloc, 10) || 0;

      log(`📊 ${sonarReport.totalIssues} SonarQube issue(s) • ${totalCodeLines} lines of code`);

      // Compact, code-free payload for Claude — file/line/rule/message/type/severity only.
      // Sorted worst-first, capped, so we never ship an unbounded prompt.
      const severityRank = { BLOCKER: 0, CRITICAL: 1, MAJOR: 2, MINOR: 3, INFO: 4 };
      const sonarIssues = sonarReport.issues
        .slice()
        .sort((a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9))
        .slice(0, 60)
        .map(i => ({
          rule: i.rule,
          type: i.type,
          severity: i.severity,
          file: (i.component || '').replace(`${projectKey}:`, ''),
          line: i.line || i.textRange?.startLine || null,
          message: redactSecrets(i.message || '')
        }));

      // Deterministic secrets classification — do NOT rely on the AI to catch
      // this reliably. We know from Sonar's rule metadata exactly which
      // issues are hardcoded-credential findings; the actual secret value is
      // never present in this data, so there is nothing to leak or redact
      // beyond the defensive pass already applied above.
      const secretIssues = sonarReport.issues.filter(isSecretIssue).map(i => ({
        type:        i.rule && i.rule.toLowerCase().startsWith('secrets:') ? 'Hardcoded Credential' : 'Possible Credential',
        file:        (i.component || '').replace(`${projectKey}:`, ''),
        line:        i.line || i.textRange?.startLine || null,
        severity:    'critical',
        rule:        i.rule,
        description: redactSecrets(i.message || 'Hardcoded credential detected by SonarQube.')
      }));

      log('🧠 Calling Claude AI — analyzing SonarQube findings (no source code sent)...');
      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: AI_MODEL, max_tokens: 4000, temperature: 0.2,
          system: `You are a senior code security and quality analyst. You will be given a JSON summary of SonarQube static-analysis findings for a repository — NOT source code, only issue metadata (rule, file, line, message, severity, type) and aggregate metrics. Analyze and prioritize these findings and return ONLY valid JSON (no markdown, no explanations):

{
  "summary": "Brief overall assessment based on the findings",
  "score": number (0-100, derived from severity/volume of findings),
  "issues": [
    {
      "severity": "critical|major|minor",
      "category": "security|quality|performance|maintainability|secrets",
      "file": "filename",
      "line": number or null,
      "title": "Short title",
      "description": "Explanation grounded in the given Sonar finding — do not invent details not implied by it",
      "fix": "How to fix it",
      "cwe": "CWE-xxx (if security issue)" or null
    }
  ],
  "security": { "rating": "A|B|C|D|E", "score": number (0-100), "findings": ["specific findings"], "vulnerabilities": [{"type":"...","severity":"critical|high|medium|low","location":"file:line","description":"..."}] },
  "maintainability": { "rating": "A|B|C|D|E", "score": number (0-100), "findings": ["specific findings"], "codeSmells": [{"type":"...","location":"file:line","description":"..."}] },
  "performance": { "rating": "A|B|C|D|E", "score": number (0-100), "findings": ["specific findings"], "bottlenecks": [{"type":"...","location":"file:line","impact":"..."}] },
  "recommendations": ["actionable improvements in priority order"],
  "metrics": { "totalIssues": number, "critical": number, "major": number, "minor": number, "technicalDebt": "estimated time to fix (e.g., 2h, 1d)" }
}

IMPORTANT:
- Base every issue strictly on the provided Sonar findings — never fabricate file/line references.
- Any finding whose rule starts with "secrets:" (already flagged for you in a separate list) MUST also appear in "issues" with category "secrets" and severity "critical".
- Never output an actual secret/credential value — the input data never contains one, only rule/file/line/message.
- Ratings should reflect the real proportion of BLOCKER/CRITICAL vs MINOR findings.`,
          messages: [{ role: 'user', content: `Repository: ${repoName} • Branch: ${branch}
Total lines of code (SonarQube ncloc): ${totalCodeLines}
Total SonarQube issues: ${sonarReport.totalIssues}
Metrics: bugs=${sonarReport.metrics.bugs || 0}, vulnerabilities=${sonarReport.metrics.vulnerabilities || 0}, code_smells=${sonarReport.metrics.code_smells || 0}, security_hotspots=${sonarReport.metrics.security_hotspots || 0}, reliability_rating=${sonarReport.metrics.reliability_rating || '—'}, security_rating=${sonarReport.metrics.security_rating || '—'}, sqale_rating=${sonarReport.metrics.sqale_rating || '—'}

Known hardcoded-credential findings (already detected by SonarQube's secrets rules — surface these prominently):
${JSON.stringify(secretIssues.map(s => ({ file: s.file, line: s.line, rule: s.rule, message: s.description })), null, 2)}

Full SonarQube issue list (metadata only, no source code):
${JSON.stringify(sonarIssues, null, 2)}` }]
        })
      });

      const aiData = await aiRes.json();
      if (!aiRes.ok || aiData.error) {
        const apiErrMsg = aiData.error?.message || `Anthropic API returned ${aiRes.status}`;
        log(`❌ Claude AI call failed: ${apiErrMsg}`);
        return socket.emit('review-result', { success: false, error: `AI analysis failed: ${safeError({ message: apiErrMsg })}` });
      }
      const raw = aiData.content?.[0]?.text || '{}';
      let review;
      try {
        review = JSON.parse(raw.replace(/```json|```/g, '').trim());
      } catch {
        review = {
          summary: 'Review complete (parse error)', score: 75, issues: [],
          security: { rating: 'B', score: 75, findings: [], vulnerabilities: [] },
          maintainability: { rating: 'B', score: 75, findings: [], codeSmells: [] },
          performance: { rating: 'B', score: 75, findings: [], bottlenecks: [] },
          recommendations: [],
          metrics: { totalIssues: 0, critical: 0, major: 0, minor: 0, technicalDebt: '0h' }
        };
      }

      // Deterministic safety net — force the secrets block from Sonar's own
      // classification rather than trusting the AI's judgment for this.
      review.secretsFound = {
        detected: secretIssues.length > 0,
        count:    secretIssues.length,
        secrets:  secretIssues
      };
      // Merge deterministic secret issues into the issues list if the AI missed any.
      const existingSecretKeys = new Set((review.issues || []).filter(i => i.category === 'secrets').map(i => `${i.file}:${i.line}`));
      for (const s of secretIssues) {
        const k = `${s.file}:${s.line}`;
        if (!existingSecretKeys.has(k)) {
          (review.issues = review.issues || []).push({
            severity: 'critical', category: 'secrets', file: s.file, line: s.line,
            title: `🔐 ${s.type} Detected`, description: s.description,
            fix: 'Move this credential to environment variables (.env) and rotate it immediately if it was ever committed.',
            cwe: 'CWE-798'
          });
        }
      }

      // Redact defensively across every text field before this ever leaves the server.
      (review.issues || []).forEach(i => { i.description = redactSecrets(i.description); i.title = redactSecrets(i.title); });
      review.summary = redactSecrets(review.summary || '');

      // FORCE SET totals from Sonar's own measures (don't trust AI response).
      review.totalCodeLines = totalCodeLines;
      review.linesOfCode    = totalCodeLines;
      review.metrics = review.metrics || {};
      review.metrics.totalIssues = sonarReport.totalIssues;
      review.metrics.critical    = (review.issues || []).filter(i => i.severity === 'critical').length;
      review.metrics.major       = (review.issues || []).filter(i => i.severity === 'major').length;
      review.metrics.minor       = (review.issues || []).filter(i => i.severity === 'minor').length;

      // Local, content-free language detection (filenames only).
      const repoPath = getRepoPath(repoName);
      review.languagesDetected = fs.existsSync(repoPath) ? scanLanguages(repoPath) : { backend: {}, frontend: {} };
      const allLangs = { ...review.languagesDetected.backend, ...review.languagesDetected.frontend };
      review.primaryLanguage = Object.keys(allLangs).sort((a, b) => allLangs[b] - allLangs[a])[0] || 'Unknown';
      review.files = sonarIssues.reduce((acc, i) => (i.file && !acc.includes(i.file) ? [...acc, i.file] : acc), []);
      review.sonarProjectKey = projectKey;

      log(`✅ AI analysis complete — Score: ${review.score ?? '—'}/100${secretIssues.length ? ` • 🔐 ${secretIssues.length} secret(s) flagged` : ''}`);

      // Persist for the "AI Reports" dashboard section.
      saveAiReport({
        projectKey, repoName, branch,
        timestamp:    new Date().toISOString(),
        score:        review.score ?? 0,
        totalIssues:  review.metrics.totalIssues,
        secretsCount: secretIssues.length,
        review
      });

      socket.emit('review-result', { success: true, branch, repoName, projectKey, review });

      // Single consolidated notification — the "Notify" step of the flow.
      log('📧 Sending AI Review notification...');
      try {
        const reportHTML = generateAIReviewReport(review, repoName, branch);
        const score = review.score || 0;
        const scoreEmoji = secretIssues.length ? '🔐' : score >= 80 ? '🎉' : score >= 60 ? '⚠️' : '🚨';
        await sendEmail({
          to: NOTIFY_EMAIL,
          subject: `${scoreEmoji} AI Review (SonarQube-based) • ${repoName} (${branch}) • Score: ${score}/100${secretIssues.length ? ` • ${secretIssues.length} secret(s) found` : ''}`,
          html: reportHTML
        });
        log('✅ Notification sent');
      } catch (emailErr) {
        log(`⚠️ Email sending failed: ${safeError(emailErr)}`);
      }
    } catch (e) {
      log(`❌ ${safeError(e)}`);
      socket.emit('review-result', { success: false, error: safeError(e) });
    }
  });

  // ── 4b. AI REPORTS — list & fetch persisted reports for the dashboard ───────
  socket.on('fetch-ai-reports', () => {
    const reports = loadAiReports().map(r => ({
      projectKey: r.projectKey, repoName: r.repoName, branch: r.branch,
      timestamp: r.timestamp, score: r.score, totalIssues: r.totalIssues, secretsCount: r.secretsCount
    }));
    socket.emit('ai-reports', { success: true, reports });
  });

  socket.on('fetch-ai-report', ({ projectKey }) => {
    if (typeof projectKey !== 'string' || /[^a-zA-Z0-9_\-\.]/.test(projectKey)) {
      return socket.emit('ai-report-detail', { success: false, error: 'Invalid project key' });
    }
    const found = loadAiReports().find(r => r.projectKey === projectKey);
    if (!found) return socket.emit('ai-report-detail', { success: false, error: 'Report not found' });
    socket.emit('ai-report-detail', { success: true, repoName: found.repoName, branch: found.branch, review: found.review });
  });

  // ── 5. SONARQUBE SCAN ──────────────────────────────────────────────────────
  socket.on('sonar-scan', async ({ branch, repoName, slnFile }) => {
    if (!socketAllowed(socket, 'scan.run', 'scan-complete')) return;
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

    // Local, content-free language tally (filenames only) for the dashboard's
    // Programming Languages card — never sent anywhere, just displayed.
    const languagesDetected = scanLanguages(repoPath);

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
          `/d:sonar.exclusions=**/node_modules/**,**/.git/**,**/bin/**,**/obj/**,**/.env,**/.env.*`
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
sonar.exclusions=node_modules/**,coverage/**,dist/**,build/**,.git/**,.claude/**,.wolf/**,data/**,**/*.test.js,**/*.spec.js,**/.env,**/.env.*
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
      socket.emit('scan-complete', { success: true, branch, repoName, projectKey, report, languagesDetected });
      log('success', `✅ Scan complete — ${report.totalIssues} issues found`);
      log('info',    `📊 View: ${SONAR_URL}/dashboard?id=${encodeURIComponent(projectKey)}`);
      log('info',    `➡️  Next: run Level 1 (AI Review) — notification is sent once that finishes.`);

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
  repoBasePath:   REPO_BASE_PATH,
  // Integration status — booleans only, never the secrets themselves.
  githubConfigured: !!GITHUB_TOKEN,
  sonarConfigured:  !!SONAR_TOKEN,
  aiConfigured:     !!ANTHROPIC_KEY,
  smtpConfigured:   !!process.env.SMTP_HOST,
  aiModel:          AI_MODEL,
  notifyEmail:      NOTIFY_EMAIL,
  smtpHost:         process.env.SMTP_HOST || ''
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
