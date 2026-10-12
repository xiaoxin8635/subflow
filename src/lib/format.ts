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
