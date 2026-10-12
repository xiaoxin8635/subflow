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
- [x] **P2.4 字幕翻译**（`docs/ROADMAP.md` 第三期）：整份字幕一键翻译为目标语言
      （英/日/韩/西/葡/繁中，qwen-flash 分批调用），时间轴与原文逐行对齐；
      按源字幕字数计费（每 1000 字 60 秒额度、最低 60 秒），SRT/VTT/ASS 三格式
      下载；独立翻译队列（Worker 并发可调）+ 完成站内通知 + 同语言进行中 409
- [x] **P2.5 邀请裂变**（`docs/ROADMAP.md` 第三期）：每用户唯一邀请码（首访懒生成，
      8 位去易混字符），新用户注册带码双方各得 10 分钟额度（注册事务内原子发奖，
      `INVITE_REWARD`/`INVITEE_BONUS` 双流水）；邀请页展示码/复制链接/统计/脱敏
      记录，登录页支持 `?ref=` 自动带码，无效码静默忽略不阻断注册，同一账号
      仅可被邀请一次（unique 防刷）
- [x] **P2.6 片段导出**（`docs/ROADMAP.md` 第三期）：选时间段裁剪导出——视频项目
      FFmpeg `-ss/-t` 裁剪+烧录字幕（字幕时间轴自动 clamp 到片段并平移至 0 起，
      区间无字幕则纯裁剪），音频项目纯裁剪输出 mp3；按片段时长 1:1 计费
      （`CONSUME_CLIP` 流水），整片导出链路不受影响（回归 E2E 覆盖）
- [x] **P2.7 双语字幕**（`docs/ROADMAP.md` 第三期）：翻译完成后可导出「原文+译文」
      双语字幕——烧录成片（原文在上、译文在下同屏，可与片段导出组合）+
      双语 SRT/ASS/VTT 字幕文件下载；译文实时读取（重新翻译后按最新版本烧录），
      不额外加价
- [x] **P2.8 加油包**（`docs/ROADMAP.md` 第三期）：一次性时长包三档（¥9.9/1 小时、
      ¥29.9/200 分钟、¥49.9/400 分钟，单价递减），购买页展示 + 后台档位快捷发码，
      兑换链路复用时长码零改动
- [x] **P2.9 工作台改版**：「剪辑台」设计母题——登录后统一深色侧边栏外壳
      （桌面侧栏/移动横滑标签栏），项目卡片带封面缩略图（转写时旁路抽帧，失败不阻断）、
      时长角标与字幕条状态徽章；状态筛选（URL 驱动 + 滑动指示条）、
      进行中项目 10 秒自动刷新、内联统计条；
      项目详情页同步套壳（监视器主导宽布局 + 处理中封面扫描线）
- [x] **P2.10 OCR 硬字幕提取**（`docs/ROADMAP.md` 后置项）：新建项目可选「提取画面字幕」
      ——qwen3-vl-plus 逐帧识别画面已有字幕（1fps 抽帧 600 帧封顶），相邻帧聚合时间轴，
      润色/导出/翻译全链路复用；计费与转写同价按视频时长，音频项目强制语音转写
- [x] **P2.11 识别设置与编辑器增强**：上传时可选「识别设置」——场景预设
      （通用/技术讲解/直播带货/课堂讲课）、识别主语言（中/粤/英/日/韩/自动检测）、
      自定义热词（≤50 个，注入润色纠错与翻译术语表）、噪声抑制（FFmpeg afftdn 降噪
      后再识别，嘈杂环境录音建议开启）；ASR 层语种透传 + 数字规范化 ITN；
      润色断句增强（语气词清理 + 场景化纠错）；编辑器新增查找替换（命中计数 + 撤销）
      与文稿导出（TXT 逐句一行 / 带时间戳 Markdown）、双语预览切换（原文/译文/双语
      叠加预览，不改字幕数据）、打包下载（zip：原文三格式 + 文稿 + 全部译文与双语）；
      翻译卡新增风格选择（通用/口语化/短视频精简，随任务快照存储）
