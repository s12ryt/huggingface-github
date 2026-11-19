# 多階段建置：建置階段保留 devDependencies，執行階段只留生產依賴。
FROM node:22-slim AS build
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx prisma generate && npx tsc -p tsconfig.build.json

# 砍掉 devDependencies 後把剩下的 node_modules 搬到執行階段，
# 這樣 @prisma/client 的查詢引擎（已由 generate 放進 node_modules）會一起帶過去。
RUN npm prune --omit=dev

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./

# 資料庫與內容快取都是狀態，掛成卷冊才不會隨容器重建而消失。
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

USER node
EXPOSE 3000

# 每次啟動先同步 schema，讓升級後的新欄位不需人工介入。
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && node dist/server.js"]
