# =====================================================================
# SubFlow 生产镜像（多阶段构建）
# 基础镜像用 Debian slim（bookworm）而非 alpine：
#   - ffmpeg-static 的 linux/x64 二进制是 glibc 构建，musl(alpine) 无法直接运行
#   - Prisma 引擎同样以 glibc 为目标平台
# 阶段：
#   deps     —— 安装全部依赖（含 ffmpeg/ffprobe 平台二进制下载）
#   builder  —— prisma generate + next build（产出 .next/standalone）
#   migrator —— 携带完整 prisma CLI，运行 npx prisma db push 后退出
#   runner   —— 仅 standalone 产物 + static + public 的精简 Web 运行镜像
#   worker   —— 队列消费端（tsx 直跑 TS 源码，与 app 同源码不同入口）
# =====================================================================

# ---------- deps：安装依赖 ----------
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# ffmpeg-static 的 install 脚本在本步下载 linux/x64 二进制（约 80MB）
RUN npm ci

# ---------- builder：构建 standalone 产物 ----------
FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 生成 Prisma Client（build 期间被 import）
RUN npx prisma generate
# NEXT_TELEMETRY 关闭遥测；构建产物在 .next/standalone
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------- migrator：数据库结构同步（compose 一次性服务） ----------
FROM node:20-bookworm-slim AS migrator
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY prisma ./prisma
# DATABASE_URL 由 compose 注入；db push 幂等，可重复执行
CMD ["npx", "prisma", "db", "push", "--skip-generate"]

# ---------- runner：精简运行镜像 ----------
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    # 上传目录固定为容器内 /app/uploads（compose 挂卷持久化）
    LOCAL_UPLOAD_DIR=./uploads

# 非 root 运行
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs subflow

# standalone 产物（含精简 node_modules 与 ffmpeg/ffprobe 二进制）
COPY --from=builder --chown=subflow:nodejs /app/.next/standalone ./
COPY --from=builder --chown=subflow:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=subflow:nodejs /app/public ./public

RUN mkdir -p /app/uploads && chown -R subflow:nodejs /app/uploads
VOLUME ["/app/uploads"]

USER subflow
EXPOSE 3000
CMD ["node", "server.js"]

# ---------- worker：队列消费端（转写 + FFmpeg 导出） ----------
FROM node:20-bookworm-slim AS worker
WORKDIR /app
ENV NODE_ENV=production \
    # 上传目录固定为容器内 /app/uploads（compose 与 app 共享宿主机目录）
    LOCAL_UPLOAD_DIR=./uploads

RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs subflow

# 完整依赖（含 dev 依赖 tsx 与 prisma CLI）+ 生成 Prisma Client
COPY --from=deps /app/node_modules ./node_modules
COPY prisma ./prisma
RUN npx prisma generate

# Worker 运行所需源码与配置（tsx 按 tsconfig paths 解析 @/ 别名）
COPY src ./src
COPY tsconfig.json package.json ./

RUN mkdir -p /app/uploads && chown -R subflow:nodejs /app/uploads
VOLUME ["/app/uploads"]

USER subflow
CMD ["npx", "tsx", "src/worker/index.ts"]
