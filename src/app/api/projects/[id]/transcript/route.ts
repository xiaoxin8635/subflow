/**
 * @file PUT /api/projects/[id]/transcript — 保存编辑后的字幕分段
 * @description 全量替换 segments（MVP 简化模型：前端整段提交，服务端结构校验）。
 *              保留 rawText / asrProvider / llmPolished 原值（编辑不改变转写留底）。
 *              服务端校验：段数上限、字段类型、时间合法性（end>start≥0）。
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import type { StoredSegment } from "@/lib/asr/types";

/** 分段数量上限（30 分钟视频按 2 秒/段也不会超过 900，给足余量） */
const MAX_SEGMENTS = 2000;
/** 单段文本长度上限 */
const MAX_TEXT_LEN = 500;

/**
 * 校验并规范化单个分段
 * @param raw 前端提交的原始分段
 * @returns 合法返回 StoredSegment，非法返回 null
 */
function sanitizeSegment(raw: unknown): StoredSegment | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const start = r.start;
  const end = r.end;
  const text = r.text;
  if (typeof start !== "number" || typeof end !== "number" || typeof text !== "string") return null;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end <= start) return null;
  const cleanText = text.trim();
  if (!cleanText || cleanText.length > MAX_TEXT_LEN) return null;
  const keywords = Array.isArray(r.keywords)
    ? r.keywords.filter((k): k is string => typeof k === "string").slice(0, 10)
    : [];
  // 时间保留 3 位小数（毫秒精度）
  return {
    start: Math.round(start * 1000) / 1000,
    end: Math.round(end * 1000) / 1000,
    text: cleanText,
    keywords,
  };
}

/**
 * 保存字幕分段
 * @param request 请求（body: { segments: unknown[] }）
 * @param params  路由参数（Promise<{ id: string }>）
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const { id } = await params;
  const project = await db.project.findUnique({
    where: { id },
    include: { transcript: true },
  });
  if (!project || project.userId !== user.id) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }
  if (project.status !== "READY") {
    return NextResponse.json({ error: "项目尚未完成转写，无法编辑" }, { status: 409 });
  }

  const body = (await request.json().catch(() => null)) as { segments?: unknown } | null;
  if (!body || !Array.isArray(body.segments)) {
    return NextResponse.json({ error: "请求格式错误：缺少 segments 数组" }, { status: 400 });
  }
  if (body.segments.length === 0) {
    return NextResponse.json({ error: "至少保留一条字幕" }, { status: 400 });
  }
  if (body.segments.length > MAX_SEGMENTS) {
    return NextResponse.json({ error: `分段数超过上限（${MAX_SEGMENTS}）` }, { status: 400 });
  }

  const segments: StoredSegment[] = [];
  for (const raw of body.segments) {
    const seg = sanitizeSegment(raw);
    if (!seg) {
      return NextResponse.json(
        { error: "存在非法分段（时间倒挂 / 文本为空或超长）" },
        { status: 400 },
      );
    }
    segments.push(seg);
  }

  await db.transcript.upsert({
    where: { projectId: id },
    create: { projectId: id, segments, llmPolished: false },
    update: { segments },
  });

  return NextResponse.json({ ok: true, count: segments.length });
}
