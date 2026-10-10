# SubFlow 部署指南

从零把 SubFlow 部署到国内云服务器并上线的完整步骤。整个流程约 1-2 周（大头是 ICP 备案等待）。

## 架构总览

```
用户浏览器 ──HTTPS──▶ Caddy(自动证书) ──▶ Next.js app(docker, :3000)
                                            ├─ PostgreSQL 16 (docker, 数据卷)
                                            ├─ Redis 7 (docker, AOF 持久化)
                                            │    ├─ 任务队列：转写 / 导出（BullMQ）
                                            │    └─ 分布式限流计数（Lua 滑动窗口）
                                            ├─ Worker(docker, 独立容器)
                                            │    ├─ 转写消费（并发 TRANSCRIBE_CONCURRENCY，默认 3）
                                            │    └─ 导出消费（FFmpeg 烧录，并发 EXPORT_CONCURRENCY，默认 1）
                                            └─ /app/uploads (宿主机卷：app 与 worker 共享，源视频+导出成片)
```

- app 只做 Web 与入队；worker 独立容器消费任务，FFmpeg 重编码不抢 Web 进程 CPU，可单独重启/伸缩
- 任务在 Redis 持久化：app/worker 容器重启不丢任务；worker 崩溃时在跑任务被检测为 stalled 后自动重试（重试用尽标记 FAILED，原因写入数据库）
- 付费用户任务优先消费（有有效订阅的用户 priority=1）
- 应用以 `output: "standalone"` 产物运行，自带 ffmpeg/ffprobe 二进制，宿主机无需安装
- 数据库结构同步由一次性 `migrate` 容器执行（`prisma db push`，幂等）

## ① 购买服务器与域名

| 项 | 建议 | 说明 |
| --- | --- | --- |
| 服务器 | 阿里云/腾讯云轻量 2核4G，3Mbps 起 | 视频上传下载吃带宽，预算允许可上 5Mbps + OSS |
| 系统 | Ubuntu 22.04 / Debian 12 | 装 Docker 用 |
| 域名 | 任一注册商 | 必须实名，随后 ICP 备案 |

## ② ICP 备案（与③并行做）

备案入口在云厂商控制台（服务器买了才能备）。个人备案即可，网站名避免「工坊/工作室」等经营性词汇（如「字幕坊」）。管局审核一般 1-2 周，期间可先完成③④。

## ③ 服务器装 Docker 并部署

```bash
# 装 Docker（官方脚本）
curl -fsSL https://get.docker.com | bash

# 拉代码
git clone https://github.com/xiaoxin8635/subflow.git && cd subflow

# 配置环境变量（参考 .env.example 内注释逐项填写）
cp .env.example .env
vim .env

# 构建并启动（首次构建约 5-10 分钟，主要耗时在下载 ffmpeg 二进制）
docker compose up -d --build

# 看日志确认四件事：migrate 成功退出、redis 健康、app 无报错、worker 打印「已启动」
docker compose logs -f
```

启动成功后 `http://服务器IP:3000` 可访问。**备案下来前不要绑域名开放访问。**

## ④ HTTPS 与反代（备案通过后）

推荐 Caddy（自动申请续期证书）。`/etc/caddy/Caddyfile`：

```
yourdomain.com {
    reverse_proxy localhost:3000
    request_body {
        max_size 520MB
    }
}
```

```bash
apt install -y caddy && systemctl reload caddy
```

> `request_body` 上限必须 ≥ 上传上限（500MB），否则大视频上传被反代拦截。

## ⑤ 上线前检查清单（缺一不可）

- [ ] **轮换 DashScope API Key**：开发期间 Key 曾暴露，到百炼控制台禁用旧 Key 换新 Key，填入生产 `.env`
- [ ] **短信报备**：阿里云短信服务申请签名+模板，通过后 `SMS_DEV_MODE=false`，删除 `DEV_FIXED_CODE`
- [ ] **切换生产 ASR**：`ASR_PROVIDER=qwen-filetrans`，`PUBLIC_ASSET_BASE_URL=https://yourdomain.com`
      （DashScope 将主动下载 `https://yourdomain.com/{videoKey}` 拉取音频，
      部署后用 `curl -I https://yourdomain.com/任意videoKey` 验证公网可达）
- [ ] **管理后台**：`ADMIN_PHONES` 填你自己的手机号，登录后访问 `/admin` 生成激活码
- [ ] **收款码**：把个人微信/支付宝收款码截图放到 `public/pay-qr/wechat.png`、`alipay.png`，
      确认 `/pricing` 页正常显示后重新 `docker compose up -d --build`
- [ ] **法务页**：`/privacy` 与 `/terms` 页面已内置，上线前把条款中的主体名称、联系方式替换为真实信息；`NEXT_PUBLIC_ICP_BEIAN` 填备案号（页脚自动展示，ICP 备案要求网站底部展示备案号）
- [ ] **备份数据库**：`docker compose exec db pg_dump -U postgres subflow > backup.sql` 写进 crontab（每日一次）
- [ ] **修改测试套餐价格**：`npx tsx prisma/seed.mjs` 写入的是演示价格，上线前到 `/admin` 或数据库调整为真实售价

## 日常运维

```bash
docker compose logs -f app        # 看应用日志（Web/入队/限流）
docker compose logs -f worker     # 看 Worker 日志（转写/导出执行、重试与死信）
docker compose restart app        # 重启应用（更新 .env 后需要）
docker compose restart worker     # 重启 Worker（在跑任务会 stalled 自动重试，不丢）
docker compose up -d --build      # 更新代码后重新构建部署
docker compose exec db pg_dump -U postgres subflow > backup.sql   # 手动备份
```

## 已知限制（后续迭代方向）

- **带宽瓶颈**：视频经服务器中转（上传→转写→下载成片），3-5Mbps 带宽下 500MB 视频传完约 15-25 分钟。
  正式运营建议接 OSS 直传 + CDN（应用层已预留 `publicUrlFor` 抽象，替换 storage.ts 即可）
- **单机部署**：compose 单机方案（Redis 队列已就绪，水平扩展只差文件上 OSS + 多实例）。日活过千再考虑