- [x] **P2.12 编辑器信息架构重排（界面批次①）**：编辑器顶部动作条收纳「字幕翻译」
      「导出成片」两个低频入口（点开右侧抽屉 ToolDrawer，Esc/遮罩/✕ 关闭），
      主界面聚焦剪辑；右列改单行工具条（时间轴 / 查找替换开关 + 文稿TXT/MD /
      打包 / 保存，窄屏横向滚动不折行），分段列表占满剩余高度；字幕样式卡收成
      一行折叠条（展示当前模板名，展开才见模板切换与微调）；新建页上传拖放区
      移到页面顶部（先选文件，处理方式与识别设置跟随其下）
- [x] **P2.13 登录页左右分栏（界面批次③·浅色版）**：桌面端左侧产品舞台——
      迷你播放器 mock（深色视频帧上三句字幕 9 秒循环轮播、关键词品牌色高亮，
      globals.css `login-caption` 动画、尊重 prefers-reduced-motion）+ 波形条
      （呼应编辑器音轨）+ 三条价值点；右侧保留原登录卡（表单逻辑零改动），
      卡片下新增《服务条款》《隐私政策》链接；移动端只保留 Logo 行 + 登录卡；
      页面去掉 SiteHeader 改自包含版式（Logo 链接回首页）
- [x] **P2.14 定价页套餐层次（界面批次③·浅色版）**：三档套餐时中间档做推荐位
      （紫描边 ring + 「最受欢迎」角标，与加油包区同视觉语言）；每张套餐卡新增
      「扫码购买」CTA（推荐档实心、其余软底），锚点滚动到底部付款区；
      套餐卡与加油包卡统一 hover 微抬升过渡
- [x] **P2.15 空状态立体插画（界面批次③·浅色版）**：新增 [empty-illustration.tsx](src/components/empty-illustration.tsx)
      内联 SVG 渐变立体图标（文件夹/放大镜/信封/胶片四款，零外部图片依赖），
      替换五处空态——工作台「还没有项目」「筛选无结果」、邀请记录、通知下拉、
      编辑器「未识别到字幕内容」；图标带 `empty-float` 缓浮动画（尊重
      prefers-reduced-motion），尺寸三档（lg 整页 / md 卡片 / sm 下拉）；
      顺手修复通知下拉方向 bug：侧边栏铃铛贴近视口底部，面板改为向上弹出
- [x] **P2.16 新建项目页「投料台」版式重构**：[new-upload.tsx](src/app/dashboard/new/new-upload.tsx)
      视图层整体重写（上传链路逻辑零改动）——大拖放区拖入时整块响应（边框/
      底色变品牌色、上传图标反色放大、文案切「松手就开始上传」，dragenter/
      leave 计数器防子元素抖动）；格式与限制信息做成拖放区内 chips；文件行
      类型图标（视频播放框/音频波形/非法格式警示三角）+ 进入/完成动效 +
      失败行「重试」按钮；处理方式改图标选择卡（选中勾角标）；场景四档压成
      chips + 下方动态 hint 行；「识别设置」收成折叠条（收起显示当前值摘要
      如「通用 · 中文（普通话）」，上传中禁改）；上传按钮内衬批量整体进度条；
      新增 `rise-in`/`pop-in` 微动效（尊重 prefers-reduced-motion）
- [x] **P2.20 工作台统计条与筛选 tabs 精修**：[page.tsx](src/app/dashboard/page.tsx) + [filter-tabs.tsx](src/components/filter-tabs.tsx) + [format.ts](src/lib/format.ts)
      工作台顶部可读性打磨（结构零改动）——`formatSecondsLabel` 秒分支
      四舍五入取整（累计转写 21.993 秒这类浮点尾差不再外露，惠及全部调用点）；
      「剩余额度 · 兑换」去 middle-dot 串接，「兑换」改品牌软底小胶囊
      （hover 翻实底——动作长得像动作）；FilterTabs 计数数字改小胶囊徽章
      三态（选中项品牌软底 / 有计数灰底 / 零计数弱化淡灰），滑动指示条不变
