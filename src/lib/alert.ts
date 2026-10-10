/**
 * @file 告警通知（P1.6 可观测性）：钉钉群自定义机器人 webhook
 * @description 触发场景：转写/导出任务重试用尽最终失败、额度守卫拦截、进程级
 *              未捕获异常。未配置 ALERT_DINGTALK_WEBHOOK 时降级为仅落结构化
 *              日志（本地开发/尚未建群不影响运行）。安全设置用「加签」：
 *              sign = base64(HMAC-SHA256(secret, `${timestamp}\n${secret}`))，
 *              拼接 timestamp 与 sign 到 URL 查询串。同类告警按 key 限频冷却，
 *              防止批量任务失败时刷屏。
 */
import crypto from "node:crypto";
import { logger } from "@/lib/logger";

/** 钉钉机器人 webhook（含 access_token），空串表示未配置 */
const WEBHOOK = (process.env.ALERT_DINGTALK_WEBHOOK ?? "").trim();

/** 加签密钥（机器人安全设置选「加签」时生成的 SEC 开头字符串） */
const SECRET = (process.env.ALERT_DINGTALK_SECRET ?? "").trim();

/** 同类告警冷却秒数（默认 5 分钟） */
const COOLDOWN_SECONDS = Number.parseInt(process.env.ALERT_COOLDOWN_SECONDS ?? "300", 10) || 300;

/** webhook 请求超时毫秒 */
const REQUEST_TIMEOUT_MS = 5000;

/** 进程内冷却记录：key → 上次发送时间戳（dev 热重载/多实例各自独立，可接受） */
const lastSentAtByKey = new Map<string, number>();

/**
 * 生成钉钉加签 URL（安全设置选「加签」时的签名算法）
 * @returns 拼接了 timestamp 与 sign 参数的 webhook URL
 */
function signedWebhookUrl(): string {
  const timestamp = Date.now();
  const stringToSign = `${timestamp}\n${SECRET}`;
  const sign = crypto.createHmac("sha256", SECRET).update(stringToSign).digest("base64");
  const sep = WEBHOOK.includes("?") ? "&" : "?";
  return `${WEBHOOK}${sep}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
}

/**
 * 发送一条告警（钉钉 text 消息；未配置 webhook 时仅落日志）
 * @param key   告警类别（用于冷却限频，如 "transcribe-failed"、"quota-guard"）
 * @param title 首行摘要
 * @param lines 详细行（每行一条）
 * @returns 是否真正发出（false = 未配置 / 冷却中 / 发送失败）
 */
export async function sendAlert(key: string, title: string, lines: string[]): Promise<boolean> {
  const text = [title, ...lines].join("\n");

  if (!WEBHOOK) {
    logger.warn("alert", "未配置告警通道，仅记录日志", { key, text });
    return false;
  }

  // 冷却限频：同 key 在冷却期内不重复发送
  const now = Date.now();
  const last = lastSentAtByKey.get(key) ?? 0;
  if (now - last < COOLDOWN_SECONDS * 1000) {
    logger.info("alert", "告警冷却中，跳过发送", { key, cooldownSeconds: COOLDOWN_SECONDS });
    return false;
  }

  const body = { msgtype: "text", text: { content: `【SubFlow 告警】${text}` } };
  try {
    const res = await fetch(signedWebhookUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    lastSentAtByKey.set(key, now);
    logger.info("alert", "告警已发送", { key });
    return true;
  } catch (e) {
    logger.error("alert", "告警发送失败", { key, error: e });
    return false;
  }
}
