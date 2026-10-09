/**
 * @file 字幕文本 ↔ 时间轴对齐算法
 * @description qwen3-asr-flash 同步接口只返回纯文本、无时间戳。本模块将全文按标点切句，
 *              并把句子「铺」在 silencedetect 检测出的语音段上（按字符权重分配时长），
 *              生成估算级句级时间戳。精度满足字幕草稿；生产环境应使用
 *              qwen3-asr-flash-filetrans 获得毫秒级真实时间戳。
 */
import type { AsrSegment } from "./types";
import type { SpeechSegment } from "../media";

/**
 * 将转写全文切分为适合字幕的句子：
 *  1. 先按强标点（。！？；!?; 与换行）切分；
 *  2. 超过 maxLen 的长句再按弱标点（，、,）二次切分；
 *  3. 相邻过短片段合并，避免字幕一闪而过。
 * @param raw    ASR 原始全文
 * @param maxLen 单条字幕最大字符数（默认 40，约对应 8-10 秒语音）
 * @returns 句子数组（顺序与原文一致）
 */
export function splitSentences(raw: string, maxLen = 40): string[] {
  const out: string[] = [];
  for (const piece of raw.split(/(?<=[。！？!?；;\n])/)) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    if (trimmed.length <= maxLen) {
      out.push(trimmed);
      continue;
    }
    // 长句按弱标点二次切分，并合并过短片段
    let buf = "";
    for (const frag of trimmed.split(/(?<=[，、,])/)) {
      const f = frag.trim();
      if (!f) continue;
      if ((buf + f).length <= maxLen) {
        buf += f;
      } else {
        if (buf) out.push(buf);
        buf = f;
      }
    }
    if (buf) out.push(buf);
  }
  return out;
}

/**
 * 将句子按字符权重铺在语音段时间轴上，生成估算时间戳。
 * 策略：句子按字符数比例消耗语音段时长；当句子边界落在两个语音段之间时，
 * 自然吸附到真实语音边界（因为「铺」的过程按段推进）。
 * @param text          ASR 全文
 * @param speech        语音段列表（detectSpeechSegments 产出，升序不重叠）
 * @param totalDuration 音频总时长（秒）
 */
export function alignTextToSpeech(
  text: string,
  speech: SpeechSegment[],
  totalDuration: number,
): AsrSegment[] {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return [];

  const totalChars = sentences.reduce((sum, s) => sum + s.length, 0);

  // 无语音段信息：退化为全长均分
  if (speech.length === 0) {
    let t = 0;
    return sentences.map((seg) => {
      const d = (seg.length / totalChars) * totalDuration;
      const item = { start: t, end: t + d, text: seg };
      t += d;
      return item;
    });
  }

  const totalSpeechSec = speech.reduce((sum, s) => sum + (s.end - s.start), 0);
  // 每句应得的时长（秒）
  const durations = sentences.map((s) => (s.length / totalChars) * totalSpeechSec);

  const result: AsrSegment[] = [];
  let segIdx = 0;
  let cursor = speech[0].start;

  for (let i = 0; i < sentences.length; i++) {
    const start = cursor;
    let need = durations[i];

    // 沿语音段消耗时长；跨段时自然跳过静音区间（吸附到下一段起点）
    while (need > 1e-6 && segIdx < speech.length) {
      const avail = speech[segIdx].end - cursor;
      if (avail <= need) {
        need -= avail;
        segIdx += 1;
        cursor = segIdx < speech.length ? speech[segIdx].start : speech[speech.length - 1].end;
      } else {
        cursor += need;
        need = 0;
      }
    }
    // 语音段耗尽仍有剩余句子（罕见：浮点误差）：钳制在音频末尾
    if (segIdx >= speech.length) cursor = speech[speech.length - 1].end;

    // 最后一句强制对齐到最后一个语音段末尾，避免尾字被截
    const end =
      i === sentences.length - 1 ? speech[speech.length - 1].end : Math.max(cursor, start + 0.2);
    result.push({ start, end, text: sentences[i] });
  }
  return result;
}