- [x] **P2.19 侧边栏导航花哨化**：[app-shell.tsx](src/components/app-shell.tsx)
      深色侧边栏视觉升级（结构与服务端组件形态零改动）——5 个导航项各带
      stroke SVG 线性图标（胶片格/＋/用户＋/票券/闪电，多段 path 合一 d）；
      当前项改品牌渐变底（`from-brand/25 to-brand/5`）+ 左缘发光指示条
      （brand 竖条 + 品牌色光晕阴影）、图标亮靛蓝、其余项图标 hover 微移
      变亮；SF Logo 改靛蓝渐变方块 + 品牌辉光；侧栏顶部淡靛蓝光晕
      （radial-gradient + isolate/-z-10 stacking，光在面板底之上、内容之下）；
      额度卡高光描边 + 余额数字白→灰渐变；移动端标签栏同步加图标、当前项
      `bg-brand/20` 软底
- [x] **P2.18 识别设置面板精修**：[new-upload.tsx](src/app/dashboard/new/new-upload.tsx)
      表单控件与整体键帽/实体键体系统一（交互逻辑零改动）——场景四档 chips
      加 stroke SVG 图标（话筒/烧杯/购物袋/学士帽，未选中态图标淡灰）；语言
      select 去 native 外观（appearance-none + 自绘 chevron + 底边实体阴影）；
      噪声抑制原生 checkbox 改 switch 开关（sr-only input + peer 轨道圆点，
      表单语义不变）；语言与噪声抑制两列布局（窄屏自动堆叠，去掉基线 hack）；
      热词标题行右侧实时计数 N/50（与折叠条摘要同一 trim 口径，空段不计）
- [x] **P2.17 编辑器舒适度精修**：[subtitle-editor.tsx](src/app/project/[id]/subtitle-editor.tsx) + [project-live-view.tsx](src/app/project/[id]/project-live-view.tsx)
      项目详情页按钮/标签视觉与可读性打磨（交互逻辑零改动）——标题元信息
      去 middle-dot 串接，引擎技术名收进悬停提示，「AI 已润色」改绿色勾徽章；
      保存三态拆分两种形态（无改动 = 绿色「已保存」状态胶囊，有改动/保存中
      = 「保存修改」实体按键，状态长得像状态、动作长得像动作）；快捷键提示
      从灰字点串改键帽样式（`Kbd` 组件，底边实体阴影与全站按键同母题）；
      字幕样式模板 chips 加迷你效果预览（`StyleDot`：中灰小底按模板字色/
      描边渲染示意「字」，三款模板不点开即可辨）；折叠条 ▾/▲▼ 字符换 SVG
      chevron（带旋转过渡）；字幕行 hover 边框加深、行内 ＋/✕ 按钮默认更淡
      （悬停行时变清晰，触屏仍可见）；工具条五按钮升级 `ToolChip` 键帽质感
      （stroke SVG 图标 + 底边实体阴影 + hover 抬升/active 按压，面板开关
      保留品牌软底激活态）
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
  （用户/额度/项目/导出/消耗）+ 页面化生成激活码（套餐码/加油包/时长码 × 数量）+ 未用码与用户总览
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

- **入口**：编辑器右列工具条「时间轴」按钮（P2.12 起收纳进单行工具条，开启高亮）
- **整体偏移**：±30 秒（step 0.1），正数后移 / 负数前移；任一行起点越界（<0）整批拒绝并提示
- **整体伸缩**：0.5-2 倍（step 0.01），以首行起点为锚点拉伸/压缩时间轴——
  锚点固定保证首行不动，数学上结果恒合法（起点 ≥0 且结束 > 起点），无需额外校验
- **一步撤销**：每次应用前自动快照，可一键恢复最近一次调整
- 调整只改本地预览（标记未保存），与逐行编辑共用「保存修改」（PUT 全量校验），
  导出前须保存——与现有 dirty 拦截逻辑一致

### 字幕翻译说明（P2.4）

- **入口**：编辑器顶部「字幕翻译」按钮唤起的右侧抽屉（P2.12 起收进抽屉，
  视频/音频项目均可用），选择目标语言后一键发起，进行中任务 3 秒轮询自动推进
- **支持语言**：英语 / 日语 / 韩语 / 西班牙语 / 葡萄牙语 / 繁体中文
  （[src/lib/constants.ts](src/lib/constants.ts) `TRANSLATE_LANGUAGES` 白名单）
- **翻译链路**：读源转写分段 → 按 40 句一批调 qwen-flash（DashScope 兼容模式，
  [src/lib/translate.ts](src/lib/translate.ts)）→ 时间轴不变、文本替换为译文；
  中文关键词高亮不适用于译文故不保留。**翻译是付费产物，LLM 失败直接抛错**
  走队列重试（与润色的静默降级语义相反），绝不交付原文
