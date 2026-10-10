/**
 * @file POST /api/uploads/[id]/complete — 完成分片上传并创建项目
 * @description 校验分片齐全 → 合并 + 魔数/大小复查 → 建项目行 → 异步启动转写流水线。
 *              余额预检与整传 POST /api/projects 保持一致；失败不残留半截文件。
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { completeAndMerge, getMeta, isValidUploadId, UploadSessionError } from "@/lib/upload-session";
import { startProcessing } from "@/lib/pipeline";

/**
 * 完成上传：合并分片并创建项目
 * @param _request 原始请求（无请求体）
 * @param params   路由参数（Promise<{ id: string }>）
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const { id } = await params;
  if (!isValidUploadId(id)) {
    return NextResponse.json({ error: "上传会话不存在" }, { status: 404 });
  }

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

    const project = await db.project.create({
      data: { userId: user.id, title, videoKey, videoName: meta.fileName, status: "UPLOADED" },
    });

    // 异步启动转写流水线（与整传一致：fire-and-forget）
    startProcessing(project.id);

    return NextResponse.json({ projectId: project.id });
  } catch (e) {
    if (e instanceof UploadSessionError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error("[upload:complete] 合并失败：", e);
    return NextResponse.json({ error: "合并上传内容失败，请重试" }, { status: 500 });
  }
}
