/**
 * @file 视频文件存储抽象（local / oss 双驱动）
 * @description STORAGE_DRIVER=local：视频落盘 LOCAL_UPLOAD_DIR（默认 ./uploads，gitignore）。
 *              STORAGE_DRIVER=oss：视频存阿里云 OSS（浏览器分片直传），worker 处理前经
 *              ensureLocalVideo 拉取到本地缓存，成片经 ossUploadFile 传回 OSS。
 *              上层（上传 API / 流水线 / ASR provider）只依赖本模块的统一接口，
 *              不感知存储介质。对象 key 语义：
 *                - local 模式源视频 key = {uuid}{ext}（历史数据兼容，无目录前缀）
 *                - oss   模式源视频 key = videos/{uuid}{ext}；成片 key 两种模式一致 = exports/{taskId}.mp4
 */
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { ossDelete, ossDownloadToFile, presignGetUrl } from "@/lib/oss";

/** 上传目录（相对项目根，可用 LOCAL_UPLOAD_DIR 覆盖） */
const LOCAL_UPLOAD_DIR = process.env.LOCAL_UPLOAD_DIR ?? "./uploads";

/** 当前存储驱动："local" 本地磁盘 | "oss" 阿里云对象存储 */
export const STORAGE_DRIVER: "local" | "oss" = process.env.STORAGE_DRIVER === "oss" ? "oss" : "local";

/** 是否 OSS 驱动 */
export function isOss(): boolean {
  return STORAGE_DRIVER === "oss";
}

/**
 * 由存储 key 解析本地磁盘绝对路径（local 模式源视频；oss 模式的临时/缓存文件也复用该根目录）
 * @param key 存储 key（可含子目录，如 exports/{taskId}.mp4）
 */
export function localPathByKey(key: string): string {
  // turbopackIgnore：运行时按环境变量读上传目录是有意行为，阻止打包器全项目追踪
  return path.join(/* turbopackIgnore: true */ process.cwd(), LOCAL_UPLOAD_DIR, key);
}

/**
 * 由存储 key 解析源视频本地路径（local 模式专用；oss 模式请用 ensureLocalVideo）
 * @param videoKey 上传时生成的存储 key（如 ab12cd.mp4）
 */
export function localVideoPath(videoKey: string): string {
  return localPathByKey(videoKey);
}

/**
 * 由导出产物 key 解析本地磁盘绝对路径（下载/删除接口使用）
 * @param outputKey 导出产物 key（exports/{taskId}.mp4）
 */
export function exportAbsPath(outputKey: string): string {
  return localPathByKey(outputKey);
}

/** 确保上传目录存在（local 模式首次上传前调用） */
export function ensureUploadDir(): void {
  fs.mkdirSync(path.join(/* turbopackIgnore: true */ process.cwd(), LOCAL_UPLOAD_DIR), { recursive: true });
}

/**
 * 生成安全的存储 key（服务端生成，绝不信任客户端文件名）
 * oss 模式带 videos/ 目录前缀与 local 模式历史数据隔离
 * @param ext 扩展名（含点，如 ".mp4"），必须来自白名单校验结果
 */
export function generateVideoKey(ext: string): string {
  const uuid = `${crypto.randomUUID()}${ext}`;
  return isOss() ? `videos/${uuid}` : uuid;
}

/**
 * 确保 FFmpeg 可用的视频本地路径：
 *   local 模式 → 直接返回磁盘路径；
 *   oss   模式 → 下载到 uploads/cache/（同 key 副本存在且大小一致时跳过），返回缓存路径。
 * 仅在 worker/服务端进程调用（需要文件系统）。
 * @param videoKey 存储 key
 */
export async function ensureLocalVideo(videoKey: string): Promise<string> {
  if (!isOss()) return localVideoPath(videoKey);
  const cachePath = path.join(
    /* turbopackIgnore: true */ process.cwd(),
    LOCAL_UPLOAD_DIR,
    "cache",
    path.basename(videoKey),
  );
  await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
  await ossDownloadToFile(videoKey, cachePath);
  return cachePath;
}

/**
 * 删除源视频（当前驱动；不存在静默通过）
 * @param videoKey 存储 key
 */
export async function removeVideo(videoKey: string): Promise<void> {
  if (isOss()) {
    await ossDelete(videoKey).catch(() => {});
    return;
  }
  await fs.promises.unlink(localVideoPath(videoKey)).catch(() => {});
}

/**
 * 清理 oss 模式下拉取的源视频本地缓存副本（local 模式为空操作——源文件即本地文件）
 * @param videoKey 存储 key
 */
export async function removeLocalVideoCache(videoKey: string): Promise<void> {
  if (!isOss()) return;
  const cachePath = path.join(
    /* turbopackIgnore: true */ process.cwd(),
    LOCAL_UPLOAD_DIR,
    "cache",
    path.basename(videoKey),
  );
  await fs.promises.unlink(cachePath).catch(() => {});
}

/**
 * 删除导出成片产物（当前驱动；不存在静默通过）
 * @param outputKey 导出产物 key（exports/{taskId}.mp4）
 */
export async function removeExportArtifact(outputKey: string): Promise<void> {
  if (isOss()) {
    await ossDelete(outputKey).catch(() => {});
    return;
  }
  await fs.promises.unlink(exportAbsPath(outputKey)).catch(() => {});
}

/**
 * 由存储 key 解析公网可访问 URL（供 qwen-filetrans 拉取音频/视频）
 *   oss   模式 → 服务端签发的私有桶 GET 签名 URL（12 小时有效，覆盖排队+识别时长）；
 *   local 模式 → 拼接 PUBLIC_ASSET_BASE_URL（生产必须配置；本地开发不可达，
 *                故本地只能使用 qwen-sync provider）。
 * @param videoKey 存储 key
 */
export function publicUrlFor(videoKey: string): string {
  if (isOss()) {
    return presignGetUrl(videoKey, 12 * 60 * 60);
  }
  const base = process.env.PUBLIC_ASSET_BASE_URL;
  if (!base) {
    throw new Error("未配置 PUBLIC_ASSET_BASE_URL，无法生成文件公网地址（qwen-filetrans 需要）");
  }
  return `${base.replace(/\/+$/, "")}/${videoKey}`;
}