- **计费**：按源字幕总字符数（每 1000 字 60 秒额度、最低 60 秒）；创建时余额
  预检（402），成功后事务内条件扣减（防并发负数）+ 写
  `CreditLedger(reason=CONSUME_TRANSLATE)`；失败不扣费
- **版本语义**：同项目同语言仅一个版本（DB unique 约束）——进行中重复发起 409；
  已终态（DONE/FAILED）重新发起即覆盖重建
- **API**：`POST/GET /api/projects/[id]/translations`（创建 / 列表）、
  `GET /api/translations/[id]`（状态轮询）、
  `GET /api/translations/[id]/[format]`（srt|vtt|ass 下载，文件名含语言代码；
  ASS 使用系统默认样式）；全部本人校验（非本人统一 404）
- **限流**：每用户每小时最多 10 次翻译创建（LLM 有真金白银成本，防刷）
- **队列**：独立 `translate` 队列，Worker 并发 `TRANSLATE_CONCURRENCY`（默认 2）；
  重试用尽标记 FAILED 并钉钉告警，完成/失败均写站内通知

### 邀请裂变说明（P2.5）

- **邀请码**：每用户唯一 8 位码（字符集去掉 0/O/1/I 易混字符，
  [src/lib/invite.ts](src/lib/invite.ts)）；首访邀请页时懒生成落库，无预生成脚本
- **奖励规则**：新用户**注册时**填写邀请码，双方各得 10 分钟额度
  （`INVITE_REWARD_INVITER_SECONDS` / `INVITE_REWARD_INVITEE_SECONDS`，env 可调），
  叠加在 30 分钟注册赠送之上；老用户带码再登录无效（仅注册分支生效）
- **原子性**：发奖在注册事务内完成——邀请人加余额 + `INVITE_REWARD` 流水 +
  `InviteRecord` 落库，被邀请人余额 = 注册赠送 + 邀请奖励 + `INVITEE_BONUS` 流水；
  无效/非法码静默忽略，绝不阻断注册
- **防刷**：`InviteRecord.inviteeId` unique 约束——同一账号终身仅可被邀请一次；
  邀请码格式白名单正则（不匹配直接忽略，不查库）
- **页面**：`/dashboard/invite` 邀请页（码/复制链接/复制码/累计统计/脱敏记录，
  [src/app/dashboard/invite/](src/app/dashboard/invite/)）；`/login?ref=CODE` 自动
  填充邀请码输入框；工作台顶栏「邀请好友」入口
- **API**：`GET /api/invite`（邀请码 + 奖励规则 + 统计 + 记录列表，手机号脱敏）

### 片段导出说明（P2.6）

- **入口**：编辑器顶部「导出成片」按钮唤起的抽屉，勾选「只导出片段」，输入起止秒
  （「当前」按钮一键填入播放器进度）；音频项目直接提供片段裁剪表单（无样式语义，输出 mp3）
- **视频片段**：FFmpeg `-ss {start} -i 源 -t {dur}` 裁剪 + `ass` 滤镜烧录——
  字幕行 clamp 到片段区间并平移至 0 起（跨边界行截断保留可见部分），
  区间内无字幕行则不挂滤镜退化为纯裁剪（[src/lib/export-pipeline.ts](src/lib/export-pipeline.ts)）
- **音频片段**：`sliceAudio` 纯裁剪，统一重编码输出 mp3（兼容性最好）；
  整片对音频项目仍拒绝（无烧录语义）
- **计费**：按片段时长 1:1（`clipCostSeconds` = ceil(end−start)，最低 1 秒），
  创建时余额预检（402），成功后事务内条件扣减 + `CreditLedger(reason=CONSUME_CLIP)`；
  整片导出计费与流水（`CONSUME_EXPORT`）不变
- **任务模型**：复用 `ExportTask`（新增可空 `startSec/endSec`，null = 整片），
  同项目同时仅一个导出任务（409）不变；下载文件名片段为
  `原名_片段_5-15s.mp4`（音频 `.mp3`），Content-Type 按格式区分

### 双语字幕说明（P2.7）

