FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install

COPY astro.config.mjs tsconfig.json ./
COPY src ./src
COPY public ./public

ENV HOST=0.0.0.0
ENV NODE_ENV=production
# Render sets PORT at runtime (default 10000). Keep a local default.
ENV PORT=10000

RUN npm run build

EXPOSE 10000
CMD ["node", "./dist/server/entry.mjs"]
