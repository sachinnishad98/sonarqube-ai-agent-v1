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

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->
