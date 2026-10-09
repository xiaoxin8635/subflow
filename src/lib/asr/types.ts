/**
 * @file ASR 模块公共类型定义
 * @description 所有 ASR provider（qwen-sync / qwen-filetrans）统一输出 AsrResult，
 *              时间单位一律为「秒」（浮点），与数据库 segments 约定一致。
 */

/** 单条字幕段（时间单位：秒） */
export interface AsrSegment {
  /** 开始时间（秒） */
  start: number;
  /** 结束时间（秒） */
  end: number;
  /** 字幕文本 */
  text: string;
}

/**
 * 入库使用的分段结构（在 AsrSegment 基础上带关键词高亮标记）。
 * 必须是纯对象字面量 type（不能是 interface / 交叉类型）：
 * 只有字面量 type 具备隐式 index signature，才能赋给 Prisma Json 字段。
 */
export type StoredSegment = {
  /** 开始时间（秒） */
  start: number;
  /** 结束时间（秒） */
  end: number;
  /** 字幕文本 */
  text: string;
  /** 关键词列表（用于编辑器高亮，转写阶段暂为空数组） */
  keywords: string[];
};

/** ASR 转写结果 */
export interface AsrResult {
  /** 带时间戳的分段 */
  segments: AsrSegment[];
  /** ASR 原始全文（润色前留底） */
  rawText: string;
  /** provider 标识（写入 Transcript.asrProvider） */
  provider: string;
}

/** ASR 转写请求参数 */
export interface TranscribeOptions {
  /** 音频文件路径（16kHz 单声道 mp3，由 media.extractAudioToMp3 产出） */
  audioPath: string;
  /** 音频总时长（秒） */
  durationSec: number;
  /** 语言代码，默认 zh */
  language?: string;
  /**
   * 源文件的公网可访问 URL（仅 filetrans provider 需要）：
   * DashScope 服务器会主动下载该文件，本地开发传不了（localhost 不可达）。
   */
  publicFileUrl?: string;
}

/** ASR 服务提供方接口：输入本地音频，输出带时间戳分段 */
export interface AsrProvider {
  /** provider 标识 */
  readonly name: string;
  /** 执行转写 */
  transcribe(options: TranscribeOptions): Promise<AsrResult>;
}
