/**
 * @file 业务常量定义
 * @description 全站共享的常量：注册赠送额度、上传限制、套餐与样式的默认配置等。
 *              修改这些值会影响 API 校验与前端展示，需保持两端一致。
 */

/** 注册赠送的转写额度（秒），默认 1800 秒 = 30 分钟，可用环境变量覆盖 */
export const SIGNUP_BONUS_SECONDS = Number(process.env.SIGNUP_BONUS_SECONDS ?? 1800);

/** 单个视频文件上传大小上限（字节），默认 500MB */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

/** 单个视频时长上限（秒），默认 30 分钟 */
export const MAX_VIDEO_DURATION_SEC = 30 * 60;

/** 支持的视频格式（MIME 白名单） */
export const ALLOWED_VIDEO_TYPES = [
  "video/mp4",
  "video/quicktime", // .mov
  "video/x-matroska", // .mkv
  "video/webm",
] as const;

/** 大陆手机号格式（前后端共用同一正则，保证校验一致） */
export const PHONE_RE = /^1[3-9]\d{9}$/;

/** 上传 API 路由 */
export const API_ROUTES = {
  sendSms: "/api/auth/sms",
  login: "/api/auth/login",
  logout: "/api/auth/logout",
  me: "/api/me",
  upload: "/api/projects/upload",
} as const;
