/**
 * @file 字幕翻译流水线（P2.4：LLM 批量翻译 + 额度扣减；Redis 队列驱动，Worker 消费）
 * @description Translation 状态机：PENDING → PROCESSING → DONE / FAILED。
 *              流程：读取源转写分段 → 逐批 LLM 翻译（时间轴不变，仅替换文本，
 *              中文关键词高亮不适用于译文故不保留）→ 单事务完成「任务置 DONE +
 *              条件扣减额度（防负数）+ 写额度流水」。计费按源字幕总字符数：
 *              每 1000 字符计 60 秒额度、最低 60 秒（创建接口已做余额预检 402）。
 *              入口 startTranslation 仅负责入队（BullMQ 翻译队列）；Redis 不可用
 *              时降级进程内直跑。processTranslation 只执行不兜错——错误上抛给
 *              Worker 触发自动重试，重试用尽后由 failed 事件调用
 *              markTranslationFailed 落库。翻译是付费产物：LLM 调用失败绝不
 *              静默回退原文（与 polish 的降级语义相反，见 translate.ts）。
 *              允许 PROCESSING 状态重跑：Worker 崩溃后 stalled 任务恢复时重新执行。
 */
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { sendAlert } from "@/lib/alert";
import { notify } from "@/lib/notify";
import { translateSegments } from "@/lib/translate";
import { parseHotwords, translateLangLabel, translateCostSeconds, translateStyleOf } from "@/lib/constants";
import { enqueueTranslation } from "@/lib/queue/queues";
import type { StoredSegment } from "@/lib/asr/types";

/** 翻译后分段契约（时间轴不变、text 为译文；对象字面量 type 以兼容 Prisma Json 写入） */
export type TranslatedSegment = { start: number; end: number; text: string };

/**
 * 启动翻译任务：优先入队（Worker 消费），Redis 不可用时降级进程内直跑
 * @param taskId Translation ID
 * @param userId 用户 ID（用于付费优先级计算）
 */
export async function startTranslation(taskId: string, userId: string): Promise<void> {
  const queued = await enqueueTranslation(taskId, userId);
  if (queued) return;
  // 降级：进程内执行并在失败时直接落 FAILED（无重试语义，与队列行为对齐）
  void processTranslation(taskId).catch(async (e) => {
    await markTranslationFailed(taskId, e instanceof Error ? e.message : "翻译失败");
  });
}

/**
 * 将翻译任务标记为失败（重试用尽后的死信落库；任务行可能已被级联删除需容错）
 * @param taskId  Translation ID
 * @param message 失败原因
 */
export async function markTranslationFailed(taskId: string, message: string): Promise<void> {
  // include project 顺带取 userId/title 用于站内通知（任务行已级联删除则跳过通知）
  const row = await db.translation
    .update({
      where: { id: taskId },
      data: { status: "FAILED", error: message, finishedAt: new Date() },
      include: { project: { select: { id: true, userId: true, title: true } } },
    })
    .catch(() => null);
  if (row) {
    await notify(row.project.userId, "TRANSLATE_FAILED", "翻译失败", `「${row.project.title}」字幕翻译失败：${message}`, `/project/${row.project.id}`);
  }
}

/**
 * 执行翻译任务：读源分段 → 分批 LLM 翻译 → 事务（置 DONE + 扣额度 + 流水）
 * 失败时向上抛错（由 Worker 决定重试或最终标记 FAILED）。
 * @param taskId Translation ID
 */
export async function processTranslation(taskId: string): Promise<void> {
  const task = await db.translation.findUnique({
    where: { id: taskId },
    include: { project: { include: { transcript: true } } },
  });
  // 任务已删除/终态（防重复执行）；PROCESSING 允许：stalled 恢复重跑
  if (!task || (task.status !== "PENDING" && task.status !== "PROCESSING")) return;

  const { project } = task;
  const langLabel = translateLangLabel(task.targetLang);
  if (!langLabel) throw new Error(`不支持的目标语言：${task.targetLang}`);

  // ① 前置校验：项目须 READY 且有非空转写分段
  if (project.status !== "READY" || !project.transcript) {
    throw new Error("项目未就绪（须转写完成）");
  }
  const sourceSegments = Array.isArray(project.transcript.segments)
    ? (project.transcript.segments as StoredSegment[])
    : [];
  if (sourceSegments.length === 0) throw new Error("项目没有字幕内容，无法翻译");

  await db.translation.update({ where: { id: taskId }, data: { status: "PROCESSING" } });

  // ② 分批 LLM 翻译（失败抛错走重试；无兜底——付费产物不交付半成品）。
  //    P2.11：任务创建时的风格快照注入 system prompt；项目热词作为术语表
  //    注入（全片译法统一，品牌/产品名保留原文）
  const texts = sourceSegments.map((s) => s.text);
  const charCount = texts.reduce((n, t) => n + t.length, 0);
  const translated = await translateSegments(texts, task.targetLang, langLabel, {
    styleInstruction: translateStyleOf(task.style).instruction,
    glossary: parseHotwords(project.hotwords),
  });

  // ③ 组装翻译分段：时间轴逐行对齐源分段，文本替换为译文
  const segments: TranslatedSegment[] = sourceSegments.map((s, i) => ({
    start: s.start,
    end: s.end,
    text: translated[i],
  }));

  // ④ 事务：任务 DONE + 扣额度（带余额守卫防负数）+ 额度流水
  const costSeconds = translateCostSeconds(charCount);
  await db.$transaction(async (tx) => {
    // 条件更新：余额足够才扣，防止并发消耗把余额扣成负数
    const deducted = await tx.user.updateMany({
      where: { id: project.userId, balanceSeconds: { gte: costSeconds } },
      data: { balanceSeconds: { decrement: costSeconds } },
    });
    if (deducted.count !== 1) {
      // 创建接口已做余额预检，走到这里说明预检后余额被并发消耗；译文作废不交付
      const message = `额度不足（翻译需 ${costSeconds} 秒，余额在任务执行期间被其他消耗占用）`;
      logger.warn("translate", "额度守卫拦截（疑似并发消耗竞态）", { taskId, userId: project.userId, costSeconds });
      void sendAlert("quota-guard", "额度守卫拦截：预检后余额被并发消耗", [
        `翻译任务：${taskId}`,
        `需扣：${costSeconds} 秒`,
      ]);
      throw new Error(message);
    }
    const user = await tx.user.findUnique({ where: { id: project.userId } });
    await tx.creditLedger.create({
      data: {
        userId: project.userId,
        changeSeconds: -costSeconds,
        balanceAfter: user!.balanceSeconds,
        reason: "CONSUME_TRANSLATE",
        refId: taskId,
      },
    });
    await tx.translation.update({
      where: { id: taskId },
      data: {
        status: "DONE",
        segments,
        charCount,
        costSeconds,
        finishedAt: new Date(),
        error: null,
      },
    });
  });
  logger.info("translate", "翻译任务完成", {
    taskId,
    title: project.title,
    targetLang: task.targetLang,
    charCount,
    costSeconds,
  });
  // 站内通知：翻译完成（铃铛提醒，旁路失败不影响主流程）
  await notify(
    project.userId,
    "TRANSLATE_DONE",
    "翻译完成",
    `「${project.title}」已翻译为${langLabel}（消耗 ${costSeconds} 秒额度）`,
    `/project/${project.id}`,
  );
}
