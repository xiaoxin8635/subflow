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
- [x] **P1 OSS 直传**（`docs/ROADMAP.md` 2.2）：`STORAGE_DRIVER=oss` 时浏览器分片
      直传 OSS（不经服务器带宽），worker 处理前拉取、成片传回 OSS，
      预览/下载 302 签名 URL；local 驱动保留，双模式全链路 E2E 验证
- [x] **P1 可观测性**（`docs/ROADMAP.md` 2.6）：结构化 JSON 日志 + 钉钉机器人告警
      （任务最终失败/额度守卫/进程异常）+ 管理后台失败任务页与一键重试
- [x] **P1 多格式导出**（`docs/ROADMAP.md` 2.4）：字幕文件 SRT / VTT / ASS 三格式
      下载（ASS 带样式与关键词高亮，可选 styleId），不消耗额度
- [x] **P1 完成通知**（`docs/ROADMAP.md` 2.3）：站内通知（铃铛未读数 + 下拉列表 +
      已读/全部已读）覆盖转写/导出的完成与失败四类事件，页面不可见时浏览器系统通知
- [x] **P1 批量处理**（`docs/ROADMAP.md` 2.5）：新建项目页一次多选/拖入多个视频
      串行批量上传（逐行进度、失败不阻断、可重传），详情页展示转写队列实时排位
- [x] **P1 CI**（`docs/ROADMAP.md` 2.7）：GitHub Actions——push/PR 自动跑
      tsc + eslint + 生产构建 + 冒烟 E2E（真实起服务，零外部 API 调用）；
      CD 部署待服务器到位后追加（见 `DEPLOY.md`）
- [x] **P2.1 音频直传**（`docs/ROADMAP.md` 第三期）：mp3 / m4a / wav 纯音频
      播客/课程转字幕（复用转写链路），项目区分 mediaKind；
      音频项目仅字幕文件下载（不提供烧录成片），前后端双重拦截
- [x] **P2.2 自定义样式保存**（`docs/ROADMAP.md` 第三期）：编辑器样式微调面板
      （字体/字号/位置/边距/字色/描边/高亮）+「另存为我的模板」（UserStyle 表）；
      导出携带当前预览样式快照（所见即所得，模板删改不影响已建任务），
      官方/个人模板统一烧录，ASS 下载支持 `?userStyleId=`
- [x] **P2.3 时间轴批量调整**（`docs/ROADMAP.md` 第三期）：字幕整体与语音不同步时，
      编辑器内一键整体偏移（±30s，起点越界拒绝）或整体伸缩（0.5-2 倍，
      以首行起点为锚），支持一步撤销；纯前端计算，保存复用统一 PUT 链路
- [ ] **上线动作**（需人工）：购服务器 + ICP 备案 + 短信报备 + 收款码（见 `DEPLOY.md` 清单）

### 导出与额度说明（模块 ④）

- 烧录链路：样式契约 + 字幕分段 → [ass.ts](src/lib/ass.ts) 编译为 ASS（PlayRes 1920x1080，
  关键词高亮用 `{\c}` 行内覆盖标签）→ FFmpeg `ass` 滤镜烧录（libx264 重编码、音频直拷）。
  滤镜内使用相对路径，规避 Windows 盘符冒号转义问题
- 字幕文件下载（[subtitle-download.ts](src/lib/subtitle-download.ts) 统一鉴权/校验）：
  **SRT**（通用，剪映/PR，带 BOM 防乱码）/ **VTT**（网页播放器 HTML5 track，[vtt.ts](src/lib/vtt.ts)）/
  **ASS**（带样式与关键词高亮，可选 `?styleId=`，缺省用默认样式）三格式，
  纯文本生成零成本不扣额度
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

### 对象存储说明（P1.2）

- `STORAGE_DRIVER=local`（默认）：视频落盘 `LOCAL_UPLOAD_DIR`，上传/预览/下载全走服务器
- `STORAGE_DRIVER=oss`：
  - 上传：`POST /api/uploads/init` 调 OSS InitiateMultipartUpload 并为每个分片签发
    直传 PUT URL（12h 有效，断点续传时由 status 接口重发），浏览器直传 OSS 不经服务器带宽；
    complete 时服务端 ListParts 核对分片 → CompleteMultipartUpload → 大小/魔数复查
  - 处理：worker 转写/烧录前经 `ensureLocalVideo` 拉源视频到本地缓存（`uploads/cache/`，
    同大小副本复用），导出成片上传 OSS 后清理本地临时文件
  - 读取：视频预览与成片下载 302 到签名 URL（预览 4h / 下载 10min 有效，流量直达 OSS）；
    qwen-filetrans 转写直接用 12h 签名 URL，无需 `PUBLIC_ASSET_BASE_URL`
