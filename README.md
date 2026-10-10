# SubFlow（字幕工坊）

AI 短视频字幕生成工具：上传视频 → 千问 ASR 语音转写 → LLM 润色 → 字幕编辑 → 一键烧录导出。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 框架 | Next.js 16（App Router + Turbopack + Cache Components） |
| 语言 | TypeScript（strict） |
| 数据库 | PostgreSQL 16（Docker）+ Prisma 6 |
| 任务队列 | Redis 7 + BullMQ（转写/导出独立 Worker 消费，宕机自动恢复，付费用户优先） |
| ASR | 阿里云百炼 qwen3-asr-flash（同步）/ qwen3-asr-flash-filetrans（异步，生产） |
| LLM 润色 | qwen-flash（DashScope OpenAI 兼容模式） |
| 媒体处理 | FFmpeg（ffmpeg-static / ffprobe-static 自带二进制） |
| 登录 | 手机号 + 短信验证码（开发模式万能码，生产对接阿里云短信） |

## 模块进度

- [x] **模块 ①**：登录/注册（短信验证码、会话、注册赠 30 分钟额度）
- [x] **模块 ②**：上传 + 转写流水线（流式上传、FFmpeg 抽音频、ASR、LLM 润色、状态机）
- [x] **模块 ③**：字幕编辑器（视频预览 + 逐行编辑 + 样式切换）
- [x] **模块 ④**：FFmpeg 烧录导出 + 额度扣减 + 激活码兑换
- [x] **模块 ⑤**：管理后台 + 购买页 + 生产构建/部署产物（`DEPLOY.md`）
- [x] **P0 加固**（`docs/ROADMAP.md` 第一期）：SRT 导出、法务页、API 限流防刷、
      分片上传 + 断点续传、项目列表分页、落地页宣传修正
- [x] **P1 任务队列**（`docs/ROADMAP.md` 2.1）：转写/导出进 Redis 队列 + 独立 Worker
      （并发上限/失败重试/宕机自动恢复/付费优先），限流器迁移 Redis 分布式滑窗
- [ ] **上线动作**（需人工）：购服务器 + ICP 备案 + 短信报备 + 收款码（见 `DEPLOY.md` 清单）

### 导出与额度说明（模块 ④）

- 烧录链路：样式契约 + 字幕分段 → [ass.ts](src/lib/ass.ts) 编译为 ASS（PlayRes 1920x1080，
  关键词高亮用 `{\c}` 行内覆盖标签）→ FFmpeg `ass` 滤镜烧录（libx264 重编码、音频直拷）。
  滤镜内使用相对路径，规避 Windows 盘符冒号转义问题
- 任务化：`ExportTask` PENDING → PROCESSING → DONE/FAILED；同一项目同时只允许一个进行中任务（409）
- 计费：按视频时长向上取整为秒；创建时余额预检（402），成功后在事务内
  「任务置 DONE + 条件扣减余额（防负数）+ 写 CreditLedger(reason=CONSUME_EXPORT)」，
  失败不扣费；删除项目时同步清理导出产物文件
### 激活码（MVP 收款载体）：`node scripts/gen-redeem-codes.mjs --seconds 600 --count 5`
  （或 `--plan 基础版`）生成 `SUBF-XXXX-XXXX-XXXX` 格式码；用户在 `/dashboard/redeem`
  兑换，时长码直接入账、套餐码开月订阅，事务内防并发重兑

### 管理后台与购买页（模块 ⑤）

- **`/admin`**：`ADMIN_PHONES` 白名单用户可见（其余一律 404）。经营统计
  （用户/额度/项目/导出/消耗）+ 页面化生成激活码（时长码/套餐码 × 数量）+ 未用码与用户总览
- **`/pricing`**：购买页，套餐数据与后台发码同源（Plan 表）；三步购买引导
  （扫码付款 → 客服发码 → 兑换到账）。收款码图片放 `public/pay-qr/wechat.png`
  与 `alipay.png` 后自动展示，未配置时显示占位
- 生产构建：登录态页面已声明 `instant = false`（Cache Components 下按需阻塞渲染）；
  `npm run build` 零警告通过，上传/导出两条链路已在生产模式 E2E 验证

### 任务队列说明（P1）

- 转写/导出任务经 BullMQ 进 Redis 队列（[src/lib/queue/](src/lib/queue/)），独立 Worker 消费
  （`npm run worker`；dev 模式 `ENABLE_INPROCESS_WORKER=1` 时随 `npm run dev` 进程内启动）
- 并发上限：`TRANSCRIBE_CONCURRENCY`（默认 3）/ `EXPORT_CONCURRENCY`（默认 1，FFmpeg 吃 CPU）；
  失败指数退避自动重试，重试用尽标记 FAILED（原因落库）；Worker 宕机后在跑任务经
  stalled 检测自动重新入队（Redis AOF 持久化，容器重启不丢任务）
