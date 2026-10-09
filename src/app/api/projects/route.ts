/**
 * @file /api/projects — 项目集合接口
 * @description
 *   POST：新建项目（视频上传）。客户端以「原始文件二进制」作为请求体流式上传，
 *         元数据放请求头（Content-Type=视频 MIME，X-File-Name=URI 编码的原始文件名），
 *         避免 multipart 将 500MB 文件整体缓冲进内存。边收边写磁盘，超限即中断并清理。
 *   GET：当前用户的项目列表（按更新时间倒序，最多 100 条）。
 */
import { NextResponse } from "next/server";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import fs from "node:fs";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { MAX_UPLOAD_BYTES, ALLOWED_VIDEO_TYPES } from "@/lib/constants";
import { ensureUploadDir, generateVideoKey, localVideoPath } from "@/lib/storage";
import { startProcessing } from "@/lib/pipeline";

/** MIME → 扩展名映射（白名单内） */
const EXT_BY_TYPE: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
  "video/webm": ".webm",
};

/** 限流 Transform：累计字节数超过上限时抛错，中断整条管道 */
class SizeLimitStream extends Transform {
  private written = 0;

  /** 流式转换：仅计数校验，原样透传 */
  _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (err: Error | null, data?: Buffer) => void,
  ): void {
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

  // 余额预检：额度耗尽的用户不允许新建（提示先兑换额度）
  if (user.balanceSeconds <= 0) {
    return NextResponse.json({ error: "剩余额度不足，请先兑换或购买额度" }, { status: 402 });
  }

  // 校验文件类型（白名单）
  const contentType = request.headers.get("content-type") ?? "";
  const ext = EXT_BY_TYPE[contentType];
  if (!ext || !(ALLOWED_VIDEO_TYPES as readonly string[]).includes(contentType)) {
    return NextResponse.json(
      { error: `不支持的视频格式：${contentType || "未知"}（仅支持 mp4/mov/mkv/webm）` },
      { status: 415 },
    );
  }

  // 原始文件名仅用于展示（title），服务端绝不以此生成存储路径
  const rawName = decodeURIComponent(request.headers.get("x-file-name") ?? "未命名视频");
  const title = rawName.replace(/[\\/:*?"<>|]/g, "_").slice(0, 100) || "未命名视频";

  if (!request.body) {
    return NextResponse.json({ error: "请求体为空" }, { status: 400 });
  }

  ensureUploadDir();
  const videoKey = generateVideoKey(ext);
  const destPath = localVideoPath(videoKey);

  // 先建项目行（拿到 id），流式写盘；失败则回滚删除
  const project = await db.project.create({
    data: { userId: user.id, title, videoKey, videoName: rawName, status: "UPLOADED" },
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
    console.error("[upload] 写盘失败：", err);
    return NextResponse.json({ error: "上传失败，请重试" }, { status: 500 });
  }

  // 上传完成，异步启动转写流水线
  startProcessing(project.id);

  return NextResponse.json({ projectId: project.id });
}

/**
 * 获取当前用户的项目列表
 */
export async function GET(): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const projects = await db.project.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    take: 100,
    select: {
      id: true,
      title: true,
      status: true,
      durationSec: true,
      error: true,
      createdAt: true,
      updatedAt: true,
      transcript: { select: { llmPolished: true } },
    },
  });

  return NextResponse.json({
    projects: projects.map((p) => ({
      id: p.id,
      title: p.title,
      status: p.status,
      durationSec: p.durationSec,
      error: p.error,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      llmPolished: p.transcript?.llmPolished ?? null,
    })),
  });
}
