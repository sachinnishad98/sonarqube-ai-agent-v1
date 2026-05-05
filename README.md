# SonarAI v2.0 — DevOps Code Quality Agent

Azure DevOps + AI Code Review + SonarQube Scan + Email Notification + Azure Ticket Creation

---

## Architecture

```
Browser (Dashboard)
   ↕  Socket.IO (real-time)
Node.js Server (server.js)
   ├── Azure DevOps API  →  Repos + Branches (real-time)
   ├── Git Commands      →  fetch + checkout + pull
   ├── Claude AI API     →  Code Review (security, quality, performance)
   ├── SonarQube Scanner →  dotnet sonarscanner begin/build/end
   ├── SonarQube API     →  Fetch report (bugs, vulns, ratings)
   ├── Nodemailer        →  Email on success/failure
   └── Azure DevOps API  →  Create Bug Ticket on failure
```

---

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure .env
Already configured. Sirf email ke liye SMTP settings add karo:
```
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_USER=devops@acidaes.com
SMTP_PASS=your_password
NOTIFY_EMAIL=team@acidaes.com
```

### 3. Run
```bash
npm start
# ya dev mode mein:
npm run dev
```

Dashboard open hoga: http://localhost:3001

---

## Flow (Step by step)

1. **Dashboard open karo** → Repositories auto-load ho jayenge Azure DevOps se
2. **Repo select karo** → Branches real-time mein aa jayengi
3. **Branch par "Launch Scan Flow" click karo** → Right panel khulega
4. **Git tab** → "Fetch + Checkout + Pull" click karo → local repo update hogi
5. **AI Review tab** → "Run AI Code Review" → Claude AI C# code review karega
   - Score out of 100
   - Issues: Critical / Major / Minor
   - Security, Maintainability, Performance ratings
6. **Sonar tab** → "Run Sonar Scan" → 3 steps chalenge:
   - `dotnet sonarscanner begin`
   - `dotnet build CRMnext_2019_Full.sln`
   - `dotnet sonarscanner end`
7. **Result** → SonarQube dashboard par report upload hogi
   - ✅ Success → Email jayega
   - ❌ Failure → Azure DevOps Bug ticket banega + email jayega

---

## Files

```
sonarai-live/
├── server.js          ← Backend (Socket.IO + APIs)
├── public/
│   └── index.html     ← Dashboard UI
├── .env               ← Config
├── package.json
└── README.md
```

---

## Original Problem vs Fix

| Problem | Fix |
|---------|-----|
| Real-time data nahi aa raha tha | `azureFetch()` function proper auth ke saath |
| Fallback static data show ho raha tha | Error clearly show hota hai, fallback sirf jab Azure down ho |
| Sonar scan missing tha | 3-step scan: begin → build → end |
| AI review missing | Claude API integration |
| Email missing | nodemailer se success/failure email |
| Azure ticket missing | `/api/wit/workitems/$Bug` se ticket |
| Git commands crash ho rahe the | `spawn()` se real-time streaming |

---

## Troubleshooting

**Azure API 401 error** → PAT token expire ho gaya hoga, renew karo  
**Git checkout fail** → REPO_PATH check karo, repos wahan clone hone chahiye  
**Sonar scan fail** → `dotnet sonarscanner` globally installed hai? `dotnet tool list -g`  
**Email nahi ja raha** → SMTP_ variables `.env` mein fill karo
