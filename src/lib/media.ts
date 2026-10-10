/**
 * @file 媒体处理工具（基于 ffmpeg-static / ffprobe-static 自带二进制）
 * @description 提供：时长探测、音频抽取（16kHz 单声道 mp3，供 ASR）、
 *              语音段检测（silencedetect，供同步 ASR 文本对齐时间戳）、音频切片。
 *              所有命令均为 Windows/Linux 兼容的 execFile 调用（不经过 shell，无注入风险）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const execFileAsync = promisify(execFile);

// 二进制缺失时快速失败（部署不完整比运行时报错更应尽早暴露）
if (!ffmpegPath || !ffprobeStatic.path) {
  throw new Error("ffmpeg/ffprobe 二进制缺失，请重新安装 ffmpeg-static 与 ffprobe-static");
}

/** ffmpeg 可执行文件路径 */
const FFMPEG: string = ffmpegPath;
/** ffprobe 可执行文件路径 */
const FFPROBE: string = ffprobeStatic.path;

/** 语音段（秒） */
export interface SpeechSegment {
  /** 开始时间（秒） */
  start: number;
  /** 结束时间（秒） */
  end: number;
}

/** execFile 输出缓冲上限（ffmpeg stderr 可能较大，给足 16MB） */
const MAX_BUFFER = 16 * 1024 * 1024;

/**
 * 探测媒体文件时长
 * @param filePath 视频或音频文件路径
 * @returns 时长（秒，浮点）
 */
export async function probeDurationSec(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync(
    FFPROBE,
    ["-v", "error", "-show_entries", "format=duration", "-of", "json", filePath],
    { maxBuffer: MAX_BUFFER },
  );
  const duration = JSON.parse(stdout).format?.duration;
  const sec = Number(duration);
  if (!Number.isFinite(sec) || sec <= 0) {
    throw new Error("无法解析媒体时长（文件可能损坏或不是有效的视频/音频）");
  }
  return sec;
}

/**
 * 从视频抽取音频：16kHz 单声道 mp3（48kbps，5 分钟约 1.8MB，Base64 后仍很小，适合 ASR）
 * @param videoPath 视频路径
 * @param outMp3    输出 mp3 路径
 */
export async function extractAudioToMp3(videoPath: string, outMp3: string): Promise<void> {
  await execFileAsync(
    FFMPEG,
    ["-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", outMp3],
    { maxBuffer: MAX_BUFFER },
  );
}

/**
 * 从源 mp3 切出一段（用于同步 ASR 的 5 分钟分块）
 * @param srcMp3   源音频路径
 * @param startSec 起始秒
 * @param durSec   时长秒
 * @param outPath  输出路径
 */
export async function sliceAudio(
  srcMp3: string,
  startSec: number,
  durSec: number,
  outPath: string,
): Promise<void> {
  // -ss 放在 -i 前走关键帧快切（mp3 无关键帧概念，实际为精确解码；速度更快）
  await execFileAsync(
    FFMPEG,
    ["-y", "-ss", startSec.toFixed(3), "-i", srcMp3, "-t", durSec.toFixed(3), outPath],
    { maxBuffer: MAX_BUFFER },
  );
}

/**
 * 语音段检测：解析 ffmpeg silencedetect 输出，返回「有声音」的区间列表。
 * 用于同步 ASR（无时间戳接口）的文本对齐：句子按字符权重铺在语音段上。
 * @param mp3Path       音频路径
 * @param totalDuration 音频总时长（秒）
 * @returns 语音段列表（升序、不重叠；完全没有声音时退化为整段一个区间）
 */
export async function detectSpeechSegments(
  mp3Path: string,
  totalDuration: number,
): Promise<SpeechSegment[]> {
  // -35dB/0.4s：对正常语音与背景音乐均可用的经验阈值
  let stderr = "";
  try {
    const result = await execFileAsync(
      FFMPEG,
      ["-hide_banner", "-i", mp3Path, "-af", "silencedetect=noise=-35dB:d=0.4", "-f", "null", "-"],
      { maxBuffer: MAX_BUFFER },
    );
    stderr = result.stderr ?? "";
  } catch (err) {
    // silencedetect 对个别损坏尾部可能返回非零码，只要拿到 stderr 就继续解析
    stderr = (err as { stderr?: string }).stderr ?? "";
    if (!stderr) throw err;
  }

  // 解析静音区间（silence_start / silence_end 成对出现）
  const silences: SpeechSegment[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) silences.push({ start: Math.max(0, Number(s[1])), end: totalDuration });
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (e && silences.length > 0) {
      silences[silences.length - 1].end = Math.min(totalDuration, Number(e[1]));
    }
  }

  // 全长减去静音区间 → 语音区间（忽略 <80ms 的碎片段）
  const speech: SpeechSegment[] = [];
  let pos = 0;
  for (const s of silences) {
    if (s.start - pos > 0.08) speech.push({ start: pos, end: s.start });
    pos = Math.max(pos, s.end);
  }
  if (totalDuration - pos > 0.08) speech.push({ start: pos, end: totalDuration });

  // 兜底：阈值过严导致全程判为「静音」时（纯音乐/低音量），退化为整段
  if (speech.length === 0) speech.push({ start: 0, end: totalDuration });
  return speech;
}
