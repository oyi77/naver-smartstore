# ==========================================
# Stage 1: Builder
# ==========================================
FROM node:20-bookworm-slim AS builder

WORKDIR /app

ENV PUPPETEER_CACHE_DIR=/app/.cache

# Install build dependencies for native modules (better-sqlite3, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files and install ALL dependencies (including devDeps for building)
COPY package*.json ./
RUN npm ci

# Copy source code and build
COPY . .
RUN npm run build

# Remove development dependencies to keep the image small
# We do this in the builder stage so we can just copy the clean node_modules later
RUN npm prune --production

# ==========================================
# Stage 2: Runner
# ==========================================
FROM node:20-bookworm-slim AS runner

WORKDIR /app

# Install runtime dependencies for Puppeteer (Chromium)
# We do NOT install the full google-chrome-stable to save space,
# relying instead on the Chromium version installed by Puppeteer.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    xdg-utils \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Copy built application and production dependencies from builder
COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.cache /app/.cache

ENV PUPPETEER_CACHE_DIR=/app/.cache

# Create data directory and ensure ownership
RUN mkdir -p /app/data && chown -R node:node /app

USER node 

ENV NODE_ENV=production

# Start the application
CMD ["npm", "start"]
