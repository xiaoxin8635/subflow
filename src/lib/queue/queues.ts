/**
 * @file BullMQ 队列定义与入队封装（转写队列 + 导出队列）
 * @description API 进程只负责入队，真正消费在 Worker（src/worker 或 dev 进程内模式）。
 *   - 优先级：有有效订阅的用户 priority=1（优先消费），免费用户 priority=10
 *   - 重试：指数退避，最终失败由 Worker 标记 DB FAILED
 *   - 入队失败（Redis 不可用）返回 false，调用方降级为进程内直跑
 */
import { Queue } from "bullmq";
import { db } from "@/lib/db";
import { getRedis } from "@/lib/queue/connection";

/** 转写队列名（抽音频 + ASR + LLM 润色，IO 密集） */
export const TRANSCRIPT_QUEUE_NAME = "transcript";
/** 导出队列名（FFmpeg 烧录，CPU 密集） */
export const EXPORT_QUEUE_NAME = "export";

/** 免费用户优先级（数字越小越先消费） */
const PRIORITY_FREE = 10;
/** 付费用户优先级 */
const PRIORITY_PAID = 1;

/** 完成任务在 Redis 的保留策略：1 小时或超出 1000 条时清理 */
const REMOVE_ON_COMPLETE = { age: 60 * 60, count: 1000 };
/** 失败任务保留 24 小时（排障后可人工重放） */
const REMOVE_ON_FAIL = { age: 24 * 60 * 60 };

/** 进程内队列实例缓存（dev 热重载复用，避免重复建连） */
const globalForQueues = globalThis as unknown as {
  __subflowQueues?: Map<string, Queue>;
};

/**
 * 获取（或创建）指定名称的队列实例
 * @param name 队列名
 */
function getQueue(name: string): Queue {
  if (!globalForQueues.__subflowQueues) {
    globalForQueues.__subflowQueues = new Map<string, Queue>();
  }
  const cached = globalForQueues.__subflowQueues.get(name);
  if (cached) return cached;

  const redis = getRedis();
  if (!redis) throw new Error("Redis 不可用");
  const queue = new Queue(name, {
    connection: redis,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: REMOVE_ON_COMPLETE,
      removeOnFail: REMOVE_ON_FAIL,
    },
  });
  globalForQueues.__subflowQueues.set(name, queue);
  return queue;
}

/**
 * 计算用户任务优先级：有有效订阅（未过期）则付费优先
 * @param userId 用户 ID
 */
async function priorityForUser(userId: string): Promise<number> {
  try {
    const sub = await db.subscription.findFirst({
      where: { userId, status: "ACTIVE", expireAt: { gt: new Date() } },
      select: { id: true },
    });
    return sub ? PRIORITY_PAID : PRIORITY_FREE;
  } catch {
    return PRIORITY_FREE;
  }
}

/**
 * 转写任务入队；失败返回 false（调用方降级为进程内直跑）
 * @param projectId 项目 ID
 * @param userId   用户 ID（用于优先级计算）
 * @returns 是否成功入队
 */
export async function enqueueTranscribe(projectId: string, userId: string): Promise<boolean> {
  try {
    const queue = getQueue(TRANSCRIPT_QUEUE_NAME);
    await queue.add(
      "transcribe",
      { projectId },
      {
        // 同项目幂等：等待中同名 job 不会重复入队。
        // 注意 BullMQ jobId 不允许含 ":"（Redis key 分隔符），用连字符拼接
        jobId: `transcribe-${projectId}`,
        priority: await priorityForUser(userId),
      },
    );
    return true;
  } catch (e) {
    console.warn("[queue] 转写任务入队失败（将降级进程内执行）：", e instanceof Error ? e.message : e);
    return false;
  }
}

/**
 * 导出任务入队；失败返回 false（调用方降级为进程内直跑）
 * @param taskId  ExportTask ID
 * @param userId  用户 ID（用于优先级计算）
 * @returns 是否成功入队
 */
export async function enqueueExport(taskId: string, userId: string): Promise<boolean> {
  try {
    const queue = getQueue(EXPORT_QUEUE_NAME);
    await queue.add(
      "export",
      { taskId },
      {
        jobId: `export-${taskId}`,
        priority: await priorityForUser(userId),
        attempts: 2, // 导出重编码耗 CPU，失败重试 1 次即可
      },
    );
    return true;
  } catch (e) {
    console.warn("[queue] 导出任务入队失败（将降级进程内执行）：", e instanceof Error ? e.message : e);
    return false;
  }
}
