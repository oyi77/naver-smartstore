# ==========================================
# Stage 1: Builder
# ==========================================
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Set Puppeteer cache to the user's home directory to match runtime expectations
ENV PUPPETEER_CACHE_DIR=/home/node/.cache/puppeteer

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including devDeps)
RUN npm ci

# Explicitly install Chrome to ensure it's in the cache
RUN npx puppeteer browsers install chrome

# Copy source code and build
COPY . .
RUN npm run build

# Prune dev dependencies
RUN npm prune --production

# ==========================================
# Stage 2: Runner
# ==========================================
FROM node:20-bookworm-slim AS runner

WORKDIR /app

# Install runtime dependencies for Puppeteer (Chromium)
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

# Copy built application and dependencies
COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

# Copy the Puppeteer cache from builder
COPY --from=builder /home/node/.cache/puppeteer /home/node/.cache/puppeteer

# Ensure correct environment variable is set
ENV PUPPETEER_CACHE_DIR=/home/node/.cache/puppeteer

# Create data directory and ensure ownership
RUN mkdir -p /app/data && \
    mkdir -p /home/node/.cache/puppeteer && \
    chown -R node:node /app && \
    chown -R node:node /home/node/.cache

# Copy and setup entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# USER node (Kept commented out - run as root for permission fixing)
# USER node 

ENV NODE_ENV=production

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "start"]
