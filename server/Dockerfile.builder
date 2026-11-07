# Runs clones and builds. Holds no secrets.
#   docker build -f server/Dockerfile.builder -t ensure-builder server
FROM node:24-alpine
RUN apk add --no-cache git && mkdir -p /cache/npm /cache/pnpm /cache/yarn /cache/corepack && chmod -R 1777 /cache
