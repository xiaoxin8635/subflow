/**
 * @file ASR provider 工厂
 * @description 按 ASR_PROVIDER 环境变量选择 provider：
 *   - qwen-sync（默认，本地开发）：qwen3-asr-flash 同步调用 + 语音段对齐时间戳
 *   - qwen-filetrans（生产）：qwen3-asr-flash-filetrans 异步任务 + 原生毫秒时间戳
 *     （需配置 PUBLIC_ASSET_BASE_URL，流水线会传入源文件公网 URL）
 */
import { qwenSyncProvider } from "./qwen-sync";
import { qwenFiletransProvider } from "./qwen-filetrans";
import type { AsrProvider } from "./types";

/** 获取当前配置的 ASR provider 实例 */
export function getAsrProvider(): AsrProvider {
  const provider = process.env.ASR_PROVIDER ?? "qwen-sync";
  switch (provider) {
    case "qwen-sync":
      return qwenSyncProvider;
    case "qwen-filetrans":
      return qwenFiletransProvider;
    default:
      throw new Error(`未知的 ASR_PROVIDER：${provider}（可选值：qwen-sync / qwen-filetrans）`);
  }
}

// 类型统一从这里导出，业务层不直接依赖具体 provider 文件
export type { AsrProvider, AsrResult, AsrSegment, StoredSegment } from "./types";
