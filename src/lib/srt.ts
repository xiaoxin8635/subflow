/**
 * @file SRT 字幕文件生成器
 * @description 将 Transcript.segments 编译为标准 SRT（SubRip）格式文本，
 *              供剪映 / PR / 达芬奇等剪辑软件二次使用。与 ass.ts 共用同一份
 *              分段数据与过滤规则（end > start、text 非空），保证两种导出时间轴一致。
 *              SRT 为纯文本格式，不含样式/高亮信息（高亮仅存在于烧录链路）。
 */

/** 字幕段（与 ass.ts 的 AssSegment 结构保持一致） */
export interface SrtSegment {
  /** 开始时间（秒） */
  start: number;
  /** 结束时间（秒） */
  end: number;
  text: string;
}

/**
 * 秒 → SRT 时间戳 HH:MM:SS,mmm（毫秒三位，逗号分隔）
 * @param t 秒
 */
export function toSrtTime(t: number): string {
  const clamped = Math.max(0, t);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000) % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

/**
 * 编译完整 SRT 文件内容
 * @param segments 字幕分段
 * @returns SRT 文本（UTF-8 无 BOM；BOM 由调用方按目标播放器决定是否追加）
 */
export function buildSrt(segments: SrtSegment[]): string {
  const blocks = segments
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && s.text?.trim())
    .map((s, i) => {
      // SRT 文本内为真实换行；抑制花括号防播放器误解析为标签
      const text = s.text.trim().replace(/[{}]/g, "");
      return `${i + 1}\n${toSrtTime(s.start)} --> ${toSrtTime(s.end)}\n${text}`;
    });
  // 块之间以空行分隔（SRT 规范），文件以换行结尾
  return `${blocks.join("\n\n")}\n`;
}
