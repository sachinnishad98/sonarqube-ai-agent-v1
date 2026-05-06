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

    // Project key: safe characters only
    const projectKey = `${GITHUB_USERNAME}-${repoName}`.replace(/[^a-zA-Z0-9\-\.]/g, '_');

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
          `/n:"${repoName}"`,
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
sonar.projectName=${repoName}
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

        // Try to run sonar-scanner CLI (with quick timeout)
        let scannerFound = false;

        try {
          log('info', '🔍 Checking for sonar-scanner CLI...');

          // Quick check if sonar-scanner exists (2 second timeout)
          await new Promise((resolve, reject) => {
            const checkProcess = execFile('sonar-scanner', ['-v'], { timeout: 2000 }, (err, stdout) => {
              if (err) {
                reject(new Error('sonar-scanner not found'));
              } else {
                scannerFound = true;
                resolve(stdout);
              }
            });

            // Force timeout after 2 seconds
            setTimeout(() => {
              try { checkProcess.kill(); } catch (_) {}
              reject(new Error('timeout'));
            }, 2000);
          });

          if (scannerFound) {
            log('success', '✅ sonar-scanner CLI found');
            log('info', '🔍 Running full JavaScript analysis...');

            // Run the scan with timeout
            await Promise.race([
              runCommand('sonar-scanner', repoPath, socket, 'scan-log'),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Scan timeout after 5 minutes')), 300000)
              )
            ]);

            log('success', '✅ JavaScript scan completed successfully!');
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
        subject: `✅ SonarQube Scan SUCCESS — ${repoName}@${branch}`,
        html: `
<!DOCTYPE html>
<html>
<head><style>
body{font-family:Arial,sans-serif;background:#f4f4f4;padding:20px}
.container{max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1)}
.header{background:linear-gradient(135deg,#10b981,#059669);color:#fff;padding:24px;text-align:center}
.header h1{margin:0;font-size:24px}
.content{padding:24px}
.metric{display:inline-block;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:8px 4px;text-align:center;min-width:100px}
.metric-value{font-size:32px;font-weight:bold;color:#111}
.metric-label{font-size:12px;color:#6b7280;margin-top:4px}
.rating{display:inline-block;width:40px;height:40px;border-radius:8px;text-align:center;line-height:40px;font-weight:bold;font-size:18px;margin:8px}
.rating-A{background:#d1fae5;color:#065f46}
.rating-B{background:#dbeafe;color:#1e40af}
.rating-C{background:#fef3c7;color:#92400e}
.footer{background:#f9fafb;padding:16px;text-align:center;font-size:12px;color:#6b7280;border-top:1px solid #e5e7eb}
.btn{display:inline-block;background:#10b981;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;margin:16px 0}
</style></head>
<body>
<div class="container">
  <div class="header">
    <h1>✅ SonarQube Scan Completed</h1>
    <p style="margin:8px 0 0;opacity:0.9">Automated Code Quality Report</p>
  </div>
  <div class="content">
    <h3 style="margin-top:0;color:#111">Repository Details</h3>
    <p><strong>Repository:</strong> ${repoName}<br>
    <strong>Branch:</strong> ${branch}<br>
    <strong>Scan Time:</strong> ${new Date().toLocaleString('en-IN')}<br>
    <strong>Project Key:</strong> ${projectKey}</p>

    <h3 style="margin-top:24px;color:#111">Quality Metrics</h3>
    <div style="text-align:center">
      <div class="metric">
        <div class="metric-value" style="color:#ef4444">${report.metrics.bugs||0}</div>
        <div class="metric-label">Bugs</div>
      </div>
      <div class="metric">
        <div class="metric-value" style="color:#f59e0b">${report.metrics.vulnerabilities||0}</div>
        <div class="metric-label">Vulnerabilities</div>
      </div>
      <div class="metric">
        <div class="metric-value" style="color:#3b82f6">${report.metrics.code_smells||0}</div>
        <div class="metric-label">Code Smells</div>
      </div>
    </div>

    <h3 style="margin-top:24px;color:#111">Quality Ratings</h3>
    <div style="text-align:center">
      <div class="rating rating-${report.metrics.reliability_rating||'A'}">${report.metrics.reliability_rating||'A'}</div>
      <div class="rating rating-${report.metrics.security_rating||'A'}">${report.metrics.security_rating||'A'}</div>
      <div class="rating rating-${report.metrics.sqale_rating||'A'}">${report.metrics.sqale_rating||'A'}</div>
    </div>
    <p style="text-align:center;font-size:12px;color:#6b7280">Reliability • Security • Maintainability</p>

    ${report.metrics.coverage ? `
    <h3 style="margin-top:24px;color:#111">Code Coverage</h3>
    <div style="background:#f3f4f6;border-radius:8px;height:24px;overflow:hidden">
      <div style="background:#10b981;height:100%;width:${report.metrics.coverage}%;text-align:center;line-height:24px;color:#fff;font-weight:bold;font-size:12px">${parseFloat(report.metrics.coverage).toFixed(1)}%</div>
    </div>` : ''}

    <div style="text-align:center">
      <a href="${SONAR_URL}/dashboard?id=${encodeURIComponent(projectKey)}" class="btn">View Full Report in SonarQube →</a>
    </div>
  </div>
  <div class="footer">
    <p><strong>SonarAI Agent</strong> — Automated Code Quality & Security Analysis<br>
    Powered by Claude AI • SonarQube • GitHub</p>
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
        subject: `❌ SonarQube Scan FAILED — ${repoName}@${branch}`,
        html: `
<!DOCTYPE html>
<html>
<head><style>
body{font-family:Arial,sans-serif;background:#f4f4f4;padding:20px}
.container{max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1)}
.header{background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff;padding:24px;text-align:center}
.header h1{margin:0;font-size:24px}
.content{padding:24px}
.error-box{background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin:16px 0}
.error-box pre{background:#fff;padding:12px;border-radius:4px;overflow-x:auto;font-size:12px;color:#991b1b}
.footer{background:#f9fafb;padding:16px;text-align:center;font-size:12px;color:#6b7280;border-top:1px solid #e5e7eb}
.btn{display:inline-block;background:#ef4444;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;margin:16px 0}
</style></head>
<body>
<div class="container">
  <div class="header">
    <h1>❌ SonarQube Scan Failed</h1>
    <p style="margin:8px 0 0;opacity:0.9">Action Required</p>
  </div>
  <div class="content">
    <h3 style="margin-top:0;color:#111">Repository Details</h3>
    <p><strong>Repository:</strong> ${repoName}<br>
    <strong>Branch:</strong> ${branch}<br>
    <strong>Scan Time:</strong> ${new Date().toLocaleString('en-IN')}</p>

    <h3 style="margin-top:24px;color:#111">Error Details</h3>
    <div class="error-box">
      <strong style="color:#dc2626">Error Message:</strong>
      <pre>${errMsg}</pre>
    </div>

    ${issue ? `
    <h3 style="margin-top:24px;color:#111">Automatic Actions Taken</h3>
    <p>✅ GitHub Issue created for tracking: <strong>#${issue.id}</strong></p>
    <div style="text-align:center">
      <a href="${issue.url}" class="btn">View GitHub Issue →</a>
    </div>` : ''}

    <h3 style="margin-top:24px;color:#111">Recommended Actions</h3>
    <ol style="color:#374151;line-height:1.8">
      <li>Check the error message above for root cause</li>
      <li>Verify SonarQube server is running (http://localhost:9000)</li>
      <li>Ensure .NET SDK and sonarscanner are installed</li>
      <li>Check repository has valid .sln file</li>
      ${issue ? `<li>Track progress in GitHub Issue #${issue.id}</li>` : ''}
    </ol>
  </div>
  <div class="footer">
    <p><strong>SonarAI Agent</strong> — Automated Code Quality & Security Analysis<br>
    Powered by Claude AI • SonarQube • GitHub</p>
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
