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
