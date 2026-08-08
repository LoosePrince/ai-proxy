# 多阶段构建：构建阶段带完整 devDependencies（tsc/vite），运行阶段只留生产依赖与产物。
# 旧镜像把源码、Prisma CLI、前端构建链一起打进运行镜像，体积与攻击面都没必要。

FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

# 先拷配置再拷源码，改源码时不会让上面的依赖层失效
COPY tsconfig.json ./
COPY web/tsconfig.json web/vite.config.ts ./web/
COPY src ./src
COPY web/index.html ./web/
COPY web/public ./web/public
COPY web/src ./web/src

# 后端编译到 dist/，前端构建到 web/dist/
RUN npm run build:server && npm run build:web

# ---------------------------------------------------------------- 运行阶段

FROM node:20-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist

# 非 root 运行：容器内不需要写文件，持久化全在远程 Lsqlite
USER node

EXPOSE 3000

# 迁移由 server.ts 启动流程内部执行（幂等），无需额外的 migrate 命令
CMD ["node", "dist/http/server.js"]