# SubFlow AI 网关（new-api）部署与运维手册

> 版本：P2.24（2026-10-13，AI 调用接入 new-api 自托管网关）
> 目标：多上游渠道（DashScope 千问 / 火山方舟豆包等）统一接入、额度耗尽
> 自动切换（failover）、用量与成本集中可见。

---

## 一、为什么需要网关

SubFlow 的 AI 成本直接花在云厂商账户余额上（Qwen 按量计费）。单一渠道的
风险：账户余额耗尽 → 所有转写/润色/翻译/OCR 全部失败 → 用户任务中断。

网关方案把「选哪家、用多少额度」从代码里抽出来，交给 new-api 统一管理：

| 能力 | 说明 |
|---|---|
| 多渠道管理 | 每个云厂商一个渠道（API Key 只存网关，SubFlow 不再接触） |
| 优先级路由 | priority 大者优先；同模型多渠道时高优先级耗尽/故障自动落到低优先级 |
| 失败自动切换 | 上游报错（含 403 额度不足）自动重试下一渠道，并可自动禁用故障渠道 |
| 用量统计 | 控制台看每个渠道的 token 消耗与费用，余额见底提前发现 |

「额度检测」的实现方式说明：各云厂商余额查询接口不统一，网关对部分渠道
支持自动查余额；更可靠的做法是**失败驱动切换**——额度耗尽必然表现为上游
报错，网关捕获后切渠道，效果等价于「用完自动切」，且不依赖各家的余额 API。

---

## 二、调用点与接入形态（代码事实）

| 模块 | 模型 | 接口形态 | 走网关？ |
|---|---|---|---|
| src/lib/polish.ts（润色） | qwen-flash | OpenAI chat | ✅ 经 ai-client.ts |
| src/lib/translate.ts（翻译） | qwen-flash | OpenAI chat | ✅ 经 ai-client.ts |
| src/lib/ocr.ts（画面字幕提取） | qwen3-vl-plus | OpenAI chat + 视觉 | ✅ 经 ai-client.ts |
| src/lib/asr/qwen-sync.ts（同步 ASR） | qwen3-asr-flash | OpenAI chat + input_audio | ✅ 经 ai-client.ts |
| src/lib/asr/qwen-filetrans.ts（异步文件转写） | paraformer/qwen3-asr | **DashScope 专有 API** | ❌ 保持直连 |

客户端工厂 `src/lib/ai-client.ts` 的解析顺序：

1. `AI_GATEWAY_BASE_URL` + `AI_GATEWAY_API_KEY` 均已配置 → 走网关；
2. 否则回落 `DASHSCOPE_API_KEY` 直连 DashScope 兼容模式；
3. 两者皆无 → 抛错（配置问题在启动期暴露）。

这个设计保证**随时可回滚**：清掉两个网关变量即恢复直连，不用改代码。

---

## 三、网关部署（本机试点已完成，生产迁移时照做）

现有部署为 docker compose 三件套（new-api + postgres + redis），
数据落盘 `D:\ai_play\lingjing\vendor\new-api\data`（bind mount）与 postgres 库。

```bash
# 本机访问入口：http://127.0.0.1:3001（容器内 3000，映射到宿主 3001，
# 避开 SubFlow server 的 3000 端口）
docker start postgres redis new-api
curl -s http://127.0.0.1:3001/api/status   # HTTP 200 即存活
```

> 历史注记：原 new-api 容器同时映射 3000/3001 两个端口，与 SubFlow 冲突；
> 2026-10-13 重建为仅映射 127.0.0.1:3001（ENV 与数据卷照原样复刻，
> 渠道/账号配置存 postgres 未丢失）。

生产部署到服务器时：沿用同一套 compose，new-api 控制台务必改强密码 +
仅内网访问（SubFlow 与网关同机，AI_GATEWAY_BASE_URL 用 127.0.0.1:3001，
不暴露公网）。

---

## 四、渠道配置（控制台操作）

