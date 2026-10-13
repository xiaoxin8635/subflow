# SubFlow AI 网关（new-api）部署与运维手册

> 版本：P2.24（2026-10-13，AI 调用接入 new-api 自托管网关；同日完成
> 双渠道配置与 failover 实测，见第四/五/六节实测结论）
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

## 四、渠道配置（2026-10-13 已完成，本机实测）

当前生产配置（可直接对照控制台检查）：

1. **渠道 1（主）dashscope-primary**（priority 10）：类型 OpenAI 兼容，
   Base URL `https://dashscope.aliyuncs.com/compatible-mode`
   （**不要带 `/v1`**——new-api 会把客户端路径 `/v1/chat/completions`
   原样拼到 Base URL 后，带了会变成 `/v1/v1/...` 报 404），
   模型 `qwen-flash,qwen3-vl-plus,qwen3-asr-flash`。
2. **渠道 2（备）volcengine-ark**（priority 5）：类型火山方舟（type 45），
   模型含 `doubao-seed-2-1-lite-260915` + 两个映射名，模型映射：
   `qwen-flash / qwen3-vl-plus → doubao-seed-2-1-lite-260915`；
   「参数覆盖」填 `{"thinking":{"type":"disabled"}}` 关闭豆包思考链
   （实测省 ~50 tokens/次，响应不再带 reasoning_content）。
   映射里**不含 qwen3-asr-flash**（格式互斥，见第五节）。
3. **运营设置 → 重试次数（RetryTimes）= 3**——默认 0 时任何错误都直接
   透传、**不会 failover**；403 额度耗尽在默认重试状态码范围（401-407）内，
   开启后即自动切换。
4. 令牌 `subflow`（限 qwen-flash / qwen3-vl-plus / qwen3-asr-flash 三模型），
   完整 key 经 `POST /api/token/{id}/key` 获取（列表页只显示打码值）。
5. SubFlow `.env` 已配置：

```bash
AI_GATEWAY_BASE_URL="http://127.0.0.1:3001/v1"
AI_GATEWAY_API_KEY="sk-xxxxxxxx"
```

---

## 五、渠道能力边界（2026-10-13 实测修正）

- **润色/翻译/OCR 可 failover 到火山豆包**（已实测通过）：映射
  `qwen-flash / qwen3-vl-plus → doubao-seed-2-1-lite-260915`，
  禁用主渠道后请求自动落火山，`model` 字段显示映射后模型名；
  恢复主渠道后流量自动回切。
- **同步 ASR 不可 failover（格式互斥，实测确认）**：doubao-seed-2-1 系列
  虽支持 `input_audio` 音频转写，但火山要求 base64 **不带** data URI 前缀，
  DashScope qwen3-asr 要求**必须带** `data:audio/mp3;base64,`（同参数格式
  另一家直接报 `expected an object, but got null`）——同一份代码无法双兼容，
  故火山渠道映射中不含 qwen3-asr-flash；DashScope 不可用时同步 ASR 靠
  BullMQ 队列持久化兜底（恢复后自动重试，用户感知是延迟而非丢失）。
- `qwen-filetrans`（异步文件转写）为 DashScope 专有协议，无法网关化，
  同样靠队列兜底。

---

## 六、试点验证清单（2026-10-13 实测结果）

- [x] 主渠道正常出结果：qwen-flash / qwen3-vl-plus 经网关均返回成功；
- [x] **failover**：禁用主渠道 → 请求自动落火山（模型映射生效）；
      恢复主渠道 → 流量自动回切；
- [x] **额度耗尽自动切换**：DashScope 返回 403（FreeTierOnly，免费额度
      用尽）时网关自动重试落火山——前提 RetryTimes > 0（默认 0 不重试）；
- [x] **豆包思考链关闭**：param_override 生效，completion_tokens 52 → 1；
- [ ] **asr_options 透传实测（挂起）**：DashScope 账户 qwen3-asr-flash
      免费额度已耗尽（403 AllocationQuota.FreeTierOnly），需到百炼控制台
      为该模型开通按量付费后补测：指定语言（如粤语）+ ITN 数字转写是否
      仍准确。**开通前本地同步 ASR（qwen3-asr-flash）不可用**；
      生产异步转写（qwen-filetrans/paraformer）计费独立，暂不受影响。

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
