FROM node:24-alpine

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod

COPY . .
ENV NODE_ENV=production
EXPOSE 8000
CMD ["node", "server/index.js"]

