FROM node:22-slim

ENV DEBIAN_FRONTEND=noninteractive

# ── System deps: Python 3, cron, build tools ──
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    cron curl git build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ── pnpm (match project lockfile) + OpenClaw ──
RUN npm install -g pnpm@10.28.1 openclaw@latest

# ── Python deps for place_order.py ──
RUN pip3 install --break-system-packages py_clob_client requests

WORKDIR /app

# ── Copy workspace structure for pnpm install ──
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages

# ── Install Node deps (no build — scanner is plain .mjs) ──
RUN pnpm install --frozen-lockfile

# ── Copy scanner script ──
COPY market_scanner.mjs .

# ── Cron schedule ──
COPY crontab /etc/cron.d/scanner-cron
RUN chmod 0644 /etc/cron.d/scanner-cron

# ── Entrypoint ──
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 18789

ENTRYPOINT ["/entrypoint.sh"]