- **入口一（烧录）**：「导出成片」抽屉内「字幕语言」选「双语（原文 + 译文）」+ 语言下拉
  （仅列出已完成的翻译语言；未完成任何翻译时提示先开「字幕翻译」抽屉），
  可与「只导出片段」组合成双语片段
- **入口二（字幕文件）**：「字幕翻译」抽屉已完成语言行提供「双语SRT」「双语ASS」下载
  （原文在上、译文在下，每条字幕双行；VTT 亦支持 `?bilingual=1`），
  供剪映等剪辑软件手动挂载
- **双语编译**：同一 Dialogue 内 `原文\N译文` 双行（[src/lib/ass.ts](src/lib/ass.ts)
  `buildBilingualAss`）——libass 垂直堆叠按 position/marginV 整体锚定，
  上下行永不错位，时间轴天然同步；关键词高亮标签只出现在原文行内自行闭合。
  SRT/VTT 双语为块内真实换行，合并逻辑与烧录共用同一索引对齐契约
- **任务模型**：`ExportTask.targetLang`（可空 = 单语）——创建时校验该语言翻译
  已完成（400），烧录时实时读取 `Translation.segments` 与原文按索引逐行合并
  （P2.4 保证行数/时间轴一致；重新翻译覆盖后，未开始的任务按最新版本烧录），
  在片段 clamp 之前合并（clamp 的过滤不破坏索引对齐）
- **计费**：双语不额外加价（烧录按视频/片段时长、字幕文件下载免费）；
  音频项目不支持双语烧录（无画面，创建接口 400 + 流水线兜底双重拦截）
- **通知**：双语导出完成的通知文案标注「双语·语言代码」

### 加油包说明（P2.8）

- **产品形态**：非订阅的一次性时长包，本质是「预设档位秒数的时长激活码」——
  复用 `RedeemCode.bonusSeconds` 载体与既有兑换链路，后端零改动
- **档位**：三档定义在 [src/lib/constants.ts](src/lib/constants.ts) `ADDON_PACKAGES`
  （体验 ¥9.9/3600s、标准 ¥29.9/12000s、大容量 ¥49.9/24000s），单价随包体递减
  （0.165 → 0.15 → 0.125 元/分钟）激励买大包；改档位只动常量一处，
  购买页与后台快捷发码同源
- **入口**：`/pricing` 加油包区块展示档位/价格/时长/折合单价（「最受欢迎」推荐标准档）；
  `/admin` 发码表单「加油包」模式按档位本地折算 `seconds` 提交（生成即对应档位时长码）
- **兑换**：与时长码同链路（`/dashboard/redeem` → `POST /api/redeem`），
  额度直接进余额（`REDEEM_BONUS` 流水），转写/导出/翻译通用；重复兑换 409

### 工作台改版说明（P2.9）

- **设计母题「剪辑台」**：创作者的视觉母语是剪辑软件（剪映/PR/达芬奇的深色工具面板 +
  浅色画面区），登录后页面统一套 [src/components/app-shell.tsx](src/components/app-shell.tsx)
  深色侧边栏外壳（桌面 ≥lg 左侧固定 240px；窄屏收纳为顶部横向滚动标签栏），
  当前项左侧 brand 色竖条高亮；底部用户区含剩余额度、脱敏手机号、通知铃铛（dark 配色）
  与退出登录；营销页与项目详情页（编辑器需全宽）仍用 SiteHeader 不套外壳
- **项目卡片（监视器轨道语言）**：封面缩略图（视频项目转写时自动抽帧，音频项目渲染
  波形占位图）、右下角时长角标（播放器 UI 惯例）、状态徽章为「字幕条」样式
  （黑底白字小圆角；转写/润色中为 brand 色底 + 呼吸点动画）
- **封面抽帧链路**：`Project.coverKey`（`covers/{projectId}.jpg` 固定 key，重转写覆盖写）
  → [src/lib/media.ts](src/lib/media.ts) `extractCoverFrame`（取视频首帧，
  缩放 640px 宽）→ [src/lib/storage.ts](src/lib/storage.ts) `uploadCover`
  （local 落盘 `uploads/covers/` / oss 上传）→ `GET /api/projects/[id]/cover`
  鉴权输出（local 流式 + 私有缓存头 / oss 302 签名 URL 4h）。
  抽帧为旁路执行：失败仅记日志，绝不阻断转写主流程；音频项目与无视频轨跳过；
  项目删除联动清理封面文件