- 首次启用：`npx tsx scripts/setup-oss-cors.ts` 配置 Bucket CORS（浏览器直传必需）；
  OSS 客户端为自研零依赖实现（[src/lib/oss.ts](src/lib/oss.ts)，V1 签名 + Multipart + 签名 URL）

### 可观测性说明（P1.6）

- **结构化日志**（[src/lib/logger.ts](src/lib/logger.ts)）：worker/导出/告警等关键路径
  输出单行 JSON（时间/级别/模块/消息/上下文），`docker logs` 可直接采集
- **钉钉告警**（[src/lib/alert.ts](src/lib/alert.ts)）：配置 `ALERT_DINGTALK_WEBHOOK`
  （+加签密钥）后，转写/导出任务重试用尽失败、额度守卫拦截、进程未捕获异常时推送
  群机器人；同类告警冷却限频（`ALERT_COOLDOWN_SECONDS`，默认 300s）；未配置时降级为日志
- **进程级捕获**（[src/lib/process-hooks.ts](src/lib/process-hooks.ts)）：app 进程
  （instrumentation）与独立 Worker 进程均挂 `uncaughtException` / `unhandledRejection`
- **失败任务页**：`/admin` 底部展示 FAILED 项目/导出任务（最近 20 条）与队列积压数，
  每条可一键重试（`POST /api/admin/retry`：移除旧 failed job → 重置状态 → 重新入队）

### 完成通知说明（P1.3）

- **站内通知**（[src/lib/notify.ts](src/lib/notify.ts)）：转写完成/失败、导出完成/失败
  四类事件写入 `Notification` 表；写入为旁路容错（失败仅落日志，不影响主流程）
- **读取**：`GET /api/notifications` 返回未读数 + 最近 30 条；
  `POST /api/notifications/read` 支持批量（`{ids}`）与全量（`{all:true}`）已读，
  where 绑定本人 userId 防越权；重复已读幂等
- **铃铛**（[src/components/notification-bell.tsx](src/components/notification-bell.tsx)）：
  60 秒轮询未读红点、tab 可见时立即刷新、下拉列表点击跳转并标已读；
  挂载于工作台与项目详情页顶栏
- **浏览器系统通知**（[src/lib/browser-notify.ts](src/lib/browser-notify.ts)）：
  处理中 UI 提供「开启完成提醒」授权按钮（绝不自动弹授权框）；仅当页面不可见
  （`document.hidden`）时在状态跃迁到终态时弹系统通知，可见时页内已有状态展示

### 批量处理与队列排位说明（P1.5）

- **批量上传**（`/dashboard/new`）：一次选择/拖入多个视频（每批 ≤20 个），串行逐个
  分片上传（避免打满浏览器连接），每个文件独立进度条；单个失败不阻断后续，
  结束后可重传失败项；断点续传逐文件生效。单文件成功直接跳详情页，多文件完成跳列表
- **队列排位**：项目状态为 UPLOADED（排队中）时，详情接口附带 `queuePosition`
  （实时计算，含付费优先级——排队位置按 BullMQ prioritized zset 的真实消费顺序）；
  详情页显示「排队中（第 N 位）…」，3 秒轮询自动推进

### 音频直传说明（P2.1）

- **支持的纯音频格式**：mp3 / m4a / wav（播客、课程、录音转字幕），与视频共用同一条
  分片上传 → 抽音频（`-vn` 对纯音频天然兼容）→ ASR → 润色链路，计费按时长不变
- **mediaKind 字段**：Project 区分 video / audio（建项目时按 MIME 白名单写入）
- **导出形态差异**：音频项目仅提供字幕文件下载（SRT/VTT/ASS，不消耗额度），
  不提供烧录成片——前端导出卡隐藏入口 + 导出 API/流水线双重拦截（400）
- 上传入口：`/dashboard/new` 支持音频与视频混选批量上传；魔数校验扩展
  ID3 / MPEG frame sync / RIFF-WAVE（mp3/wav）等音频签名

### 自定义样式说明（P2.2）

- **样式微调面板**（编辑器「字幕样式」卡内）：字体 / 字号（@1080p 高度百分比）/
  位置（顶部/居中/底部）/ 垂直边距 / 字色 / 描边色与宽度（0=不描边）/
  关键词高亮色（可关闭）；调整实时反映在左侧预览
- **我的模板**：微调效果可「另存为我的模板」（`UserStyle` 表，每人 ≤20 个），
  样式选择器分组展示官方模板与我的模板，个人模板可删除
- **导出快照（所见即所得）**：创建导出时把当前预览的样式配置快照写入
  `ExportTask.styleConfig`，烧录以快照为准——微调未保存为模板也按所见导出，
  模板后续被删/改不影响已建任务
- **API**：`GET/POST /api/user-styles`、`DELETE /api/user-styles/[id]`（本人校验，
  config 服务端强校验：范围 + 颜色格式 + 字体名白名单字符集，阻断 ASS Style 行注入）；
  导出请求体支持 `{ styleId | userStyleId, styleConfig? }`（样式标识二选一，
  styleConfig 提供时以它为准；仅传 `styleId` 的旧调用完全兼容）
