/**
 * @file 样式配置契约与校验（前后端共享）
 * @description StyleConfig 是字幕样式的唯一契约：数据库 Style.config / UserStyle.config 的
 *              JSON 结构、前端 SubtitleOverlay 渲染器、FFmpeg ASS 生成器三方共同遵守。
 *              坐标基准：fontSize 为 @1080p 高度百分比，outlineWidth / marginV 为 @1080p 像素。
 *              parseStyleConfig 用于数据库读取侧容错（结构不对返回 null，调用方回退默认样式）；
 *              validateStyleConfigInput 用于 API 写入侧强校验（范围 + 格式），
 *              其中 fontFamily 白名单字符集可阻断 ASS Style 行注入（逗号/引号/花括号/换行均不允许）。
 */

/**
 * 样式配置契约（与数据库 Style.config / UserStyle.config JSON 一致）。
 * 注意：必须是对象字面量 type 而非 interface——Prisma Json 字段写入要求
 * 隐式 index signature，interface 类型会 TS2322（项目已踩坑）
 */
export type StyleConfig = {
  /** 字体名（渲染时自动回退系统无衬线；仅允许字母/数字/中文/空格/连字符/下划线） */
  fontFamily: string;
  /** 字号：相对 1080p 高度的百分比（5.2 ≈ 56px @1080p），合法范围 3-12 */
  fontSize: number;
  /** 主颜色 #RRGGBB */
  primaryColor: string;
  /** 描边颜色，空字符串 = 不描边 */
  outlineColor: string;
  /** 描边宽度（px @1080p），合法范围 0-12 */
  outlineWidth: number;
  /** 垂直位置 */
  position: "top" | "center" | "bottom";
  /** 垂直边距（px @1080p），合法范围 0-400 */
  marginV: number;
  /** 关键词高亮色，空字符串 = 不高亮 */
  highlight: string;
};

/** #RRGGBB 十六进制颜色格式 */
const HEX_RE = /^#[0-9a-f]{6}$/;

/**
 * 字体名白名单：字母/数字/中文/空格/连字符/下划线，1-50 字符。
 * 刻意排除逗号（ASS Style 行按逗号分列）、引号/反斜杠/花括号（ASS 语法字符）、换行
 */
const FONT_RE = /^[0-9A-Za-z一-龥 _-]{1,50}$/;

/**
 * 安全解析 Style/UserStyle.config JSON（数据库读取侧容错）
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

/**
 * API 写入侧强校验（创建/导出携带的自定义样式配置）
 * @param raw 请求体中的 config 值
 * @returns ok=true 时返回归一化后的 config（颜色统一小写、字体名去首尾空格）；
 *          ok=false 时返回面向用户的错误信息
 */
export function validateStyleConfigInput(
  raw: unknown,
): { ok: true; config: StyleConfig } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "样式配置须为对象" };
  }
  const c = raw as Record<string, unknown>;

  const fontFamily = typeof c.fontFamily === "string" ? c.fontFamily.trim() : "";
  if (!FONT_RE.test(fontFamily)) {
    return { ok: false, error: "字体名不合法（1-50 字符，仅字母/数字/中文/空格/连字符）" };
  }

  if (typeof c.fontSize !== "number" || !Number.isFinite(c.fontSize) || c.fontSize < 3 || c.fontSize > 12) {
    return { ok: false, error: "字号须在 3-12 之间" };
  }

  const primaryColor = typeof c.primaryColor === "string" ? c.primaryColor.toLowerCase() : "";
  if (!HEX_RE.test(primaryColor)) {
    return { ok: false, error: "主颜色须为 #RRGGBB 格式" };
  }

  const outlineColor = typeof c.outlineColor === "string" ? c.outlineColor.toLowerCase() : "";
  if (outlineColor !== "" && !HEX_RE.test(outlineColor)) {
    return { ok: false, error: "描边颜色须为 #RRGGBB 格式或空字符串" };
  }

  if (
    typeof c.outlineWidth !== "number" ||
    !Number.isFinite(c.outlineWidth) ||
    c.outlineWidth < 0 ||
    c.outlineWidth > 12
  ) {
    return { ok: false, error: "描边宽度须在 0-12 之间" };
  }

  if (c.position !== "top" && c.position !== "center" && c.position !== "bottom") {
    return { ok: false, error: "垂直位置不合法" };
  }

  if (typeof c.marginV !== "number" || !Number.isFinite(c.marginV) || c.marginV < 0 || c.marginV > 400) {
    return { ok: false, error: "垂直边距须在 0-400 之间" };
  }

  const highlight = typeof c.highlight === "string" ? c.highlight.toLowerCase() : "";
  if (highlight !== "" && !HEX_RE.test(highlight)) {
    return { ok: false, error: "高亮色须为 #RRGGBB 格式或空字符串" };
  }

  return {
    ok: true,
    config: {
      fontFamily,
      fontSize: c.fontSize,
      primaryColor,
      outlineColor,
      outlineWidth: c.outlineWidth,
      position: c.position,
      marginV: c.marginV,
      highlight,
    },
  };
}
