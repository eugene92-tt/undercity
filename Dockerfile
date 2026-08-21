# better-sqlite3 is a native module, so build it against the same Node that
# will run it. Debian slim rather than Alpine: the prebuilt binaries are glibc.
FROM node:22-slim AS build
WORKDIR /app

# Toolchain only in this stage; the runtime image carries none of it.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY content ./content
COPY public ./public
COPY scripts ./scripts

# DATA_DIR is mounted as a persistent disk; nothing durable lives in the image.
ENV DATA_DIR=/var/data
ENV MODE=hosted
ENV PORT=3000
EXPOSE 3000

# Drop privileges: the node image ships a non-root `node` user.
RUN mkdir -p /var/data && chown -R node:node /var/data /app
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
