/**
 * @file 管理后台鉴权辅助
 * @description 通过 ADMIN_PHONES 环境变量（逗号分隔手机号白名单）判定管理员。
 *              未配置则无人是管理员（后台页面与 API 均按不存在处理，返回 404，
 *              不向未授权者暴露后台的存在）。
 */

/** 解析白名单（小写化去空格；手机号本身无大小写差异，防御性处理） */
function adminPhones(): Set<string> {
  return new Set(
    (process.env.ADMIN_PHONES ?? "")
      .split(/[,,]/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * 判定用户是否为管理员
 * @param phone 用户手机号（完整，非脱敏）
 */
export function isAdminPhone(phone: string): boolean {
  return adminPhones().has(phone);
}

/** 当前是否配置了管理员白名单（部署文档提示用） */
export function hasAdminConfig(): boolean {
  return adminPhones().size > 0;
}
