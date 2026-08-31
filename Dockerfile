FROM node:22-alpine
WORKDIR /app
COPY . .
RUN corepack enable && corepack pnpm install --frozen-lockfile && corepack pnpm build
ENV MOCK_MODE=true
EXPOSE 3000 3001
CMD ["sh", "-c", "corepack pnpm --filter @social/api start & corepack pnpm --filter @social/web start"]
