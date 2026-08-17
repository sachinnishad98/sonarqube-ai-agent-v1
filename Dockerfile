# ══════════════════════════════════════════════════════════════════════════════
#  SonarAI Agent — application image #1 of 2.
#
#  Contains: Node 22 + git + JRE 17 + sonar-scanner CLI 5.0.1.
#  Does NOT contain SonarQube — that is a separate image (Dockerfile.sonarqube)
#  which this app reaches over the network via SONAR_URL, and re-exposes to the
#  browser through its own reverse proxy at /sonarqube.
#
#  Build:  docker build -t sonarai-agent:2.1.0 .
#  Run:    docker run -p 3002:3002 --env-file .env.docker sonarai-agent:2.1.0
# ══════════════════════════════════════════════════════════════════════════════

# ─── STAGE 1: fetch and unpack the sonar-scanner CLI ──────────────────────────
# A throwaway stage so curl/unzip and the downloaded archive never reach the
# final image — only the extracted scanner directory is copied forward.
FROM debian:bookworm-slim AS scanner

# This is the "any OS" CLI build: ~600KB, no bundled JRE, so it runs on both
# amd64 and arm64 using whatever Java the runtime stage provides.
ARG SONAR_SCANNER_VERSION=5.0.1.3006

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt

# The archive expands to a version-named directory (sonar-scanner-5.0.1.3006),
# which is renamed so the runtime stage can reference a stable path.
RUN curl -fsSL -o scanner.zip \
      "https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/sonar-scanner-cli-${SONAR_SCANNER_VERSION}.zip" \
 && unzip -q scanner.zip \
 && mv "sonar-scanner-${SONAR_SCANNER_VERSION}" /opt/sonar-scanner \
 && rm scanner.zip \
 && chmod +x /opt/sonar-scanner/bin/sonar-scanner


# ─── STAGE 2: production node_modules only ────────────────────────────────────
# Separated so devDependencies (nodemon) and the npm cache stay out of the
# runtime image, and so this layer is rebuilt only when the lockfile changes.
FROM node:22-bookworm-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force


# ─── STAGE 3: runtime ─────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# git             — the agent clones the GitHub repos it scans
# openjdk-17-jre  — sonar-scanner is a Java program and ships no JRE of its own
# ca-certificates — TLS to api.github.com and api.anthropic.com
# tini            — PID 1 that reaps the git/scanner children this app spawns
# curl            — used by HEALTHCHECK below
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      openjdk-17-jre-headless \
      ca-certificates \
      tini \
      curl \
 && rm -rf /var/lib/apt/lists/*

# Debian's JDK path is arch-suffixed (java-17-openjdk-amd64 / -arm64), so it is
# resolved from the installed binary rather than hardcoded — otherwise the image
# builds on x86 but the scanner cannot find Java on Graviton/arm64.
# -n stops ln from descending into the directory if the link already exists.
RUN ln -sfn "$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")" /usr/lib/jvm/default-java

# The sonar-scanner wrapper runs "$JAVA_HOME/bin/java" when JAVA_HOME is set and
# falls back to `which java` otherwise — this makes the first path deterministic.
ENV JAVA_HOME=/usr/lib/jvm/default-java
ENV SONAR_SCANNER_HOME=/opt/sonar-scanner
ENV PATH="${SONAR_SCANNER_HOME}/bin:${PATH}"

COPY --from=scanner /opt/sonar-scanner /opt/sonar-scanner

WORKDIR /app

# node_modules first, then source — source changes are frequent and must not
# invalidate the (slow) dependency layer above them.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
COPY public/ ./public/

# data/ holds users.json (admin hash + session secret) and the AI report history;
# /repos holds the cloned repositories. Both should be mounted as volumes so a
# restart does not wipe the admin account or force a re-clone of every repo.
RUN mkdir -p /app/data /repos \
 && chown -R node:node /app /repos

# ─── Runtime configuration ────────────────────────────────────────────────────
# HOST=0.0.0.0 is mandatory in a container: the app defaults to 127.0.0.1, which
# would make the published port unreachable from outside the network namespace.
# SONAR_URL uses the service DNS name — inside this container "localhost" is
# this container, not the SonarQube one.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3002 \
    REPO_PATH=/repos \
    SONAR_URL=http://sonarqube:9000/sonarqube \
    SONAR_PROXY_PATH=/sonarqube \
    AI_MODEL=claude-sonnet-5

# Secrets (GITHUB_TOKEN, SONAR_TOKEN, ANTHROPIC_API_KEY, SMTP_PASS, ADMIN_PASSWORD)
# are deliberately NOT baked in — inject them at run time via --env-file or AWS
# Secrets Manager. Anything ENV'd here is readable by anyone who pulls the image.

# Drop root. The node base image ships an unprivileged `node` user (uid 1000).
USER node

EXPOSE 3002

# /login is the one route served before the auth gate, so a 200 here proves the
# process is up and serving without needing credentials.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:3002/login | grep -q '^200$' || exit 1

# tini forwards signals and reaps the zombie git/sonar-scanner children that
# spawn(..., { shell: true }) leaves behind.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
