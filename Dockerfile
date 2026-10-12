FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production APP_MODE=live HOST=0.0.0.0 PORT=3001 DB_PATH=/app/data/handyman.sqlite
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
RUN chmod -R a+rX /app/server /app/dist /app/node_modules /app/package.json /app/package-lock.json \
    && mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3001
CMD ["npm", "start"]
