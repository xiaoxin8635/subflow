/**
 * @file 进程内限流器（滑动窗口）
 * @description 单机内存实现的滑动窗口限流，MVP 单容器部署下有效；P1 切 Redis 时
 *              保持本文件接口不变、仅替换存储实现即可（调用方无感知）。
 *              注意：多实例部署时各实例独立计数，届时必须迁移 Redis。
 */

/** 滑动窗口存储：key → 窗口内的请求时间戳列表 */
const buckets = new Map<string, number[]>();

/** 上次惰性清理时间； buckets 过大时全量清扫防内存泄漏 */
let lastSweep = Date.now();

/** 全量清扫间隔（毫秒）：清理已空桶防长期运行内存增长 */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 检查并记录一次请求（滑动窗口计数）
 * @param key      限流维度键，如 "ip:1.2.3.4:login"、"phone:138...:sms"
 * @param limit    窗口内允许的最大次数
 * @param windowMs 窗口长度（毫秒）
 * @returns ok 是否放行；retryAfterSec 被拒时建议的等待秒数
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();

  // 惰性全量清扫：防止无请求的 key 永久占内存
  if (now - lastSweep > SWEEP_INTERVAL_MS) {
    lastSweep = now;
    for (const [k, stamps] of buckets) {
      const alive = stamps.filter((t) => now - t < windowMs);
      if (alive.length === 0) buckets.delete(k);
      else buckets.set(k, alive);
    }
  }

  const stamps = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (stamps.length >= limit) {
    // 最早一条记录滑出窗口所需的时间
    const retryAfterSec = Math.max(1, Math.ceil((stamps[0] + windowMs - now) / 1000));
    buckets.set(key, stamps);
    return { ok: false, retryAfterSec };
  }
  stamps.push(now);
  buckets.set(key, stamps);
  return { ok: true, retryAfterSec: 0 };
}

/**
 * 从请求头解析客户端真实 IP（Caddy/Nginx 反代场景取 X-Forwarded-For 首段）
 * @param req 原始请求
 */
export function getClientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

/**
 * 限流检查的便捷封装：被拒时可直接用返回值构造 429 响应头
 * @param req      原始请求（用于取 IP）
 * @param scope    业务域（如 "login"、"sms"）
 * @param identity 身份标识（IP / 手机号 / 用户 ID）
 * @param limit    窗口内允许次数
 * @param windowMs 窗口毫秒
 */
export function rateLimit(
  req: Request,
  scope: string,
  identity: string,
  limit: number,
  windowMs: number,
): { ok: boolean; retryAfterSec: number } {
  return checkRateLimit(`${scope}:${identity}`, limit, windowMs);
}
