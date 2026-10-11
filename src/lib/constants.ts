/**
 * @file 业务常量定义
 * @description 全站共享的常量：注册赠送额度、上传限制、套餐与样式的默认配置等。
 *              修改这些值会影响 API 校验与前端展示，需保持两端一致。
 */

/** 注册赠送的转写额度（秒），默认 1800 秒 = 30 分钟，可用环境变量覆盖 */
export const SIGNUP_BONUS_SECONDS = Number(process.env.SIGNUP_BONUS_SECONDS ?? 1800);

/** 单个视频文件上传大小上限（字节），默认 500MB */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

/** 分片上传的每片大小（字节），默认 5MB（最后一片可小于此值） */
export const UPLOAD_CHUNK_SIZE = 5 * 1024 * 1024;

/** 单个视频时长上限（秒），默认 30 分钟 */
export const MAX_VIDEO_DURATION_SEC = 30 * 60;

/** 支持的视频格式（MIME 白名单） */
export const ALLOWED_VIDEO_TYPES = [
  "video/mp4",
  "video/quicktime", // .mov
  "video/x-matroska", // .mkv
  "video/webm",
] as const;

/** 支持的纯音频格式（MIME 白名单，P2.1 音频直传：播客/课程转字幕） */
export const ALLOWED_AUDIO_TYPES = [
  "audio/mpeg", // .mp3（Chrome/Edge/Firefox）
  "audio/mp3", // .mp3（部分环境）
  "audio/mp4", // .m4a（Chrome/Edge：AAC 封装于 ISO BMFF）
  "audio/x-m4a", // .m4a（Safari/部分环境）
  "audio/wav", // .wav
  "audio/x-wav", // .wav（部分环境）
] as const;

/** 媒体类型（决定导出形态：video 可烧录成片，audio 仅字幕文件下载） */
export type MediaKind = "video" | "audio";

/**
 * 由 MIME 判定媒体类型（上传白名单的唯一判定入口）
 * @param contentType 客户端声明的 MIME
 * @returns video / audio；不在白名单时返回 null
 */
export function mediaKindOf(contentType: string): MediaKind | null {
  if ((ALLOWED_VIDEO_TYPES as readonly string[]).includes(contentType)) return "video";
  if ((ALLOWED_AUDIO_TYPES as readonly string[]).includes(contentType)) return "audio";
  return null;
}

/**
 * 清洗处理模式参数（前后端共用）：白名单外（含缺省/非法值）一律回退 asr。
 * 音频项目的强制 asr 由各上传入口在判定 mediaKind 后自行处理。
 * @param value 客户端传入的处理模式（header / JSON 字段）
 */
export function normalizeProcessMode(value: unknown): "asr" | "ocr" {
  return value === "ocr" ? "ocr" : "asr";
}

// ---------------------------------------------------------------------
// 语音识别设置（P2.11 场景自适应识别）：场景预设 / 主语言 / 自定义热词。
// 场景与热词在两处生效——ASR 语境增强（filetrans 走 parameters.corpus，
// 同步模式不支持语境输入）与 AI 润色纠错 prompt；语言透传 DashScope
// asr_options.language。
// ---------------------------------------------------------------------

/** 识别场景预设：context 为注入 ASR/润色的场景描述文本（空串 = 无附加描述） */
export const ASR_SCENES = [
  {
    code: "general",
    label: "通用",
    hint: "日常口播 / vlog / 访谈",
    context: "",
  },
  {
    code: "tech",
    label: "技术讲解",
    hint: "编程 / 软件教程，专有名词多",
    context:
      "这是一段编程与技术讲解视频，内容涉及软件开发、API、框架、模型等专业术语，英文术语请按原貌识别。",
  },
  {
    code: "live",
    label: "直播带货",
    hint: "商品讲解 / 价格口播",
    context:
      "这是一段电商直播带货录音，内容涉及商品名称、品牌与促销话术，数字与商品名请准确识别。",
  },
  {
    code: "course",
    label: "课堂讲课",
    hint: "知识讲授 / 课程录屏",
    context: "这是一段课堂教学录音，内容为系统性的知识讲授，术语密度较高。",
  },
] as const;

/** 场景代码类型 */
export type AsrSceneCode = (typeof ASR_SCENES)[number]["code"];

/**
 * 清洗场景参数：白名单外（含缺省/非法值）回退 general
 * @param value 客户端传入的场景代码
 */
export function normalizeScene(value: unknown): AsrSceneCode {
  return ASR_SCENES.some((s) => s.code === value) ? (value as AsrSceneCode) : "general";
}