- **状态筛选**（[src/components/filter-tabs.tsx](src/components/filter-tabs.tsx)）：
  全部/进行中/已完成/失败四档，URL 参数驱动（`?status=`，可分享/刷新保持），
  滑动指示条动画（`useLayoutEffect` 测量 + 双 rAF 兜底字体重排），
  每档带实时计数；`prefers-reduced-motion` 下关过渡
- **自动刷新**（[src/components/auto-refresh.tsx](src/components/auto-refresh.tsx)）：
  列表存在进行中项目时服务端条件渲染该组件，10 秒轮询 `router.refresh()`；
  页面不可见时跳过；项目全部到终态后组件不再渲染、轮询自然停止
- **统计条**：内联数字（项目数 / 累计转写 / 剩余额度）代替 SaaS 卡片套件，
  余额展示复用 [src/lib/format.ts](src/lib/format.ts) `formatSecondsLabel`
  （「X 小时 Y 分钟」）
- **退出登录**：桌面侧边栏底部整行按钮 + 移动端标签栏末尾紧凑入口
  （[src/components/logout-button.tsx](src/components/logout-button.tsx)）
- **封面为首帧**：封面帧取视频第 0 帧（用户指定）；seed/重转写固定 key 覆盖写
- **项目详情页同母题**（[src/app/project/[id]/page.tsx](src/app/project/[id]/page.tsx)）：
  详情页也套 AppShell 外壳（登录后唯一例外已消除，营销页仍用 SiteHeader）；
  内容区放宽为监视器主导布局（max-w-7xl，视频预览是最大幅面）；
  处理中态渲染「封面监视器 + 扫描线」卡（与工作台列表同款，详情接口附带
  `coverKey`）；状态徽章紧挨标题；翻译/导出入口 P2.12 起收进编辑器顶部按钮抽屉

### OCR 硬字幕提取说明（P2.10）

- **场景**：画面上已烧录字幕的视频（无人声也能提取），扩大可处理视频范围；
  新建项目页「处理方式」二选一——语音转写（默认）/ 提取画面字幕（OCR，仅视频，
  混选的音频自动按语音转写）
- **管线**：`Project.processMode`（asr/ocr，服务端白名单清洗 normalizeProcessMode）
  → [src/lib/ocr.ts](src/lib/ocr.ts) `extractSubtitlesFromVideo`：均匀采样抽帧
  （[src/lib/media.ts](src/lib/media.ts) `extractFrames`，1fps，600 帧封顶——超 10 分钟
  视频均匀降采样）→ **qwen3-vl-plus** 逐帧识别字幕文字（DashScope OpenAI 兼容模式，
  与 ASR 同一接入；并发 3 `OCR_CONCURRENCY`、单帧重试 2 次指数退避）→ 相邻同文本帧
  合并为句（时间轴精度 = 采样间隔 1 秒）→ 走既有 LLM 润色与入库链路（OCR 错字更常见，
  更需要润色）；识别失败与 ASR 同语义走任务失败重试
- **模型名注意**：旧 `qwen-vl-plus` / `qwen3-vl-flash` 已 404 下线，用 `qwen3-vl-plus`
  （可用 `OCR_MODEL` 环境变量覆盖）；实测成本约 0.026 元/分钟视频（~285 token/帧）、
  处理耗时约为视频时长的 60%
- **入口与 API**：整传 `POST /api/projects` 收 `X-Process-Mode` 头；分片 complete
  收 body `{ processMode }`；两路均做白名单清洗且**音频项目强制 asr**（前后端双重）；
  列表/详情接口均返回 `processMode`
- **全链路复用**：OCR 产出的字幕段结构与转写一致 → 编辑器/样式/导出/翻译/双语/片段
  全部现成可用；音频项目恒不涉及 OCR
- **已知边界**：OCR 视频自带原字幕，预览/烧录的新字幕会与原字幕重叠（原字幕无法去除，
  物理限制）；竖屏花字/滚动字幕不保证识别；全片无字幕时报「OCR 未识别到任何字幕文字」
  失败（与 ASR 无语音同语义）
