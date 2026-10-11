/**
 * @file POST /api/uploads/[id]/complete — 完成分片上传并创建项目
 * @description 校验分片齐全 → 合并/提交（local 合并文件；oss 提交 Multipart）→
 *              魔数/大小复查 → 建项目行 → 异步启动转写流水线。
 *              余额预检与整传 POST /api/projects 保持一致；失败不残留半截对象。
 *              识别设置（P2.11）随 body 入库：{ processMode, scene, language,
 *              hotwords, denoise }，非法值白名单清洗回退默认。
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import {
  mediaKindOf,
  normalizeAsrLanguage,
  normalizeProcessMode,
  normalizeScene,
  parseHotwords,
} from "@/lib/constants";
import { completeAndMerge, getMeta, isValidUploadId, UploadSessionError } from "@/lib/upload-session";
import { startProcessing } from "@/lib/pipeline";

/**
 * 完成上传：合并分片并创建项目
 * @param request 请求（body 可选 JSON { processMode?, scene?, language?, hotwords? }，缺省 asr/general/zh）
 * @param params   路由参数（Promise<{ id: string }>）
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const { id } = await params;
  if (!isValidUploadId(id)) {
    return NextResponse.json({ error: "上传会话不存在" }, { status: 404 });
  }

  // 处理模式与识别设置（body 可选字段）：白名单外一律回退默认值
  const body = (await request.json().catch(() => null)) as {
    processMode?: unknown;
    scene?: unknown;
    language?: unknown;
    hotwords?: unknown;
    denoise?: unknown;
  } | null;
  const requestedMode = normalizeProcessMode(body?.processMode);
  const scene = normalizeScene(body?.scene);
  const language = normalizeAsrLanguage(body?.language);
  const hotwords = parseHotwords(body?.hotwords);
  // 噪声开关（P2.11）：显式 true 才开启，其余一律 false
  const denoise = body?.denoise === true;

  try {
    const meta = getMeta(id, user.id);

    // 余额预检：与整传一致（额度耗尽不允许新建）
    if (user.balanceSeconds <= 0) {
      return NextResponse.json({ error: "剩余额度不足，请先兑换或购买额度" }, { status: 402 });
    }

    // 合并分片（内部含分片齐全校验、总大小与魔数复查）
    const videoKey = await completeAndMerge(id, meta);

    // 展示字段清洗：与整传 POST /api/projects 保持同一规则
    const title = meta.fileName.replace(/[\\/:*?"<>|]/g, "_").slice(0, 100) || "未命名视频";

    // init 时已过 MIME 白名单，这里按 MIME 定媒体类型（决定导出形态）；音频项目强制 asr
    const mediaKind = mediaKindOf(meta.contentType) === "audio" ? "audio" : "video";

    const project = await db.project.create({
      data: {
        userId: user.id,
        title,
        mediaKind,
        processMode: mediaKind === "audio" ? "asr" : requestedMode,
        videoKey,
        videoName: meta.fileName,
        status: "UPLOADED",
        scene,
        language,
        hotwords: hotwords.length > 0 ? hotwords.join(",") : null,
        denoise,
      },
    });

    // 异步启动转写流水线（与整传一致：fire-and-forget）
    void startProcessing(project.id, user.id);

    return NextResponse.json({ projectId: project.id });
  } catch (e) {
    if (e instanceof UploadSessionError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error("[upload:complete] 合并失败：", e);
    return NextResponse.json({ error: "合并上传内容失败，请重试" }, { status: 500 });
  }
}
