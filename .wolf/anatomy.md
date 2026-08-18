# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-05-08T06:30:00.489Z
> Files: 30 tracked | Anatomy hits: 0 | Misses: 0

## ./

- `.gitignore` — Git ignore rules (~110 tok)
- `.dockerignore` — Keeps .env, data/, node_modules, .git and the .bat helpers out of the build context (~230 tok)
- `Dockerfile` — Agent image. 3 stages: scanner (downloads sonar-scanner CLI), deps (npm ci --omit=dev), runtime (node:22-slim + git + JRE 17). Non-root, tini PID 1, HOST=0.0.0.0. Does NOT contain SonarQube. (~900 tok)
- `Dockerfile.sonarqube` — SonarQube image, pinned to sonarqube:26.4.0.121862-community. Only real change is SONAR_WEB_CONTEXT=/sonarqube so the agent can reverse-proxy it. (~430 tok)
- `db-check.js` — Standalone DB verification CLI, runnable from any directory (.env resolves against `__dirname`). Subcommands: projects | runs | issues | metrics | tables | reports | `save <id> [html|xml]` | `sql "SELECT ..."` (SELECT/WITH only). `save` writes a stored report body to a file — the only practical way to read a 550 kB text column. Not used by the agent at runtime. (~1700 tok)
- `docker-compose.yml` — agent + sonarqube + postgres. Only `agent` publishes a port (3002); SonarQube is reached through the agent proxy at /sonarqube. (~750 tok)
- `.env.docker.example` — Runtime env template for the containers (~450 tok)
- `check-sonar.bat` (~190 tok)
- `CLAUDE.md` — OpenWolf (~57 tok)
- `install-sonar-scanner.bat` (~271 tok)
- `package-lock.json` — npm lock file (~14614 tok)
- `package.json` — Node.js package manifest (~128 tok)
- `README.md` — Project documentation (~2111 tok)
- `server.js` — SonarAI v3.0 — GitHub + Local SonarQube Version (~20474 tok)
- `server.log` (~176 tok)
- `SETUP_GUIDE.md` — 🚀 SonarAI Agent — Complete Setup Guide (~2035 tok)
- `sonar-project.properties` — ,coverage/**,dist/**,build/**,.git/**,.claude/**,.wolf/**,**/*.test.js,**/*.spec.js (~134 tok)
- `SONARQUBE_LABEL_FIX_GUIDE.md` — SonarQube Label Fix Guide (~829 tok)
- `sonarqube-label-fix.js` — ==UserScript== (~731 tok)
- `start-sonar.bat` (~156 tok)
- `test-setup.js` — SonarAI Agent — Setup Verification Script (~2462 tok)

## .claude/

- `settings.json` (~441 tok)
- `settings.local.json` (~84 tok)

## .claude/rules/

- `openwolf.md` (~313 tok)

## .scannerwork/

- `.sonar_lock` (~0 tok)
- `report-task.txt` (~91 tok)

## .sonarqube/bin/targets/

- `SonarQube.Integration.targets` (~11911 tok)

## .sonarqube/conf/

- `Sonar-cs-none.ruleset` (~4814 tok)
- `Sonar-cs.ruleset` (~5074 tok)
- `Sonar-vbnet-none.ruleset` (~2154 tok)
- `Sonar-vbnet.ruleset` (~2267 tok)
- `SonarQubeAnalysisConfig.xml` — </Property> (~4716 tok)

## .sonarqube/conf/cs/

- `SonarLint.xml` (~5526 tok)

## .sonarqube/conf/vbnet/

- `SonarLint.xml` (~3052 tok)

## .sonarqube/out/

- `Telemetry.S4NET.json` (~220 tok)

## public/

- `index.html` — Single-file dashboard SPA. Views are `<div id="view-*">` blocks toggled by `showView()` off the `VIEW_META` registry; sidebar has 5 nav groups (Workspace/Operations/AI/Platform/Admin). Auth-gated: boots off `/api/auth/me`, redirects to `/login` without a session. (~44000 tok)
- `login.html` — BusinessNext-styled split login page. Left: BN logo + "SonarQube AI Agent (Login)" + floating-label form posting to `/api/auth/login`. Right: dark panel with a 4-slide carousel of gradient stat cards. (~5200 tok)
- `bn-logo.svg` — BusinessNext wordmark, used on the login page (~4400 tok)

## lib/

- `sonar-report.js` — Renders a fetchSonarReport() result into HTML and XML, both fully tabular. HTML: 8 table sections (overview, ratings, metrics, severity, type, file, rule, issue register) with inline styles so it survives an email client, plus an optional JS layer for search / severity chips / column sort. XML: 9 uniform `<table><row/>` blocks with attribute columns — importable into Excel or a SQL staging table. Exports generateSonarHtml, generateSonarXml, summarise, esc, xmlEsc. (~4200 tok)
- `report-store.js` — ReportStore class: auto-creates and reads the `sonarai_reports` table in SonarQube's Postgres (its own table, never SonarQube's). save/list/body/status/close. Degrades to a no-op when SONARQUBE_DB_HOST is unset or the server is down. (~1500 tok)
- `ai-providers.js` — One chat() interface over Anthropic plus three OpenAI-compatible vendors (Groq, OpenRouter, custom base URL). Also testConnection(), listModels(), providerList(). Maps vendor errors to actionable hints; omits temperature for Claude models that reject it. (~2200 tok)
- `ai-settings.js` — AiSettings class. Provider/model/key config in data/ai-settings.json, keys AES-256-GCM encrypted with a key derived from the install secret, never returned to the browser (publicView() exposes only a mask). seedFromEnv() imports ANTHROPIC_API_KEY once. (~1700 tok)
