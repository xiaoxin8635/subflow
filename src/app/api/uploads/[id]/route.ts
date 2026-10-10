/**
 * @file GET /api/uploads/[id] — 查询分片上传会话（断点续传）
 * @description 客户端中断（刷新/断网）后，凭保存的 uploadId 查询已到齐的分片索引，
 *              跳过已传分片继续上传，避免从头重传大文件。
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getMeta, isValidUploadId, listReceivedChunks, UploadSessionError } from "@/lib/upload-session";

/**
 * 查询会话已到齐的分片
 * @param _request 原始请求（未使用）
 * @param params   路由参数（Promise<{ id: string }>）
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const { id } = await params;
  // 非法格式直接 404（防止任意字符串进文件路径）
  if (!isValidUploadId(id)) {
    return NextResponse.json({ error: "上传会话不存在" }, { status: 404 });
  }

  try {
    const meta = getMeta(id, user.id);
    return NextResponse.json({
      fileName: meta.fileName,
      size: meta.size,
      chunkSize: meta.chunkSize,
      chunkCount: meta.chunkCount,
      uploadedIndexes: listReceivedChunks(id, meta),
    });
  } catch (e) {
    if (e instanceof UploadSessionError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error("[upload:status] 查询会话失败：", e);
    return NextResponse.json({ error: "查询上传会话失败" }, { status: 500 });
  }
}
