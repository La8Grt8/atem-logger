FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci --include=dev --ignore-scripts
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
LABEL org.opencontainers.image.source=https://github.com/La8Grt8/atem-logger
WORKDIR /app
ENV NODE_ENV=production ATEM_LOGGER_DOCKER=1 PORT=9920 DATA_DIR=/data OUTPUT_DIR=/edl
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public
EXPOSE 9920
VOLUME ["/data", "/edl"]
CMD ["node", "dist/server.js"]
