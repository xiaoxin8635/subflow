"use client";
/**
 * @file 导出卡片（客户端组件）：整片烧录 / 片段裁剪导出（P2.6）/ 双语字幕（P2.7）
 * @description 视频项目：展示预计扣费与当前余额，可选「只导出片段」（输入起止秒，
 *              「当前」按钮读播放器进度），点击「导出视频」创建任务并轮询状态：
 *              idle → submitting → processing → done（下载按钮）/ failed（重试）。
 *              片段导出按片段时长计费（ceil(end-start)），整片按时长计费。
 *              双语字幕（P2.7）：字幕语言选「双语」时携带 targetLang 创建任务，
 *              烧录原文+译文同屏（原文在上、译文在下）；语言下拉仅列出已完成
 *              翻译的语言，未完成任何翻译时提示先去翻译卡翻译。
 *              音频项目：无烧录语义，提供片段裁剪导出（输出 mp3，按片段时长计费）
 *              与字幕文件下载。
 *              余额不足（402）时引导去兑换页。字幕有未保存修改时禁止导出（导出读取库内数据）。
 *              批次①起渲染于编辑器顶部「导出成片」按钮唤起的抽屉内
 *              （ToolDrawer 标题栏已含名称，视频分支卡内不再重复标题）。
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { StyleConfig } from "@/lib/style-config";
import { clipCostSeconds, translateLangLabel } from "@/lib/constants";
import {
  browserNotify,
  notificationPermission,
  requestNotificationPermission,
} from "@/lib/browser-notify";

/** /api/me 返回的余额结构（仅取需要的字段） */
interface MeBody {
  user: { balanceSeconds: number };
}

/** 导出任务状态轮询响应 */
interface ExportTaskBody {
  task: {
    id: string;
    status: "PENDING" | "PROCESSING" | "DONE" | "FAILED";
    error: string | null;
  };
}

/**
 * 秒数格式化为「X 小时 Y 分钟」
 * @param total 总秒数
 */
function formatSeconds(total: number): string {
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  if (minutes > 0) return `${minutes} 分钟`;
  return `${total} 秒`;
}

/**
 * 解析用户输入的秒数（允许一位小数；空串/非法/越界返回 null）
 * @param raw   输入框原始值
 * @param upper 上界（媒体时长；null 表示不设上界校验）
 */
function parseSecInput(raw: string, upper: number | null): number | null {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n) || n < 0) return null;
  if (upper != null && n > upper) return null;
  return n;
}

/** 导出卡片的交互状态机 */
type ExportPhase = "idle" | "submitting" | "processing" | "done" | "failed";

/**
 * 导出卡片组件
 * @param props.projectId      项目 ID
 * @param props.projectTitle   项目标题（系统通知文案用）
 * @param props.durationSec    媒体时长（秒），用于预计扣费展示与片段上界校验
 * @param props.styleId        当前选中样式 ID（官方模板或我的模板的 ID，导出按此样式烧录）
 * @param props.styleName      当前选中样式名称（展示用）
 * @param props.styleSource    样式来源（创建导出时决定请求体用 styleId 还是 userStyleId）
 * @param props.styleConfig    当前预览的样式配置（含未保存微调，随导出请求快照，所见即所得）
 * @param props.assQuery       ASS 下载链接附加的样式 query（如 "styleId=xx" / "userStyleId=yy"）
 * @param props.dirty          字幕是否有未保存修改（true 时禁止导出）
 * @param props.mediaKind      媒体类型（audio 时无烧录语义，提供片段裁剪导出）
 * @param props.getCurrentTime 读播放器当前进度（秒）的回调（「当前」按钮填入起止点用）
 */
