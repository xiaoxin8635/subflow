/**
 * @file AI 网关客户端工厂（OpenAI 兼容 chat 调用统一入口）
 * @description 为润色 / 翻译 / OCR / ASR 同步转写等 OpenAI 兼容调用创建客户端。
 *   优先接入 AI 网关（new-api 自托管网关，配置 AI_GATEWAY_BASE_URL +
 *   AI_GATEWAY_API_KEY）：由网关在多个上游渠道（DashScope / 火山方舟等）间做
 *   优先级路由与失败自动切换（额度耗尽表现为上游报错，网关秒切备用渠道）；
 *   网关未配置时回落 DashScope 兼容模式直连——渐进式迁移，可随时回滚。
 *   注意：ASR 异步文件转写（qwen-filetrans）是 DashScope 专有 API，不走本
 *   工厂，保持直连（见 src/lib/asr/qwen-filetrans.ts）。
 */
import OpenAI from "openai";

/** DashScope 兼容模式直连地址（未配置网关时的回落目标） */
const DASHSCOPE_COMPAT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

/**
 * 创建 OpenAI 兼容 chat 客户端（网关优先，未配置网关回落 DashScope 直连）
 * @throws 网关与直连配置均缺失时抛错（启动期即可发现配置问题）
 */
export function createChatClient(): OpenAI {
  const gatewayBaseUrl = process.env.AI_GATEWAY_BASE_URL?.trim();
  const gatewayApiKey = process.env.AI_GATEWAY_API_KEY?.trim();
  if (gatewayBaseUrl && gatewayApiKey) {
    return new OpenAI({ apiKey: gatewayApiKey, baseURL: gatewayBaseUrl });
  }
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "缺少 AI 调用配置：请设置 DASHSCOPE_API_KEY（直连），或 AI_GATEWAY_BASE_URL + AI_GATEWAY_API_KEY（走网关）",
    );
  }
  return new OpenAI({ apiKey, baseURL: DASHSCOPE_COMPAT_BASE_URL });
}
