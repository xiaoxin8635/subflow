/**
 * @file 分片上传会话管理（local / oss 双驱动）
 * @description 会话元信息统一落盘 uploads/tmp/{uploadId}/meta.json（含驱动标记）。
 *              local 模式：分片暂存为 chunk_N，complete 时按序合并为 uploads/{videoKey}。
 *              oss   模式：init 时调 OSS InitiateMultipartUpload 拿 uploadId 并为每个
 *              分片签发直传 PUT URL（浏览器 → OSS，不经服务器带宽）；complete 时服务端
 *              ListParts 核对分片齐全与大小 → CompleteMultipartUpload 合并对象 →
 *              HeadObject 校验总大小 → Range 读文件头校验魔数 → 清理会话。
 *              断点续传：已到片按「local 文件存在且大小符合 / oss ListParts 存在且大小
 *              符合」判定，客户端查询后跳过重传；oss 预签名 URL 过期后由 status 接口重发。
 *              安全约束：uploadId 由服务端生成（UUID），index 必须为合法整数，
 *              会话绑定 userId，绝不将客户端输入直接拼进路径。
 */
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { MAX_UPLOAD_BYTES, UPLOAD_CHUNK_SIZE } from "@/lib/constants";
import { ensureUploadDir, generateVideoKey, localPathByKey, isOss } from "@/lib/storage";
import {
  ossAbortMultipart,
  ossCompleteMultipart,
  ossDelete,
  ossGetRange,
  ossHead,
  ossInitMultipart,
  ossListParts,
  presignPartPutUrl,
} from "@/lib/oss";

/** 上传目录（与 storage.ts 保持同一来源，可用 LOCAL_UPLOAD_DIR 覆盖） */
const LOCAL_UPLOAD_DIR = process.env.LOCAL_UPLOAD_DIR ?? "./uploads";

/** 会话元信息（落盘为 meta.json） */
interface UploadMeta {
  uploadId: string;
  /** 会话归属用户（防他人向会话写片/合并） */
  userId: string;
  fileName: string;
  contentType: string;
  /** 期望总字节数 */
  size: number;
  chunkSize: number;
  chunkCount: number;
  createdAt: number;
  /** 存储驱动标记（创建会话时的快照，complete 按此走对应合并逻辑） */
  driver: "local" | "oss";
  /** oss 模式：OSS Multipart Upload 会话 ID */
  ossUploadId?: string;
  /** oss 模式：目标对象 key（= 最终 videoKey） */
  objectKey?: string;
}

/** 会话有效期：创建后 24 小时未完成即视为孤儿，可被惰性清扫 */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** oss 直传分片 PUT URL 有效期（秒）：12 小时，续传时由 status 接口重发新签名 */
const PART_URL_TTL_SEC = 12 * 60 * 60;

/** 合法 uploadId 格式（服务端生成的 UUID），任何拼路径前必须校验 */
const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** tmp 目录绝对路径 */
function tmpRoot(): string {
  return path.join(/* turbopackIgnore: true */ process.cwd(), LOCAL_UPLOAD_DIR, "tmp");
}

/** 单个会话目录绝对路径（uploadId 必须已通过 UPLOAD_ID_RE 校验） */
function sessionDir(uploadId: string): string {
  return path.join(tmpRoot(), uploadId);
}

/** meta.json 绝对路径 */
function metaPath(uploadId: string): string {
  return path.join(sessionDir(uploadId), "meta.json");
}

/** 第 index 片的落盘路径（local 模式） */
function chunkPath(uploadId: string, index: number): string {
  return path.join(sessionDir(uploadId), `chunk_${index}`);
}

/** 第 index 片（0 起）的期望字节数 */
function expectedChunkSize(meta: UploadMeta, index: number): number {
  const isLast = index === meta.chunkCount - 1;
  return isLast ? meta.size - (meta.chunkCount - 1) * meta.chunkSize : meta.chunkSize;
}

/**
 * 校验 uploadId 是否为服务端生成的合法 UUID（防路径穿越）
 * @param id 客户端传入的会话 ID
 */
export function isValidUploadId(id: string): boolean {
  return UPLOAD_ID_RE.test(id);
}

/** 创建会话的返回体 */
export interface InitSessionResult {
  uploadId: string;
  chunkSize: number;
  chunkCount: number;
  /** 存储驱动标记（客户端据此决定分片上传目标） */
  mode: "local" | "oss";
  /** oss 模式：每个分片（0 起索引对应 partUrls[index]）的直传 PUT 签名 URL */
  partUrls?: string[];
}

