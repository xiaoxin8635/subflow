/**
 * @file WebVTT 字幕文件生成器（P1.4 多格式导出）
 * @description 将 Transcript.segments 编译为标准 WebVTT 格式文本，供网页播放器
 *              （HTML5 <track>）与支持 VTT 的剪辑软件使用。与 ass.ts/srt.ts 共用
 *              同一份分段数据与过滤规则（end > start、text 非空），保证各格式
 *              导出时间轴一致。VTT 与 SRT 同为纯文本，不含样式/高亮信息。
 */

/** 字幕段（与 srt.ts 的 SrtSegment 结构保持一致） */
export interface VttSegment {
  /** 开始时间（秒） */
  start: number;
  /** 结束时间（秒） */
  end: number;
  text: string;
}

/**
 * 秒 → VTT 时间戳 HH:MM:SS.mmm（毫秒三位，点分隔——与 SRT 的逗号不同）
 * @param t 秒
 */
export function toVttTime(t: number): string {
  const clamped = Math.max(0, t);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000) % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

/**
 * 编译完整 WebVTT 文件内容
 * @param segments 字幕分段
 * @returns VTT 文本（以 WEBVTT 魔数行开头；无 BOM，BOM 会破坏部分解析器对魔数的识别）
 */
export function buildVtt(segments: VttSegment[]): string {
  const blocks = segments
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && s.text?.trim())
    .map((s) => {
      // VTT 支持行内标签，但源文本可能含未闭合的 <>，统一抑制防解析错误
      const text = s.text.trim().replace(/[<>]/g, "");
      return `${toVttTime(s.start)} --> ${toVttTime(s.end)}\n${text}`;
    });
  // WEBVTT 规范：文件必须以 "WEBVTT" 行开头，cue 之间空行分隔
  return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}
