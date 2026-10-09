/**
 * @file 项目处理流水线（进程内异步任务）
 * @description 状态机：UPLOADED → TRANSCRIBING（抽音频+ASR）→ POLISHING（LLM 润色）
 *              → READY / FAILED（原因写入 Project.error）。
 *              MVP 采用进程内 fire-and-forget，不引入消息队列；dev 模式热重载会中断
 *              进行中的任务（重传即可），生产为常驻 Node 进程不受影响。
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { db } from "@/lib/db";
import { extractAudioToMp3, probeDurationSec } from "@/lib/media";
import { publicUrlFor } from "@/lib/storage";
import { getAsrProvider } from "@/lib/asr";
import type { StoredSegment } from "@/lib/asr/types";
import { polishSegments } from "@/lib/polish";
import { MAX_VIDEO_DURATION_SEC } from "@/lib/constants";

/**
 * 由存储 key 解析磁盘上视频文件绝对路径
 * @param videoKey 上传时生成的存储 key
 */
export function localVideoPath(videoKey: string): string {
  const dir = process.env.LOCAL_UPLOAD_DIR ?? "./uploads";
  return path.join(process.cwd(), dir, videoKey);
}

/**
 * 启动后台处理任务（不阻塞调用方；未捕获异常兜底打日志）
 * @param projectId 项目 ID
 */
export function startProcessing(projectId: string): void {
  void processProject(projectId).catch((e) => {
    console.error(`[pipeline] 项目 ${projectId} 流水线异常：`, e);
  });
}

/**
 * 执行完整流水线：探测时长 → 抽音频 → ASR 转写 → LLM 润色 → 结果落库
 * 任何一步失败都会把项目置为 FAILED 并记录原因。
 * @param projectId 项目 ID
 */
async function processProject(projectId: string): Promise<void> {
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || !project.videoKey) return;

  // 临时音频文件（流水线结束后清理）
  const tmpAudio = path.join(os.tmpdir(), `subflow-audio-${projectId}.mp3`);

  try {
    // ① 探测时长并校验上限
    await db.project.update({ where: { id: projectId }, data: { status: "TRANSCRIBING" } });
    const videoPath = localVideoPath(project.videoKey);
    const durationSec = await probeDurationSec(videoPath);
    if (durationSec > MAX_VIDEO_DURATION_SEC) {
      throw new Error(`视频时长 ${Math.round(durationSec / 60)} 分钟，超过上限 ${MAX_VIDEO_DURATION_SEC / 60} 分钟`);
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
  } catch (err) {
    const message = err instanceof Error ? err.message : "处理失败";
    console.error(`[pipeline] 项目 ${projectId} 失败：${message}`);
    await db.project
      .update({ where: { id: projectId }, data: { status: "FAILED", error: message } })
      .catch(() => {});
  } finally {
    await fs.unlink(tmpAudio).catch(() => {});
  }
}