/**
 * 按代码查询场景预设定义
 * @param code 场景代码
 * @returns 场景定义（未命中返回通用）
 */
export function asrSceneOf(code: string): (typeof ASR_SCENES)[number] {
  return ASR_SCENES.find((s) => s.code === code) ?? ASR_SCENES[0];
}

/** 识别主语言（code 透传 DashScope；auto = 自动检测，不传语言参数） */
export const ASR_LANGUAGES = [
  { code: "zh", label: "中文（普通话）" },
  { code: "yue", label: "粤语" },
  { code: "en", label: "英语" },
  { code: "ja", label: "日语" },
  { code: "ko", label: "韩语" },
  { code: "auto", label: "自动检测" },
] as const;

/**
 * 清洗识别主语言参数：白名单外回退 zh
 * @param value 客户端传入的语言代码
 */
export function normalizeAsrLanguage(value: unknown): string {
  return ASR_LANGUAGES.some((l) => l.code === value) ? (value as string) : "zh";
}

/** 热词数量上限（DashScope context 长度有限，防超长输入） */
export const HOTWORDS_MAX_COUNT = 50;

/** 单个热词字符上限 */
export const HOTWORD_MAX_LEN = 30;

/**
 * 清洗热词输入：按逗号/顿号/分号/换行拆分，去空去重、限长限量
 * @param value 客户端传入的热词原始串
 * @returns 干净的热词数组（保持输入顺序）
 */
export function parseHotwords(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const words = value
    .split(/[,，、;；\n]/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0 && w.length <= HOTWORD_MAX_LEN);
  return Array.from(new Set(words)).slice(0, HOTWORDS_MAX_COUNT);
}

/**
 * 组装 ASR 语境增强文本（场景描述 + 热词表），注入 qwen-filetrans 的
 * parameters.corpus（同步模式 qwen-sync 实测拒绝语境输入，其场景/热词
 * 由润色纠错 prompt 承担）；两者皆空时返回 undefined（不注入）
 * @param scene    场景代码（normalize 后）
 * @param hotwords 清洗后的热词数组
 */
export function buildAsrContext(scene: string, hotwords: string[]): string | undefined {
  const parts: string[] = [];
  const sceneContext = asrSceneOf(scene).context;
  if (sceneContext) parts.push(sceneContext);
  if (hotwords.length > 0) parts.push(`音视频中可能出现以下专有名词，请准确识别：${hotwords.join("、")}`);
  return parts.length > 0 ? parts.join("。") : undefined;
}

/** 大陆手机号格式（前后端共用同一正则，保证校验一致） */
export const PHONE_RE = /^1[3-9]\d{9}$/;

/** API 路由（前后端共用，避免硬编码路径漂移） */
export const API_ROUTES = {
  sendSms: "/api/auth/sms",
  login: "/api/auth/login",
  logout: "/api/auth/logout",
  me: "/api/me",
  projects: "/api/projects",
} as const;

/** 由项目 ID 拼接详情路由 */
export const projectApi = (id: string): string => `/api/projects/${id}`;

/**
 * 字幕翻译支持的目标语言（P2.4）：code 为 LLM 提示词与 API 参数用的语言代码，
 * label 为界面展示名；顺序即语言下拉框顺序
 */
export const TRANSLATE_LANGUAGES = [
  { code: "en", label: "英语" },
  { code: "ja", label: "日语" },
  { code: "ko", label: "韩语" },
  { code: "es", label: "西班牙语" },
  { code: "pt", label: "葡萄牙语" },
  { code: "zh-TW", label: "繁体中文" },
] as const;

/** 翻译目标语言代码类型（供 API 白名单校验与前端类型约束共用） */
export type TranslateLangCode = (typeof TRANSLATE_LANGUAGES)[number]["code"];

/**
 * 按 charCount 查询语言白名单中的展示名
 * @param code 语言代码
 * @returns 展示名（未命中返回 null）
 */
export function translateLangLabel(code: string): string | null {
  return TRANSLATE_LANGUAGES.find((l) => l.code === code)?.label ?? null;
}

/**
 * 翻译计费（P2.4 付费点）：每 1000 源字符计 60 秒额度，最低按 60 秒起收
 * （与一次最短转写同价，保证小额消费也有计费意义）
 * @param charCount 源字幕总字符数（不含时间轴）
 * @returns 应扣减的额度（秒），向上取整
 */
export function translateCostSeconds(charCount: number): number {
  return Math.max(60, Math.ceil((charCount / 1000) * 60));
}

