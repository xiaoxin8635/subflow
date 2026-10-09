/**
 * @file qwen3-asr-flash 同步转写 provider（OpenAI 兼容模式，Base64 传本地音频）
 * @description 适用：本地开发 / 无公网文件地址的场景。
 *   - 单次请求上限 5 分钟：超长音频按 CHUNK_SEC 用 FFmpeg 切块，逐块转写；
 *   - 该接口不返回时间戳：对每块做 silencedetect 语音段检测，
 *     用 align.alignTextToSpeech 将文本铺到语音段上生成估算时间戳；
 *   - 生产环境（文件有公网 URL）应切换 qwen-filetrans provider 获取毫秒级真实时间戳。
 * 文档：https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import OpenAI from "openai";
import { detectSpeechSegments, sliceAudio } from "../media";
import { alignTextToSpeech } from "./align";
import type { AsrProvider, AsrResult, TranscribeOptions } from "./types";

/** 单块最大秒数：官方上限 5 分钟（300s），留 30s 余量防边界截断 */
const CHUNK_SEC = 270;
/** 单块请求失败重试次数（指数退避） */
const MAX_RETRIES = 2;

/** 创建 DashScope 兼容模式客户端 */
function newClient(): OpenAI {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("缺少 DASHSCOPE_API_KEY 环境变量");
  return new OpenAI({
    apiKey,
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  });
}

/** 休眠工具 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 转写单个音频块（Base64 input_audio），带指数退避重试。
 * 实测要点（DashScope qwen3-asr-flash 兼容模式）：
 *   - input_audio.data 必须是 data URI（"data:audio/mp3;base64,..."），
 *     裸 base64 会被服务端误判为音频 URL 报 InvalidParameter；
 *   - content 中不能携带 text part，否则报 "dedicated task asr does not support this input"。
 * @param audioPath 音频文件路径（读取后转 Base64）
 * @returns 该块的纯文本转写结果
 */
async function transcribeChunkBase64(base64: string): Promise<string> {
  let lastErr: unknown = new Error("未知错误");
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await newClient().chat.completions.create({
        model: "qwen3-asr-flash",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "input_audio",
                input_audio: { data: `data:audio/mp3;base64,${base64}`, format: "mp3" },
              },
            ],
          },
        ],
        temperature: 0,
      });
      const text = res.choices[0]?.message?.content?.trim() ?? "";
      if (!text) throw new Error("ASR 返回空文本");
      return text;
    } catch (err) {
      lastErr = err;
      console.warn(`[asr:qwen-sync] 转写失败（第 ${attempt + 1} 次）：`, err);
      if (attempt < MAX_RETRIES) await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastErr;
}

/** qwen3-asr-flash 同步 provider */
export const qwenSyncProvider: AsrProvider = {
  name: "qwen3-asr-flash-sync",

  async transcribe({ audioPath, durationSec, language = "zh" }: TranscribeOptions): Promise<AsrResult> {
    const chunkCount = Math.max(1, Math.ceil(durationSec / CHUNK_SEC));

    // 1. 整段语音段检测一次（块对齐时按块窗口截取），避免重复跑 silencedetect
    const allSpeech = await detectSpeechSegments(audioPath, durationSec);

    // 2. 逐块转写并块内对齐
    const segments = [];
    const rawParts: string[] = [];

    for (let i = 0; i < chunkCount; i++) {
      const chunkStart = i * CHUNK_SEC;
      const chunkDur = Math.min(CHUNK_SEC, durationSec - chunkStart);

      // 该块窗口内的语音段（换算为块内相对时间）
      const chunkSpeech = allSpeech
        .map((s) => ({
          start: Math.max(0, s.start - chunkStart),
          end: Math.min(chunkDur, s.end - chunkStart),
        }))
        .filter((s) => s.end - s.start > 0.05)
        .map((s) => ({ start: s.start, end: Math.max(s.start + 0.05, s.end) }));

      // 读块内容：单块直接读源文件；多块先切片到临时文件
      let base64: string;
      let tmpFile: string | null = null;
      if (chunkCount === 1) {
        base64 = (await fs.promises.readFile(audioPath)).toString("base64");
      } else {
        tmpFile = path.join(os.tmpdir(), `subflow-asr-${Date.now()}-${i}.mp3`);
        await sliceAudio(audioPath, chunkStart, chunkDur, tmpFile);
        base64 = (await fs.promises.readFile(tmpFile)).toString("base64");
      }

      try {
        const chunkText = await transcribeChunkBase64(base64);
        if (!chunkText) continue;
        rawParts.push(chunkText);
        segments.push(
          ...alignTextToSpeech(chunkText, chunkSpeech, chunkDur).map((seg) => ({
            start: seg.start + chunkStart,
            end: seg.end + chunkStart,
            text: seg.text,
          })),
        );
      } finally {
        if (tmpFile) await fs.promises.unlink(tmpFile).catch(() => {});
      }
    }

    if (segments.length === 0) {
      throw new Error("ASR 未识别到任何语音内容");
    }
    return { segments, rawText: rawParts.join(""), provider: this.name };
  },
};