- 优先级：有有效订阅的用户任务优先消费（付费优先）
- 降级策略：Redis 不可用时任务自动降级进程内直跑、限流器降级内存版（可用性优先，日志提示）

## 部署

见 [DEPLOY.md](DEPLOY.md)：服务器选购、ICP 备案、`docker compose up -d --build`
（多阶段构建：migrate 一次性容器同步表结构 + standalone 精简运行镜像，自带 ffmpeg）、
Caddy HTTPS、上线前检查清单与日常运维命令。

## 后续规划

见 [docs/ROADMAP.md](docs/ROADMAP.md)：三期开发路线（P0 上线前必做 → P1 高并发与增强 → P2 增长扩展），含功能清单、架构演进步骤与工作量预估。

### 字幕编辑器说明（模块 ③）

- 视频回放：`GET /api/projects/[id]/video` 支持 HTTP Range（拖动进度、倍速）
- 编辑保存：`PUT /api/projects/[id]/transcript` 全量提交，服务端校验
  （段数 ≤2000、单段文本 ≤500 字、时间合法性 end>start≥0）
- 样式预览：`GET /api/styles` 返回模板；叠加层按 config 契约渲染
  （fontSize 为 @1080p 高度百分比、marginV/outlineWidth 按 @1080p 像素等比缩放，
  描边用 8 向 text-shadow 模拟）——该契约同时是后续 FFmpeg ASS 烧录的依据
- 交互：点击时间戳跳转播放、播放中自动高亮/滚动当前行、双击编辑、
  行内时间微调、删除行、上方插入行

## 本地开发

```bash
# 1. 启动 PostgreSQL（首次）
docker run -d --name subflow-db -e POSTGRES_PASSWORD=subflow123 -e POSTGRES_DB=subflow -p 5432:5432 postgres:16

# 2. 启动 Redis（任务队列 + 限流，首次）
docker run -d --name subflow-redis -p 6379:6379 redis:7-alpine redis-server --appendonly yes

# 3. 安装依赖 + 初始化数据库
npm install
npx prisma db push
npx tsx prisma/seed.mjs   # 写入套餐与字幕样式种子数据

# 4. 配置 .env（参考 .env 内注释，必填 DASHSCOPE_API_KEY）

# 5. 启动
npm run dev   # .env 的 ENABLE_INPROCESS_WORKER=1 时，进程内直接启动队列 Worker，无需另开终端
```

登录页输入任意 11 位手机号，开发模式（`SMS_DEV_MODE=true`）固定验证码 `123456`，
新用户自动注册并赠送 30 分钟转写额度。

## ASR 双模式说明

| 模式 | 变量值 | 时间戳 | 适用 |
| --- | --- | --- | --- |
| 同步 | `ASR_PROVIDER=qwen-sync` | FFmpeg 静音检测 + 文本对齐（估算） | 本地开发（无公网地址） |
| 异步 | `ASR_PROVIDER=qwen-filetrans` | 原生句级毫秒时间戳 | 生产（需配置 `PUBLIC_ASSET_BASE_URL`，DashScope 会主动下载源文件） |

> 实测注意：qwen3-asr-flash 兼容模式的 `input_audio.data` 必须为
> `data:audio/mp3;base64,...` 形式（裸 base64 会被误判为 URL），
> 且 content 中不能携带 text part，否则报 `dedicated task asr does not support this input`。

## E2E 测试

```bash
# 全流程：登录 → 上传 → 轮询至 READY → 校验分段结构
node scripts/e2e-pipeline-test.mjs

# 导出链路：生成激活码 → 兑换（含防刷 409/404）→ 创建导出 → 轮询至 DONE
#           → 下载成片 → ffprobe 校验时长 → PSNR 验证字幕已烧录 → 扣费与流水校验
node scripts/e2e-export-test.mjs

# P0 专项：分片上传（中断→resume→续传→合并）→ SRT 断言 → 魔数拒绝 → 分页 → 限流
node scripts/e2e-p0-test.mjs

# P1 队列专项：无 Worker 任务滞留 → 启动消费 → 导出队列 + 扣费 → kill 宕机恢复
# （脚本自管 Worker 子进程，运行前确保没有其他 Worker 在跑）
node scripts/e2e-queue-test.mjs

# 生成激活码（落库并打印）
node scripts/gen-redeem-codes.mjs --seconds 600 --count 5
```

## 上线前 TODO

- [ ] 轮换 DashScope API Key（开发期间曾在聊天记录中暴露）
- [ ] 阿里云短信签名/模板报备，关闭 `SMS_DEV_MODE`
- [ ] ICP 备案 + 域名；补齐隐私协议 `/privacy`、用户协议 `/terms`
- [ ] 生产切换 OSS 存储 + `ASR_PROVIDER=qwen-filetrans`
