"use client";
/**
 * @file 管理后台失败任务列表（客户端组件，P1.6 可观测性）
 * @description 展示终态 FAILED 的转写项目与导出任务（各最近 20 条）及队列侧
 *              failed 积压数；每条带「重试」按钮，POST /api/admin/retry 重新入队，
 *              成功后 router.refresh() 同步列表。无失败记录时整块隐藏。
 */
import { useState } from "react";
import { useRouter } from "next/navigation";

/** 失败项目行 */
interface FailedProject {
  id: string;
  title: string;
  error: string;
  createdAt: string;
}

/** 失败导出任务行 */
interface FailedExport {
  id: string;
  projectTitle: string;
  error: string;
  createdAt: string;
}

/** 队列 failed 积压数（Redis 不可用时为 null） */
interface QueueFailed {
  transcript: number | null;
  export: number | null;
}

/**
 * 失败任务列表组件
 * @param props.projects 失败项目列表（服务端注入）
 * @param props.exports  失败导出任务列表（服务端注入）
 * @param props.queueFailed 队列积压统计（服务端注入）
 */
export function AdminFailures({
  projects,
  exports,
  queueFailed,
}: {
  projects: FailedProject[];
  exports: FailedExport[];
  queueFailed: QueueFailed;
}) {
  const router = useRouter();
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // 无任何失败记录（且队列无积压）时整块不渲染
  const hasFailures =
    projects.length > 0 || exports.length > 0 || (queueFailed.transcript ?? 0) > 0 || (queueFailed.export ?? 0) > 0;
  if (!hasFailures) return null;

  /**
   * 重试一个失败任务
   * @param type 任务类型
   * @param id   项目或导出任务 ID
   */
  async function retry(type: "project" | "export", id: string) {
    if (retryingId) return;
    setRetryingId(id);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, id }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setMessage(body.error ?? `重试失败（HTTP ${res.status}）`);
      } else {
        setMessage("已重新入队，等待 Worker 处理");
        router.refresh();
      }
    } catch {
      setMessage("网络异常，请稍后重试");
    } finally {
      setRetryingId(null);
    }
  }

  /** 行内时间展示 */
  const fmt = (iso: string) => new Date(iso).toLocaleString("zh-CN", { hour12: false });

  return (
    <section className="mt-8 rounded-2xl border border-red-100 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <h2 className="text-sm font-medium text-red-600">失败任务</h2>
        <span className="text-xs text-neutral-400">
          队列积压：转写 {queueFailed.transcript ?? "—"} / 导出 {queueFailed.export ?? "—"}
        </span>
      </div>

      {message && <p className="mt-2 text-sm text-neutral-600">{message}</p>}

      {projects.length > 0 && (
        <>
          <h3 className="mt-4 text-xs text-neutral-400">转写失败的项目（最近 20 条）</h3>
          <ul className="mt-2 space-y-1.5">
            {projects.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-black/5 bg-neutral-50 px-4 py-2.5 text-sm"
              >
                <span className="max-w-[200px] truncate font-medium">{p.title}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-red-500" title={p.error}>
                  {p.error || "未知原因"}
                </span>
                <span className="text-xs text-neutral-400">{fmt(p.createdAt)}</span>
                <button
                  onClick={() => retry("project", p.id)}
                  disabled={retryingId !== null}
                  className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-50"
                >
                  {retryingId === p.id ? "重试中…" : "重试转写"}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {exports.length > 0 && (
        <>
          <h3 className="mt-4 text-xs text-neutral-400">导出失败的任务（最近 20 条）</h3>
          <ul className="mt-2 space-y-1.5">
            {exports.map((t) => (
              <li
                key={t.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-black/5 bg-neutral-50 px-4 py-2.5 text-sm"
              >
                <span className="max-w-[200px] truncate font-medium">{t.projectTitle}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-red-500" title={t.error}>
                  {t.error || "未知原因"}
                </span>
                <span className="text-xs text-neutral-400">{fmt(t.createdAt)}</span>
                <button
                  onClick={() => retry("export", t.id)}
                  disabled={retryingId !== null}
                  className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-50"
                >
                  {retryingId === t.id ? "重试中…" : "重试导出"}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
