# 🚀 SonarAI Agent — Complete Setup Guide

**Goal:** Automated Code Quality & Security Analysis with AI

---

## 📋 **Prerequisites**

### 1. **SonarQube Local Setup**
```bash
# Download SonarQube Community Edition
# https://www.sonarsource.com/products/sonarqube/downloads/

# Extract and run:
cd sonarqube-x.x.x/bin/windows-x86-64
.\StartSonar.bat

# Access: http://localhost:9000
# Login: admin / admin (change on first login)
```

**Generate SonarQube Token:**
1. Login → My Account → Security → Generate Token
2. Name: `SonarAI-Agent`
3. Type: User Token
4. Copy token (starts with `sqa_`)

### 2. **.NET SDK + SonarScanner**
```bash
# Install .NET SDK (if not installed)
# https://dotnet.microsoft.com/download

# Install SonarScanner globally
dotnet tool install --global dotnet-sonarscanner

# Verify installation
dotnet sonarscanner --version
```

### 3. **Node.js**
```bash
# Install Node.js 18+ from https://nodejs.org
node --version  # Should be v18 or higher
npm --version
```

### 4. **Git**
```bash
# Install Git for Windows
# https://git-scm.com/download/win

git --version
```

### 5. **GitHub Personal Access Token**
1. Go to: https://github.com/settings/tokens/new
2. Name: `SonarAI-Agent`
3. Expiration: 90 days (or custom)
4. Permissions:
   - ✅ **repo** (full control)
   - ✅ **read:user**
5. Generate token → Copy (starts with `ghp_`)

### 6. **Gmail App Password** (for email notifications)
1. Google Account → Security → Enable **2-Step Verification**
2. Security → App passwords → Generate new
3. App: `SonarAI` → Generate
4. Copy 16-digit password (format: `xxxx xxxx xxxx xxxx`)

---

## ⚙️ **Configuration**

### **1. Clone Repository**
```bash
cd D:\SonarQube
git clone https://github.com/sachinnishad98/sonarqube-ai-agent-v1.git
cd sonarqube-ai-agent-v1
```

### **2. Install Dependencies**
```bash
npm install
```

### **3. Configure .env File**

Open `.env` and fill in:

```env
# ── GITHUB CONFIG ──────────────────────────────────────────────
GITHUB_USERNAME=sachinnishad98
GITHUB_TOKEN=ghp_YOUR_TOKEN_HERE

# ── LOCAL REPO PATHS ────────────────────────────────────────────
REPO_PATH=D:\SonarQube\SonarQube-AI-Agent
REPO_PATH_sonarqube-ai-agent-v1=D:\SonarQube\sonarqube-ai-agent-v1

# ── LOCAL SONARQUBE ─────────────────────────────────────────────
SONAR_URL=http://localhost:9000
SONAR_TOKEN=sqa_YOUR_TOKEN_HERE

# ── DOTNET PATH ──────────────────────────────────────────────────
DOTNET_ROOT=C:\Program Files\dotnet\

# ── CLAUDE AI (Code Review) ─────────────────────────────────────
ANTHROPIC_API_KEY=sk-ant-YOUR_KEY_HERE

# ── SERVER PORT ──────────────────────────────────────────────────
PORT=3002

# ── EMAIL NOTIFICATIONS ──────────────────────────────────────────
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=sachinnishad834@gmail.com
SMTP_PASS=YOUR_16_DIGIT_APP_PASSWORD_HERE
NOTIFY_EMAIL=sachinnishad834@gmail.com
```

**Security Note:** Never commit `.env` file to git! (Already in `.gitignore`)

---

## 🎯 **Running the Agent**

### **Step 1: Start SonarQube**
```bash
cd <sonarqube-installation>/bin/windows-x86-64
.\StartSonar.bat

# Wait 2-3 minutes for startup
# Verify: http://localhost:9000
```

### **Step 2: Start SonarAI Agent**
```bash
cd D:\SonarQube\sonarqube-ai-agent-v1
npm start
```

**Expected output:**
```
🚀 SonarAI v3.0 (GitHub Edition) → http://localhost:3002
   GitHub  : sachinnishad98
   Sonar   : http://localhost:9000
   Repos   : D:\SonarQube\SonarQube-AI-Agent
   AI Key  : ✅ Set
   Email   : ✅ Set
```

### **Step 3: Open Dashboard**
```
http://localhost:3002
```

---

## 🔄 **Complete Workflow Demo**

### **1. Select Repository**
- Click **"Repositories"** in sidebar
- Click **"Refresh"** if repos not loaded
- Click on **`sonarqube-ai-agent-v1`** card

### **2. Pick Branch**
- Select **`main`** branch
- Click **"Launch Scan Flow"** → Right panel opens