- **E2E**：[scripts/e2e-ocr-test.mjs](scripts/e2e-ocr-test.mjs)（18 断言——含 FFmpeg
  drawtext 造硬字幕视频，注意 drawtext 必须放在 concat 之后，输入段是局部时间轴）

### 识别设置说明（P2.11）

- **入口**：新建项目页「识别设置」区（仅语音转写模式显示场景/语言；OCR 模式仅热词——
  热词对 OCR 项目的润色纠错同样生效）；字段随 complete 请求入库
  （`Project.scene / language / hotwords`，服务端白名单清洗，非法值回退默认）
- **场景预设**：[src/lib/constants.ts](src/lib/constants.ts) `ASR_SCENES` 四档
  （通用/技术讲解/直播带货/课堂讲课），每档带场景描述文本，注入 AI 润色纠错 prompt
  （让模型知道该按哪个领域的术语习惯纠错）
- **识别主语言**：`ASR_LANGUAGES` 六档（中/粤/英/日/韩/自动检测），透传 DashScope
  `asr_options.language`；「自动检测」不传语言参数交给服务端判定
- **数字规范化 ITN**：`asr_options.enable_itn` 默认开启（「一百二十三」→「123」，
  短视频字幕惯例）
- **噪声抑制**：上传页「噪声抑制」勾选（仅语音转写模式显示，`Project.denoise`）——
  抽取音频时叠加 FFmpeg `afftdn`（FFT 自适应降噪）滤镜，对嘈杂环境录音先降噪再识别；
  默认关闭（干净音源降噪反而可能损伤语音细节）；对 OCR 模式无意义（不抽音频）故隐藏
- **自定义热词**：逗号/顿号/分号/换行拆分、去重、≤50 个、单词 ≤30 字
  （`parseHotwords`）；三处生效——润色纠错 prompt（按标准写法纠正同音字）、
  翻译术语表（全片译法统一、品牌名保留原文）、filetrans 语境语料（见下）
- **ASR 语境增强的实测边界**：qwen3-asr-flash OpenAI 兼容模式（dashscope.aliyuncs.com）
  **实测拒绝 system message**（`InternalError.Algo.InvalidParameter`，与官方文档描述不符），
  同步模式的场景/热词不在 ASR 层注入，全部由润色纠错 prompt 承担（qwen-flash 常规
  chat 模型无限制）；生产 filetrans 走原生协议 `parameters.corpus` + `parameters.language`
  （注意：语言参数是 string，不是 paraformer 时代的 language_hints 数组），待部署后实测
- **润色断句增强**：[src/lib/polish.ts](src/lib/polish.ts) 在既有「严格句数不变」契约上
  新增纯语气词清理（单独的「呃」「嗯」「啊」可删）与场景/热词纠错指令；增强失败
  回退原文（不阻断转写）
- **上传页注意（React 陷阱）**：选择/拖放文件必须先 `Array.from()` 快照再 setState——
  React 的 setState updater 延迟到渲染期执行，若直接传 `e.target.files` 并在 onChange
  里重置 `input.value`，updater 迭代到已清空的 FileList 会出现「选了文件但列表没反应」

### 编辑器增强与翻译风格说明（P2.11）

- **查找替换**（[subtitle-editor.tsx](src/app/project/[id]/subtitle-editor.tsx)）：
  右列工具条「查找替换」开关面板——查找词实时显示命中段数，「全部替换」前自动快照
  （与时间轴批量调整共用「撤销最近一次批量调整」，保留一步）；替换为空 = 删除匹配文本；
  纯前端计算，保存复用统一 PUT 链路
- **文稿导出**：右列头部「文稿TXT / 文稿MD」按钮——TXT 逐句一行（公众号/笔记直接用）、
  MD 为「**mm:ss.d** 句文本」带时间戳格式；下载内容带 UTF-8 BOM（Windows 记事本/
  Excel 不乱码），文件名取项目标题并清洗 Windows 非法字符
- **翻译风格**（[translate-card.tsx](src/app/project/[id]/translate-card.tsx)）：
  语言 chips 下新增风格三档（通用/口语化/短视频精简，`TRANSLATE_STYLES`），随翻译任务
  快照存储（`Translation.style`，重新翻译可换风格）；风格指令注入每批翻译的
  system prompt；项目热词自动作为术语表注入（全片译法统一，品牌/产品/人名保留原文）；
  同语言重新翻译覆盖旧版本（语义 = 换风格重译）
