"use client";
/**
 * @file 导出卡片（客户端组件）
 * @description 展示预计扣费与当前余额，点击「导出视频」创建烧录任务并轮询状态：
 *              idle → submitting → processing → done（下载按钮）/ failed（重试）。
 *              余额不足（402）时引导去兑换页。字幕有未保存修改时禁止导出（导出读取库内数据）。
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
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

/** 导出卡片的交互状态机 */
type ExportPhase = "idle" | "submitting" | "processing" | "done" | "failed";

/**
 * 导出卡片组件
 * @param props.projectId    项目 ID
 * @param props.projectTitle 项目标题（系统通知文案用）
 * @param props.durationSec  视频时长（秒），用于预计扣费展示
 * @param props.styleId      当前选中样式 ID（导出按此样式烧录）
 * @param props.styleName    当前选中样式名称（展示用）
 * @param props.dirty        字幕是否有未保存修改（true 时禁止导出）
 */
export function ExportCard({
  projectId,
  projectTitle,
  durationSec,
  styleId,
  styleName,
  dirty,
}: {
  projectId: string;
  projectTitle?: string;
  durationSec: number;
  styleId: string | null;
  styleName: string | null;
  dirty: boolean;
}) {
  const [phase, setPhase] = useState<ExportPhase>("idle");
  const [balance, setBalance] = useState<number | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 浏览器通知授权状态（SSR 首帧为 unsupported，挂载后读取真实值）
  const [perm, setPerm] = useState<string>("unsupported");
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevPhase = useRef<ExportPhase>("idle");

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
      browserNotify("导出完成", `${label}已烧录完成，可下载成片`);
    } else if (prevPhase.current === "processing" && phase === "failed") {
      browserNotify("导出失败", `${label}导出失败，请回页面查看原因`);
    }
    prevPhase.current = phase;
  }, [phase, projectTitle]);

  const costSeconds = Math.ceil(durationSec);
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
   * 创建导出任务
   */
  async function handleExport() {
    if (!styleId || phase === "submitting" || phase === "processing") return;
    setPhase("submitting");
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/exports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ styleId }),
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

  const busy = phase === "submitting" || phase === "processing";
  const disabled = !styleId || busy || dirty;

  return (
    <div className="mt-4 rounded-2xl border border-black/5 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">导出成片</p>
          <p className="mt-0.5 text-xs text-neutral-400">
            按所选样式（{styleName ?? "未选择"}）烧录字幕 · 预计消耗 {costSeconds} 秒额度
            {balance != null && <> · 当前余额 {formatSeconds(balance)}</>}
          </p>
        </div>

        {phase === "done" && taskId ? (
          <a
            href={`/api/exports/${taskId}/download`}
            className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-700"
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
                  : insufficient
                    ? "余额不足"
                    : undefined
            }
            className="rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            {phase === "submitting" ? "创建任务…" : phase === "processing" ? "烧录中…" : "导出视频"}
          </button>
        )}
      </div>

      {/* 字幕文件下载（纯文本生成不扣额度；读取库内数据，未保存修改时同样禁用） */}
      <div className="mt-3 flex items-center justify-between gap-3 border-t border-neutral-100 pt-3">
        <p className="text-xs text-neutral-400">
          字幕文件下载 · 不消耗额度{dirty && " · 有未保存修改时下载的是已保存版本"}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <a
            href={`/api/projects/${projectId}/srt`}
            title={dirty ? "建议先保存修改，下载内容为已保存版本" : "通用格式：剪映 / PR / 达芬奇"}
            className={`rounded-xl border border-neutral-200 px-3 py-1.5 text-sm text-neutral-700 transition-colors hover:border-neutral-300 ${
              dirty ? "opacity-60" : ""
            }`}
          >
            ⬇ SRT
          </a>
          <a
            href={`/api/projects/${projectId}/vtt`}
            title={dirty ? "建议先保存修改，下载内容为已保存版本" : "网页播放器通用（HTML5 track）"}
            className={`rounded-xl border border-neutral-200 px-3 py-1.5 text-sm text-neutral-700 transition-colors hover:border-neutral-300 ${
              dirty ? "opacity-60" : ""
            }`}
          >
            ⬇ VTT
          </a>
          <a
            href={`/api/projects/${projectId}/ass`}
            title={dirty ? "建议先保存修改，下载内容为已保存版本" : "带样式与关键词高亮：mpv / PotPlayer 直接挂载"}
            className={`rounded-xl border border-neutral-200 px-3 py-1.5 text-sm text-neutral-700 transition-colors hover:border-neutral-300 ${
              dirty ? "opacity-60" : ""
            }`}
          >
            ⬇ ASS
          </a>
        </div>
      </div>

      {/* 烧录进行中提示 */}
      {phase === "processing" && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-neutral-500">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-brand/20 border-t-brand" />
          FFmpeg 正在烧录字幕，一般几秒到几分钟（取决于视频长度）…
          {perm === "default" && (
            <button
              type="button"
              onClick={() => void requestNotificationPermission().then(setPerm)}
              className="text-xs text-neutral-400 underline underline-offset-2 transition-colors hover:text-brand"
            >
              开启完成提醒（切到其他页面时通知你）
            </button>
          )}
        </div>
      )}

      {/* 余额不足引导 */}
      {insufficient && !busy && (
        <p className="mt-3 text-sm text-amber-600">
          额度不足：本次导出需 {costSeconds} 秒。
          <Link href="/dashboard/redeem" className="ml-1 underline underline-offset-2">
            去兑换额度 →
          </Link>
        </p>
      )}

      {/* 未保存修改提示 */}
      {dirty && !busy && (
        <p className="mt-3 text-sm text-amber-600">字幕有未保存修改，请先点击右上角「保存修改」再导出</p>
      )}

      {/* 失败信息 + 重试 */}
      {phase === "failed" && error && (
        <div className="mt-3">
          <p className="text-sm text-red-600">导出失败：{error}</p>
          <button
            onClick={() => setPhase("idle")}
            className="mt-1 text-sm text-brand underline underline-offset-2"
          >
            返回重试
          </button>
        </div>
      )}
    </div>
  );
}
