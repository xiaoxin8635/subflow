/**
 * @file /api/projects — 项目集合接口
 * @description
 *   POST：新建项目（视频整传上传）。客户端以「原始文件二进制」作为请求体流式上传，
 *         元数据放请求头（Content-Type=视频 MIME，X-File-Name=URI 编码的原始文件名），
 *         避免 multipart 将 500MB 文件整体缓冲进内存。边收边写磁盘，超限即中断并清理。
 *         注意：STORAGE_DRIVER=oss 时本端点禁用（视频应走浏览器直传的分片会话接口）。
 *   GET：当前用户的项目列表（按更新时间倒序，最多 100 条）。
 */
import { NextResponse } from "next/server";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import fs from "node:fs";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { MAX_UPLOAD_BYTES, mediaKindOf, normalizeProcessMode } from "@/lib/constants";
import { ensureUploadDir, generateVideoKey, localVideoPath, isOss } from "@/lib/storage";
import { startProcessing } from "@/lib/pipeline";
import { rateLimit } from "@/lib/rate-limit";
import { isValidMediaMagic } from "@/lib/upload-session";

/** 每用户新建项目频率上限（个/小时），防刷上传占磁盘与 ASR 费用 */
const UPLOAD_HOURLY_LIMIT = 10;

/** MIME → 扩展名映射（白名单内，视频 + 纯音频） */
const EXT_BY_TYPE: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
};

/** 限流 Transform：累计字节数超上限抛 FILE_TOO_LARGE；首块顺带校验文件魔数 */
class SizeLimitStream extends Transform {
  private written = 0;
  private checkedMagic = false;

  /** 流式转换：魔数 + 大小校验，原样透传 */
  _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (err: Error | null, data?: Buffer) => void,
  ): void {
    // 首块校验魔数：非白名单媒体内容立即中断（防改后缀上传任意文件）
    if (!this.checkedMagic) {
      this.checkedMagic = true;
      if (!isValidMediaMagic(chunk)) {
        callback(new Error("NOT_MEDIA"));
        return;
      }
    }
    this.written += chunk.length;
    if (this.written > MAX_UPLOAD_BYTES) {
      callback(new Error("FILE_TOO_LARGE"));
      return;
    }
    callback(null, chunk);
  }
}

/**
 * 新建项目并流式接收视频文件
 * @param request 请求（body 为原始视频二进制）
 */
export async function POST(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  // 限流：每用户每小时最多 10 个新项目
  const rl = await rateLimit(request, "upload", user.id, UPLOAD_HOURLY_LIMIT, 60 * 60 * 1000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: `上传过于频繁，每小时最多 ${UPLOAD_HOURLY_LIMIT} 个视频，请 ${Math.ceil(rl.retryAfterSec / 60)} 分钟后再试` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  // 余额预检：额度耗尽的用户不允许新建（提示先兑换额度）
  if (user.balanceSeconds <= 0) {
    return NextResponse.json({ error: "剩余额度不足，请先兑换或购买额度" }, { status: 402 });
  }

  // OSS 模式：整传会占用服务器带宽，禁用并引导走分片会话直传接口
  if (isOss()) {
    return NextResponse.json(
      { error: "当前为直传模式，请使用分片上传接口（POST /api/uploads/init）" },
      { status: 409 },
    );
  }

  // 校验文件类型（MIME 白名单：视频 + 纯音频），并确定媒体类型
  const contentType = request.headers.get("content-type") ?? "";
  const kind = mediaKindOf(contentType);
  const ext = EXT_BY_TYPE[contentType];
  if (!kind || !ext) {
    return NextResponse.json(
      { error: `不支持的媒体格式：${contentType || "未知"}（支持 mp4/mov/mkv/webm/mp3/m4a/wav）` },
      { status: 415 },
    );
  }

  // 原始文件名仅用于展示（title），服务端绝不以此生成存储路径
  const rawName = decodeURIComponent(request.headers.get("x-file-name") ?? "未命名视频");
  const title = rawName.replace(/[\\/:*?"<>|]/g, "_").slice(0, 100) || "未命名视频";

  // 处理模式（X-Process-Mode 头）：asr 语音转写（默认）/ ocr 硬字幕提取；音频项目强制 asr
  const processMode = kind === "audio" ? "asr" : normalizeProcessMode(request.headers.get("x-process-mode"));

  if (!request.body) {
    return NextResponse.json({ error: "请求体为空" }, { status: 400 });
  }

  ensureUploadDir();
  const videoKey = generateVideoKey(ext);
  const destPath = localVideoPath(videoKey);

  // 先建项目行（拿到 id），流式写盘；失败则回滚删除
  const project = await db.project.create({
    data: { userId: user.id, title, mediaKind: kind, processMode, videoKey, videoName: rawName, status: "UPLOADED" },
  });

  try {
    await pipeline(
      Readable.fromWeb(request.body as WebReadableStream<Uint8Array>),
      new SizeLimitStream(),
      fs.createWriteStream(destPath),
    );
  } catch (err) {
    // 清理半截文件与项目行
    await fs.promises.unlink(destPath).catch(() => {});
    await db.project.delete({ where: { id: project.id } }).catch(() => {});
    if (err instanceof Error && err.message === "FILE_TOO_LARGE") {
      return NextResponse.json(
        { error: `文件超过大小上限（${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB）` },
        { status: 413 },
      );
    }
    if (err instanceof Error && err.message === "NOT_MEDIA") {
      return NextResponse.json({ error: "文件内容不是有效的视频/音频格式" }, { status: 415 });
    }
    console.error("[upload] 写盘失败：", err);
    return NextResponse.json({ error: "上传失败，请重试" }, { status: 500 });
  }

  // 上传完成，异步启动转写流水线
  void startProcessing(project.id, user.id);

  return NextResponse.json({ projectId: project.id });
}

/**
 * 获取当前用户的项目列表（分页）
 * @param request 查询参数 page（默认 1）、pageSize（默认 20，上限 100）
 */
export async function GET(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const url = new URL(request.url);
  const page = Math.max(1, Math.floor(Number(url.searchParams.get("page")) || 1));
  const pageSize = Math.min(
    100,
    Math.max(1, Math.floor(Number(url.searchParams.get("pageSize")) || 20)),
  );

  const [total, projects] = await Promise.all([
    db.project.count({ where: { userId: user.id } }),
    db.project.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        title: true,
        status: true,
        mediaKind: true,
        processMode: true,
        durationSec: true,
        error: true,
        createdAt: true,
        updatedAt: true,
        transcript: { select: { llmPolished: true } },
      },
    }),
  ]);

  return NextResponse.json({
    projects: projects.map((p) => ({
      id: p.id,
      title: p.title,
      status: p.status,
      mediaKind: p.mediaKind,
      processMode: p.processMode,
      durationSec: p.durationSec,
      error: p.error,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      llmPolished: p.transcript?.llmPolished ?? null,
    })),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
}
