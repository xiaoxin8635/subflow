/**
 * @file POST /api/uploads/init — 创建分片上传会话
 * @description 客户端先调本接口拿到 uploadId 与分片参数，再逐片上传：
 *              local 模式 → PUT /api/uploads/[id]/chunks/[index] 走服务器；
 *              oss   模式 → 使用返回的 partUrls 浏览器直传 OSS（不经服务器带宽）。
 *              全部完成后 POST /api/uploads/[id]/complete 合并入库。
 *              限流复用新建项目配额（每用户每小时 10 个），防止绕过整传限流。
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { ALLOWED_VIDEO_TYPES } from "@/lib/constants";
import { initSession, UploadSessionError } from "@/lib/upload-session";
import { rateLimit } from "@/lib/rate-limit";

/**
 * 创建分片上传会话
 * @param request 请求体 { fileName, contentType, size }
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  // 限流：与整传 POST /api/projects 共用同一配额（每用户每小时 10 个新项目）
  const rl = await rateLimit(request, "upload", user.id, 10, 60 * 60 * 1000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: `上传过于频繁，每小时最多 10 个视频，请 ${Math.ceil(rl.retryAfterSec / 60)} 分钟后再试` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  // 余额预检：与整传保持一致
  if (user.balanceSeconds <= 0) {
    return NextResponse.json({ error: "剩余额度不足，请先兑换或购买额度" }, { status: 402 });
  }

  const body = (await request.json().catch(() => null)) as
    | { fileName?: unknown; contentType?: unknown; size?: unknown }
    | null;
  const fileName = typeof body?.fileName === "string" ? body.fileName : "";
  const contentType = typeof body?.contentType === "string" ? body.contentType : "";
  const size = typeof body?.size === "number" ? Math.floor(body.size) : 0;

  // MIME 白名单（与整传一致）
  if (!(ALLOWED_VIDEO_TYPES as readonly string[]).includes(contentType)) {
    return NextResponse.json(
      { error: `不支持的视频格式：${contentType || "未知"}（仅支持 mp4/mov/mkv/webm）` },
      { status: 415 },
    );
  }
  if (!fileName) {
    return NextResponse.json({ error: "缺少文件名" }, { status: 400 });
  }

  try {
    const session = await initSession(user.id, fileName, contentType, size);
    return NextResponse.json(session);
  } catch (e) {
    if (e instanceof UploadSessionError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error("[upload:init] 创建会话失败：", e);
    return NextResponse.json({ error: "创建上传会话失败，请重试" }, { status: 500 });
  }
}
