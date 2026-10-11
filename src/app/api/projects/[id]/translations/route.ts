/**
 * @file /api/projects/[id]/translations — 创建翻译任务 + 列出项目已有翻译（P2.4）
 * @description POST：为 READY 项目创建 LLM 字幕翻译任务（异步执行，付费点）。
 *              请求体：{ targetLang, style? }（TRANSLATE_LANGUAGES 白名单内的语言
 *              代码；style 为翻译风格 TRANSLATE_STYLES 代码，白名单外回退 general）。
 *              计费按源字幕总字符数（每 1000 字符计 60 秒额度、最低 60 秒），
 *              创建时余额预检（402），成功后在流水线事务内条件扣减。
 *              同项目同语言仅一个版本（DB unique 约束）：已有进行中任务 → 409；
 *              已终态（DONE/FAILED）→ 覆盖重建（重新翻译）。
 *              纯音频项目同样支持（产出目标语言字幕文件）。
 *              校验链：登录 → 限流 → 语言白名单 → 项目归属 → 状态就绪 →
 *              余额预检 → 并发检查。创建后 fire-and-forget 启动流水线。
 *              GET：列出该项目全部翻译任务（按创建时间倒序，不含 segments 大字段）。
 * 说明：Next.js 15+ 动态路由参数为 Promise，必须 await；
 *      Cache Components 模式下禁止 export const runtime 路由配置。
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { startTranslation } from "@/lib/translate-pipeline";
import { rateLimit } from "@/lib/rate-limit";
import { TRANSLATE_LANGUAGES, normalizeTranslateStyle, translateLangLabel, translateCostSeconds, TRANSLATE_RATE_LIMIT_PER_HOUR } from "@/lib/constants";
import type { StoredSegment } from "@/lib/asr/types";

/**
 * 创建翻译任务
 * @param request 请求体 { targetLang: string, style?: string }
 * @param params  路由参数（Promise<{ id: string }>）
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  // 限流：LLM 翻译有真金白银成本，每用户每小时最多 10 次
  const rl = await rateLimit(request, "translate", user.id, TRANSLATE_RATE_LIMIT_PER_HOUR, 60 * 60 * 1000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "翻译操作过于频繁，请稍后再试" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { targetLang?: unknown; style?: unknown };
  const targetLang = typeof body.targetLang === "string" ? body.targetLang : "";
  const style = normalizeTranslateStyle(body?.style);
  const langLabel = translateLangLabel(targetLang);
  if (!langLabel) {
    return NextResponse.json(
      { error: "不支持的目标语言", supported: TRANSLATE_LANGUAGES.map((l) => l.code) },
      { status: 400 },
    );
  }

  // 项目归属 + 就绪校验（不存在/非本人统一 404）
  const project = await db.project.findUnique({
    where: { id },
    include: { transcript: { select: { projectId: true, segments: true } } },
  });
  if (!project || project.userId !== user.id) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }
  if (project.status !== "READY" || !project.transcript) {
    return NextResponse.json({ error: "项目未就绪或没有转写结果" }, { status: 400 });
  }
  const sourceSegments = Array.isArray(project.transcript.segments)
    ? (project.transcript.segments as StoredSegment[])
    : [];
  if (sourceSegments.length === 0) {
    return NextResponse.json({ error: "项目没有字幕内容，无法翻译" }, { status: 400 });
  }

  // 计费快照：按源字幕总字符数（创建时锁定，任务执行期间源文件再变不影响本次扣费语义）
  const charCount = sourceSegments.reduce((n, s) => n + (s.text?.length ?? 0), 0);
  const costSeconds = translateCostSeconds(charCount);
  if (user.balanceSeconds < costSeconds) {
    return NextResponse.json(
      {
        error: `额度不足：本次翻译需 ${costSeconds} 秒，当前余额 ${user.balanceSeconds} 秒`,
        required: costSeconds,
        balance: user.balanceSeconds,
      },
      { status: 402 },
    );
  }

  // 同语言防并发：进行中 409；终态（DONE/FAILED）覆盖重建 = 重新翻译
  const existing = await db.translation.findUnique({
    where: { projectId_targetLang: { projectId: id, targetLang } },
  });
  if (existing && (existing.status === "PENDING" || existing.status === "PROCESSING")) {
    return NextResponse.json(
      { error: "该语言的翻译已在进行中，请稍候", taskId: existing.id },
      { status: 409 },
    );
  }

  const task = await db.$transaction(async (tx) => {
    if (existing) await tx.translation.delete({ where: { id: existing.id } });
    return tx.translation.create({ data: { projectId: id, targetLang, style } });
  });
  void startTranslation(task.id, user.id);

  return NextResponse.json({
    taskId: task.id,
    charCount,
    costSeconds,
    balanceSeconds: user.balanceSeconds,
  });
}

/**
 * 列出项目的全部翻译任务（编辑器翻译卡展示各语言状态用）
 * @param request 请求（query 可选 withSegments=1：DONE 任务附带 segments，
 *                供编辑器双语预览；缺省不含大字段）
 * @param params  路由参数（Promise<{ id: string }>）
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const { id } = await params;
  const project = await db.project.findUnique({ where: { id }, select: { userId: true } });
  if (!project || project.userId !== user.id) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  const withSegments = new URL(request.url).searchParams.get("withSegments") === "1";
  const translations = await db.translation.findMany({
    where: { projectId: id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      targetLang: true,
      style: true,
      status: true,
      charCount: true,
      costSeconds: true,
      error: true,
      createdAt: true,
      finishedAt: true,
      ...(withSegments ? { segments: true } : {}),
    },
  });
  // withSegments 模式下仅 DONE 任务携带译文分段（其余状态无内容，置 null 统一契约）
  const payload = withSegments
    ? translations.map((t) => ({
        ...t,
        segments: t.status === "DONE" && Array.isArray(t.segments) ? t.segments : null,
      }))
    : translations;
  return NextResponse.json({ translations: payload });
}
