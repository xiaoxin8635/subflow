/**
 * @file 站内通知写入（P1.3 任务完成通知）
 * @description 转写/导出完成或失败时写 Notification 行。写入失败仅记日志、
 *              不影响主流程（通知是旁路能力，不能让业务失败）。
 *              读取侧：GET /api/notifications（铃铛未读数与列表）。
 */
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

/** 通知类型（字符串而非枚举：前端展示映射自行维护，DB 侧保持宽松） */
export type NotificationType =
  | "TRANSCRIBE_DONE"
  | "TRANSCRIBE_FAILED"
  | "EXPORT_DONE"
  | "EXPORT_FAILED"
  | "TRANSLATE_DONE"
  | "TRANSLATE_FAILED";

/**
 * 写一条站内通知（容错：失败仅落日志）
 * @param userId 接收用户 ID
 * @param type   通知类型
 * @param title  标题（列表首行）
 * @param body   详情（可空）
 * @param link   点击跳转路径（如 /project/xxx，可空）
 */
export async function notify(
  userId: string,
  type: NotificationType,
  title: string,
  body?: string,
  link?: string,
): Promise<void> {
  try {
    await db.notification.create({
      data: { userId, type, title, body: body ?? null, link: link ?? null },
    });
  } catch (e) {
    logger.warn("notify", "站内通知写入失败（忽略）", { userId, type, error: e });
  }
}
