"use client";
/**
 * @file 字幕翻译卡（P2.4）：项目详情页 READY 态展示
 * @description 功能：选择目标语言与翻译风格发起 LLM 翻译（付费，按源字幕字数计费；
 *              P2.11 风格随任务快照存储，项目热词自动作为术语表注入）；
 *              展示项目全部翻译任务状态（进行中轮询推进 / 已完成提供
 *              SRT/VTT/ASS 三格式下载 + 双语 SRT/ASS 下载（原文在上、译文在下，
 *              P2.7）/ 失败展示原因并可重试；已完成语言可「重新翻译」覆盖旧版本）。
 *              数据源：GET /api/projects/[id]/translations（列表，含状态），
 *              存在进行中任务时每 3 秒轮询；发起 POST 创建任务。
 *              客户端额度估算仅作展示，实际以服务端下单时字数为准。
 */
import { useCallback, useEffect, useState } from "react";
import { TRANSLATE_LANGUAGES, TRANSLATE_STYLES, translateCostSeconds } from "@/lib/constants";

/** 翻译任务行（GET /api/projects/[id]/translations 响应元素） */
interface TranslationRow {
  id: string;
  targetLang: string;
  style?: string;
  status: "PENDING" | "PROCESSING" | "DONE" | "FAILED";
  charCount: number | null;
  costSeconds: number | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** 进行中状态集合（判断是否需要轮询） */
const ACTIVE = new Set(["PENDING", "PROCESSING"]);

/**
 * 翻译卡组件
 * @param projectId 项目 ID（API 地址）
 * @param charCount 源字幕总字符数（客户端预估计费用）
 */
export function TranslateCard({
  projectId,
  charCount,
}: {
  projectId: string;
  charCount: number;
}) {
  const [translations, setTranslations] = useState<TranslationRow[] | null>(null);
  const [selected, setSelected] = useState<string>("en");
  const [style, setStyle] = useState<string>("general");
  const [starting, setStarting] = useState(false);
  const [msg, setMsg] = useState("");

  /** 拉取项目翻译任务列表（轮询与手动刷新共用） */
  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/translations`, { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { translations: TranslationRow[] };
      setTranslations(body.translations);
    } catch {
      // 网络抖动：保留旧数据，等待下一轮
    }
  }, [projectId]);

  // 挂载后拉取列表（微任务包裹：避免 effect 内同步 setState 触发 eslint 规则）
  useEffect(() => {
    void Promise.resolve().then(() => void refresh());
  }, [refresh]);

  // 存在进行中任务时轮询推进状态（全部终态自动停止）
  const hasActive = translations?.some((t) => ACTIVE.has(t.status)) ?? false;
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [hasActive, refresh]);

  /**
   * 发起翻译（新语言或覆盖旧版本）
   * @param lang 目标语言代码
   */
  async function start(lang: string) {
    setMsg("");
    setStarting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/translations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetLang: lang, style }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setMsg(body.error ?? `请求失败（HTTP ${res.status}）`);
      }
      // 无论成败都刷新列表（409 已在进行中 / 成功创建都需要看到最新状态）
      await refresh();
    } catch {
      setMsg("网络异常，请稍后重试");
    } finally {
      setStarting(false);
    }
  }

  /** 语言代码 → 展示名（未知代码兜底显示原值） */
  const langLabelOf = (code: string) => TRANSLATE_LANGUAGES.find((l) => l.code === code)?.label ?? code;
  const selectedLabel = langLabelOf(selected);
  const estimate = translateCostSeconds(Math.max(charCount, 1));

  const chipActive = "border-brand bg-brand/5 text-brand";
  const chipIdle = "border-black/10 text-neutral-600 hover:border-black/20";

  return (
    <div className="mt-6 rounded-2xl border border-black/5 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">🌐 字幕翻译</h2>
        <p className="text-xs text-neutral-400">按源字幕字数计费：每 1000 字 60 秒额度，最低 60 秒</p>
      </div>
      <p className="mt-1 text-sm text-neutral-500">
        将整份字幕翻译为目标语言，生成新的字幕文件（时间轴与原文逐行对齐）。
      </p>

      {/* 语言选择 */}
      <div className="mt-4 flex flex-wrap gap-2">
        {TRANSLATE_LANGUAGES.map((l) => (
          <button
            key={l.code}
            type="button"
            onClick={() => setSelected(l.code)}
            className={`rounded-full border px-3.5 py-1.5 text-sm transition-colors ${
              selected === l.code ? chipActive : chipIdle
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>

      {/* 翻译风格（P2.11）：随任务快照存储，重新翻译可换风格 */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-sm text-neutral-500">风格</span>
        {TRANSLATE_STYLES.map((s) => (
          <button
            key={s.code}
            type="button"
            title={s.instruction}
            onClick={() => setStyle(s.code)}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
              style === s.code ? chipActive : chipIdle
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* 发起翻译 */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-neutral-50 px-4 py-3">
        <p className="text-sm text-neutral-600">
          翻译为{selectedLabel} · 预计消耗约 <span className="font-medium text-neutral-800">{estimate}</span> 秒额度
          （以下单时实际字数为准）
        </p>
        <button
          type="button"
          disabled={starting}
          onClick={() => void start(selected)}
          className="rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {starting ? "提交中…" : "开始翻译"}
        </button>
      </div>
      {msg && <p className="mt-3 text-sm text-red-600">{msg}</p>}

      {/* 已有翻译任务列表 */}
      {translations && translations.length > 0 && (
        <ul className="mt-4 divide-y divide-neutral-100 border-t border-neutral-100">
          {translations.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{langLabelOf(t.targetLang)} 字幕</p>
                <p className="mt-0.5 text-xs text-neutral-400">
                  {t.status === "DONE" &&
                    `已完成（${t.charCount ?? "?"} 字 · 消耗 ${t.costSeconds ?? "?"} 秒额度）`}
                  {t.status === "FAILED" && `失败：${t.error ?? "未知原因"}`}
                  {ACTIVE.has(t.status) && "翻译中…（完成后自动更新）"}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {t.status === "DONE" && (
                  <>
                    <a
                      href={`/api/translations/${t.id}/srt`}
                      className="rounded-lg border border-black/10 px-2.5 py-1 text-xs text-neutral-600 transition-colors hover:border-brand hover:text-brand"
                    >
                      SRT
                    </a>
                    <a
                      href={`/api/translations/${t.id}/vtt`}
                      className="rounded-lg border border-black/10 px-2.5 py-1 text-xs text-neutral-600 transition-colors hover:border-brand hover:text-brand"
                    >
                      VTT
                    </a>
                    <a
                      href={`/api/translations/${t.id}/ass`}
                      title="使用系统默认样式"
                      className="rounded-lg border border-black/10 px-2.5 py-1 text-xs text-neutral-600 transition-colors hover:border-brand hover:text-brand"
                    >
                      ASS
                    </a>
                    <a
                      href={`/api/translations/${t.id}/srt?bilingual=1`}
                      title="原文在上、译文在下（每条字幕双行），可用于剪映等软件手动挂载"
                      className="rounded-lg border border-brand/30 bg-brand/5 px-2.5 py-1 text-xs text-brand transition-colors hover:border-brand"
                    >
                      双语SRT
                    </a>
                    <a
                      href={`/api/translations/${t.id}/ass?bilingual=1`}
                      title="原文在上、译文在下（系统默认样式），可用于 mpv / PotPlayer 挂载或剪辑软件"
                      className="rounded-lg border border-brand/30 bg-brand/5 px-2.5 py-1 text-xs text-brand transition-colors hover:border-brand"
                    >
                      双语ASS
                    </a>
                    <button
                      type="button"
                      disabled={starting || hasActive}
                      onClick={() => void start(t.targetLang)}
                      className="rounded-lg px-2.5 py-1 text-xs text-neutral-500 underline underline-offset-2 transition-colors hover:text-brand disabled:opacity-50"
                    >
                      重新翻译
                    </button>
                  </>
                )}
                {t.status === "FAILED" && (
                  <button
                    type="button"
                    disabled={starting}
                    onClick={() => void start(t.targetLang)}
                    className="rounded-lg border border-black/10 px-2.5 py-1 text-xs text-neutral-600 transition-colors hover:border-brand hover:text-brand disabled:opacity-50"
                  >
                    重试
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
