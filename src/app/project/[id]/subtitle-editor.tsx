"use client";
/**
 * @file 字幕编辑器（客户端组件）
 * @description 布局：左侧视频预览（叠加当前行字幕，样式实时可切换），右侧分段列表。
 *   能力：点击行跳转播放、播放中自动高亮/滚动当前行、逐行编辑文本与时间、
 *         删除行、上方插入行、切换样式模板、保存（PUT 全量 segments）。
 *   依赖 API：GET /api/projects/[id]/video、PUT /api/projects/[id]/transcript、GET /api/styles。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { SubtitleOverlay, parseStyleConfig } from "@/components/subtitle-overlay";
import type { StyleConfig } from "@/components/subtitle-overlay";

/** 编辑器使用的分段结构（keywords 由后端保证存在） */
export interface EditorSegment {
  start: number;
  end: number;
  text: string;
  keywords: string[];
}

/** 样式列表项（GET /api/styles 返回） */
interface StyleMeta {
  id: string;
  name: string;
  config: unknown;
  isDefault: boolean;
}

/** 秒 → mm:ss.d 展示 */
function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}

/**
 * 字幕编辑器组件
 * @param projectId       项目 ID（视频流/保存接口地址）
 * @param initialSegments 服务端首屏字幕分段
 */
