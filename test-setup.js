/**
 * SonarAI Agent — Setup Verification Script
 * Run: node test-setup.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('\n🔍 SonarAI Agent — Setup Verification\n');
console.log('='.repeat(60));

let issues = 0;
let warnings = 0;

// ─── CHECK 1: Environment Variables ──────────────────────────────────────────
console.log('\n1️⃣  Checking Environment Variables...');

const requiredEnv = [
  'GITHUB_USERNAME',
  'GITHUB_TOKEN',
  'SONAR_URL',
  'SONAR_TOKEN',
  'ANTHROPIC_API_KEY',
  'REPO_PATH'
];

const optionalEnv = [
  'SMTP_HOST',
  'SMTP_USER',
  'SMTP_PASS',
  'NOTIFY_EMAIL'
];

requiredEnv.forEach(key => {
  if (process.env[key]) {
    console.log(`   ✅ ${key}: Set`);
  } else {
    console.log(`   ❌ ${key}: MISSING`);
    issues++;
  }
});

optionalEnv.forEach(key => {
  if (process.env[key]) {
    console.log(`   ✅ ${key}: Set`);
  } else {
    console.log(`   ⚠️  ${key}: Not set (email notifications disabled)`);
    warnings++;
  }
});

// ─── CHECK 2: Node.js Version ────────────────────────────────────────────────
console.log('\n2️⃣  Checking Node.js...');
const nodeVersion = process.version;
const nodeMajor = parseInt(nodeVersion.split('.')[0].substring(1));

if (nodeMajor >= 18) {
  console.log(`   ✅ Node.js ${nodeVersion} (OK)`);
} else {
  console.log(`   ❌ Node.js ${nodeVersion} (Need v18+)`);
  issues++;
}

// ─── CHECK 3: Dependencies ───────────────────────────────────────────────────
console.log('\n3️⃣  Checking Dependencies...');
try {
  const packageJson = require('./package.json');
  const deps = Object.keys(packageJson.dependencies || {});
  const missing = [];

  deps.forEach(dep => {
    try {
      require.resolve(dep);
    } catch {
      missing.push(dep);
    }
  });

  if (missing.length === 0) {
    console.log(`   ✅ All dependencies installed (${deps.length} packages)`);
  } else {
    console.log(`   ❌ Missing: ${missing.join(', ')}`);
    console.log(`   → Run: npm install`);
    issues++;
  }
} catch (e) {
  console.log(`   ❌ Cannot read package.json`);
  issues++;
}

// ─── CHECK 4: Git ────────────────────────────────────────────────────────────
console.log('\n4️⃣  Checking Git...');
try {
  const gitVersion = execSync('git --version', { encoding: 'utf8' }).trim();
  console.log(`   ✅ ${gitVersion}`);
} catch {
  console.log(`   ❌ Git not found in PATH`);
  issues++;
}

// ─── CHECK 5: .NET SDK ───────────────────────────────────────────────────────
console.log('\n5️⃣  Checking .NET SDK...');
try {
  const dotnetVersion = execSync('dotnet --version', { encoding: 'utf8' }).trim();
  console.log(`   ✅ .NET SDK ${dotnetVersion}`);
} catch {
  console.log(`   ❌ .NET SDK not found`);
  console.log(`   → Download: https://dotnet.microsoft.com/download`);
  issues++;
}

// ─── CHECK 6: SonarScanner ───────────────────────────────────────────────────
console.log('\n6️⃣  Checking SonarScanner...');
try {
  const toolList = execSync('dotnet tool list --global', { encoding: 'utf8' });
  if (toolList.includes('dotnet-sonarscanner')) {
    // Extract version from output
    const match = toolList.match(/dotnet-sonarscanner\s+([\d\.]+)/);
    const version = match ? match[1] : 'installed';
    console.log(`   ✅ SonarScanner ${version}`);
  } else {
    console.log(`   ❌ SonarScanner not found`);
    console.log(`   → Run: dotnet tool install --global dotnet-sonarscanner`);
    issues++;
  }
} catch {
  console.log(`   ❌ Cannot check SonarScanner`);
  console.log(`   → Run: dotnet tool install --global dotnet-sonarscanner`);
  issues++;
}

// ─── CHECK 7: SonarQube Server ───────────────────────────────────────────────
console.log('\n7️⃣  Checking SonarQube Server...');
const sonarUrl = process.env.SONAR_URL || 'http://localhost:9000';
const fetch = require('node-fetch');

(async () => {
  try {
    const res = await fetch(`${sonarUrl}/api/system/status`, { timeout: 5000 });
    const data = await res.json();
    if (data.status === 'UP') {
      console.log(`   ✅ SonarQube is running (${data.version || 'unknown version'})`);
    } else {
      console.log(`   ⚠️  SonarQube status: ${data.status}`);
      warnings++;
    }
  } catch (e) {
    console.log(`   ❌ Cannot connect to SonarQube at ${sonarUrl}`);
    console.log(`   → Start SonarQube server first`);
    issues++;
  }

  // ─── CHECK 8: GitHub API ───────────────────────────────────────────────────
  console.log('\n8️⃣  Checking GitHub API...');
  const githubToken = process.env.GITHUB_TOKEN;
  const githubUser = process.env.GITHUB_USERNAME;

  if (githubToken && githubUser) {
    try {
      const res = await fetch(`https://api.github.com/users/${githubUser}`, {
        headers: {
          'Authorization': `token ${githubToken}`,
          'User-Agent': 'SonarAI-Setup-Check'
        },
        timeout: 5000
      });

      if (res.ok) {
        const data = await res.json();
        console.log(`   ✅ GitHub API connected (${data.name || githubUser})`);
      } else if (res.status === 401) {
        console.log(`   ❌ GitHub token invalid or expired`);
        console.log(`   → Generate new: https://github.com/settings/tokens`);
        issues++;
      } else {
        console.log(`   ❌ GitHub API error: ${res.status}`);
        issues++;
      }
    } catch (e) {
      console.log(`   ❌ Cannot connect to GitHub API`);
      console.log(`   → Check internet connection`);
      issues++;
    }
  } else {
    console.log(`   ⚠️  Skipped (GITHUB_TOKEN or GITHUB_USERNAME not set)`);
  }

  // ─── CHECK 9: Claude AI API ──────────────────────────────────────────────────
  console.log('\n9️⃣  Checking Claude AI API...');
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (anthropicKey) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01'
        },
        timeout: 5000,
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'test' }]
        })
      });

      if (res.ok || res.status === 400) {
        // 400 is OK — means key is valid but request format issue
        console.log(`   ✅ Claude AI API key valid`);
      } else if (res.status === 401) {
        console.log(`   ❌ Claude AI API key invalid`);
        console.log(`   → Check: https://console.anthropic.com/settings/keys`);
        issues++;
      } else {
        console.log(`   ⚠️  Claude AI API returned ${res.status}`);
        warnings++;
      }
    } catch (e) {
      console.log(`   ⚠️  Cannot verify Claude AI API (${e.message})`);
      warnings++;
    }
  } else {
    console.log(`   ⚠️  Skipped (ANTHROPIC_API_KEY not set)`);
  }

  // ─── CHECK 10: Repo Paths ────────────────────────────────────────────────────
  console.log('\n🔟 Checking Repo Paths...');
  const repoPath = process.env.REPO_PATH;

  if (repoPath) {
    if (fs.existsSync(repoPath)) {
      console.log(`   ✅ REPO_PATH exists: ${repoPath}`);
    } else {
      console.log(`   ⚠️  REPO_PATH does not exist: ${repoPath}`);
      console.log(`   → Will be created automatically on first clone`);
      warnings++;
    }
  }

  // Check custom repo paths
  const customRepoPath = process.env.REPO_PATH_sonarqube_ai_agent_v1;
  if (customRepoPath) {
    if (fs.existsSync(customRepoPath)) {
      console.log(`   ✅ Custom path exists: ${customRepoPath}`);
      if (fs.existsSync(path.join(customRepoPath, '.git'))) {
        console.log(`   ✅ Valid git repository`);
      } else {
        console.log(`   ⚠️  Not a git repository (missing .git folder)`);
        warnings++;
      }
    } else {
      console.log(`   ❌ Custom path does not exist: ${customRepoPath}`);
      issues++;
    }
  }

  // ─── SUMMARY ─────────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  console.log('\n📊 Summary:\n');

  if (issues === 0 && warnings === 0) {
    console.log('   🎉 Perfect! All checks passed.');
    console.log('   → Ready to run: npm start');
  } else if (issues === 0) {
    console.log(`   ✅ Setup OK (${warnings} warnings)`);
    console.log('   → Ready to run: npm start');
  } else {
    console.log(`   ❌ Setup incomplete (${issues} issues, ${warnings} warnings)`);
    console.log('   → Fix issues above before running');
  }

  console.log('\n' + '='.repeat(60) + '\n');
  process.exit(issues > 0 ? 1 : 0);
})();
