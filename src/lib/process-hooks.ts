/**
 * @file 进程级错误捕获安装（P1.6 可观测性）
 * @description 给 Node 进程挂 uncaughtException / unhandledRejection 全局捕获 →
 *              结构化日志 + 钉钉告警。由 Next.js instrumentation（app 进程）与
 *              独立 Worker 入口（src/worker/index.ts）共同调用；以 globalThis
 *              标记保证 dev 热重载/多入口下只挂一次。
 */

/** globalThis 上的已挂载标记键名 */
const GUARD_KEY = "__subflowProcessHooks";

/**
 * 安装进程级错误捕获（幂等；非 Node 运行时直接跳过）
 */
export async function installProcessErrorHooks(): Promise<void> {
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== "nodejs") return;
  const g = globalThis as unknown as { [GUARD_KEY]?: boolean };
  if (g[GUARD_KEY]) return;
  g[GUARD_KEY] = true;

  const { logger } = await import("@/lib/logger");
  const { sendAlert } = await import("@/lib/alert");

  // 顶层未捕获异常：记录 + 告警。不主动退出进程（Next 服务器自身有请求级
  // 容错；进程退出交给容器重启策略，避免单次异常造成整站不可用）
  process.on("uncaughtException", (err) => {
    logger.error("process", "未捕获异常（uncaughtException）", { error: err });
    void sendAlert("uncaught-exception", "进程发生未捕获异常", [String(err?.message ?? err)]);
  });
  // 未处理的 Promise 拒绝：记录 + 告警（多为某处漏 catch，需要排查）
  process.on("unhandledRejection", (reason) => {
    logger.error("process", "未处理的 Promise 拒绝（unhandledRejection）", { error: reason });
    void sendAlert("unhandled-rejection", "进程发生未处理的 Promise 拒绝", [
      reason instanceof Error ? reason.message : String(reason),
    ]);
  });
}
