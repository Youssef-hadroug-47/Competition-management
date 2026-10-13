FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts

USER node

EXPOSE 3000

CMD ["node", "src/server.js"]
