/**
 * @file Redis 连接单例（应用侧：限流器 + 任务入队）
 * @description API 进程与限流/入队共用一条懒连接。关键配置：
 *   - enableOfflineQueue=false：Redis 断连时命令立即报错而不是无限排队，
 *     让限流器/入队方能在同一请求内快速降级（内存限流 / 进程内直跑任务）
 *   - maxRetriesPerRequest=1：单条命令最多重试一次即抛错
 *   Worker 进程的连接由 workers.ts 单独创建（BullMQ 要求
 *   maxRetriesPerRequest=null 以支持阻塞取任务），不复用本单例。
 */
import Redis from "ioredis";

/** Redis 连接串（默认本地开发容器 subflow-redis） */
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/** 全局单例（dev 热重载下复用，避免连接泄漏） */
const globalForRedis = globalThis as unknown as { __subflowRedis?: Redis | null };

/**
 * 获取应用侧 Redis 客户端；连接失败/未就绪时返回 null（调用方降级）
 * @returns ioredis 实例或 null（不可用时）
 */
export function getRedis(): Redis | null {
  if (globalForRedis.__subflowRedis !== undefined) {
    return globalForRedis.__subflowRedis;
  }
  try {
    const client = new Redis(REDIS_URL, {
      lazyConnect: true, // 首条命令时才真正建连
      enableOfflineQueue: false, // 断连时命令快速失败（触发调用方降级）
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => Math.min(times * 500, 5000),
      maxLoadingRetryTime: 3000,
    });
    // 常驻进程下静默连接错误（错误由调用方在命令层感知）
    client.on("error", () => {});
    globalForRedis.__subflowRedis = client;
    return client;
  } catch {
    globalForRedis.__subflowRedis = null;
    return null;
  }
}

/**
 * 判断 Redis 是否当前可用（status 为 ready/connect 时可尝试命令）
 */
export function redisHealthy(): boolean {
  const client = getRedis();
  if (!client) return false;
  return client.status === "ready" || client.status === "connect";
}