/**
 * 创建上传会话
 * @param userId      会话归属用户
 * @param fileName    原始文件名（仅展示用）
 * @param contentType MIME（已由调用方白名单校验）
 * @param size        文件总字节数
 */
export async function initSession(
  userId: string,
  fileName: string,
  contentType: string,
  size: number,
): Promise<InitSessionResult> {
  if (!Number.isInteger(size) || size <= 0 || size > MAX_UPLOAD_BYTES) {
    throw new UploadSessionError(400, "文件大小不合法");
  }
  ensureUploadDir();
  fs.mkdirSync(tmpRoot(), { recursive: true });
  // 惰性清扫：每次 init 顺手清理过期孤儿会话
  sweepStaleSessions();

  const uploadId = crypto.randomUUID();
  const chunkSize = UPLOAD_CHUNK_SIZE;
  const chunkCount = Math.ceil(size / chunkSize);

  if (isOss()) {
    // oss 直传：ext 必须来自白名单 MIME（调用方已校验），objectKey 即最终 videoKey
    const ext = path.extname(fileName).toLowerCase() || ".mp4";
    const objectKey = generateVideoKey(ext);
    const ossUploadId = await ossInitMultipart(objectKey, contentType);
    fs.mkdirSync(sessionDir(uploadId), { recursive: true });
    const meta: UploadMeta = {
      uploadId, userId, fileName, contentType, size, chunkSize, chunkCount,
      createdAt: Date.now(), driver: "oss", ossUploadId, objectKey,
    };
    fs.writeFileSync(metaPath(uploadId), JSON.stringify(meta), "utf8");
    const partUrls = Array.from({ length: chunkCount }, (_, i) =>
      presignPartPutUrl(objectKey, ossUploadId, i + 1, PART_URL_TTL_SEC),
    );
    return { uploadId, chunkSize, chunkCount, mode: "oss", partUrls };
  }

  // local 模式：分片落盘暂存
  fs.mkdirSync(sessionDir(uploadId), { recursive: true });
  const meta: UploadMeta = {
    uploadId, userId, fileName, contentType, size, chunkSize, chunkCount,
    createdAt: Date.now(), driver: "local",
  };
  fs.writeFileSync(metaPath(uploadId), JSON.stringify(meta), "utf8");
  return { uploadId, chunkSize, chunkCount, mode: "local" };
}

/**
 * 读取会话元信息（含归属校验）
 * @param uploadId 会话 ID（须先过 isValidUploadId）
 * @param userId   当前用户
 * @throws UploadSessionError 404 会话不存在 / 403 非本人会话 / 410 会话过期
 */
export function getMeta(uploadId: string, userId: string): UploadMeta {
  let raw: string;
  try {
    raw = fs.readFileSync(metaPath(uploadId), "utf8");
  } catch {
    throw new UploadSessionError(404, "上传会话不存在或已过期，请重新上传");
  }
  const meta = JSON.parse(raw) as UploadMeta;
  if (meta.userId !== userId) throw new UploadSessionError(403, "无权操作该上传会话");
  if (Date.now() - meta.createdAt > SESSION_TTL_MS) {
    throw new UploadSessionError(410, "上传会话已过期，请重新上传");
  }
  return meta;
}

/**
 * 查询已到齐的分片索引（断点续传依据；0 起）
 * local：文件存在且大小符合预期；oss：ListParts 分片存在且大小符合预期
 * @param uploadId 会话 ID
 * @param meta     会话元信息
 */
export async function listReceivedChunks(uploadId: string, meta: UploadMeta): Promise<number[]> {
  const expectedOf = (i: number): number => expectedChunkSize(meta, i);

  if (meta.driver === "oss") {
    const parts = await ossListParts(meta.objectKey!, meta.ossUploadId!);
    const received: number[] = [];
    for (const p of parts) {
      const idx = p.partNumber - 1;
      if (idx >= 0 && idx < meta.chunkCount && p.size === expectedOf(idx)) received.push(idx);
    }
    return received;
  }

  const received: number[] = [];
  for (let i = 0; i < meta.chunkCount; i++) {
    try {
      if (fs.statSync(chunkPath(uploadId, i)).size === expectedOf(i)) received.push(i);
    } catch {
      // 分片不存在：跳过
    }
  }
  return received;
}

/**
 * 为 oss 会话重发分片直传 URL（续传时签名可能已过期）
 * @param meta 会话元信息
 */
