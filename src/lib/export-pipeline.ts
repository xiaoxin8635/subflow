/**
 * @file 导出流水线（FFmpeg 烧录字幕 + 额度扣减；Redis 队列驱动，Worker 消费）
 * @description ExportTask 状态机：PENDING → PROCESSING → DONE / FAILED。
 *              流程：样式契约 + 字幕分段编译为 ASS 文件（写入 uploads/exports/），
 *              FFmpeg `ass` 滤镜烧录（libx264 重编码视频、音频直拷）。存储驱动：
 *              local 成片留在 uploads/exports/；oss 先经 ensureLocalVideo 拉取源视频、
 *              烧录完成后将成片上传 OSS 并清理本地临时文件。
 *              片段导出（P2.6）：startSec/endSec 非空时按区间裁剪——视频项目
 *              `-ss/-t` 裁剪 + 烧录（字幕时间轴 clamp 到片段并平移至 0 起），
 *              音频项目纯裁剪统一输出 mp3（sliceAudio）。
 *              成功后在单个事务内完成任务置 DONE + 扣减额度 + 写额度流水
 *              （整片 CONSUME_EXPORT / 片段 CONSUME_CLIP）。
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
import fsSync from "node:fs";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { sendAlert } from "@/lib/alert";
import { notify } from "@/lib/notify";
import { buildAss, DEFAULT_ASS_CONFIG } from "@/lib/ass";
import { parseStyleConfig } from "@/lib/style-config";
import { clipCostSeconds } from "@/lib/constants";
import { sliceAudio } from "@/lib/media";
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
 * 片段区间的展示/文件名标签（整数不带小数点，如 "5-15s"；小数保留 1 位，如 "5.5-15s"）
 * @param startSec 片段开始（秒）
 * @param endSec   片段结束（秒）
 */
export function clipFileLabel(startSec: number, endSec: number): string {
  const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  return `${fmt(startSec)}-${fmt(endSec)}s`;
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
  // P2.6 片段导出：startSec/endSec 非空即片段模式（音频纯裁剪 / 视频裁剪+烧录）
  const isClip = task.startSec != null && task.endSec != null;
  const clipStart = isClip ? task.startSec! : 0;
  const clipDur = isClip ? task.endSec! - task.startSec! : 0;
  // 音频项目片段产物统一 mp3（重编码兼容性最好）；视频与整片导出均为 mp4
  const isAudioClip = isClip && project.mediaKind === "audio";
  const outExt = isAudioClip ? "mp3" : "mp4";
  const assAbsPath = path.join(exportsAbsDir(), `${taskId}.ass`);
  const outAbsPath = path.join(exportsAbsDir(), `${taskId}.${outExt}`);

  try {
    // ① 前置校验：项目须 READY 且有转写结果与时长；纯音频项目仅支持片段裁剪
    if (project.status !== "READY" || !project.transcript || project.durationSec == null) {
      throw new Error("项目未就绪（须转写完成且有时长）");
    }
    if (project.mediaKind === "audio" && !isClip) {
      throw new Error("音频项目不支持整片烧录成片（仅字幕文件下载或片段裁剪）");
    }
    const segments = Array.isArray(project.transcript.segments)
      ? (project.transcript.segments as StoredSegment[])
      : [];
    // 音频片段裁剪不需要字幕；视频（整片/片段）项目须有字幕内容
    if (!isAudioClip && segments.length === 0) throw new Error("项目没有字幕内容，无法导出");

    await db.exportTask.update({ where: { id: taskId }, data: { status: "PROCESSING" } });
    await ensureExportsDir();

    // ①' 源媒体本地路径（oss 模式先拉取到本地缓存，失败即抛错交由重试）
    const inputAbsPath = await ensureLocalVideo(project.videoKey!);

    // ② 视频烧录分支：片段时字幕时间轴 clamp 到片段区间并平移至 0 起
    //    （区间内无字幕行则不挂 ass 滤镜，退化为纯裁剪）
    if (!isAudioClip) {
      const burnSegments: StoredSegment[] = isClip
        ? segments
            .map((s) => ({
              ...s,
              start: Math.max(0, s.start - clipStart),
              end: Math.min(clipDur, s.end - clipStart),
            }))
            .filter((s) => s.end - s.start > 0.01)
        : segments;
      const styleForBurn =
        parseStyleConfig(task.styleConfig) ??
        parseStyleConfig(style?.config) ??
        DEFAULT_ASS_CONFIG;
      if (burnSegments.length > 0) {
        await fs.writeFile(assAbsPath, buildAss(styleForBurn, burnSegments), "utf8");
      }
    }

    // ③ FFmpeg：音频片段走 sliceAudio 纯裁剪；视频走烧录命令（片段时 -ss 前置 + -t 限长）
    if (isAudioClip) {
      await sliceAudio(inputAbsPath, clipStart, clipDur, outAbsPath);
    } else {
      const assFilterPath = `${UPLOAD_DIR.replace(/\\/g, "/")}/${EXPORTS_SUBDIR}/${taskId}.ass`;
      await new Promise<void>((resolve, reject) => {
        if (!ffmpegPath) {
          reject(new Error("ffmpeg 二进制不可用"));
          return;
        }
        const child = spawn(
          ffmpegPath,
          [
            "-y",
            ...(isClip ? ["-ss", clipStart.toFixed(3)] : []),
            "-i", inputAbsPath,
            ...(isClip ? ["-t", clipDur.toFixed(3)] : []),
            ...(fsSyncExists(assAbsPath) ? ["-vf", `ass=${assFilterPath}`] : []),
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
    }

    // ③' oss 模式：成片上传 OSS（必须在扣费事务前——上传失败则整体重试，不产生扣费）
    if (isOss()) {
      await ossUploadFile(`${EXPORTS_SUBDIR}/${taskId}.${outExt}`, outAbsPath, isAudioClip ? "audio/mpeg" : "video/mp4");
    }

    // ④ 事务：任务 DONE + 扣额度（带余额守卫防负数）+ 额度流水
    const costSeconds = isClip ? clipCostSeconds(clipStart, clipStart + clipDur) : Math.ceil(project.durationSec);
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
          reason: isClip ? "CONSUME_CLIP" : "CONSUME_EXPORT",
          refId: taskId,
        },
      });
      await tx.exportTask.update({
        where: { id: taskId },
        data: { status: "DONE", outputKey: `${EXPORTS_SUBDIR}/${taskId}.${outExt}`, finishedAt: new Date(), error: null },
      });
    });
    logger.info("export", "导出任务完成", { taskId, title: project.title, costSeconds, isClip });
    // 站内通知：导出完成（铃铛提醒，旁路失败不影响主流程）
    const rangeLabel = isClip ? `片段 ${clipFileLabel(clipStart, clipStart + clipDur)}` : "成片";
    await notify(project.userId, "EXPORT_DONE", "导出完成", `「${project.title}」${rangeLabel}已导出（消耗 ${costSeconds} 秒额度）`, `/project/${project.id}`);
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

/**
 * 同步检查文件是否存在（决定 FFmpeg 命令是否挂 ass 滤镜；片段区间可能无字幕行）
 * @param filePath 文件绝对路径
 */
function fsSyncExists(filePath: string): boolean {
  try {
    return fsSync.existsSync(filePath);
  } catch {
    return false;
  }
}