### **3. Git Operations** (Tab 1)
- Click **"Fetch + Checkout"**
- Watch real-time logs:
  ```
  🔄 Git Sync — sonarqube-ai-agent-v1@main
  📁 Target path: D:\SonarQube\sonarqube-ai-agent-v1
  📂 Repo exists at path
  🔀 Fetching latest...
  ✅ Fetch complete
  🔀 Checking out main...
  ✅ Checkout complete
  ⬇️  Pulling latest changes...
  ✅ Pull complete!
  ```

### **4. AI Code Review** (Tab 2)
- Click **"Run AI Code Review"**
- Claude AI analyzes code for:
  - 🔴 **Critical Issues** (SQL injection, hardcoded secrets, etc.)
  - 🟡 **Major Issues** (security, performance)
  - 🔵 **Minor Issues** (code style, best practices)
- Score: `/100`
- Ratings: Security, Maintainability, Performance (A-E)

### **5. SonarQube Scan** (Tab 3)
- Click **"Run Sonar Scan"**
- 3-step process:
  1. ✅ **Begin** — Initialize scanner
  2. ✅ **Build** — Compile project
  3. ✅ **End** — Upload results
- Watch terminal-style logs
- View metrics:
  - Bugs, Vulnerabilities, Code Smells
  - Coverage %
  - Quality Ratings

### **6. Email Notification**
- ✅ **Success:** Professional HTML email with metrics
- ❌ **Failure:** Error details + GitHub issue link

---

## 📊 **SonarQube Dashboard**

After scan completes:
```
http://localhost:9000/dashboard?id=sachinnishad98-sonarqube-ai-agent-v1
```

View:
- Overall quality gate status
- Detailed bug/vulnerability list
- Security hotspots
- Code coverage trends
- Duplications

---

## 🔒 **Security Features**

✅ **Input Validation:** Repo/branch names sanitized  
✅ **Path Traversal Protection:** Blocks `../` attacks  
✅ **Token Sanitization:** Hides secrets in error logs  
✅ **Rate Limiting:** 10 requests/min per socket  
✅ **CORS:** Localhost only  
✅ **CSP Headers:** Blocks XSS attacks  
✅ **Safe Env Variables:** Minimal exposure to child processes  

---

## 🤖 **AI-Powered Features**

### **Claude AI Code Review:**
- Analyzes code quality, security, performance
- Identifies OWASP Top 10 vulnerabilities
- Suggests fixes with context
- No human review needed for basic checks

### **Automated Issue Creation:**
- Scan fails → GitHub issue auto-created
- Includes error details, timestamp, logs
- Tags: `bug`, `sonarqube`

### **Smart Email Notifications:**
- Professional HTML templates
- Visual metrics (charts, ratings)
- Actionable recommendations

---

## 🐛 **Troubleshooting**

### **1. SonarQube not accessible**
```bash
# Check if running:
netstat -ano | findstr :9000

# Restart:
cd <sonarqube>/bin/windows-x86-64
.\StartSonar.bat
```

### **2. Git operations timeout**
- Check internet connection
- Verify GitHub token is valid
- Ensure repo path exists

### **3. Sonar scan fails**
- Check `.sln` file exists in repo
- Verify `dotnet` command works:
  ```bash
  dotnet --version
  dotnet sonarscanner --version
  ```

### **4. Email not sending**
- Verify Gmail App Password (not regular password)
- Check 2-Step Verification is ON
- Test with: https://nodemailer.com/smtp/testing/

### **5. AI Review fails**
- Check `ANTHROPIC_API_KEY` is set
- Verify API key is active: https://console.anthropic.com

---

## 📁 **Project Structure**
```
sonarqube-ai-agent-v1/
├── server.js              ← Backend (Socket.IO + APIs)
├── public/
│   └── index.html         ← Dashboard UI
├── .env                   ← Configuration (SECRET!)
├── package.json           ← Dependencies
├── SETUP_GUIDE.md         ← This file
└── README.md              ← Quick start
```

---

## 🚀 **Next Steps: Organization Deployment**

### **For Enterprise Use:**

1. **Replace GitHub with Azure DevOps:**
   - Update endpoints in `server.js`
   - Use Azure PAT instead of GitHub token

2. **Remote SonarQube:**
   - Change `SONAR_URL` to enterprise server
   - Update token with org-level permissions

3. **SMTP Server:**
   - Replace Gmail with company SMTP
   - Use internal mail server

4. **Authentication:**
   - Add SSO/LDAP login
   - Role-based access control

5. **CI/CD Integration:**
   - Add GitHub Actions / Azure Pipelines
   - Automatic scans on PR/merge

6. **Database:**
   - Store scan history
   - Track metrics over time

---

## 📞 **Support**

- Issues: https://github.com/sachinnishad98/sonarqube-ai-agent-v1/issues
- Email: sachinnishad834@gmail.com

---

**Built with ❤️ by Sachin Nishad**  
*Powered by Claude AI • SonarQube • GitHub*
