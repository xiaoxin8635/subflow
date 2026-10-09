/**
 * @file 字幕 LLM 润色模块（qwen-flash，DashScope OpenAI 兼容模式）
 * @description 对 ASR 逐句文本做错别字修正/标点规范/书面化处理，要求：
 *   - 严格保持句数与语序不变（字幕需要与时间轴一一对应）；
 *   - 返回等长 JSON 数组；解析失败或长度不符时整体回退原文（降级不阻断流水线）。
 */
import OpenAI from "openai";

/** 创建 DashScope 兼容模式客户端 */
function newClient(): OpenAI {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("缺少 DASHSCOPE_API_KEY 环境变量");
  return new OpenAI({
    apiKey,
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  });
}

/**
 * 润色字幕文本
 * @param texts ASR 原始句子数组
 * @returns texts 润色后的句子数组（长度与输入一致）、polished 是否成功润色
 */
export async function polishSegments(
  texts: string[],
): Promise<{ texts: string[]; polished: boolean }> {
  if (texts.length === 0) return { texts, polished: false };
  if (!process.env.DASHSCOPE_API_KEY) return { texts, polished: false };

  try {
    const res = await newClient().chat.completions.create({
      model: "qwen-flash",
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content:
            "你是短视频字幕校对助手。对语音转写文本逐句修正：错别字、多字漏字、标点规范、" +
            "明显的同音字错误。严格要求：不改变语义与语序，不合并或拆分句子，" +
            "不添加任何解释或前后缀，输出句数必须与输入完全一致。",
        },
        {
          role: "user",
          content:
            `输入 ${texts.length} 句：\n${JSON.stringify({ lines: texts })}\n` +
            '请仅输出 JSON（不要 markdown 代码块）：{"lines":["第1句","第2句",...]}，' +
            `lines 数组长度必须等于 ${texts.length}。`,
        },
      ],
    });

    const content = res.choices[0]?.message?.content ?? "";
    // 容错解析：模型偶尔会包一层 ```json ... ```
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      console.warn("[polish] 返回内容不含 JSON，回退原文");
      return { texts, polished: false };
    }
    const parsed = JSON.parse(match[0]) as { lines?: unknown };
    const lines: unknown = parsed.lines;
    if (!Array.isArray(lines) || lines.length !== texts.length) {
      console.warn(`[polish] 句数不匹配（期望 ${texts.length}，实际 ${Array.isArray(lines) ? lines.length : 0}），回退原文`);
      return { texts, polished: false };
    }
    return {
      texts: lines.map((t, i) =>
        typeof t === "string" && t.trim() ? t.trim() : texts[i],
      ),
      polished: true,
    };
  } catch (err) {
    // 润色是增强步骤，失败不阻断转写流水线
    console.warn("[polish] 润色请求失败，回退原文：", err);
    return { texts, polished: false };
  }
}
