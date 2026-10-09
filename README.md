# SubFlow（字幕工坊）

AI 短视频字幕生成工具：上传视频 → 千问 ASR 语音转写 → LLM 润色 → 字幕编辑 → 一键烧录导出。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 框架 | Next.js 16（App Router + Turbopack + Cache Components） |
| 语言 | TypeScript（strict） |
| 数据库 | PostgreSQL 16（Docker）+ Prisma 6 |
| ASR | 阿里云百炼 qwen3-asr-flash（同步）/ qwen3-asr-flash-filetrans（异步，生产） |
| LLM 润色 | qwen-flash（DashScope OpenAI 兼容模式） |
| 媒体处理 | FFmpeg（ffmpeg-static / ffprobe-static 自带二进制） |
| 登录 | 手机号 + 短信验证码（开发模式万能码，生产对接阿里云短信） |

## 模块进度

- [x] **模块 ①**：登录/注册（短信验证码、会话、注册赠 30 分钟额度）
- [x] **模块 ②**：上传 + 转写流水线（流式上传、FFmpeg 抽音频、ASR、LLM 润色、状态机）
- [ ] **模块 ③**：字幕编辑器（视频预览 + 逐行编辑 + 样式切换）
- [ ] **模块 ④**：FFmpeg 烧录导出 + 额度扣减 + 激活码兑换
- [ ] **模块 ⑤**：支付接入 + 联调 + 部署上线

## 本地开发

```bash
# 1. 启动 PostgreSQL（首次）
docker run -d --name subflow-db -e POSTGRES_PASSWORD=subflow123 -e POSTGRES_DB=subflow -p 5432:5432 postgres:16

# 2. 安装依赖 + 初始化数据库
npm install
npx prisma db push
npx tsx prisma/seed.mjs   # 写入套餐与字幕样式种子数据

# 3. 配置 .env（参考 .env 内注释，必填 DASHSCOPE_API_KEY）

# 4. 启动
npm run dev
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
# 生成中文测试语音（Windows 自带 SAPI TTS，PowerShell）
#   见 scripts/e2e-pipeline-test.mjs 头部注释
node scripts/e2e-pipeline-test.mjs
```

脚本流程：FFmpeg 合成测试视频 → 登录 → 流式上传 → 轮询至 READY → 校验分段结构并打印字幕。

## 上线前 TODO

- [ ] 轮换 DashScope API Key（开发期间曾在聊天记录中暴露）
- [ ] 阿里云短信签名/模板报备，关闭 `SMS_DEV_MODE`
- [ ] ICP 备案 + 域名；补齐隐私协议 `/privacy`、用户协议 `/terms`
- [ ] 生产切换 OSS 存储 + `ASR_PROVIDER=qwen-filetrans`
