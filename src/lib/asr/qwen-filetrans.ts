/**
 * @file qwen3-asr-flash-filetrans 异步转写 provider（DashScope 原生 API）
 * @description 适用：生产环境。流程：提交任务（输入必须是 DashScope 服务器可下载的
 *              公网文件 URL，由调用方通过 publicFileUrl 传入）→ 轮询任务状态 →
 *              SUCCEEDED 后下载 transcription_url 的结果 JSON，解析句级毫秒时间戳。
 *              本地开发因 localhost 不可达而无法使用，请保持 ASR_PROVIDER=qwen-sync；
 *              部署后配置 PUBLIC_ASSET_BASE_URL 并切换。
 * 文档：https://help.aliyun.com/document_detail/3028805.html
 */
import type { AsrProvider, AsrResult, TranscribeOptions } from "./types";

/** DashScope 原生 ASR 异步任务端点（提交与查询同一 URL，查询用 task_id 参数） */
const ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription";

/** 轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 3000;
/** 轮询超时（毫秒）：30 分钟视频，转写一般 1-3 分钟内完成，留足余量 */
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

/** DashScope 异步任务响应结构（仅声明用到的字段） */
interface TaskResponse {
  output?: {
    task_id?: string;
    task_status?: string;
    results?: Array<{
      file_url?: string;
      transcription_url?: string;
      subtask_status?: string;
      code?: string;
      message?: string;
    }>;
  };
  message?: string;
  code?: string;
}

/** 转写结果 JSON 中句级结构（毫秒时间戳） */
interface ResultSentence {
  begin_time?: number;
  end_time?: number;
  text?: string;
}

/** 转写结果 JSON 顶层/中间层结构（做防御性解析） */
interface ResultPayload {
  transcripts?: Array<{ sentences?: ResultSentence[] }>;
  sentences?: ResultSentence[];
}

/**
 * 调用 DashScope 原生 API（Bearer 鉴权）
 * @param pathWithQuery 请求路径（含查询串）
 * @param init          fetch 初始化参数
 */
async function dashscopeFetch(pathWithQuery: string, init?: RequestInit): Promise<TaskResponse> {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("缺少 DASHSCOPE_API_KEY 环境变量");
  const res = await fetch(`${ENDPOINT}${pathWithQuery}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const json = (await res.json()) as TaskResponse;
  if (!res.ok) {
    throw new Error(`DashScope ASR 请求失败：HTTP ${res.status} ${json.code ?? ""} ${json.message ?? ""}`);
  }
  return json;
}

/** qwen3-asr-flash-filetrans 异步 provider */
export const qwenFiletransProvider: AsrProvider = {
  name: "qwen3-asr-flash-filetrans",

  async transcribe({
    language = "zh",
    asrContext,
    publicFileUrl,
  }: TranscribeOptions): Promise<AsrResult> {
    if (!publicFileUrl) {
      throw new Error("qwen-filetrans 需要调用方传入 publicFileUrl（公网可访问的源文件地址）");
    }

    // 1. 提交任务（language=auto 时不传语言参数交给服务端检测；
    //    语境增强（场景/热词）走 parameters.corpus——官方文档热词语料通道）
    const submitRes = await dashscopeFetch("", {
      method: "POST",
      body: JSON.stringify({
        model: "qwen3-asr-flash-filetrans",
        input: { file_urls: [publicFileUrl] },
        parameters: {
          // qwen3-asr-flash-filetrans 的语言参数是顶层 language（string），
          // 不是 paraformer 时代的 language_hints 数组（官方 API 文档）
          ...(language !== "auto" ? { language } : {}),
          ...(asrContext ? { corpus: { text: asrContext } } : {}),
        },
      }),
    });
    const taskId = submitRes.output?.task_id;
    if (!taskId) throw new Error(`提交转写任务失败：${submitRes.message ?? "无 task_id"}`);

    // 2. 轮询任务状态
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let transcriptionUrl: string | undefined;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const pollRes = await dashscopeFetch(`?task_id=${encodeURIComponent(taskId)}`, { method: "GET" });
      const status = pollRes.output?.task_status;
      if (status === "SUCCEEDED") {
        const result = pollRes.output?.results?.[0];
        if (result?.subtask_status === "FAILED" || !result?.transcription_url) {
          throw new Error(`转写子任务失败：${result?.message ?? result?.code ?? "未知原因"}`);
        }
        transcriptionUrl = result.transcription_url;
        break;
      }
      if (status === "FAILED" || status === "CANCELED") {
        throw new Error(`转写任务失败：${pollRes.message ?? status}`);
      }
      // PENDING / RUNNING → 继续等待
    }
    if (!transcriptionUrl) throw new Error("转写任务超时");

    // 3. 下载结果 JSON 并解析句级时间戳（毫秒 → 秒）
    const resultRes = await fetch(transcriptionUrl);
    if (!resultRes.ok) throw new Error(`下载转写结果失败：HTTP ${resultRes.status}`);
    const payload = (await resultRes.json()) as ResultPayload;
    const sentences = payload.transcripts?.flatMap((t) => t.sentences ?? []) ?? payload.sentences ?? [];
    const segments = sentences
      .filter((s) => typeof s.begin_time === "number" && typeof s.end_time === "number" && s.text?.trim())
      .map((s) => ({ start: (s.begin_time as number) / 1000, end: (s.end_time as number) / 1000, text: (s.text as string).trim() }));
    if (segments.length === 0) throw new Error("转写结果为空");

    return { segments, rawText: segments.map((s) => s.text).join(""), provider: this.name };
  },
};
