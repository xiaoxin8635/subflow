/**
 * @file 独立 Worker 进程入口：npm run worker（生产 compose 的 worker 服务同用此入口）
 * @description 与 Next.js 应用进程分离部署/伸缩：加载项目 .env（不覆盖已有环境变量，
 *              容器内由 compose 注入的环境优先），消费转写与导出队列，
 *              SIGTERM/SIGINT 优雅退出（最多等 30 秒在跑任务收尾）。
 *              注意：必须在加载业务模块前完成 .env 注入，故使用动态 import。
 */
import fs from "node:fs";
import path from "node:path";

/**
 * 极简 .env 加载器：仅填充 process.env 中不存在的键
 * （支持 KEY="value" / KEY=value / 行内注释；容器环境变量优先）
 */
function loadDotEnv(): void {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"?([^"\r\n#]*)"?\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

/** 启动 Worker 并注册优雅退出信号处理 */
async function main(): Promise<void> {
  loadDotEnv();
  const { createSubflowWorkers } = await import("../lib/queue/workers");
  const handle = createSubflowWorkers();

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    console.log(`[worker] 收到 ${signal}，优雅退出（等待在跑任务完成，最多 30 秒）…`);
    const timeout = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 30_000);
      if (typeof t.unref === "function") t.unref();
    });
    void Promise.race([handle.close(), timeout]).then(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((e) => {
  console.error("[worker] 启动失败：", e);
  process.exit(1);
});