/** 翻译任务限流：每用户每小时最多发起次数（防 LLM 成本被刷） */
export const TRANSLATE_RATE_LIMIT_PER_HOUR = 10;

// ---------------------------------------------------------------------
// 翻译风格（P2.11 翻译风格控制）：instruction 注入翻译 system prompt；
// 项目热词自动作为术语表注入（品牌名/产品名全片译法统一）
// ---------------------------------------------------------------------

/** 翻译风格预设 */
export const TRANSLATE_STYLES = [
  {
    code: "general",
    label: "通用",
    instruction: "译文自然流畅，符合目标语言的表达习惯。",
  },
  {
    code: "colloquial",
    label: "口语化",
    instruction: "译文口语化、有网感，像视频博主的说话方式，可适度使用目标语言的流行表达。",
  },
  {
    code: "concise",
    label: "短视频精简",
    instruction:
      "译文尽量简短精炼，适合短视频字幕快速阅读：优先短句，省略不影响语义的虚词与客套表达。",
  },
] as const;

/** 翻译风格代码类型 */
export type TranslateStyleCode = (typeof TRANSLATE_STYLES)[number]["code"];

/**
 * 清洗翻译风格参数：白名单外（含缺省/非法值）回退 general
 * @param value 客户端传入的风格代码
 */
export function normalizeTranslateStyle(value: unknown): TranslateStyleCode {
  return TRANSLATE_STYLES.some((s) => s.code === value) ? (value as TranslateStyleCode) : "general";
}

/**
 * 按代码查询翻译风格定义
 * @param code 风格代码
 * @returns 风格定义（未命中返回通用）
 */
export function translateStyleOf(code: string): (typeof TRANSLATE_STYLES)[number] {
  return TRANSLATE_STYLES.find((s) => s.code === code) ?? TRANSLATE_STYLES[0];
}

/**
 * 片段导出计费（P2.6 付费点）：按片段时长 1:1 计费（向上取整，最低 1 秒）
 * 无起收价——FFmpeg 裁剪是本地计算，边际成本即片段时长本身；
 * 整片导出（ceil(durationSec)）等价于 start=0、end=时长 的特例，语义一致
 * @param startSec 片段开始（秒）
 * @param endSec   片段结束（秒，须大于 startSec）
 * @returns 应扣减的额度（秒）
 */
export function clipCostSeconds(startSec: number, endSec: number): number {
  return Math.max(1, Math.ceil(endSec - startSec));
}

/** 邀请奖励（P2.5 邀请裂变）：邀请人每邀 1 名新用户获得的额度（秒），可用环境变量覆盖 */
export const INVITE_REWARD_INVITER_SECONDS = Number(process.env.INVITE_REWARD_INVITER_SECONDS ?? 600);

/** 邀请奖励：被邀请的新用户注册时额外获得的额度（秒，叠加在注册赠送之上） */
export const INVITE_REWARD_INVITEE_SECONDS = Number(process.env.INVITE_REWARD_INVITEE_SECONDS ?? 600);

/** 邀请码字符集：去掉易混淆的 0/O/1/I（32 个字符，8 位码空间约 1.1 万亿） */
export const INVITE_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** 邀请码长度 */
export const INVITE_CODE_LENGTH = 8;

/** 邀请码格式校验（前后端共用：仅字符集内的大写字母数字，8 位） */
export const INVITE_CODE_RE = /^[2-9A-HJ-NP-Z]{8}$/;

/**
 * 加油包档位（P2.8 商业化）：非订阅的一次性时长包——激活码收款模式下，
 * 购买页展示档位、客服按档发码（bonusSeconds = seconds 的时长码）、
 * 用户兑换到账（REDEEM_BONUS 流水）。改档位只动这里，购买页与后台同源。
 * 单价随包体递减（0.165 → 0.15 → 0.125 元/分钟），激励买大包。
 */
export const ADDON_PACKAGES = [
  { id: "starter", name: "体验加油包", priceCents: 990, seconds: 3600 },
  { id: "standard", name: "标准加油包", priceCents: 2990, seconds: 12000 },
  { id: "pro", name: "大容量加油包", priceCents: 4990, seconds: 24000 },
] as const;

/** 加油包档位类型 */
export type AddonPackage = (typeof ADDON_PACKAGES)[number];

/**
 * 按 ID 查询加油包档位
 * @param id 档位 ID
 * @returns 档位对象（未命中返回 null）
 */
export function findAddonPackage(id: string): AddonPackage | null {
  return ADDON_PACKAGES.find((p) => p.id === id) ?? null;
}
