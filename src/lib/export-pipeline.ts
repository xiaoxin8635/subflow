/**
 * @file 导出流水线（FFmpeg 烧录字幕 + 额度扣减；Redis 队列驱动，Worker 消费）
 * @description ExportTask 状态机：PENDING → PROCESSING → DONE / FAILED。
 *              流程：样式契约 + 字幕分段编译为 ASS 文件（写入 uploads/exports/），
 *              FFmpeg `ass` 滤镜烧录（libx264 重编码视频、音频直拷）。存储驱动：
 *              local 成片留在 uploads/exports/；oss 先经 ensureLocalVideo 拉取源视频、
 *              烧录完成后将成片上传 OSS 并清理本地临时文件。
 *              成功后在单个事务内完成任务置 DONE + 扣减额度 + 写额度流水。
 *              入口 startExport 仅负责入队（BullMQ 导出队列）；Redis 不可用时降级
 *              进程内直跑。processExport 只执行不兜错——错误上抛给 Worker 触发
 *              自动重试，重试用尽后由 failed 事件调用 markExportFailed 落库。
 *              允许 PROCESSING 状态重跑：Worker 崩溃后 stalled 任务恢复时
 *              （状态停在 PROCESSING）重新执行整段烧录。
 *              注意：`-vf ass=` 滤镜内的路径使用相对路径（cwd=项目根），
 *              规避 Windows 盘符冒号在滤镜参数中的转义问题。
 */
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { sendAlert } from "@/lib/alert";
import { notify } from "@/lib/notify";
import { buildAss, DEFAULT_ASS_CONFIG } from "@/lib/ass";
import { enqueueExport } from "@/lib/queue/queues";
import { ensureLocalVideo, isOss, removeLocalVideoCache } from "@/lib/storage";
import { ossUploadFile } from "@/lib/oss";
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
 * 启动导出任务：优先入队（Worker 消费），Redis 不可用时降级进程内直跑
 * @param taskId ExportTask ID
 * @param userId 用户 ID（用于付费优先级计算）
 */
export async function startExport(taskId: string, userId: string): Promise<void> {
  const queued = await enqueueExport(taskId, userId);
  if (queued) return;
  // 降级：进程内执行并在失败时直接落 FAILED（无重试语义，与队列行为对齐）
  void processExport(taskId).catch(async (e) => {
    await markExportFailed(taskId, e instanceof Error ? e.message : "导出失败");
  });
}

/**
 * 将导出任务标记为失败（重试用尽后的死信落库；任务行可能已被级联删除需容错）
 * @param taskId  ExportTask ID
 * @param message 失败原因
 */
export async function markExportFailed(taskId: string, message: string): Promise<void> {
  // include project 顺带取 userId/title 用于站内通知（任务行已级联删除则跳过通知）
  const row = await db.exportTask
    .update({
      where: { id: taskId },
      data: { status: "FAILED", error: message, finishedAt: new Date() },
      include: { project: { select: { id: true, userId: true, title: true } } },
    })
    .catch(() => null);
  if (row) {
    await notify(row.project.userId, "EXPORT_FAILED", "导出失败", `「${row.project.title}」导出失败：${message}`, `/project/${row.project.id}`);
  }
}

/**
 * 执行导出任务：生成 ASS → FFmpeg 烧录 → 事务（置 DONE + 扣额度 + 流水）
 * 失败时清理半成品后向上抛错（由 Worker 决定重试或最终标记 FAILED）。
 * @param taskId ExportTask ID
 */
export async function processExport(taskId: string): Promise<void> {
  const task = await db.exportTask.findUnique({
    where: { id: taskId },
    include: {
      project: { include: { transcript: true } },
      style: true,
    },
  });
  // 任务已删除/已完成/失败终态（防重复执行）；PROCESSING 允许：stalled 恢复重跑
  if (!task || (task.status !== "PENDING" && task.status !== "PROCESSING") || !task.project.videoKey) return;

  const { project, style } = task;
  const assAbsPath = path.join(exportsAbsDir(), `${taskId}.ass`);
  const outAbsPath = path.join(exportsAbsDir(), `${taskId}.mp4`);

  try {
    // ① 前置校验：项目须 READY 且有转写结果与时长；纯音频项目不可烧录
    if (project.status !== "READY" || !project.transcript || project.durationSec == null) {
      throw new Error("项目未就绪（须转写完成且有时长）");
    }
    if (project.mediaKind === "audio") {
      throw new Error("音频项目不支持烧录成片（仅字幕文件下载）");
    }
    const segments = Array.isArray(project.transcript.segments)
      ? (project.transcript.segments as StoredSegment[])
      : [];
    if (segments.length === 0) throw new Error("项目没有字幕内容，无法导出");

    await db.exportTask.update({ where: { id: taskId }, data: { status: "PROCESSING" } });
    await ensureExportsDir();

    // ①' 源视频本地路径（oss 模式先拉取到本地缓存，失败即抛错交由重试）
    const inputAbsPath = await ensureLocalVideo(project.videoKey!);

    // ② 生成 ASS 文件（样式缺失时用共享默认配置兜底，保证仍可导出）
    const assContent = buildAss(
      (style?.config as unknown as Parameters<typeof buildAss>[0]) ?? DEFAULT_ASS_CONFIG,
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
          "-i", inputAbsPath,
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

    // ③' oss 模式：成片上传 OSS（必须在扣费事务前——上传失败则整体重试，不产生扣费）
    if (isOss()) {
      await ossUploadFile(`${EXPORTS_SUBDIR}/${taskId}.mp4`, outAbsPath, "video/mp4");
    }

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
        const message = `额度不足（导出需 ${costSeconds} 秒，余额在任务执行期间被其他消耗占用）`;
        logger.warn("export", "额度守卫拦截（疑似并发消耗竞态）", { taskId, userId: project.userId, costSeconds });
        void sendAlert("quota-guard", "额度守卫拦截：预检后余额被并发消耗", [
          `任务：${taskId}`,
          `需扣：${costSeconds} 秒`,
        ]);
        throw new Error(message);
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
    logger.info("export", "导出任务完成", { taskId, title: project.title, costSeconds });
    // 站内通知：导出完成（铃铛提醒，旁路失败不影响主流程）
    await notify(project.userId, "EXPORT_DONE", "导出完成", `「${project.title}」已导出（消耗 ${costSeconds} 秒额度）`, `/project/${project.id}`);
    // ⑤ oss 模式：事务成功后清理本地成片与源视频缓存副本（源视频保留在 OSS 供预览/再导出）
    if (isOss()) {
      await fs.unlink(outAbsPath).catch(() => {});
      await removeLocalVideoCache(project.videoKey!).catch(() => {});
    }
  } catch (err) {
    // 失败时清理半成品输出（可能是不完整文件），错误上抛交由调用方重试/落 FAILED
    await fs.unlink(outAbsPath).catch(() => {});
    throw err instanceof Error ? err : new Error("导出失败");
  } finally {
    // ASS 文件是中间产物，无论成败都清理
    await fs.unlink(assAbsPath).catch(() => {});
  }
}
