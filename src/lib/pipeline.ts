/**
 * @file 项目处理流水线（Redis 队列驱动，Worker 消费）
 * @description 状态机：UPLOADED → TRANSCRIBING（抽音频+ASR）→ POLISHING（LLM 润色）
 *              → READY / FAILED（原因写入 Project.error）。
 *              入口 startProcessing 仅负责入队（BullMQ 转写队列）；Redis 不可用时
 *              降级为进程内直跑（job 未入队，无重复风险）。
 *              processProject 只执行不兜错——错误上抛给 Worker 以触发自动重试，
 *              重试用尽后由 Worker 的 failed 事件调用 markProjectFailed 落库。
 *              存储驱动：local 直接读盘；oss 先经 ensureLocalVideo 拉取到本地缓存。
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { db } from "@/lib/db";
import { notify } from "@/lib/notify";
import { extractAudioToMp3, probeDurationSec } from "@/lib/media";
import { ensureLocalVideo, publicUrlFor } from "@/lib/storage";
import { getAsrProvider } from "@/lib/asr";
import type { StoredSegment } from "@/lib/asr/types";
import { polishSegments } from "@/lib/polish";
import { enqueueTranscribe } from "@/lib/queue/queues";
import { MAX_VIDEO_DURATION_SEC } from "@/lib/constants";

/**
 * 启动转写任务：优先入队（Worker 消费），Redis 不可用时降级进程内直跑
 * @param projectId 项目 ID
 * @param userId    用户 ID（用于付费优先级计算）
 */
export async function startProcessing(projectId: string, userId: string): Promise<void> {
  const queued = await enqueueTranscribe(projectId, userId);
  if (queued) return;
  // 降级：进程内执行并在失败时直接落 FAILED（无重试语义，与队列行为对齐）
  void processProject(projectId).catch(async (e) => {
    await markProjectFailed(projectId, e instanceof Error ? e.message : "处理失败");
  });
}

/**
 * 将项目标记为失败（重试用尽后的死信落库；表行可能已被删除需容错）
 * @param projectId 项目 ID
 * @param message   失败原因
 */
export async function markProjectFailed(projectId: string, message: string): Promise<void> {
  // update 返回更新后的行：顺带取 userId/title/link 用于站内通知（行已删则跳过通知）
  const row = await db.project
    .update({ where: { id: projectId }, data: { status: "FAILED", error: message } })
    .catch(() => null);
  if (row) {
    await notify(row.userId, "TRANSCRIBE_FAILED", "转写失败", `「${row.title}」处理失败：${message}`, `/project/${row.id}`);
  }
}

/**
 * 执行完整流水线：探测时长 → 抽音频 → ASR 转写 → LLM 润色 → 结果落库
 * 任何一步失败都会向上抛错（由 Worker 决定重试或最终标记 FAILED）。
 * @param projectId 项目 ID
 */
export async function processProject(projectId: string): Promise<void> {
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || !project.videoKey) return;

  // 临时音频文件（流水线结束后清理）
  const tmpAudio = path.join(os.tmpdir(), `subflow-audio-${projectId}.mp3`);

  try {
    // ① 探测时长并校验上限（oss 模式先拉取到本地缓存）
    await db.project.update({ where: { id: projectId }, data: { status: "TRANSCRIBING" } });
    const videoPath = await ensureLocalVideo(project.videoKey);
    const durationSec = await probeDurationSec(videoPath);
    if (durationSec > MAX_VIDEO_DURATION_SEC) {
      throw new Error(`媒体时长 ${Math.round(durationSec / 60)} 分钟，超过上限 ${MAX_VIDEO_DURATION_SEC / 60} 分钟`);
    }
    await db.project.update({ where: { id: projectId }, data: { durationSec } });

    // ② 抽取音频（16kHz 单声道 mp3）
    await extractAudioToMp3(videoPath, tmpAudio);

    // ③ ASR 转写（filetrans provider 需要源文件公网 URL；sync provider 传本地音频即可）
    const provider = getAsrProvider();
    const asr = await provider.transcribe({
      audioPath: tmpAudio,
      durationSec,
      language: project.language,
      publicFileUrl:
        provider.name === "qwen3-asr-flash-filetrans" ? publicUrlFor(project.videoKey) : undefined,
    });

    // ④ LLM 润色（失败自动回退原文，不阻断）
    await db.project.update({ where: { id: projectId }, data: { status: "POLISHING" } });
    const { texts, polished } = await polishSegments(asr.segments.map((s) => s.text));
    const segments: StoredSegment[] = asr.segments.map((s, i) => ({
      start: Math.round(s.start * 1000) / 1000,
      end: Math.round(s.end * 1000) / 1000,
      text: texts[i],
      keywords: [],
    }));

    // ⑤ 结果落库并置 READY
    await db.transcript.upsert({
      where: { projectId },
      create: { projectId, segments, rawText: asr.rawText, asrProvider: asr.provider, llmPolished: polished },
      update: { segments, rawText: asr.rawText, asrProvider: asr.provider, llmPolished: polished },
    });
    await db.project.update({ where: { id: projectId }, data: { status: "READY", error: null } });
    console.log(`[pipeline] 项目 ${projectId} 处理完成：${segments.length} 段（润色=${polished}）`);
    // 站内通知：转写完成（铃铛提醒，旁路失败不影响主流程）
    await notify(project.userId, "TRANSCRIBE_DONE", "转写完成", `「${project.title}」字幕已就绪，共 ${segments.length} 段`, `/project/${projectId}`);
  } finally {
    await fs.unlink(tmpAudio).catch(() => {});
  }
}