- ASS 字幕下载支持 `?userStyleId=`（与 `?styleId=` 对等，仅本人模板可用）
- 样式契约统一收敛在 [src/lib/style-config.ts](src/lib/style-config.ts)
  （前端渲染器 / ASS 生成器 / API 校验三方共用）

### 时间轴批量调整说明（P2.3）

- **入口**：编辑器右列「时间轴批量调整」折叠面板
- **整体偏移**：±30 秒（step 0.1），正数后移 / 负数前移；任一行起点越界（<0）整批拒绝并提示
- **整体伸缩**：0.5-2 倍（step 0.01），以首行起点为锚点拉伸/压缩时间轴——
  锚点固定保证首行不动，数学上结果恒合法（起点 ≥0 且结束 > 起点），无需额外校验
- **一步撤销**：每次应用前自动快照，可一键恢复最近一次调整
- 调整只改本地预览（标记未保存），与逐行编辑共用「保存修改」（PUT 全量校验），
  导出前须保存——与现有 dirty 拦截逻辑一致

### CI 说明（P1.7）

- `.github/workflows/ci.yml`：push/PR 到 main 自动触发，两个 job：
  - **check**：`npm ci` → prisma generate → tsc → eslint → 生产构建（零外部依赖）
  - **smoke**：Postgres/Redis service 容器 → db push + seed → 构建 → 起生产 server
    （进程内 Worker）→ 跑 [scripts/ci-smoke.mjs](scripts/ci-smoke.mjs)（13 项断言：
    未登录 401 / 登录会话 / 魔数 415 / 页面与轻接口健康）。
    冒烟全程**不调用 DashScope**，CI 零 API 费用
- 全链路 E2E（转写/导出/队列/OSS/通知/批量）烧真实 ASR/LLM 费用，保留在本地人工触发
- **CD**：暂无服务器。购机备案后在 ci.yml 追加 deploy job
  （SSH → `git pull` → `docker compose up -d --build`，步骤见 `DEPLOY.md`）

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
| 异步 | `ASR_PROVIDER=qwen-filetrans` | 原生句级毫秒时间戳 | 生产（oss 驱动自动用签名 URL；local 驱动需配 `PUBLIC_ASSET_BASE_URL`） |

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

# P1.2 OSS 直传专项：STORAGE_DRIVER=oss 时运行（整传禁用 → 分片直传 → 转写
# → 预览 302 → 导出下载 302 → 扣费 → 删除清理）
node scripts/e2e-oss-test.mjs

# P1.6 可观测性专项：告警收发+冷却（本地 webhook 模拟）→ 权限 → 无音轨视频
# 制造真实失败 → admin 失败重试闭环（运行约 3-5 分钟，含重试退避等待）
node scripts/e2e-observability-test.mjs

# P1.3 完成通知专项：权限 → 参数校验 → 双视频转写完成通知 → 单条/全部已读
# → 越权 → 无音轨失败通知 → 导出完成通知（运行约 3-6 分钟，真实调用 DashScope）
node scripts/e2e-notify-test.mjs

# P1.5 批量处理专项：暂停队列制造排队 → 详情 API 排队位置（付费优先 FIFO）
# → 恢复后转写完成位置清空 → 批量上传入口渲染
node scripts/e2e-batch-test.mjs

# P2.1 音频直传专项：MIME 白名单 → 伪音频魔数 415 → 真实 mp3 上传转写
# → mediaKind=audio → SRT 下载 → 烧录导出被拒 400（运行约 1-2 分钟，真实调用 DashScope）
node scripts/e2e-audio-test.mjs

# P2.2 自定义样式专项：模板 CRUD/上限/越权/非法配置 → 直连 DB 造 READY 项目（零 ASR 费用）
# → 我的模板烧录导出 → 快照独立性 → 微调 styleConfig 所见即所得 → ASS 带 userStyleId
# （注意：STORAGE_DRIVER=oss 时请以 `STORAGE_DRIVER=local npm start` 启动被测服务）
node scripts/e2e-user-style-test.mjs

# 配置 OSS Bucket CORS（浏览器直传必需，每个 Bucket 执行一次）
npx tsx scripts/setup-oss-cors.ts

# 生成激活码（落库并打印）
node scripts/gen-redeem-codes.mjs --seconds 600 --count 5
```

## 上线前 TODO

- [ ] 轮换 DashScope API Key（开发期间曾在聊天记录中暴露）
- [ ] 阿里云短信签名/模板报备，关闭 `SMS_DEV_MODE`
- [ ] ICP 备案 + 域名；补齐隐私协议 `/privacy`、用户协议 `/terms`
- [ ] 生产切换 OSS 存储 + `ASR_PROVIDER=qwen-filetrans`
