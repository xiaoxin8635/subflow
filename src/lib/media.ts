/**
 * @file 媒体处理工具（基于 ffmpeg-static / ffprobe-static 自带二进制）
 * @description 提供：时长探测、音频抽取（16kHz 单声道 mp3，供 ASR）、
 *              封面帧抽取（工作台缩略图）、均匀采样抽帧（OCR 硬字幕提取）、
 *              语音段检测（silencedetect，供同步 ASR 文本对齐时间戳）、音频切片。
 *              所有命令均为 Windows/Linux 兼容的 execFile 调用（不经过 shell，无注入风险）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
 * @param opts      denoise: 噪声抑制（P2.11）——叠加 FFmpeg afftdn（FFT 自适应降噪）
 *                  滤镜，适配嘈杂环境录音；默认关闭（干净音源降噪反而可能损伤语音细节）
 */
export async function extractAudioToMp3(
  videoPath: string,
  outMp3: string,
  opts: { denoise?: boolean } = {},
): Promise<void> {
  await execFileAsync(
    FFMPEG,
    [
      "-y",
      "-i", videoPath,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-b:a", "48k",
      ...(opts.denoise ? ["-af", "afftdn"] : []),
      outMp3,
    ],
    { maxBuffer: MAX_BUFFER },
  );
}

/**
 * 从视频抽取一帧作为封面（工作台缩略图）：640px 宽 JPEG（保持宽高比，高度偶数对齐）
 * @param videoPath 视频路径
 * @param outJpg    输出 JPEG 路径
 * @param atSec     取帧时刻（秒）；封面用 0（视频首帧）
 */
export async function extractCoverFrame(
  videoPath: string,
  outJpg: string,
  atSec: number,
): Promise<void> {
  await execFileAsync(
    FFMPEG,
    [
      "-y",
      "-ss", Math.max(0, atSec).toFixed(3),
      "-i", videoPath,
      "-frames:v", "1",
      "-vf", "scale=640:-2",
      "-q:v", "3",
      outJpg,
    ],
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

/** 波形峰值数据（编辑器 WaveformStrip 渲染消费的 JSON 契约） */
export interface WaveformData {
  /** 每秒峰值桶数（前端据此刻时间：index / rate = 秒） */
  rate: number;
  /** 峰值数组（16bit 原始振幅 0-32767，前端渲染时自行归一化） */
  peaks: number[];
}

/**
 * 提取音频波形峰值（编辑器时间轴渲染用）：解码为 8kHz 单声道 16bit PCM，
 * 按桶取绝对值最大值（约 10 桶/秒，总桶数封顶 36000——超长媒体均匀加大桶宽）。
 * 输出 JSON 体积可控（1 小时 ≈ 250KB），无音轨/损坏文件时 ffmpeg 报错上抛，
 * 由调用方旁路容错（不阻断转写主流程）。
 * @param mediaPath 视频或音频文件路径（-vn 自动忽略视频轨）
 * @param outJson   输出 JSON 路径（{ rate, peaks } 结构）
 */
export async function extractWaveformPeaks(
  mediaPath: string,
  outJson: string,
): Promise<void> {
  const tmpPcm = path.join(
    os.tmpdir(),
    `subflow-wave-${Date.now()}-${Math.random().toString(36).slice(2)}.pcm`,
  );
  try {
    // ① 解码为裸 PCM（流式写临时文件，内存不受源时长影响）
    await execFileAsync(
      FFMPEG,
      ["-y", "-i", mediaPath, "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", tmpPcm],
      { maxBuffer: MAX_BUFFER },
    );
    // ② 按桶取峰值：桶宽 ≥800 样本（=10 桶/秒）且总桶数 ≤36000（超长媒体均匀加大桶宽）
    const pcm = await fs.readFile(tmpPcm);
    const totalSamples = Math.floor(pcm.length / 2);
    const MAX_PEAKS = 36000;
    const samplesPerBucket = Math.max(800, Math.ceil(totalSamples / MAX_PEAKS));
    const peaks: number[] = [];
    for (let i = 0; i < totalSamples; i += samplesPerBucket) {
      const end = Math.min(i + samplesPerBucket, totalSamples);
      let peak = 0;
      for (let j = i; j < end; j++) {
        const v = Math.abs(pcm.readInt16LE(j * 2));
        if (v > peak) peak = v;
      }
      peaks.push(peak);
    }
    // ③ 写 JSON（rate 由实际桶宽反推，前端拿它换算时间轴）
    const data: WaveformData = { rate: 8000 / samplesPerBucket, peaks };
    await fs.writeFile(outJson, JSON.stringify(data));
  } finally {
    await fs.unlink(tmpPcm).catch(() => {});
  }
}

/**
 * 均匀采样抽帧（OCR 硬字幕提取用）：按 fps 抽帧缩放到 640px 宽 JPEG，帧数封顶。
 * @param videoPath   视频路径
 * @param outDir      帧图输出目录（需已存在；命名 frame_%04d.jpg，从 1 起）
 * @param durationSec 视频总时长（秒），用于计算封顶后的采样帧率
 * @param maxFrames   最大帧数（超过时均匀降采样：fps = maxFrames / duration）
 * @returns 帧文件名列表（升序，与时间对应：第 i 帧时刻 ≈ i / fps）
 */
export async function extractFrames(
  videoPath: string,
  outDir: string,
  durationSec: number,
  maxFrames: number,
): Promise<string[]> {
  // 采样帧率：默认 1fps；超长视频按 maxFrames 封顶均匀降采样（最低 0.1fps 防除零）
  const fps = durationSec > maxFrames ? Math.max(0.1, maxFrames / durationSec) : 1;
  await execFileAsync(
    FFMPEG,
    [
      "-y",
      "-i", videoPath,
      "-vf", `fps=${fps.toFixed(4)},scale=640:-2`,
      "-q:v", "5",
      path.join(outDir, "frame_%04d.jpg"),
    ],
    { maxBuffer: MAX_BUFFER },
  );
  return (await fs.readdir(outDir)).filter((f) => f.startsWith("frame_") && f.endsWith(".jpg")).sort();
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
