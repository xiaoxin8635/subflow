/**
 * @file 共享展示格式化工具
 * @description 前后端共用的秒数人性化展示：「X 小时 Y 分钟」（整点小时省略分钟，
 *              不足 1 小时只显示分钟，不足 1 分钟显示秒）。
 *              3600 → 「1 小时」；12000 → 「3 小时 20 分钟」；90 → 「1 分钟」。
 */

/**
 * 秒数格式化为「X 小时 Y 分钟」
 * @param total 秒数（非负；小数按四舍五入取整——媒体时长为浮点，统计展示无需小数精度）
 */
export function formatSecondsLabel(total: number): string {
  const whole = Math.round(total);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  if (hours > 0) return `${hours} 小时${minutes > 0 ? ` ${minutes} 分钟` : ""}`;
  if (minutes > 0) return `${minutes} 分钟`;
  return `${whole} 秒`;
}

/**
 * 相对时间（列表扫读友好：「3 天前」比完整时间戳一眼可读）
 * @param date 目标时间
 * @param now 当前时间（默认取调用时刻；仅测试注入用）
 * @returns 不足 1 分钟「刚刚」/ 1 小时内「N 分钟前」/ 1 天内「N 小时前」/
 *          7 天内「N 天前」/ 更早回退「YYYY/M/D」日期
 */
export function formatRelativeTime(date: Date, now: Date = new Date()): string {
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return date.toLocaleDateString("zh-CN");
}
