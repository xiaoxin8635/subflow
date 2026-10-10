/**
 * @file PUT /api/uploads/[id]/chunks/[index] — 上传单个分片
 * @description 请求体为该片的原始二进制（Content-Type: application/octet-stream）。
 *              覆盖写幂等：同一片重复上传以最后一次为准；写入时校验片大小不超预期。
 */
import { NextResponse } from "next/server";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { getCurrentUser } from "@/lib/auth";
import {
  getMeta,
  isValidUploadId,
  listReceivedChunks,
  writeChunk,
  UploadSessionError,
} from "@/lib/upload-session";

/**
 * 上传单个分片
 * @param request 原始请求（body 为分片二进制）
 * @param params  路由参数（Promise<{ id: string; index: string }>）
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; index: string }> },
): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const { id, index: rawIndex } = await params;
  if (!isValidUploadId(id)) {
    return NextResponse.json({ error: "上传会话不存在" }, { status: 404 });
  }
  const index = Number(rawIndex);
  if (!Number.isInteger(index) || index < 0) {
    return NextResponse.json({ error: "分片索引不合法" }, { status: 400 });
  }
  if (!request.body) {
    return NextResponse.json({ error: "请求体为空" }, { status: 400 });
  }

  try {
    const meta = getMeta(id, user.id);
    const written = await writeChunk(
      id,
      meta,
      index,
      request.body as WebReadableStream<Uint8Array>,
    );
    const received = listReceivedChunks(id, meta);
    return NextResponse.json({
      ok: true,
      index,
      written,
      receivedCount: received.length,
      chunkCount: meta.chunkCount,
    });
  } catch (e) {
    if (e instanceof UploadSessionError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error("[upload:chunk] 写入分片失败：", e);
    return NextResponse.json({ error: "分片写入失败，请重试" }, { status: 500 });
  }
}