export function refreshPartUrls(meta: UploadMeta): string[] {
  return Array.from({ length: meta.chunkCount }, (_, i) =>
    presignPartPutUrl(meta.objectKey!, meta.ossUploadId!, i + 1, PART_URL_TTL_SEC),
  );
}

/**
 * 写入单个分片（local 模式专用；覆盖写幂等，超限分片拒绝）
 * @param uploadId 会话 ID
 * @param meta     会话元信息
 * @param index    分片索引
 * @param body     分片二进制流
 * @returns 该片实际写入字节数
 */
export async function writeChunk(
  uploadId: string,
  meta: UploadMeta,
  index: number,
  body: WebReadableStream<Uint8Array>,
): Promise<number> {
  if (meta.driver === "oss") {
    throw new UploadSessionError(400, "该会话为 OSS 直传模式，请使用 init 返回的直传地址上传分片");
  }
  if (!Number.isInteger(index) || index < 0 || index >= meta.chunkCount) {
    throw new UploadSessionError(400, "分片索引不合法");
  }
  const expected = expectedChunkSize(meta, index);

  let written = 0;
  // 边收边写并计数：超出该片应有大小立即中断（防伪造超长分片）
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length;
      if (written > expected) {
        cb(new Error("CHUNK_TOO_LARGE"));
        return;
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(body),
      counter,
      fs.createWriteStream(chunkPath(uploadId, index)),
    );
  } catch (err) {
    await fs.promises.unlink(chunkPath(uploadId, index)).catch(() => {});
    if (err instanceof Error && err.message === "CHUNK_TOO_LARGE") {
      throw new UploadSessionError(400, "分片大小超出预期");
    }
    throw err;
  }
  return written;
}

/**
 * 校验媒体文件魔数（文件头签名），防止改后缀上传任意文件
 * @param head 文件前若干字节（至少 12 字节）
 * @returns 是否为白名单内的媒体格式：
 *          视频 mp4/mov/m4a：ftyp；mkv/webm：EBML 头；
 *          音频 mp3：ID3 标签或 MPEG frame sync（0xFF Ex）；wav：RIFF/WAVE
 */
export function isValidMediaMagic(head: Buffer): boolean {
  if (head.length < 12) return false;
  // mp4 / mov / m4a（ISO BMFF 家族）：偏移 4 起为 "ftyp"
  if (head.subarray(4, 8).toString("latin1") === "ftyp") return true;
  // mkv / webm：EBML 头 1A 45 DF A3
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return true;
  // mp3（带 ID3v2 标签）："ID3"
  if (head.subarray(0, 3).toString("latin1") === "ID3") return true;
  // mp3（裸 MPEG 音频帧）：frame sync 11111111 111xxxxx
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return true;
  // wav：RIFF 容器且偏移 8 起为 "WAVE"
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WAVE") {
    return true;
  }
  return false;
}

/**
 * 放弃 oss 会话的 Multipart Upload（complete 校验失败时调用，清理已传分片）
 * @param meta 会话元信息
 */
async function abortIfOss(meta: UploadMeta): Promise<void> {
  if (meta.driver === "oss" && meta.objectKey && meta.ossUploadId) {
    await ossAbortMultipart(meta.objectKey, meta.ossUploadId).catch(() => {});
  }
}

/**
 * 校验分片齐全 → 合并/提交为正式视频对象 → 清理会话
 * local：按序合并文件 + 总大小/魔数复查；oss：ListParts 核对 → Complete →
 * HeadObject 总大小复查 → Range 读文件头魔数复查。
 * @param uploadId 会话 ID
 * @param meta     会话元信息
 * @returns 合并后的 videoKey（调用方接着建项目行并启动流水线）
 */
export async function completeAndMerge(uploadId: string, meta: UploadMeta): Promise<string> {
  if (meta.driver === "oss") return completeOss(uploadId, meta);
  return completeLocal(uploadId, meta);
}

/**
 * oss 模式完成：核对分片 → CompleteMultipartUpload → 大小/魔数复查
 * @param uploadId 会话 ID
 * @param meta     会话元信息
 */
