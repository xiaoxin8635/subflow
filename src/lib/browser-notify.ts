/**
 * @file 浏览器系统通知工具（P1.3 任务完成通知）
 * @description 仅供客户端组件使用。约定：
 *              - 仅在页面不可见（document.hidden）时弹系统通知——可见时用户正在看，
 *                页内已有状态展示，弹窗是打扰
 *              - 权限必须由用户点击按钮触发 requestPermission，绝不自动弹授权框
 *              - 全程 try/catch：通知是增强能力，任何失败都静默
 */

/**
 * 当前浏览器是否支持 Notification API
 */
export function notificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/**
 * 读取当前授权状态（不支持时返回 "unsupported"）
 */
export function notificationPermission(): NotificationPermission | "unsupported" {
  return notificationSupported() ? Notification.permission : "unsupported";
}

/**
 * 请求授权（必须由用户点击触发调用）
 */
export async function requestNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (!notificationSupported()) return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return "unsupported";
  }
}

/**
 * 弹系统通知（未授权 / 页面可见 / 不支持时静默跳过）
 * @param title 通知标题
 * @param body  通知正文
 */
export function browserNotify(title: string, body: string): void {
  if (!notificationSupported()) return;
  if (Notification.permission !== "granted") return;
  if (!document.hidden) return;
  try {
    new Notification(title, { body });
  } catch {
    /* 某些环境（如 Android Chrome 要求 ServiceWorker）会抛错，静默 */
  }
}
