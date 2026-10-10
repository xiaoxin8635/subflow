/**
 * @file 分布式限流器（Redis 滑动窗口 + 内存降级）
 * @description 生产用 Redis ZSET 滑动窗口（Lua 原子执行），多实例部署下全局限流；
 *              Redis 不可用时自动降级为进程内内存版（限流是防刷手段而非安全边界，
 *              可用性优先），并在日志中提示。接口自 P0 以来保持稳定：
 *              checkRateLimit/rateLimit 均为 async（Redis 往返），调用方 await。
 */

import { getRedis, redisHealthy } from "@/lib/queue/connection";

/**
 * Lua 脚本：原子滑动窗口检查
 * KEYS[1]=限流键  ARGV: [nowMs, windowMs, limit, 唯一成员]
 * 返回 {放行(1/0), 被拒时建议等待秒数}
 */
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry = 1
  if oldest[2] then
    retry = math.max(1, math.ceil((tonumber(oldest[2]) + window - now) / 1000))
  end
  return {0, retry}
end
redis.call('ZADD', key, now, ARGV[4])
redis.call('PEXPIRE', key, window)
return {1, 0}
`;

/** 内存降级存储：key → 窗口内的请求时间戳列表 */
const memBuckets = new Map<string, number[]>();

/** 内存版上次惰性清理时间 */
let memLastSweep = Date.now();

/** 内存版全量清扫间隔（毫秒） */
const MEM_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/** 降级提示去重（避免每次请求刷屏） */
let degradedWarned = false;

/**
 * 内存版滑动窗口检查（降级路径，逻辑与 P0 内存版一致）
 * @param key      限流维度键
 * @param limit    窗口内允许的最大次数
 * @param windowMs 窗口长度（毫秒）
 */
function memCheck(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  if (now - memLastSweep > MEM_SWEEP_INTERVAL_MS) {
    memLastSweep = now;
    for (const [k, stamps] of memBuckets) {
      const alive = stamps.filter((t) => now - t < windowMs);
      if (alive.length === 0) memBuckets.delete(k);
      else memBuckets.set(k, alive);
    }
  }
  const stamps = (memBuckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (stamps.length >= limit) {
    const retryAfterSec = Math.max(1, Math.ceil((stamps[0] + windowMs - now) / 1000));
    memBuckets.set(key, stamps);
    return { ok: false, retryAfterSec };
  }
  stamps.push(now);
  memBuckets.set(key, stamps);
  return { ok: true, retryAfterSec: 0 };
}

/**
 * 检查并记录一次请求（滑动窗口计数；Redis 优先，失败降级内存）
 * @param key      限流维度键，如 "login:ip:1.2.3.4"
 * @param limit    窗口内允许的最大次数
 * @param windowMs 窗口长度（毫秒）
 * @returns ok 是否放行；retryAfterSec 被拒时建议的等待秒数
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<{ ok: boolean; retryAfterSec: number }> {
  const redis = getRedis();
  if (redis && redisHealthy()) {
    try {
      const now = Date.now();
      // ZSET 成员须唯一（同毫秒并发请求）：时间戳 + 随机后缀
      const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;
      const result = (await redis.eval(
        SLIDING_WINDOW_LUA,
        1,
        `rl:${key}`,
        String(now),
        String(windowMs),
        String(limit),
        member,
      )) as [number, number];
      return { ok: result[0] === 1, retryAfterSec: Number(result[1]) };
    } catch (e) {
      if (!degradedWarned) {
        degradedWarned = true;
        console.warn("[rate-limit] Redis 不可用，限流降级为进程内内存版：", e instanceof Error ? e.message : e);
      }
    }
  }
  return memCheck(key, limit, windowMs);
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
export async function rateLimit(
  req: Request,
  scope: string,
  identity: string,
  limit: number,
  windowMs: number,
): Promise<{ ok: boolean; retryAfterSec: number }> {
  return checkRateLimit(`${scope}:${identity}`, limit, windowMs);
}