1. 登录 `http://127.0.0.1:3001` 控制台 → 渠道 → 添加渠道：
   - **渠道 1（主）DashScope**：类型选「阿里云」或 OpenAI 兼容自定义，
     Base URL `https://dashscope.aliyuncs.com/compatible-mode/v1`，
     模型列表填 `qwen-flash,qwen3-vl-plus,qwen3-asr-flash`，
     priority 设高（如 10）。
   - **渠道 2（备）火山方舟**（拿到 Key 后加）：OpenAI 兼容，
     Base URL `https://ark.cn-beijing.volces.com/api/v3`，模型填豆包
     文本/视觉系列（如 `doubao-seed-1-6...`），priority 设低（如 5），
     并在「模型映射」里把 `qwen-flash→豆包文本`、`qwen3-vl-plus→豆包视觉`。
   - 同名模型多渠道并存时，网关按 priority 从高到低尝试。
2. 控制台 → 令牌 → 新建令牌（限定可用模型与额度），得到 `sk-` 开头的
   **网关令牌**——填入 SubFlow 的 `AI_GATEWAY_API_KEY`。
3. SubFlow `.env` 配置：

```bash
AI_GATEWAY_BASE_URL="http://127.0.0.1:3001/v1"
AI_GATEWAY_API_KEY="sk-xxxxxxxx"
```

4. 验证（对网关直接发起，不经 SubFlow）：

```bash
curl http://127.0.0.1:3001/v1/chat/completions \
  -H "Authorization: Bearer $AI_GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen-flash","messages":[{"role":"user","content":"回复OK"}]}'
```

---

## 五、渠道能力边界（调研结论，2026-10）

- **火山方舟 Chat 只有文本与视觉两种形态**（OpenAI 兼容），没有音频输入
  的 chat 模型 → 润色/翻译/OCR 可 failover 到豆包，**同步 ASR 不行**。
- 火山语音识别是独立产品线（专有协议），如需 ASR 双渠道需单独对接
  （或引入 SiliconFlow 等 whisper 兼容接口）——暂缓，先靠队列缓冲兜底。
- `qwen-filetrans`（异步文件转写）为 DashScope 专有协议，无法网关化；
  DashScope 账户没余额时它同样不可用——靠 BullMQ 任务持久化 + 恢复后
  自动重试兜底（用户感知是延迟而非丢失）。

---

## 六、试点验证清单（启用网关后逐项过）

- [ ] `curl /v1/models` 能列出网关配置的模型；
- [ ] 润色/翻译走网关出结果（上传转写一条 35s 样片全链路）；
- [ ] **同步 ASR 的 `asr_options` 透传**：qwen3-asr-flash 请求体顶层的
  `asr_options`（language/enable_itn）可能被网关结构化转发剥离——
  实测指定语言（如粤语）转写是否仍准确、数字是否转阿拉伯数字；
  若被剥离，在该渠道设置中开启透传/原始请求模式后复测；
- [ ] 停用主渠道（模拟额度耗尽）→ 请求自动落到备用渠道成功；
- [ ] 恢复主渠道 → 网关重新分流回主渠道。

---

## 七、「平台没额度」分层兜底（运维视角)

| 层 | 机制 | 用户感知 |
|---|---|---|
| 1 | 网关多渠道 failover（自动、秒级） | 无 |
| 2 | 余额/失败告警：new-api 控制台 + `ALERT_DINGTALK_WEBHOOK` 钉钉提醒充值 | 无 |
| 3 | BullMQ 队列缓冲：任务持久化，渠道恢复后 worker 自动重试 | 延迟 |
| 4 | 预付费激活码：收入先于成本；极端时关闭新建任务入口消化存量 | 可公告 |

---

## 八、相关文件

- `src/lib/ai-client.ts` — 客户端工厂（网关优先/直连回落）
- `.env.example` — `AI_GATEWAY_BASE_URL` / `AI_GATEWAY_API_KEY` 说明
- `README.md` — P2.24 变更记录
