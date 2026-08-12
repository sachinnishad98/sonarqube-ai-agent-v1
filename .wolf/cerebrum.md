# Cerebrum

> OpenWolf's learning memory. Updated automatically as the AI learns from interactions.
> Do not edit manually unless correcting an error.
> Last updated: 2026-05-06

## User Preferences

<!-- How the user likes things done. Code style, tools, patterns, communication. -->

- **Hindi-English Mix:** User prefers Hindi-English communication style (Hinglish)
- **Reference screenshots for UI work (2026-08-12):** User drops reference screenshots in `D:\SonarQube\ErrorPng\` (1.png, 2.png, …) and expects them read and matched *structurally*, not copy-pasted. Explicit instruction: "copy paste mat karna — mere sonarqube agent se related jo hoga wahi rakhna" — adapt every label/column/section to this agent's own domain (repos, branches, scans, AI reviews), never carry over the reference app's domain nouns.
- **Branding (2026-08-12):** Product name "SonarQube AI Agent", business unit line "BUSINESSNEXT CDG" underneath, SonarQube three-arc mark (inline SVG, white on the pink gradient tile) as the logo. Pink is #E82276.
- **Dashboards should look "bhara" (full):** User dislikes sparse pages — wants stat tiles, tables, grouped nav and real content on every screen rather than placeholder panels.
- **Security Focus:** User wants comprehensive security scanning including secrets, API keys, passwords detection
- **Detailed Metrics:** User wants detailed code metrics displayed prominently (total lines, secrets found/not found)
- **Visual Feedback:** User prefers visual indicators (blocks, badges) for security scan results

## Key Learnings

- **Project:** sonarai-live
- **Description:** SonarAI - Azure DevOps + AI Code Review + SonarQube Agent
- **AI Review Features (2026-05-07):**
  - AI Code Review now includes: (1) Total Code Lines count, (2) Secrets Scanning (API keys, passwords, tokens), (3) Visual "Not Found" block when no secrets detected
  - Secrets scanning excludes .env files (config files, not code)
  - Claude AI prompt updated to scan for hardcoded credentials: password=, api_key=, token=, secret=, connection strings
  - Email report HTML includes dedicated "Secrets Scan" section with color-coded results (red for found, green for clean)
  - Total code lines tracked throughout analysis pipeline and displayed in stats row

- **Frontend architecture (2026-08-12):** `public/index.html` is a single-file SPA — no build step. Views are `<div id="view-<name>">` blocks toggled by `showView()`, driven by the `VIEW_META` registry (title/subtitle/owning nav group). To add a page: add the markup block, a `VIEW_META` entry, a `nav-<name>` sidebar item, and (optionally) a `render<Name>()` called from `showView`.
- **Browser-local state (2026-08-12):** Dashboard preferences, scan history, audit trail and the operator profile live in `localStorage` under `sonarai.*` keys. Anything not backed by the server is labelled "this device" / "local" in the UI on purpose — do not present local-only screens as if they were server features.
- **Auth model (2026-08-12):** Local accounts in `data/users.json` (gitignored) — scrypt hash + per-user salt, never plaintext. Sessions are stateless `base64url(payload).HMAC` cookies (`sai_session`) signed with a secret generated on first boot and stored alongside the users. No auth npm packages; everything uses node's `crypto`. First boot prints a generated admin password to the console once — or reads `ADMIN_USERNAME`/`ADMIN_PASSWORD`/`ADMIN_NAME`/`ADMIN_EMAIL` from `.env`. To recover a locked-out agent: stop it, delete `data/users.json`, restart.
- **Roles & permissions (2026-08-12):** `admin` = `['*']` (expands to every entry in `ALL_PERMISSIONS`), `reviewer` = repos/reports view + scan.run + review.run + projects.edit + audit.view, `viewer` = repos.view + reports.view. Server enforces via `requirePerm(perm)` on REST routes and `socketAllowed(socket, perm, failEvent)` on socket events — the frontend `can()` gating is convenience only. Guards prevent demoting/disabling/deleting the last active admin and self-deletion.
- **Screenshotting views (2026-08-12):** `openwolf designqc` only captures route `/`, so it can't reach the client-side views. Use puppeteer-core from `C:\Users\SachinNishad\AppData\Roaming\npm\node_modules\openwolf\node_modules\puppeteer-core` with `executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe'`, then `page.evaluate(n => showView(n), name)` between screenshots.

## Do-Not-Repeat

<!-- Mistakes made and corrected. Each entry prevents the same mistake recurring. -->
<!-- Format: [YYYY-MM-DD] Description of what went wrong and what to do instead. -->

- **[2026-05-07] Don't trust AI response for totalCodeLines** — AI sometimes returns 0 or undefined for totalCodeLines. Always FORCE SET from actual scan result: `review.totalCodeLines = totalCodeLines` (the variable we calculated). Never rely solely on AI's JSON response for count data.

- **[2026-05-07] Use fallback chains in frontend** — When displaying data from backend, always use fallback chains: `${review.totalCodeLines || review.linesOfCode || 0}` instead of just `${review.linesOfCode}`. This handles backward compatibility and missing fields.

- **[2026-08-11] TaskStop doesn't always release the port for `npm start`** — Stopping the background bash task that ran `npm start` can leave the underlying node.exe still bound to PORT 3002 (EADDRINUSE on restart). Always verify with `netstat -ano | grep :3002` after TaskStop, and `taskkill //PID <pid> //F` the stale process before restarting. Happened twice (GitHub token update, SonarQube token update).

- **[2026-08-12] dotenv silently loses to OS-level env vars of the same name** — This machine has a stale `ANTHROPIC_API_KEY` set at the Windows User+Machine environment level. `dotenv.config()` never overrides an already-set process.env value, so the server was silently using that stale/invalid key instead of the correct one in `.env`, even though startup logs showed "AI Key: ✅ Set". Fixed with `dotenv.config({ override: true })`. If any other env var in this project (SONAR_TOKEN, GITHUB_TOKEN, etc.) ever behaves as if `.env` edits aren't taking effect, check `[Environment]::GetEnvironmentVariable("NAME","User")` / `"Machine"` before assuming the .env value is wrong.

- **[2026-08-11] GITHUB_TOKEN / SONAR_TOKEN in .env can silently expire** — When repos don't load or SonarQube scan fails with 401/"Not authorized", check the token validity directly before assuming code is broken: `curl -H "Authorization: token <t>" https://api.github.com/user` for GitHub, `curl -u <t>: http://localhost:9000/api/authentication/validate` for SonarQube. A fresh SonarQube token can be minted without the UI via `curl -u admin:<password> -X POST http://localhost:9000/api/user_tokens/generate -d name=<name>` (admin credentials known for this local instance).

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->
