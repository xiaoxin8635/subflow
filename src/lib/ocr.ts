/**
 * @file OCR 硬字幕提取（qwen3-vl 视觉模型，OpenAI 兼容模式）
 * @description 适用场景：画面上已烧录字幕的视频（无人声也能提取）。
 *   流程：均匀采样抽帧（1fps，封顶 MAX_FRAMES）→ 逐帧识别字幕文字 →
 *   相邻同文本帧合并为句（start=首帧时刻，end=末帧时刻+帧间隔）。
 *   逐帧串行改并发分批（OCR_CONCURRENCY）以加速长视频；
 *   单帧失败指数退避重试，最终失败抛错（走任务失败重试机制）。
 *   时间轴精度 = 采样间隔（1fps → 1 秒），对字幕场景足够。
 * 文档：https://help.aliyun.com/zh/model-studio/vision
 * 模型接入：经 AI 网关客户端工厂（ai-client.ts）——配置 AI_GATEWAY_* 走网关
 *   多渠道 failover，未配置回落 DashScope 直连。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractFrames } from "./media";
import { createChatClient } from "./ai-client";
import type { AsrResult } from "./asr/types";

/** 视觉模型名（可用 OCR_MODEL 环境变量覆盖；qwen-vl-plus 旧名已下线会 404） */
const OCR_MODEL = process.env.OCR_MODEL ?? "qwen3-vl-plus";
/** 抽帧上限：≤10 分钟视频 1fps 全采，更长的均匀降采样（控制耗时与成本） */
const MAX_FRAMES = 600;
/** 逐帧识别并发数（过高可能触发 DashScope 限流） */
const OCR_CONCURRENCY = Number(process.env.OCR_CONCURRENCY ?? 3);
/** 单帧请求失败重试次数（指数退避） */
const MAX_RETRIES = 2;

/** 逐帧识别 prompt（实测：要求只输出原文、无字幕输出空，聚合逻辑依赖此约定） */
const FRAME_PROMPT =
  "识别画面中出现的字幕文字（通常位于画面下方居中）。只输出字幕原文，不要任何解释、标点补充或引号；若画面中没有字幕文字，只输出一个空字符串。";

/** 休眠工具 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 识别单帧画面中的字幕文字（带指数退避重试）
 * @param frameJpg 帧图 JPEG 文件路径
 * @returns 字幕原文（无字幕为空字符串）
 */
async function recognizeFrame(frameJpg: string): Promise<string> {
  const base64 = await fs.readFile(frameJpg).then((buf) => buf.toString("base64"));
  let lastErr: unknown = new Error("未知错误");
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await createChatClient().chat.completions.create({
        model: OCR_MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } },
              { type: "text", text: FRAME_PROMPT },
            ],
          },
        ],
        temperature: 0,
      });
      return (res.choices[0]?.message?.content ?? "").trim();
    } catch (err) {
      lastErr = err;
      console.warn(`[ocr] 帧识别失败（第 ${attempt + 1} 次）：`, err instanceof Error ? err.message : err);
      if (attempt < MAX_RETRIES) await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastErr;
}

/**
 * 从视频提取硬字幕：抽帧 → 并发分批逐帧识别 → 相邻同文本合并为句
 * @param videoPath   视频文件路径
 * @param durationSec 视频总时长（秒）
 * @returns 与 ASR 同构的结果（segments/rawText/provider），可直接走润色与入库链路
 */
export async function extractSubtitlesFromVideo(
  videoPath: string,
  durationSec: number,
): Promise<AsrResult> {
  // ① 抽帧到临时目录（用完即删）
  const frameDir = await fs.mkdtemp(path.join(os.tmpdir(), "subflow-ocr-"));
  let texts: string[] = [];
  let fps = 1;
  try {
    const frames = await extractFrames(videoPath, frameDir, durationSec, MAX_FRAMES);
    // 帧率与抽帧时一致：帧数 ≤ maxFrames → 1fps；否则为帧数/时长（允许 ±1 帧误差取实际值）
    fps = Math.max(0.1, frames.length / durationSec);
    console.log(`[ocr] 项目抽帧 ${frames.length} 帧（fps=${fps.toFixed(3)}），开始识别（并发 ${OCR_CONCURRENCY}）`);

    // ② 并发分批逐帧识别（保持顺序：结果下标即帧序号）
    texts = new Array(frames.length).fill("");
    let next = 0;
    const worker = async () => {
      while (next < frames.length) {
        const i = next++;
        texts[i] = await recognizeFrame(path.join(frameDir, frames[i]));
      }
    };
    await Promise.all(Array.from({ length: Math.min(OCR_CONCURRENCY, frames.length) }, worker));

    // ③ 全部为空 → 视频没有可提取的字幕（对称 ASR 的「未识别到语音」失败语义）
    if (texts.every((t) => !t)) {
      throw new Error("OCR 未识别到任何字幕文字（视频画面中可能没有字幕）");
    }
  } finally {
    await fs.rm(frameDir, { recursive: true, force: true }).catch(() => {});
  }

  // ④ 相邻同文本帧合并为句：帧 i 覆盖时间窗 [i/fps, (i+1)/fps)
  const frameDur = 1 / fps;
  const segments: AsrResult["segments"] = [];
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    if (!text) continue;
    const last = segments[segments.length - 1];
    if (last && last.text === text) {
      last.end = (i + 1) * frameDur; // 同句延续到本帧覆盖窗口结束
    } else {
      segments.push({ start: i * frameDur, end: (i + 1) * frameDur, text });
    }
  }

  return {
    segments,
    rawText: texts.filter(Boolean).join("\n"),
    provider: `ocr-${OCR_MODEL}`,
  };
}