export function ExportCard({
  projectId,
  projectTitle,
  durationSec,
  styleId,
  styleName,
  styleSource = "official",
  styleConfig = null,
  assQuery = "",
  dirty,
  mediaKind = "video",
  getCurrentTime,
}: {
  projectId: string;
  projectTitle?: string;
  durationSec: number;
  styleId: string | null;
  styleName: string | null;
  styleSource?: "official" | "user";
  styleConfig?: StyleConfig | null;
  assQuery?: string;
  dirty: boolean;
  mediaKind?: "video" | "audio";
  getCurrentTime?: () => number;
}) {
  const [phase, setPhase] = useState<ExportPhase>("idle");
  const [balance, setBalance] = useState<number | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 片段导出（P2.6）：视频项目为可选开关；音频项目恒为片段模式
  const [clipEnabled, setClipEnabled] = useState(mediaKind === "audio");
  const [clipStartStr, setClipStartStr] = useState("");
  const [clipEndStr, setClipEndStr] = useState("");
  // 双语字幕（P2.7）：已完成翻译的语言（挂载时拉取）+ 双语目标语言（"" = 单语原文）
  const [doneLangs, setDoneLangs] = useState<string[]>([]);
  const [bilingualLang, setBilingualLang] = useState("");
  // 浏览器通知授权状态（SSR 首帧为 unsupported，挂载后读取真实值）
  const [perm, setPerm] = useState<string>("unsupported");
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevPhase = useRef<ExportPhase>("idle");

  // 片段起止解析（clipEnabled=false 时视为整片，恒有效）
  const clipStart = clipEnabled ? parseSecInput(clipStartStr, durationSec) : 0;
  const clipEnd = clipEnabled ? parseSecInput(clipEndStr, durationSec) : 0;
  const clipValid = !clipEnabled || (clipStart != null && clipEnd != null && clipEnd > clipStart);

  // 挂载后读取通知授权状态（微任务：Notification 仅浏览器可读，避免 effect 内同步 setState）
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) setPerm(notificationPermission());
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    const label = projectTitle ? `「${projectTitle}」` : "视频";
    if (prevPhase.current === "processing" && phase === "done") {
      browserNotify("导出完成", `${label}已${clipEnabled ? "片段" : ""}导出完成，可下载成片`);
    } else if (prevPhase.current === "processing" && phase === "failed") {
      browserNotify("导出失败", `${label}导出失败，请回页面查看原因`);
    }
    prevPhase.current = phase;
  }, [phase, projectTitle, clipEnabled]);

  // 预计扣费：片段按片段时长（ceil(end-start)），整片按媒体时长
  const costSeconds =
    clipEnabled && clipStart != null && clipEnd != null && clipEnd > clipStart
      ? clipCostSeconds(clipStart, clipEnd)
      : Math.ceil(durationSec);
  const insufficient = balance != null && balance < costSeconds;

  // 挂载时拉取余额
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/me", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as MeBody;
        if (!cancelled) setBalance(body.user.balanceSeconds);
      } catch {
        // 余额获取失败不阻断导出（后端会再次预检）
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 挂载时拉取已完成翻译的语言列表（双语烧录选项；音频项目无烧录语义跳过）
  useEffect(() => {
    if (mediaKind === "audio") return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/translations`, { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { translations?: { targetLang: string; status: string }[] };
        const langs = (body.translations ?? [])
          .filter((t) => t.status === "DONE")
          .map((t) => t.targetLang);
        if (!cancelled) setDoneLangs(langs);
      } catch {
        // 翻译列表获取失败仅影响双语选项（后端创建时仍有校验兜底）
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, mediaKind]);

  // 轮询任务状态直至终态；卸载时清理
  useEffect(() => {
    if (phase !== "processing" || !taskId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/exports/${taskId}`, { cache: "no-store" });
        if (res.ok) {
          const body = (await res.json()) as ExportTaskBody;
          if (cancelled) return;
          if (body.task.status === "DONE") {
            setPhase("done");
            // 扣费后刷新余额展示
            const me = await fetch("/api/me", { cache: "no-store" });
            if (me.ok) setBalance(((await me.json()) as MeBody).user.balanceSeconds);
            return;
          }
          if (body.task.status === "FAILED") {
            setError(body.task.error ?? "导出失败");
            setPhase("failed");
            return;
          }
        }
      } catch {
        // 网络抖动：下一轮重试
      }
      if (!cancelled) pollTimer.current = setTimeout(poll, 2000);
    };
    pollTimer.current = setTimeout(poll, 1500);
    return () => {
      cancelled = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [phase, taskId]);

  /**
   * 创建导出任务（整片或片段）
   */
  async function handleExport() {
    if (!styleId && mediaKind !== "audio") return;
    if (!clipValid || phase === "submitting" || phase === "processing") return;
    setPhase("submitting");
    setError(null);
    try {
      // 样式标识按来源二选一（音频片段无样式语义不传）；始终携带当前预览配置快照（微调未保存也按所见导出）
      const res = await fetch(`/api/projects/${projectId}/exports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(mediaKind === "audio"
            ? {}
            : styleSource === "user"
              ? { userStyleId: styleId }
              : { styleId }),
          ...(mediaKind !== "audio" && styleConfig ? { styleConfig } : {}),
          ...(clipEnabled && clipStart != null && clipEnd != null
            ? { startSec: clipStart, endSec: clipEnd }
            : {}),
          // 双语字幕（P2.7）：选了双语语言时携带（仅视频项目有此选项）
          ...(mediaKind !== "audio" && bilingualLang ? { targetLang: bilingualLang } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { taskId?: string; error?: string };
      if (!res.ok || !body.taskId) {
        setError(body.error ?? `导出失败（HTTP ${res.status}）`);
        setPhase("failed");
        return;
      }
      setTaskId(body.taskId);
      setPhase("processing");
    } catch {
      setError("网络异常，请稍后重试");
      setPhase("failed");
    }
  }

  /** 「当前」按钮：把播放器进度填入指定输入框（保留 1 位小数） */
  function fillCurrent(target: "start" | "end") {
    const t = getCurrentTime?.() ?? 0;
    const rounded = Math.min(durationSec, Math.round(t * 10) / 10);
    if (target === "start") setClipStartStr(String(rounded));
    else setClipEndStr(String(rounded));
  }

  const busy = phase === "submitting" || phase === "processing";
  const disabled = (mediaKind !== "audio" && !styleId) || busy || dirty || !clipValid;
  /** 片段输入行（起止秒 + 「当前」按钮），视频/音频分支共用 */
  const clipInputs = (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
      <label className="flex items-center gap-1.5">
        <span className="text-neutral-500">开始</span>
        <input
          type="text"
          inputMode="decimal"
          value={clipStartStr}
          onChange={(e) => setClipStartStr(e.target.value)}
          placeholder="0"
          className={`w-20 rounded-lg border bg-white/[0.04] px-2 py-1 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-brand/30 ${
            clipEnabled && clipStart == null ? "border-red-400" : "border-white/10"
          }`}
        />
        <span className="text-neutral-400">s</span>
      </label>
      <button
        type="button"
        onClick={() => fillCurrent("start")}
        title="填入播放器当前进度"
        className="rounded-lg border border-white/10 px-2 py-1 text-xs text-neutral-400 transition-colors hover:border-brand hover:text-brand-strong"
      >
        当前
      </button>
      <label className="flex items-center gap-1.5">
        <span className="text-neutral-500">结束</span>
        <input
          type="text"
          inputMode="decimal"
          value={clipEndStr}
          onChange={(e) => setClipEndStr(e.target.value)}
          placeholder={String(Math.round(durationSec))}
          className={`w-20 rounded-lg border bg-white/[0.04] px-2 py-1 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-brand/30 ${
            clipEnabled && clipEnd == null ? "border-red-400" : "border-white/10"
          }`}
        />
        <span className="text-neutral-400">s</span>
      </label>
      <button
        type="button"
        onClick={() => fillCurrent("end")}
        title="填入播放器当前进度"
        className="rounded-lg border border-white/10 px-2 py-1 text-xs text-neutral-400 transition-colors hover:border-brand hover:text-brand-strong"
      >
        当前
      </button>
      {clipEnabled && !clipValid && (
        <span className="text-xs text-red-400">
          请填写 0 ~ {Math.round(durationSec)}s 内的起止秒，且结束需大于开始
        </span>
      )}
    </div>
  );

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.04] p-4">
      {mediaKind === "audio" ? (
        /* 纯音频项目：无烧录语义，提供片段裁剪导出（纯裁剪输出 mp3） */
        <div>
          <p className="text-sm font-medium">片段裁剪导出</p>
          <p className="mt-0.5 text-xs text-neutral-400">
            选择时间段裁剪音频（输出 mp3，按片段时长计费）；字幕文件可直接下载（SRT / VTT / ASS，不消耗额度）
          </p>
          {clipInputs}
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-xs text-neutral-400">
              预计消耗 {costSeconds} 秒额度
              {balance != null && <> · 当前余额 {formatSeconds(balance)}</>}
            </p>
            {phase === "done" && taskId ? (
              <a
                href={`/api/exports/${taskId}/download`}
                className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
              >
                ⬇ 下载片段
              </a>
            ) : (
              <button
                onClick={handleExport}
                disabled={disabled || insufficient}
                title={
                  dirty
                    ? "字幕有未保存修改，请先保存"
                    : !clipValid
                      ? "请填写合法的片段区间"
                      : insufficient
                        ? "余额不足"
                        : undefined
                }
                className="rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-50"
              >
                {phase === "submitting" ? "创建任务…" : phase === "processing" ? "裁剪中…" : "导出片段"}
              </button>
            )}
          </div>
        </div>
      ) : (
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="mt-0.5 text-xs text-neutral-400">
              按所选样式（{styleName ?? "未选择"}）烧录字幕 · 预计消耗 {costSeconds} 秒额度
              {balance != null && <> · 当前余额 {formatSeconds(balance)}</>}
            </p>
          </div>

          {phase === "done" && taskId ? (
            <a
              href={`/api/exports/${taskId}/download`}
              className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
            >
              ⬇ 下载成片
            </a>
          ) : (
            <button
              onClick={handleExport}
              disabled={disabled || insufficient}
              title={
                dirty
                  ? "字幕有未保存修改，请先保存"
                  : !styleId
                    ? "请先选择字幕样式"
                    : !clipValid
                      ? "请填写合法的片段区间"
                      : insufficient
                        ? "余额不足"
                        : undefined
              }
              className="rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-50"
            >
              {phase === "submitting" ? "创建任务…" : phase === "processing" ? "导出中…" : clipEnabled ? "导出片段" : "导出视频"}
            </button>
          )}
        </div>

        {/* 片段导出开关与区间输入（P2.6） */}
        <label className="mt-3 flex w-fit cursor-pointer items-center gap-2 text-sm text-neutral-300">
          <input
            type="checkbox"
            checked={clipEnabled}
            onChange={(e) => setClipEnabled(e.target.checked)}
            className="h-4 w-4 accent-brand"
          />
          只导出片段（裁剪所选时间段，按片段时长计费）
        </label>
        {clipEnabled && clipInputs}

        {/* 字幕语言（P2.7 双语）：原文 / 双语（原文+译文同屏，原文在上译文在下） */}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
          <span className="text-neutral-400">字幕语言</span>
          <label className="flex cursor-pointer items-center gap-1.5 text-neutral-300">
            <input
              type="radio"
              name="subLang"
              checked={!bilingualLang}
              onChange={() => setBilingualLang("")}
              className="accent-brand"
            />
            原文
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-neutral-300">
            <input
              type="radio"
              name="subLang"
              checked={!!bilingualLang}
              onChange={() => setBilingualLang(doneLangs[0] ?? "")}
              disabled={doneLangs.length === 0}
              className="accent-brand disabled:cursor-not-allowed disabled:opacity-40"
            />
            双语（原文 + 译文）
          </label>
          {!!bilingualLang && (
            <select
              value={bilingualLang}
              onChange={(e) => setBilingualLang(e.target.value)}
              className="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
            >
              {doneLangs.map((lang) => (
                <option key={lang} value={lang}>
                  {translateLangLabel(lang) ?? lang}
                </option>
              ))}
            </select>
          )}
          {doneLangs.length === 0 && (
            <span className="text-xs text-neutral-500">完成一次翻译后可烧录双语字幕（见下方翻译卡）</span>
          )}
        </div>
      </div>
      )}

      {/* 字幕文件下载（纯文本生成不扣额度；读取库内数据，未保存修改时同样禁用） */}
      <div className="mt-3 flex items-center justify-between gap-3 border-t border-white/10 pt-3">
        <p className="text-xs text-neutral-500">
          字幕文件下载 · 不消耗额度{dirty && " · 有未保存修改时下载的是已保存版本"}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <a
            href={`/api/projects/${projectId}/srt`}
            title={dirty ? "建议先保存修改，下载内容为已保存版本" : "通用格式：剪映 / PR / 达芬奇"}
            className={`rounded-xl border border-white/10 px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:border-white/25 ${
              dirty ? "opacity-60" : ""
            }`}
          >
            ⬇ SRT
          </a>
          <a
            href={`/api/projects/${projectId}/vtt`}
            title={dirty ? "建议先保存修改，下载内容为已保存版本" : "网页播放器通用（HTML5 track）"}
            className={`rounded-xl border border-white/10 px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:border-white/25 ${
              dirty ? "opacity-60" : ""
            }`}
          >
            ⬇ VTT
          </a>
          <a
            href={`/api/projects/${projectId}/ass${assQuery ? `?${assQuery}` : ""}`}
            title={dirty ? "建议先保存修改，下载内容为已保存版本" : "带样式与关键词高亮：mpv / PotPlayer 直接挂载（按所选模板配置，未保存的微调不含在内）"}
            className={`rounded-xl border border-white/10 px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:border-white/25 ${
              dirty ? "opacity-60" : ""
            }`}
          >
            ⬇ ASS
          </a>
        </div>
      </div>

      {/* 导出进行中提示 */}
      {phase === "processing" && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-neutral-400">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-brand/20 border-t-brand" />
          FFmpeg 正在{clipEnabled ? "裁剪" : bilingualLang ? "烧录双语字幕" : "烧录字幕"}，一般几秒到几分钟（取决于媒体长度）…
          {perm === "default" && (
            <button
              type="button"
              onClick={() => void requestNotificationPermission().then(setPerm)}
              className="text-xs text-neutral-500 underline underline-offset-2 transition-colors hover:text-brand-strong"
            >
              开启完成提醒（切到其他页面时通知你）
            </button>
          )}
        </div>
      )}

      {/* 余额不足引导 */}
      {insufficient && !busy && (
        <p className="mt-3 text-sm text-amber-400">
          额度不足：本次导出需 {costSeconds} 秒。
          <Link href="/dashboard/redeem" className="ml-1 underline underline-offset-2">
            去兑换额度 →
          </Link>
        </p>
      )}

      {/* 未保存修改提示 */}
      {dirty && !busy && (
        <p className="mt-3 text-sm text-amber-400">字幕有未保存修改，请先点击右上角「保存修改」再导出</p>
      )}

      {/* 失败信息 + 重试 */}
      {phase === "failed" && error && (
        <div className="mt-3">
          <p className="text-sm text-red-400">导出失败：{error}</p>
          <button
            onClick={() => setPhase("idle")}
            className="mt-1 text-sm text-brand-strong underline underline-offset-2"
          >
            返回重试
          </button>
        </div>
      )}
    </div>
  );
}
