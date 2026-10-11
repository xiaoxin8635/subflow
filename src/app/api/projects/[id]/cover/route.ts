/**
 * @file GET /api/projects/[id]/cover — 项目封面帧（工作台缩略图）
 * @description 仅项目本人可访问。local 模式：整文件流式响应（封面为 ~几十 KB 的
 *              JPEG，无需 Range），带 1 小时私有缓存（封面生成后不变，重复访问不重读盘）。
 *              oss   模式：302 跳转到签名 URL（4 小时有效）。coverKey 为空或文件缺失
 *              返回 404——前端列表按 coverKey 有无直接渲染占位，不发起无效请求。
 */
import fs from "node:fs";
import { Readable } from "node:stream";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { isOss, localPathByKey } from "@/lib/storage";
import { presignGetUrl } from "@/lib/oss";

/** oss 签名 URL 有效期（秒） */
const COVER_URL_TTL_SEC = 4 * 60 * 60;

/** local 模式浏览器缓存时长（秒）：封面生成后不变 */
const COVER_CACHE_SEC = 60 * 60;

/**
 * 封面帧响应（local 流式 / oss 302 签名 URL）
 * @param _request 原始请求（封面无 Range 需求，仅占位）
 * @param params   路由参数（Promise<{ id: string }>）
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return new Response("未登录", { status: 401 });

  const { id } = await params;
  const project = await db.project.findUnique({ where: { id } });
  if (!project || project.userId !== user.id || !project.coverKey) {
    return new Response("封面不存在", { status: 404 });
  }

  const cacheControl = `private, max-age=${COVER_CACHE_SEC}`;

  // oss 模式：授权后 302 到签名 URL，图片流量直达 OSS
  if (isOss()) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: presignGetUrl(project.coverKey, COVER_URL_TTL_SEC, "inline"),
        "Cache-Control": cacheControl,
      },
    });
  }

  const coverPath = localPathByKey(project.coverKey);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(coverPath);
  } catch {
    return new Response("封面文件缺失", { status: 410 });
  }

  const nodeStream = fs.createReadStream(coverPath);
  return new Response(Readable.toWeb(nodeStream) as unknown as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(stat.size),
      "Cache-Control": cacheControl,
    },
  });
}
