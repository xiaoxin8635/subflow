/**
 * @file 导出流水线（FFmpeg 烧录字幕 + 额度扣减）
 * @description ExportTask 状态机：PENDING → PROCESSING → DONE / FAILED。
 *              流程：样式契约 + 字幕分段编译为 ASS 文件（写入 uploads/exports/），
 *              FFmpeg `ass` 滤镜烧录（libx264 重编码视频、音频直拷），成功后在
 *              单个事务内完成任务置 DONE + 扣减额度 + 写额度流水；任一步失败则
 *              置 FAILED 并记录原因，不扣额度。
 *              注意：`-vf ass=` 滤镜内的路径使用相对路径（cwd=项目根），
 *              规避 Windows 盘符冒号在滤镜参数中的转义问题。
 */
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { db } from "@/lib/db";
import { buildAss } from "@/lib/ass";
import type { StoredSegment } from "@/lib/asr/types";

/** 导出产物目录（与上传目录同级：uploads/exports/） */
const EXPORTS_SUBDIR = "exports";

/** 上传根目录（与 storage.ts 的 LOCAL_UPLOAD_DIR 语义一致） */
const UPLOAD_DIR = process.env.LOCAL_UPLOAD_DIR ?? "./uploads";

/** ffmpeg stderr 保留尾部长度（错误信息截取用） */
const STDERR_TAIL = 2000;

/**
 * 解析导出目录的磁盘绝对路径
 */
function exportsAbsDir(): string {
  return path.join(process.cwd(), UPLOAD_DIR, EXPORTS_SUBDIR);
}

/**
 * 确保导出目录存在
 */
async function ensureExportsDir(): Promise<void> {
  await fs.mkdir(exportsAbsDir(), { recursive: true });
}

/**
 * 启动导出任务（不阻塞调用方；兜底记录未捕获异常）
 * @param taskId ExportTask ID
 */
export function startExport(taskId: string): void {
  void processExport(taskId).catch((e) => {
    console.error(`[export] 导出任务 ${taskId} 异常：`, e);
  });
}

/**
 * 执行导出任务：生成 ASS → FFmpeg 烧录 → 事务（置 DONE + 扣额度 + 流水）
 * @param taskId ExportTask ID
 */
async function processExport(taskId: string): Promise<void> {
  const task = await db.exportTask.findUnique({
    where: { id: taskId },
    include: {
      project: { include: { transcript: true } },
      style: true,
    },
  });
  // 任务已被删除（如项目删除级联）或非初始态（防 dev 热重载重跑）：直接返回
  if (!task || task.status !== "PENDING" || !task.project.videoKey) return;

  const { project, style } = task;
  const assAbsPath = path.join(exportsAbsDir(), `${taskId}.ass`);
  const outAbsPath = path.join(exportsAbsDir(), `${taskId}.mp4`);

  try {
    // ① 前置校验：项目须 READY 且有转写结果与时长
    if (project.status !== "READY" || !project.transcript || project.durationSec == null) {
      throw new Error("项目未就绪（须转写完成且有时长）");
    }
    const segments = Array.isArray(project.transcript.segments)
      ? (project.transcript.segments as StoredSegment[])
      : [];
    if (segments.length === 0) throw new Error("项目没有字幕内容，无法导出");

    await db.exportTask.update({ where: { id: taskId }, data: { status: "PROCESSING" } });
    await ensureExportsDir();

    // ② 生成 ASS 文件（样式缺失时用「白字黑边、底部」兜底配置，保证仍可导出）
    const fallbackConfig: Parameters<typeof buildAss>[0] = {
      fontFamily: "Noto Sans SC",
      fontSize: 5.2,
      primaryColor: "#FFFFFF",
      outlineColor: "#000000",
      outlineWidth: 3,
      position: "bottom",
      marginV: 90,
      highlight: "",
    };
    const assContent = buildAss(
      (style?.config as unknown as Parameters<typeof buildAss>[0]) ?? fallbackConfig,
      segments,
    );
    await fs.writeFile(assAbsPath, assContent, "utf8");

    // ③ FFmpeg 烧录：滤镜内用相对路径（规避 Windows 盘符冒号转义）；音频直拷不重编码
    await new Promise<void>((resolve, reject) => {
      if (!ffmpegPath) {
        reject(new Error("ffmpeg 二进制不可用"));
        return;
      }
      // 滤镜参数中的 ASS 路径：相对 cwd（项目根），斜杠用 /（FFmpeg 跨平台通用）
      const assFilterPath = `${UPLOAD_DIR.replace(/\\/g, "/")}/${EXPORTS_SUBDIR}/${taskId}.ass`;
      const child = spawn(
        ffmpegPath,
        [
          "-y",
          "-i", path.join(/* turbopackIgnore: true */ process.cwd(), UPLOAD_DIR, project.videoKey!),
          "-vf", `ass=${assFilterPath}`,
          "-c:v", "libx264",
          "-preset", "veryfast",
          "-crf", "23",
          "-c:a", "copy",
          "-movflags", "+faststart",
          outAbsPath,
        ],
        { cwd: process.cwd(), windowsHide: true },
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > STDERR_TAIL * 3) stderr = stderr.slice(-STDERR_TAIL * 3);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg 退出码 ${code}：${stderr.slice(-STDERR_TAIL)}`));
      });
    });

    // ④ 事务：任务 DONE + 扣额度（带余额守卫防负数）+ 额度流水
    const costSeconds = Math.ceil(project.durationSec);
    await db.$transaction(async (tx) => {
      // 条件更新：余额足够才扣，防止并发导出把余额扣成负数
      const deducted = await tx.user.updateMany({
        where: { id: project.userId, balanceSeconds: { gte: costSeconds } },
        data: { balanceSeconds: { decrement: costSeconds } },
      });
      if (deducted.count !== 1) {
        // 创建接口已做余额预检，走到这里说明预检后余额被并发消耗；产物作废不交付
        throw new Error(`额度不足（导出需 ${costSeconds} 秒，余额在任务执行期间被其他消耗占用）`);
      }
      const user = await tx.user.findUnique({ where: { id: project.userId } });
      await tx.creditLedger.create({
        data: {
          userId: project.userId,
          changeSeconds: -costSeconds,
          balanceAfter: user!.balanceSeconds,
          reason: "CONSUME_EXPORT",
          refId: taskId,
        },
      });
      await tx.exportTask.update({
        where: { id: taskId },
        data: { status: "DONE", outputKey: `${EXPORTS_SUBDIR}/${taskId}.mp4`, finishedAt: new Date(), error: null },
      });
    });
    console.log(`[export] 任务 ${taskId} 完成：${project.title}，扣费 ${costSeconds} 秒`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "导出失败";
    console.error(`[export] 任务 ${taskId} 失败：${message}`);
    await db.exportTask
      .update({ where: { id: taskId }, data: { status: "FAILED", error: message, finishedAt: new Date() } })
      .catch(() => {});
    // 失败时清理半成品输出（可能是不完整文件）
    await fs.unlink(outAbsPath).catch(() => {});
  } finally {
    // ASS 文件是中间产物，无论成败都清理
    await fs.unlink(assAbsPath).catch(() => {});
  }
}

/**
 * 由导出任务 outputKey 解析产物磁盘绝对路径（下载 API 使用）
 * @param outputKey 导出产物 key（exports/{taskId}.mp4）
 */
export function exportAbsPath(outputKey: string): string {
  return path.join(/* turbopackIgnore: true */ process.cwd(), UPLOAD_DIR, outputKey);
}
