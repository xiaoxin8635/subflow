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
  /**
   * 识别主语言（P2.11）：zh/yue/en/ja/ko 透传给 ASR 服务；
   * "auto" = 自动检测，不传语言参数。默认 zh。
   */
  language?: string;
  /**
   * ASR 语境增强文本（P2.11 场景自适应）：场景描述 + 热词表。
   * 仅 qwen-filetrans 注入 parameters.corpus；qwen-sync 不接受语境输入
   * （实测拒绝 system message），场景/热词由润色纠错 prompt 承担。
   * 可空（通用场景且无热词时不注入）。
   */
  asrContext?: string;
  /**
   * 是否开启数字规范化 ITN（P2.11）：「一百二十三」→「123」，
   * 短视频字幕惯例用阿拉伯数字，默认开启（仅 qwen-sync 生效）。
   */
  enableItn?: boolean;
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