- **双语预览切换**：编辑器存在已完成翻译时显示「叠加预览」chips（原文/译文/双语，
  多语言时先选语言）——只合成叠加层显示文本（双语 = `原文\n译文`，whitespace-pre-wrap
  两行渲染），不修改字幕数据；译文行与原文按索引对齐（P2.4 契约）
  （`GET /api/projects/[id]/translations?withSegments=1`，仅 DONE 任务携带分段）
- **打包下载（zip）**：编辑器右列「打包下载」按钮 → `GET /api/projects/[id]/subtitle-bundle`
  ——一个 zip 装下原文 SRT/VTT/ASS + 文稿 TXT/MD + 每个已完成翻译的三格式与
  双语 SRT/ASS（原文在上译文在下）；文件名取项目标题（清洗 Windows 非法字符），
  zip 内 SRT/文稿带 UTF-8 BOM（与单格式下载一致）；纯文本生成零成本不扣额度

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
- 轨道化字幕列表：每行显示时间区间（等宽数字）与「轨道位置条」——该句在整片
  时间轴上的位置与跨度（当前播放行实色高亮），一眼扫出句子分布与密度
- 音频波形时间轴：字幕列表顶部渲染真实音频波形（转写时旁路提取 PCM 峰值，
  约 10 桶/秒封顶 36000 桶，JSON 存储双驱动复用）；点击/拖动/方向键定位
  （只 seek 不播放），已播放区域染色 + 播放头；旧项目与提取失败时优雅退化
- 波形拖拽调时间轴：波形上叠加与行列表对应的半透明字幕段落块（块内截断显示
  句文字，更接近剪辑软件字幕轨）——拖块左/右缘（8px 热区）调起止时间、拖块
  中间整体平移（时长不变），拖拽中浮显实时时间提示、仅本地预览（松手才落位）；
  起点≥0 / 终点≤片长 / 最短 0.1 秒自动拦截；与其他句时间重叠的块显示琥珀
  警示色并提示「播放会同显」（仅警示不拦截，配音重叠合法），与时间轴批量调整
  共用一步撤销；保存走统一 PUT
- 剪辑快捷键：`空格` 播放/暂停、`←`/`→` 快退/快进 2 秒、`Ctrl/Cmd+S` 保存
  （焦点在输入框时不劫持）；「已保存」按钮态以最近一次保存为基线，
  保存成功后 dirty 归零

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

# P2.4 字幕翻译专项：语言白名单 → 余额 402 → 真实翻译两语言（调用 DashScope，约几分钱）
# → 三格式下载 → 计费/流水/通知 → 同语言 409 → 越权 → 限流 429（注入 PENDING 零 LLM 成本）
node scripts/e2e-translate-test.mjs

# P2.5 邀请裂变专项：未登录 401 → 首访懒生成邀请码 → 带码注册双方发奖（余额/流水/记录）
# → 老用户带码无效 → 无效码静默 → invitee unique 防刷 → 邀请页/登录页/工作台 SSR
node scripts/e2e-invite-test.mjs

# P2.6 片段导出专项：参数校验 → 402 → 音频片段 mp3 / 视频片段烧录（真 FFmpeg 裁剪）
# → 无字幕区间纯裁剪 → 409/越权 → 整片导出回归（本地 FFmpeg，零 API 费用；
#   注意被测服务须以 STORAGE_DRIVER=local 启动）
node scripts/e2e-clip-test.mjs

# P2.7 双语字幕专项：targetLang 校验（非法/无翻译/进行中/音频拦截）→ 双语整片烧录
# → 双语+片段组合烧录（真 FFmpeg）→ 双语 SRT/ASS/VTT 下载内容断言 → 单语回归 → 越权
# （译文直插 DB 零 LLM 费用；被测服务须以 STORAGE_DRIVER=local 启动；重跑前清 rl:export:*）
node scripts/e2e-bilingual-test.mjs

# P2.8 加油包专项：购买页 SSR 档位渲染（名称/价格/时长/单价/标签）→ 按档位秒数发码
# → 兑换到账（余额/REDEEM_BONUS 流水）→ 重复兑换 409 → 清理（零 LLM/API 费用）
node scripts/e2e-addon-test.mjs

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
