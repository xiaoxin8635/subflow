/**
 * @file 短信验证码发送服务
 * @description 双模式设计：
 *   - 开发模式（SMS_DEV_MODE=true）：不下发真实短信，验证码打印到服务端控制台，
 *     并接受 DEV_FIXED_CODE 作为万能验证码，便于本地联调。
 *   - 生产模式：阿里云短信（dysmsapi SDK），需提前报备签名（SignName）与模板（TemplateCode）。
 *     AK 建议使用仅授予 AliyunDysmsFullAccess 权限的 RAM 子账号，不要用主账号 AK。
 * 本模块只负责「发送」；验证码的生成、存储与校验在 /api/auth/* 路由中完成。
 */
import Dysmsapi20170525, * as $Dysmsapi from "@alicloud/dysmsapi20170525";
import { Config } from "@alicloud/openapi-client";

/** 是否处于开发模式（未配置真实短信时必须为 true） */
export const isSmsDevMode = (): boolean => process.env.SMS_DEV_MODE === "true";

/**
 * 发送短信验证码
 * @param phone 目标手机号（11 位大陆手机号）
 * @param code 6 位数字验证码（明文，仅发送瞬间使用）
 * @throws 生产模式下发送失败时抛出异常（含阿里云返回的错误信息）
 */
export async function sendVerificationCode(phone: string, code: string): Promise<void> {
  if (isSmsDevMode()) {
    // 开发模式：仅打印到服务端日志，方便本地调试查看
    console.log(`[sms:dev] 验证码 ${code} → ${phone}（开发模式，未下发真实短信）`);
    return;
  }

  const signName = process.env.ALIYUN_SMS_SIGN_NAME;
  const templateCode = process.env.ALIYUN_SMS_TEMPLATE_CODE;
  const akId = process.env.ALIYUN_AK_ID;
  const akSecret = process.env.ALIYUN_AK_SECRET;
  if (!signName || !templateCode || !akId || !akSecret) {
    throw new Error("短信服务未正确配置：缺少 SIGN_NAME / TEMPLATE_CODE / AK 凭据");
  }

  const config = new Config({ accessKeyId: akId, accessKeySecret: akSecret });
  config.endpoint = "dysmsapi.aliyuncs.com";
  const client = new Dysmsapi20170525(config);

  const request = new $Dysmsapi.SendSmsRequest({
    phoneNumbers: phone,
    signName,
    templateCode,
    templateParam: JSON.stringify({ code }),
  });

  const response = await client.sendSms(request);
  if (response.body?.code !== "OK") {
    throw new Error(`短信发送失败：${response.body?.code ?? "UNKNOWN"} ${response.body?.message ?? ""}`);
  }
}
