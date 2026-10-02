FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY frontend/public ./frontend/public
COPY container ./container

EXPOSE 3000
CMD ["node", "container/server.js"]
