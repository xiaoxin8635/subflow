/**
 * @file GET /api/projects/[id]/video — 视频回放流
 * @description 支持HTTP Range 请求（<video> 拖动进度/倍速必需）：按请求的字节区间
 *              返回 206 Partial Content，单次响应上限 4MB 防止一次性读入大段数据。
 *              仅项目本人可访问；videoKey 由服务端生成，无路径遍历风险。
 */
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { localVideoPath } from "@/lib/storage";

/** 单次 Range 响应最大字节数（4MB，浏览器会连续拉取） */
const CHUNK_SIZE = 4 * 1024 * 1024;

/** 扩展名 → MIME（与上传白名单一致） */
const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
};

/**
 * 流式返回视频内容（支持 Range）
 * @param request 原始请求（读取 Range 头）
 * @param params  路由参数（Promise<{ id: string }>）
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return new Response("未登录", { status: 401 });

  const { id } = await params;
  const project = await db.project.findUnique({ where: { id } });
  if (!project || project.userId !== user.id || !project.videoKey) {
    return new Response("项目不存在", { status: 404 });
  }

  const videoPath = localVideoPath(project.videoKey);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(videoPath);
  } catch {
    return new Response("视频文件缺失", { status: 410 });
  }

  const ext = path.extname(videoKeySafe(project.videoKey)).toLowerCase();
  const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";

  // 解析 Range: bytes=start-end（end 可空）
  const rangeHeader = request.headers.get("range");
  const match = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/);
  let start = 0;
  let end = Math.min(CHUNK_SIZE - 1, stat.size - 1);
  let status = 200;

  if (match) {
    start = match[1] ? Number(match[1]) : 0;
    end = match[2] ? Number(match[2]) : Math.min(start + CHUNK_SIZE - 1, stat.size - 1);
    // 非法区间（越界/倒挂）：返回 416 让浏览器重置
    if (start >= stat.size || start > end) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${stat.size}` },
      });
    }
    end = Math.min(end, stat.size - 1);
    status = 206;
  }

  const nodeStream = fs.createReadStream(videoPath, { start, end });
  return new Response(Readable.toWeb(nodeStream) as unknown as ReadableStream, {
    status,
    headers: {
      "Content-Type": mime,
      "Accept-Ranges": "bytes",
      "Content-Length": String(end - start + 1),
      ...(status === 206 ? { "Content-Range": `bytes ${start}-${end}/${stat.size}` } : {}),
      "Cache-Control": "private, no-store",
    },
  });
}

/**
 * 防御性处理 videoKey（只取文件名部分，杜绝目录跳转）
 * @param key 存储 key
 */
function videoKeySafe(key: string): string {
  return path.basename(key);
}
