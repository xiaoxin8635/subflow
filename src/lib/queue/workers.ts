/**
 * @file BullMQ Worker 工厂：转写/导出/翻译队列消费端
 * @description 由独立 Worker 进程（src/worker/index.ts）或 dev 进程内模式
 *              （instrumentation.ts + ENABLE_INPROCESS_WORKER=1）调用。
 *              - 并发上限：TRANSCRIBE_CONCURRENCY（默认 3）/ EXPORT_CONCURRENCY（默认 1）
 *                / TRANSLATE_CONCURRENCY（默认 2）
 *              - 重试：指数退避（见 queues.ts 默认配置）；重试用尽在 failed 事件中
 *                标记 DB FAILED，相当于死信落库
 *              - 宕机恢复：worker 崩溃后未完成任务由 BullMQ 检测为 stalled 并自动
 *                重新入队（占用一次重试次数），Redis 持久化保证重启不丢任务
 */
import { Worker, type Job } from "bullmq";
import Redis from "ioredis";
import { TRANSCRIPT_QUEUE_NAME, EXPORT_QUEUE_NAME, TRANSLATE_QUEUE_NAME } from "@/lib/queue/queues";
import { logger } from "@/lib/logger";
import { sendAlert } from "@/lib/alert";
import { processProject, markProjectFailed } from "@/lib/pipeline";
import { processExport, markExportFailed } from "@/lib/export-pipeline";
import { processTranslation, markTranslationFailed } from "@/lib/translate-pipeline";

/**
 * 读取正整数环境变量（未配置或非法时回退默认值）
 * @param name 环境变量名
 * @param def  默认值
 */
function intEnv(name: string, def: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/**
 * 创建转写 + 导出两个 Worker
 * @returns close()：优雅退出（停止取新任务，等待在跑任务完成）
 */
export function createSubflowWorkers(): { close(): Promise<void> } {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  const transcriptConcurrency = intEnv("TRANSCRIBE_CONCURRENCY", 3);
  const exportConcurrency = intEnv("EXPORT_CONCURRENCY", 1);
  const translateConcurrency = intEnv("TRANSLATE_CONCURRENCY", 2);

  // BullMQ 要求 Worker 连接 maxRetriesPerRequest=null（阻塞取任务期间断连不抛错）
  const makeConnection = () => new Redis(url, { maxRetriesPerRequest: null });

  /** 判断本次失败是否已重试用尽（attemptsMade 在失败时递增，含本次） */
  function isExhausted(job: Job): boolean {
    return job.attemptsMade >= (job.opts.attempts ?? 1);
  }

  /** 转写 Worker：IO 密集，默认并发 3 */
  const transcriptWorker = new Worker(
    TRANSCRIPT_QUEUE_NAME,
    (job) => processProject(job.data.projectId as string),
    { connection: makeConnection(), concurrency: transcriptConcurrency },
  );
  transcriptWorker.on("failed", async (job, err) => {
    if (!job) return;
    if (!isExhausted(job)) {
      logger.warn("worker", "转写任务失败，将自动重试", {
        attempt: `${job.attemptsMade}/${job.opts.attempts}`,
        projectId: job.data.projectId,
        error: err.message,
      });
      return;
    }
    logger.error("worker", "转写任务最终失败（死信落库）", {
      projectId: job.data.projectId,
      error: err.message,
    });
    await markProjectFailed(job.data.projectId as string, err.message);
    await sendAlert("transcribe-failed", "转写任务最终失败（重试用尽）", [
      `项目：${job.data.projectId}`,
      `原因：${err.message}`,
    ]);
  });

  /** 导出 Worker：FFmpeg 吃 CPU，默认并发 1（可用 env 调大） */
  const exportWorker = new Worker(
    EXPORT_QUEUE_NAME,
    (job) => processExport(job.data.taskId as string),
    { connection: makeConnection(), concurrency: exportConcurrency },
  );
  exportWorker.on("failed", async (job, err) => {
    if (!job) return;
    if (!isExhausted(job)) {
      logger.warn("worker", "导出任务失败，将自动重试", {
        attempt: `${job.attemptsMade}/${job.opts.attempts}`,
        taskId: job.data.taskId,
        error: err.message,
      });
      return;
    }
    logger.error("worker", "导出任务最终失败（死信落库）", {
      taskId: job.data.taskId,
      error: err.message,
    });
    await markExportFailed(job.data.taskId as string, err.message);
    await sendAlert("export-failed", "导出任务最终失败（重试用尽）", [
      `任务：${job.data.taskId}`,
      `原因：${err.message}`,
    ]);
  });

  /** 翻译 Worker：LLM 调用 IO 密集，默认并发 2（可用 env 调大） */
  const translateWorker = new Worker(
    TRANSLATE_QUEUE_NAME,
    (job) => processTranslation(job.data.taskId as string),
    { connection: makeConnection(), concurrency: translateConcurrency },
  );
  translateWorker.on("failed", async (job, err) => {
    if (!job) return;
    if (!isExhausted(job)) {
      logger.warn("worker", "翻译任务失败，将自动重试", {
        attempt: `${job.attemptsMade}/${job.opts.attempts}`,
        taskId: job.data.taskId,
        error: err.message,
      });
      return;
    }
    logger.error("worker", "翻译任务最终失败（死信落库）", {
      taskId: job.data.taskId,
      error: err.message,
    });
    await markTranslationFailed(job.data.taskId as string, err.message);
    await sendAlert("translate-failed", "翻译任务最终失败（重试用尽）", [
      `任务：${job.data.taskId}`,
      `原因：${err.message}`,
    ]);
  });

  logger.info("worker", "已启动", {
    transcriptConcurrency,
    exportConcurrency,
    translateConcurrency,
    redis: url,
  });

  return {
    /** 优雅退出：停止取新任务，等待在跑任务完成（调用方可叠加超时） */
    async close() {
      await Promise.all([transcriptWorker.close(), exportWorker.close(), translateWorker.close()]);
    },
  };
}
