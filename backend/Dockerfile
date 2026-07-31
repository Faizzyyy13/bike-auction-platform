# ============================================================================
# Backend Dockerfile — Multi-Stage Build
# ============================================================================

# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first for optimal layer caching
COPY package*.json tsconfig.json ./

# Install dependencies
RUN npm install

# Copy source code and Lua scripts
COPY src ./src

# Build TypeScript code
RUN npm run build

# Stage 2: Runtime
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy built artifacts and production node_modules from builder
COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/lua ./dist/lua

# Expose HTTP / WebSocket port
EXPOSE 3000

# Run server
CMD ["node", "dist/server.js"]
