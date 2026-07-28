FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY tsconfig*.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3008
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && addgroup -S nodejs && adduser -S node -G nodejs
COPY --from=builder /app/build ./build
USER node
EXPOSE 3008
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3008') + '/health').then(res => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "build/index.js"]
