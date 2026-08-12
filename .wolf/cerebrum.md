# Cerebrum

> OpenWolf's learning memory. Updated automatically as the AI learns from interactions.
> Do not edit manually unless correcting an error.
> Last updated: 2026-05-06

## User Preferences

<!-- How the user likes things done. Code style, tools, patterns, communication. -->

- **Hindi-English Mix:** User prefers Hindi-English communication style (Hinglish)
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
