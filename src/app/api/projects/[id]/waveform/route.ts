/**
 * @file GET /api/projects/[id]/waveform — 项目音频波形峰值 JSON（编辑器时间轴渲染）
 * @description 仅项目本人可访问。local 模式：整文件读回（JSON 数十~数百 KB，
 *              无需 Range），带 1 小时私有缓存（波形生成后不变，重复进入编辑器
 *              不重读盘）。oss 模式：302 跳转到签名 URL（4 小时有效）。
 *              waveformKey 为空（旧项目/提取失败）或文件缺失返回 404——前端按
 *              waveformKey 有无决定是否请求，404 时静默降级为不渲染波形。
 */
import fs from "node:fs";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { isOss, localPathByKey } from "@/lib/storage";
import { presignGetUrl } from "@/lib/oss";

/** oss 签名 URL 有效期（秒） */
const WAVEFORM_URL_TTL_SEC = 4 * 60 * 60;

/** local 模式浏览器缓存时长（秒）：波形生成后不变 */
const WAVEFORM_CACHE_SEC = 60 * 60;

/**
 * 波形峰值 JSON 响应（local 读文件 / oss 302 签名 URL）
 * @param _request 原始请求（波形无 Range 需求，仅占位）
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
  if (!project || project.userId !== user.id || !project.waveformKey) {
    return new Response("波形不存在", { status: 404 });
  }

  const cacheControl = `private, max-age=${WAVEFORM_CACHE_SEC}`;

  // oss 模式：授权后 302 到签名 URL，JSON 流量直达 OSS
  if (isOss()) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: presignGetUrl(project.waveformKey, WAVEFORM_URL_TTL_SEC, "inline"),
        "Cache-Control": cacheControl,
      },
    });
  }

  const wavePath = localPathByKey(project.waveformKey);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(wavePath);
  } catch {
    return new Response("波形文件缺失", { status: 410 });
  }

  return new Response(await fs.promises.readFile(wavePath, "utf8"), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(stat.size),
      "Cache-Control": cacheControl,
    },
  });
}