async function completeOss(uploadId: string, meta: UploadMeta): Promise<string> {
  const objectKey = meta.objectKey!;
  const received = await listReceivedChunks(uploadId, meta);
  const missing = meta.chunkCount - received.length;
  if (missing > 0) {
    throw new UploadSessionError(409, `还有 ${missing} 个分片未上传完成`);
  }

  const parts = await ossListParts(objectKey, meta.ossUploadId!);
  await ossCompleteMultipart(objectKey, meta.ossUploadId!, parts);

  // 总大小复查：合并结果必须等于 init 时声明的 size
  const { size: merged } = await ossHead(objectKey);
  if (merged !== meta.size) {
    await ossDelete(objectKey).catch(() => {});
    await cleanupSession(uploadId);
    throw new UploadSessionError(400, `合并后大小不符（期望 ${meta.size}，实际 ${merged}），请重新上传`);
  }

  // 魔数复查：整体内容必须确实是白名单媒体格式
  const head = await ossGetRange(objectKey, 0, 15);
  if (!isValidMediaMagic(head)) {
    await ossDelete(objectKey).catch(() => {});
    await cleanupSession(uploadId);
    throw new UploadSessionError(415, "文件内容不是有效的视频/音频格式");
  }

  await cleanupSession(uploadId);
  return objectKey;
}

/**
 * 清理本地会话目录
 * @param uploadId 会话 ID
 */
async function cleanupSession(uploadId: string): Promise<void> {
  await fs.promises.rm(sessionDir(uploadId), { recursive: true, force: true }).catch(() => {});
}

/**
 * local 模式完成：校验分片齐全 → 按序合并 → 大小/魔数复查 → 清理暂存目录
 * @param uploadId 会话 ID
 * @param meta     会话元信息
 */
async function completeLocal(uploadId: string, meta: UploadMeta): Promise<string> {
  const received = new Set(await listReceivedChunks(uploadId, meta));
  const missing = meta.chunkCount - received.size;
  if (missing > 0) {
    throw new UploadSessionError(409, `还有 ${missing} 个分片未上传完成`);
  }

  ensureUploadDir();
  const ext = path.extname(meta.fileName).toLowerCase() || ".mp4";
  const videoKey = generateVideoKey(ext);
  const destPath = localPathByKey(videoKey);

  // 按序追加合并（预分配空间减少碎片）
  const out = fs.openSync(destPath, "w");
  try {
    for (let i = 0; i < meta.chunkCount; i++) {
      const buf = fs.readFileSync(chunkPath(uploadId, i));
      fs.writeSync(out, buf);
    }
  } finally {
    fs.closeSync(out);
  }

  // 总大小复查：合并结果必须等于 init 时声明的 size
  const merged = fs.statSync(destPath).size;
  if (merged !== meta.size) {
    await fs.promises.unlink(destPath).catch(() => {});
    await cleanupSession(uploadId);
    throw new UploadSessionError(400, `合并后大小不符（期望 ${meta.size}，实际 ${merged}），请重新上传`);
  }

  // 魔数复查：整体内容必须确实是白名单媒体格式（分片可被逐片伪造，合并后统一校验文件头）
  const head = Buffer.alloc(12);
  const fd = fs.openSync(destPath, "r");
  try {
    fs.readSync(fd, head, 0, 12, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (!isValidMediaMagic(head)) {
    await fs.promises.unlink(destPath).catch(() => {});
    await cleanupSession(uploadId);
    throw new UploadSessionError(415, "文件内容不是有效的视频/音频格式");
  }

  await cleanupSession(uploadId);
  return videoKey;
}

/**
 * 惰性清扫：删除创建超过 TTL 且未完成的会话目录
 * oss 会话同时放弃 OSS Multipart Upload（异步 fire-and-forget，不阻塞 init）
 */
function sweepStaleSessions(): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(tmpRoot());
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!UPLOAD_ID_RE.test(name)) continue;
    const dir = path.join(tmpRoot(), name);
    try {
      const metaRaw = fs.readFileSync(path.join(dir, "meta.json"), "utf8");
      const meta = JSON.parse(metaRaw) as UploadMeta;
      if (now - meta.createdAt > SESSION_TTL_MS) {
        fs.rmSync(dir, { recursive: true, force: true });
        void abortIfOss(meta);
      }
    } catch {
      // meta 缺失或损坏：按创建时间兜底清理
      try {
        const st = fs.statSync(dir);
        if (now - st.ctimeMs > SESSION_TTL_MS) fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 目录已消失：忽略
      }
    }
  }
}

/** 上传会话业务错误（携带 HTTP 状态码，路由层直接转响应） */
export class UploadSessionError extends Error {
  /** HTTP 状态码 */
  readonly status: number;

  /**
   * @param status HTTP 状态码
   * @param message 错误信息
   */
  constructor(status: number, message: string) {
    super(message);
    this.name = "UploadSessionError";
    this.status = status;
  }
}