export function SubtitleEditor({
  projectId,
  initialSegments,
}: {
  projectId: string;
  initialSegments: EditorSegment[];
}) {
  const [segments, setSegments] = useState<EditorSegment[]>(initialSegments);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [styles, setStyles] = useState<StyleMeta[]>([]);
  const [activeStyle, setActiveStyle] = useState<StyleConfig | null>(null);
  const [activeStyleId, setActiveStyleId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [containerH, setContainerH] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const videoBoxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);

  // 加载样式列表并选中默认样式
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/styles", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { styles: StyleMeta[] };
        if (cancelled) return;
        setStyles(body.styles);
        const def = body.styles.find((s) => s.isDefault) ?? body.styles[0];
        if (def) {
          setActiveStyleId(def.id);
          setActiveStyle(parseStyleConfig(def.config));
        }
      } catch {
        // 样式加载失败不阻断编辑，仅无叠加预览
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 监听视频容器高度变化（叠加层按 @1080p 等比缩放需要）
  useEffect(() => {
    const el = videoBoxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerH(el.clientHeight));
    ro.observe(el);
    setContainerH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  /** 当前播放时间对应的分段下标（无匹配返回 -1） */
  const activeIdx = useMemo(
    () => segments.findIndex((s) => currentTime >= s.start && currentTime < s.end),
    [segments, currentTime],
  );

  // 播放中自动滚动到当前行
  useEffect(() => {
    if (activeIdx < 0 || !listRef.current) return;
    const row = listRef.current.children[activeIdx] as HTMLElement | undefined;
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeIdx]);

  /** 点击行：跳到该行起点并播放 */
  function seekTo(t: number) {
    if (videoRef.current) {
      videoRef.current.currentTime = t;
      void videoRef.current.play().catch(() => {});
    }
  }

  /** 更新某行字段 */
  function updateSegment(idx: number, patch: Partial<EditorSegment>) {
    setSegments((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  }

  /** 删除行（至少保留 1 行） */
  function removeSegment(idx: number) {
    setSegments((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));
    if (editingIdx === idx) setEditingIdx(null);
  }

  /** 在目标行上方插入新行（默认时长 2 秒，可再手动微调） */
  function insertBefore(idx: number) {
    setSegments((prev) => {
      const cur = prev[idx];
      const start = Math.round(cur.start * 10) / 10;
      const row: EditorSegment = { start, end: start + 2, text: "新字幕", keywords: [] };
      return [...prev.slice(0, idx), row, ...prev.slice(idx)];
    });
    setEditingIdx(idx);
  }

  /** 是否有未保存修改 */
  const dirty =
    JSON.stringify(segments) !== JSON.stringify(initialSegments);

  /** 保存到服务端 */
  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/transcript`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segments }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `保存失败（HTTP ${res.status}）`);
      setMessage({ type: "ok", text: "字幕已保存" });
    } catch (e) {
      setMessage({ type: "err", text: e instanceof Error ? e.message : "保存失败" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-4 lg:grid lg:grid-cols-[5fr_4fr] lg:gap-6">
      {/* ============ 左：视频预览 ============ */}
      <div>
        <div ref={videoBoxRef} className="relative overflow-hidden rounded-2xl bg-black shadow-sm">
          <video
            ref={videoRef}
            src={`/api/projects/${projectId}/video`}
            controls
            playsInline
            className="block w-full"
            onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          />
          {/* 字幕叠加预览 */}
          {activeStyle && activeIdx >= 0 && (
            <SubtitleOverlay config={activeStyle} segment={segments[activeIdx]} containerH={containerH} />
          )}
        </div>

        {/* 样式切换 */}
        <div className="mt-4 rounded-2xl border border-black/5 bg-white p-4 shadow-sm">
          <p className="text-sm font-medium">字幕样式</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {styles.map((s) => (
              <button
                key={s.id}
                onClick={() => {
                  setActiveStyleId(s.id);
                  setActiveStyle(parseStyleConfig(s.config));
                }}
                className={`rounded-full px-3.5 py-1.5 text-sm transition-colors ${
                  activeStyleId === s.id
                    ? "bg-brand text-white"
                    : "border border-neutral-200 text-neutral-600 hover:border-brand/40 hover:text-brand"
                }`}
              >
                {s.name}
              </button>
            ))}
            {styles.length === 0 && (
              <span className="text-sm text-neutral-400">暂无样式模板</span>
            )}
          </div>
          <p className="mt-2 text-xs text-neutral-400">切换后立即在左侧预览，导出时将按所选样式烧录</p>
        </div>
      </div>

      {/* ============ 右：分段列表 ============ */}
      <div className="mt-6 lg:mt-0">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-neutral-500">
            共 {segments.length} 段 · 点击行跳转播放
          </p>
          <button
            onClick={handleSave}
            disabled={saving || !dirty}
            className="rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "保存中…" : dirty ? "保存修改" : "已保存"}
          </button>
        </div>

        {message && (
          <p className={`mt-2 text-sm ${message.type === "err" ? "text-red-600" : "text-green-600"}`}>
            {message.text}
          </p>
        )}

        <ol ref={listRef} className="mt-3 max-h-[70vh] space-y-2 overflow-y-auto pr-1">
          {segments.map((seg, idx) => {
            const isActive = idx === activeIdx;
            const isEditing = idx === editingIdx;
            return (
              <li
                key={idx}
                className={`rounded-xl border px-4 py-3 transition-colors ${
                  isActive
                    ? "border-brand/40 bg-brand-soft/60"
                    : "border-black/5 bg-white hover:bg-neutral-50"
                }`}
              >
                {isEditing ? (
                  /* ---------- 编辑态 ---------- */
                  <div className="space-y-2">
                    <textarea
                      value={seg.text}
                      autoFocus
                      rows={2}
                      onChange={(e) => updateSegment(idx, { text: e.target.value })}
                      className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                    <div className="flex items-center gap-2 text-xs text-neutral-500">
                      <label>
                        开始
                        <input
                          type="number"
                          step={0.1}
                          min={0}
                          value={seg.start}
                          onChange={(e) =>
                            updateSegment(idx, { start: Number(e.target.value) })
                          }
                          className="ml-1 w-20 rounded-md border border-neutral-200 px-2 py-1 outline-none focus:border-brand"
                        />
                      </label>
                      <label>
                        结束
                        <input
                          type="number"
                          step={0.1}
                          min={0}
                          value={seg.end}
                          onChange={(e) => updateSegment(idx, { end: Number(e.target.value) })}
                          className="ml-1 w-20 rounded-md border border-neutral-200 px-2 py-1 outline-none focus:border-brand"
                        />
                      </label>
                      <span className="flex-1" />
                      <button
                        onClick={() => setEditingIdx(null)}
                        className="rounded-lg bg-brand px-3 py-1.5 font-medium text-white transition-colors hover:bg-brand-strong"
                      >
                        完成
                      </button>
                    </div>
                  </div>
                ) : (
                  /* ---------- 展示态 ---------- */
                  <div className="flex items-start gap-3">
                    <button
                      onClick={() => seekTo(seg.start)}
                      className="shrink-0 pt-0.5 font-mono text-xs text-neutral-400 transition-colors hover:text-brand"
                      title="跳转到此句"
                    >
                      {fmt(seg.start)}
                    </button>
                    <p
                      className="flex-1 cursor-text text-sm leading-6"
                      onDoubleClick={() => setEditingIdx(idx)}
                      title="双击编辑"
                    >
                      {seg.text}
                    </p>
                    <div className="flex shrink-0 gap-1">
                      <button
                        onClick={() => insertBefore(idx)}
                        className="rounded-md px-1.5 py-1 text-xs text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-brand"
                        title="在上方插入一行"
                      >
                        ＋
                      </button>
                      <button
                        onClick={() => removeSegment(idx)}
                        disabled={segments.length <= 1}
                        className="rounded-md px-1.5 py-1 text-xs text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40"
                        title="删除此行"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
