/**
 * @file 字幕 LLM 批量翻译模块（qwen-flash，DashScope OpenAI 兼容模式）
 * @description 将整项目字幕文本翻译为目标语言（P2.4 付费点）。与 polish.ts 的
 *   关键差异：翻译是用户付费购买的产物，任何失败都必须抛错（由队列重试 /
 *   标记 FAILED），绝不静默回退原文——否则用户为「翻译」付了钱却拿到原文。
 *   长字幕按批次切分逐批翻译（单次 LLM 调用输出 token 有限，整项目一次调用
 *   在分段多时会截断），批内要求句数严格一致且逐句非空。
 */
import OpenAI from "openai";

/** 单次 LLM 调用翻译的句子数上限（控制输出长度，防止截断） */
const TRANSLATE_BATCH_SIZE = 40;

/** 创建 DashScope 兼容模式客户端（与 polish.ts 同一接入方式） */
function newClient(): OpenAI {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("缺少 DASHSCOPE_API_KEY 环境变量");
  return new OpenAI({
    apiKey,
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  });
}

/**
 * 翻译单个批次（一次 LLM 调用），失败直接抛错
 * @param texts 批内源句数组
 * @param targetLang 目标语言代码（提示词用）
 * @param langLabel 目标语言展示名（提示词用，比代码更利于模型理解）
 * @returns 与输入等长的译文数组（已逐句校验非空字符串）
 * @throws API 调用失败 / 返回不含 JSON / 句数不符 / 存在空译文时抛 Error
 */
async function translateBatchOnce(
  texts: string[],
  targetLang: string,
  langLabel: string,
): Promise<string[]> {
  const res = await newClient().chat.completions.create({
    model: "qwen-flash",
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content:
          `你是专业短视频字幕翻译。把给定的每句简体中文文本翻译成${langLabel}。` +
          "严格要求：逐句翻译，不合并或拆分句子，句数与输入完全一致；" +
          "译文保持字幕长度（简洁口语化，不逐字硬译）；不添加任何解释、序号或前后缀；" +
          "专有名词/品牌名保留原文。",
      },
      {
        role: "user",
        content:
          `输入 ${texts.length} 句：\n${JSON.stringify({ lines: texts })}\n` +
          `请仅输出 JSON（不要 markdown 代码块）：{"lines":["译文1","译文2",...]}，` +
          `lines 数组长度必须等于 ${texts.length}，且每项为非空${langLabel}文本。`,
      },
    ],
  });

  const content = res.choices[0]?.message?.content ?? "";
  // 容错提取：模型偶尔会包一层 ```json ... ```
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("翻译返回内容不含 JSON");
  const parsed = JSON.parse(match[0]) as { lines?: unknown };
  const lines: unknown = parsed.lines;
  if (!Array.isArray(lines) || lines.length !== texts.length) {
    throw new Error(
      `翻译句数不匹配（期望 ${texts.length}，实际 ${Array.isArray(lines) ? lines.length : 0}）`,
    );
  }
  // 逐句校验：任何一句非字符串/空白都算失败（索引错位会让整条字幕不可用）
  return lines.map((t, i) => {
    if (typeof t !== "string" || !t.trim()) {
      throw new Error(`第 ${i + 1} 句译文为空或非法`);
    }
    return t.trim();
  });
}

/**
 * 翻译整项目字幕（自动分批，顺序执行批间调用）
 * @param texts 源句数组（与转写分段一一对应）
 * @param targetLang 目标语言代码（TRANSLATE_LANGUAGES 白名单内的 code）
 * @param langLabel 目标语言展示名
 * @returns 与输入索引对齐的译文数组
 * @throws 任一批次失败即抛错（带批次序号上下文，便于排查）
 */
export async function translateSegments(
  texts: string[],
  targetLang: string,
  langLabel: string,
): Promise<string[]> {
  if (texts.length === 0) return [];

  const out: string[] = [];
  for (let i = 0; i < texts.length; i += TRANSLATE_BATCH_SIZE) {
    const batch = texts.slice(i, i + TRANSLATE_BATCH_SIZE);
    try {
      const translated = await translateBatchOnce(batch, targetLang, langLabel);
      out.push(...translated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `翻译批次失败（第 ${Math.floor(i / TRANSLATE_BATCH_SIZE) + 1} 批，` +
          `第 ${i + 1}-${i + batch.length} 句）：${msg}`,
        { cause: err },
      );
    }
  }
  return out;
}
