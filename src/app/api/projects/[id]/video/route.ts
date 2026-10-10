/**
 * @file GET /api/projects/[id]/video — 视频回放
 * @description local 模式：支持 HTTP Range 的流式响应（<video> 拖动进度/倍速必需），
 *              单次响应上限 4MB 防止一次性读入大段数据。
 *              oss   模式：302 跳转到服务端签发的私有桶 GET 签名 URL（4 小时有效），
 *              播放流量直达 OSS 不经服务器；Range 由 OSS 处理。
 *              两种模式均仅项目本人可访问；videoKey 由服务端生成，无路径遍历风险。
 */
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { localVideoPath, isOss } from "@/lib/storage";
import { presignGetUrl } from "@/lib/oss";

/** 单次 Range 响应最大字节数（4MB，浏览器会连续拉取） */
const CHUNK_SIZE = 4 * 1024 * 1024;

/** oss 签名 URL 有效期（秒）：4 小时，覆盖单次观看会话 */
const VIDEO_URL_TTL_SEC = 4 * 60 * 60;

/** 扩展名 → MIME（与上传白名单一致，含纯音频） */
const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
};

/**
 * 返回视频回放响应（local 流式 / oss 302 签名 URL）
 * @param request 原始请求（local 模式读取 Range 头）
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

  const videoKey = videoKeySafe(project.videoKey);
  const ext = path.extname(videoKey).toLowerCase();
  const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";

  // oss 模式：授权后 302 到签名 URL，播放流量直达 OSS
  if (isOss()) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: presignGetUrl(project.videoKey, VIDEO_URL_TTL_SEC, "inline"),
        "Cache-Control": "private, no-store",
      },
    });
  }

  const videoPath = localVideoPath(project.videoKey);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(videoPath);
  } catch {
    return new Response("视频文件缺失", { status: 410 });
  }

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
