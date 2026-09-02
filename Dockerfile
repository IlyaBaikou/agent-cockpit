FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY config ./config
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/config ./config
USER node
EXPOSE 4317
CMD ["npm", "start"]
