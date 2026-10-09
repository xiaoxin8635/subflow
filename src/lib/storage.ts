/**
 * @file 视频文件存储模块（本地磁盘实现）
 * @description MVP 阶段视频落盘到 LOCAL_UPLOAD_DIR（默认 ./uploads，gitignore）。
 *              生产环境切换 OSS 时，仅需替换本模块的「写入/读取/删除/公网 URL」实现，
 *              上层（上传 API / 流水线 / ASR provider）不感知存储介质。
 */
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

/** 上传目录（相对项目根，可用 LOCAL_UPLOAD_DIR 覆盖） */
const LOCAL_UPLOAD_DIR = process.env.LOCAL_UPLOAD_DIR ?? "./uploads";

/**
 * 由存储 key 解析磁盘绝对路径
 * @param videoKey 上传时生成的存储 key（如 ab12cd.mp4）
 */
export function localVideoPath(videoKey: string): string {
  return path.join(process.cwd(), LOCAL_UPLOAD_DIR, videoKey);
}

/** 确保上传目录存在（首次上传前调用） */
export function ensureUploadDir(): void {
  fs.mkdirSync(path.join(process.cwd(), LOCAL_UPLOAD_DIR), { recursive: true });
}

/**
 * 生成安全的存储 key（服务端生成，绝不信任客户端文件名）
 * @param ext 扩展名（含点，如 ".mp4"），必须来自白名单校验结果
 */
export function generateVideoKey(ext: string): string {
  return `${crypto.randomUUID()}${ext}`;
}

/**
 * 删除本地视频文件（存在才删，不存在静默通过）
 * @param videoKey 存储 key
 */
export async function deleteLocalVideo(videoKey: string): Promise<void> {
  await fs.promises.unlink(localVideoPath(videoKey)).catch(() => {});
}

/**
 * 由存储 key 解析公网可访问 URL（供 qwen-filetrans 拉取音频）
 * 生产环境必须配置 PUBLIC_ASSET_BASE_URL（公网域名或 OSS 外链地址）；
 * 本地开发该地址不可达，因此本地只能使用 qwen-sync provider。
 */
export function publicUrlFor(videoKey: string): string {
  const base = process.env.PUBLIC_ASSET_BASE_URL;
  if (!base) {
    throw new Error("未配置 PUBLIC_ASSET_BASE_URL，无法生成文件公网地址（qwen-filetrans 需要）");
  }
  return `${base.replace(/\/+$/, "")}/${videoKey}`;
}
