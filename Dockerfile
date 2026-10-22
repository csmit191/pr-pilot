# syntax=docker/dockerfile:1

# ---- Build stage: install everything and compile the TypeScript --------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Dependencies first, so this layer is cached until package*.json changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage: production dependencies and compiled JavaScript only ----------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Never run as root inside the container. (The official node image ships a "node" user.)
USER node

# Hosts such as Render set PORT themselves; this is the default for `docker run`.
ENV PORT=3000
EXPOSE 3000

# Used by `docker run` / Compose. (Render uses the healthCheckPath in render.yaml instead.)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Configuration comes from environment variables (see .env.example), never from files in the image.
CMD ["node", "dist/index.js"]
