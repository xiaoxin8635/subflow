/**
 * @file 字幕叠加渲染层（纯展示组件）
 * @description 按样式 config 契约把单条字幕渲染为视频容器上的叠加层。
 *              config 结构与 FFmpeg ASS 生成器共同遵守（见 prisma/seed.mjs）：
 *              fontSize 为相对 1080p 高度的百分比，outlineWidth/marginV 为 @1080p 像素，
 *              渲染时按容器实际高度等比缩放。
 */
"use client";

import type { CSSProperties, ReactNode } from "react";

/** 样式配置契约（与数据库 Style.config JSON 一致） */
export interface StyleConfig {
  /** 字体名（渲染时自动回退系统无衬线） */
  fontFamily: string;
  /** 字号：相对 1080p 高度的百分比（5.2 ≈ 56px @1080p） */
  fontSize: number;
  /** 主颜色 #RRGGBB */
  primaryColor: string;
  /** 描边颜色，空字符串 = 不描边 */
  outlineColor: string;
  /** 描边宽度（px @1080p） */
  outlineWidth: number;
  /** 垂直位置 */
  position: "top" | "center" | "bottom";
  /** 垂直边距（px @1080p） */
  marginV: number;
  /** 关键词高亮色，空字符串 = 不高亮 */
  highlight: string;
}

/** 单条字幕分段（渲染所需最小结构） */
export interface OverlaySegment {
  text: string;
  keywords?: string[];
}

/**
 * 把文本按关键词列表拆分为节点数组（高亮色非空时生效）
 * @param text     字幕文本
 * @param keywords 关键词列表
 * @param highlightColor 高亮色
 */
function splitByKeywords(
  text: string,
  keywords: string[],
  highlightColor: string,
): ReactNode[] {
  if (!highlightColor || keywords.length === 0) return [text];

  // 用正则把所有关键词（转义后）合并匹配，一次扫描完成拆分
  const escaped = keywords
    .filter((k) => k.length > 0)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (escaped.length === 0) return [text];
  const re = new RegExp(`(${escaped.join("|")})`, "g");

  return text.split(re).map((part, i) =>
    keywords.includes(part) ? (
      <span key={i} style={{ color: highlightColor }}>
        {part}
      </span>
    ) : (
      part
    ),
  );
}

/**
 * 字幕叠加层
 * @param config       样式配置
 * @param segment      当前字幕（text + keywords）
 * @param containerH   容器实际高度（px，用于 @1080p → 实际缩放）
 */
export function SubtitleOverlay({
  config,
  segment,
  containerH,
}: {
  config: StyleConfig;
  segment: OverlaySegment | null;
  containerH: number;
}) {
  if (!segment) return null;

  // @1080p 基准 → 实际容器尺寸的缩放系数
  const scale = containerH > 0 ? containerH / 1080 : 1;
  const fontSizePx = (config.fontSize / 100) * 1080 * scale;
  const marginPx = config.marginV * scale;
  const outlinePx = config.outlineWidth * scale;

  // 用 8 向 text-shadow 模拟描边（Chrome/Chrome 内核渲染一致性最好）
  const hasOutline = Boolean(config.outlineColor) && config.outlineWidth > 0;
  const shadow: string | undefined = hasOutline
    ? [0, 45, 90, 135, 180, 225, 270, 315]
        .map((deg) => {
          const rad = (deg * Math.PI) / 180;
          return `${(Math.cos(rad) * outlinePx).toFixed(2)}px ${(Math.sin(rad) * outlinePx).toFixed(2)}px 0 ${config.outlineColor}`;
        })
        .join(", ")
    : undefined;

  // 垂直定位
  const positionStyle: CSSProperties =
    config.position === "top"
      ? { top: marginPx }
      : config.position === "center"
        ? { top: "50%", transform: "translateY(-50%)" }
        : { bottom: marginPx };

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute inset-x-0 px-[4%] text-center leading-snug"
        style={{ ...positionStyle, fontFamily: `"${config.fontFamily}", "Microsoft YaHei", sans-serif` }}
      >
        <span
          className="whitespace-pre-wrap break-words font-bold"
          style={{
            fontSize: `${fontSizePx}px`,
            color: config.primaryColor,
            textShadow: shadow,
          }}
        >
          {splitByKeywords(segment.text, segment.keywords ?? [], config.highlight)}
        </span>
      </div>
    </div>
  );
}

/**
 * 安全解析 Style.config JSON（数据库读取侧容错）
 * @param raw 未知类型的 config 值
 * @returns 合法返回 StyleConfig，否则 null（调用方回退默认样式）
 */
export function parseStyleConfig(raw: unknown): StyleConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (
    typeof c.fontFamily !== "string" ||
    typeof c.fontSize !== "number" ||
    typeof c.primaryColor !== "string" ||
    typeof c.outlineColor !== "string" ||
    typeof c.outlineWidth !== "number" ||
    (c.position !== "top" && c.position !== "center" && c.position !== "bottom") ||
    typeof c.marginV !== "number" ||
    typeof c.highlight !== "string"
  ) {
    return null;
  }
  return {
    fontFamily: c.fontFamily,
    fontSize: c.fontSize,
    primaryColor: c.primaryColor,
    outlineColor: c.outlineColor,
    outlineWidth: c.outlineWidth,
    position: c.position,
    marginV: c.marginV,
    highlight: c.highlight,
  };
}
