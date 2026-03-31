# Stage 1: install production dependencies
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# Stage 2: production image
FROM node:20-alpine AS production
WORKDIR /app

RUN apk add --no-cache ffmpeg

COPY --from=deps /app/node_modules ./node_modules
COPY server.js ./
COPY public/ ./public/

ENV NODE_ENV=production

EXPOSE 3000 1935

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/status || exit 1

CMD ["node", "server.js"]
