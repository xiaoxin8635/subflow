/**
 * @file 分片上传会话管理（本地磁盘实现）
 * @description 分片暂存于 uploads/tmp/{uploadId}/（meta.json + chunk_N），
 *              complete 时按序合并为正式视频文件（uploads/{videoKey}）并清理暂存目录。
 *              支持断点续传：已到片按「文件存在且大小符合预期」判定，客户端可查询后跳过重传。
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
import { ensureUploadDir, generateVideoKey } from "@/lib/storage";

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
}

/** 会话有效期：创建后 24 小时未完成即视为孤儿，可被惰性清扫 */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

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

/** 第 index 片的落盘路径 */
function chunkPath(uploadId: string, index: number): string {
  return path.join(sessionDir(uploadId), `chunk_${index}`);
}

/**
 * 校验 uploadId 是否为服务端生成的合法 UUID（防路径穿越）
 * @param id 客户端传入的会话 ID
 */
export function isValidUploadId(id: string): boolean {
  return UPLOAD_ID_RE.test(id);
}

/**
 * 创建上传会话
 * @param userId      会话归属用户
 * @param fileName    原始文件名（仅展示用）
 * @param contentType MIME（已由调用方白名单校验）
 * @param size        文件总字节数
 * @returns uploadId、每片大小、总片数
 */
export function initSession(
  userId: string,
  fileName: string,
  contentType: string,
  size: number,
): { uploadId: string; chunkSize: number; chunkCount: number } {
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
  fs.mkdirSync(sessionDir(uploadId), { recursive: true });
  const meta: UploadMeta = {
    uploadId,
    userId,
    fileName,
    contentType,
    size,
    chunkSize,
    chunkCount,
    createdAt: Date.now(),
  };
  fs.writeFileSync(metaPath(uploadId), JSON.stringify(meta), "utf8");
  return { uploadId, chunkSize, chunkCount };
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
 * 查询已到齐的分片索引（断点续传依据）
 * 判定标准：文件存在且大小符合预期（最后一片 = size % chunkSize 或 chunkSize）
 * @param uploadId 会话 ID
 * @param meta     会话元信息
 */
export function listReceivedChunks(uploadId: string, meta: UploadMeta): number[] {
  const received: number[] = [];
  for (let i = 0; i < meta.chunkCount; i++) {
    const expected = i === meta.chunkCount - 1 ? meta.size - (meta.chunkCount - 1) * meta.chunkSize : meta.chunkSize;
    try {
      if (fs.statSync(chunkPath(uploadId, i)).size === expected) received.push(i);
    } catch {
      // 分片不存在：跳过
    }
  }
  return received;
}

/**
 * 写入单个分片（覆盖写，天然幂等；超限分片拒绝）
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
  if (!Number.isInteger(index) || index < 0 || index >= meta.chunkCount) {
    throw new UploadSessionError(400, "分片索引不合法");
  }
  const isLast = index === meta.chunkCount - 1;
  const expected = isLast ? meta.size - (meta.chunkCount - 1) * meta.chunkSize : meta.chunkSize;

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
 * 校验视频文件魔数（文件头签名），防止改后缀上传任意文件
 * @param head 文件前若干字节（至少 12 字节）
 * @returns 是否为白名单内的视频格式（mp4/mov：ftyp；mkv/webm：EBML 头）
 */
export function isValidVideoMagic(head: Buffer): boolean {
  if (head.length < 12) return false;
  // mp4 / mov：偏移 4 起为 "ftyp"
  if (head.subarray(4, 8).toString("latin1") === "ftyp") return true;
  // mkv / webm：EBML 头 1A 45 DF A3
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return true;
  return false;
}

/**
 * 校验分片齐全 → 按序合并为正式视频文件 → 清理暂存目录
 * @param uploadId 会话 ID
 * @param meta     会话元信息
 * @returns 合并后的 videoKey（调用方接着建项目行并启动流水线）
 */
export async function completeAndMerge(uploadId: string, meta: UploadMeta): Promise<string> {
  const received = new Set(listReceivedChunks(uploadId, meta));
  const missing = meta.chunkCount - received.size;
  if (missing > 0) {
    throw new UploadSessionError(409, `还有 ${missing} 个分片未上传完成`);
  }

  ensureUploadDir();
  const ext = path.extname(meta.fileName).toLowerCase() || ".mp4";
  const videoKey = generateVideoKey(ext);
  const destPath = path.join(/* turbopackIgnore: true */ process.cwd(), LOCAL_UPLOAD_DIR, videoKey);

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
    fs.rmSync(sessionDir(uploadId), { recursive: true, force: true });
    throw new UploadSessionError(400, `合并后大小不符（期望 ${meta.size}，实际 ${merged}），请重新上传`);
  }

  // 魔数复查：整体内容必须确实是白名单视频格式（分片可被逐片伪造，合并后统一校验文件头）
  const head = Buffer.alloc(12);
  const fd = fs.openSync(destPath, "r");
  try {
    fs.readSync(fd, head, 0, 12, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (!isValidVideoMagic(head)) {
    await fs.promises.unlink(destPath).catch(() => {});
    fs.rmSync(sessionDir(uploadId), { recursive: true, force: true });
    throw new UploadSessionError(415, "文件内容不是有效的视频格式");
  }

  // 合并成功，清理暂存目录
  fs.rmSync(sessionDir(uploadId), { recursive: true, force: true });
  return videoKey;
}

/**
 * 惰性清扫：删除创建超过 TTL 且未完成的会话目录
 * （init 时调用；全量扫描目录开销可接受——孤儿会话量级很小）
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
