/**
 * @file Next.js instrumentation：dev 进程内 Worker 模式
 * @description 设 ENABLE_INPROCESS_WORKER=1 时，应用进程内直接启动队列消费端
 *              （本地开发免开第二个终端）。生产 compose 用独立 worker 容器，
 *              不配置此变量即可（FFmpeg CPU 与 Web 进程隔离）。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.ENABLE_INPROCESS_WORKER !== "1") return;

  // 全局守卫：dev 热重载/多入口下只启动一次
  const g = globalThis as unknown as { __subflowInprocessWorker?: boolean };
  if (g.__subflowInprocessWorker) return;
  g.__subflowInprocessWorker = true;

  const { createSubflowWorkers } = await import("@/lib/queue/workers");
  createSubflowWorkers();
  console.log("[instrumentation] 进程内 Worker 已启动（ENABLE_INPROCESS_WORKER=1）");
}
