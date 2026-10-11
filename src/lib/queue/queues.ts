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
/** 翻译队列名（LLM 批量翻译，IO 密集，P2.4） */
export const TRANSLATE_QUEUE_NAME = "translate";

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

/**
 * 翻译任务入队；失败返回 false（调用方降级为进程内直跑）
 * @param taskId Translation ID
 * @param userId 用户 ID（用于优先级计算）
 * @returns 是否成功入队
 */
export async function enqueueTranslation(taskId: string, userId: string): Promise<boolean> {
  try {
    const queue = getQueue(TRANSLATE_QUEUE_NAME);
    await queue.add(
      "translate",
      { taskId },
      {
        jobId: `translate-${taskId}`,
        priority: await priorityForUser(userId),
        attempts: 2, // 付费任务，LLM 调用有成本，失败重试 1 次即可（与导出对齐）
      },
    );
    return true;
  } catch (e) {
    console.warn("[queue] 翻译任务入队失败（将降级进程内执行）：", e instanceof Error ? e.message : e);
    return false;
  }
}

/**
 * 移除队列中的旧 job（管理后台重试前调用）
 * @description BullMQ 对同 jobId 的已存在 job（含 failed/completed set 中的）
 *              不会重新创建——重试必须先移除旧 job 再入队，重试次数随之重置。
 *              已终态失败的 job 处于 failed set，remove 安全；job 不存在时静默跳过。
 * @param queueName 队列名（TRANSCRIPT_QUEUE_NAME / EXPORT_QUEUE_NAME）
 * @param jobId     任务 ID（如 `transcribe-${projectId}`）
 */
export async function removeQueueJob(queueName: string, jobId: string): Promise<void> {
  try {
    const queue = getQueue(queueName);
    const job = await queue.getJob(jobId);
    if (job) await job.remove();
  } catch (e) {
    console.warn("[queue] 移除旧任务失败（忽略）：", e instanceof Error ? e.message : e);
  }
}

/**
 * 获取队列失败任务数（管理后台展示；Redis 不可用返回 null）
 * @param queueName 队列名
 */
export async function queueFailedCount(queueName: string): Promise<number | null> {
  try {
    return await getQueue(queueName).getFailedCount();
  } catch {
    return null;
  }
}

/**
 * 查询转写任务的排队位置（批量上传的队列可视化；Redis 不可用返回 null）
 * @description bullmq 6.x 中带 priority 的任务在 prioritized zset（job.getState()
 *              返回 "prioritized"，getWaiting() 不含它们），消费顺序 = zset score
 *              升序（付费优先 + 同级 FIFO）；wait list 的任务排在其后。
 *              因此直接读 Redis 原始结构计算位置（Queue.getJobs 的返回顺序
 *              并非消费顺序，实测不适用于位置计算）。
 * @param jobId 任务 ID（`transcribe-${projectId}`）
 * @returns position=等待队列第 N 位（1 起）；active=true 表示正在处理；
 *          两者皆空表示任务不在队列（已完成/失败/降级直跑）
 */
export async function transcribeQueuePosition(
  jobId: string,
): Promise<{ position: number | null; active: boolean } | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const prioritized = await redis.zrange(`bull:${TRANSCRIPT_QUEUE_NAME}:prioritized`, 0, "-1");
    const idx = prioritized.indexOf(jobId);
    if (idx >= 0) return { position: idx + 1, active: false };
    const waiting = await redis.lrange(`bull:${TRANSCRIPT_QUEUE_NAME}:wait`, 0, "-1");
    const wIdx = waiting.indexOf(jobId);
    if (wIdx >= 0) return { position: prioritized.length + wIdx + 1, active: false };
    const activeIds = await redis.smembers(`bull:${TRANSCRIPT_QUEUE_NAME}:active`);
    return { position: null, active: activeIds.includes(jobId) };
  } catch {
    return null;
  }
}
