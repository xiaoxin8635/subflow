"use client";
/**
 * @file 字幕编辑器（客户端组件）
 * @description 布局：左侧视频预览（叠加当前行字幕，样式实时可切换/微调），右侧分段列表。
 *   能力：点击行跳转播放、播放中自动高亮/滚动当前行、逐行编辑文本与时间、
 *         删除行、上方插入行、时间轴批量调整（整体偏移/整体伸缩 + 撤销）、
 *         音频波形时间轴（点击/拖动定位；波形上叠加字幕段落块，拖边缘调起止/拖整体平移，
 *         waveformKey 存在时渲染）、
 *         选择官方样式模板、样式微调（字体/字号/位置/边距/字色/
 *         描边/高亮）、另存为我的模板、删除我的模板、保存（PUT 全量 segments）、
 *         导出成片（ExportCard：携带当前预览样式快照烧录，所见即所得 + 额度扣减 + 下载）。
 *   依赖 API：GET /api/projects/[id]/video、PUT /api/projects/[id]/transcript、
 *             GET /api/styles、GET/POST /api/user-styles、DELETE /api/user-styles/[id]、
 *             POST /api/projects/[id]/exports、GET /api/exports/[id]。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { SubtitleOverlay } from "@/components/subtitle-overlay";
import { parseStyleConfig } from "@/lib/style-config";
import type { StyleConfig } from "@/lib/style-config";
import { ExportCard } from "./export-card";
import { WaveformStrip } from "./waveform-strip";

/** 编辑器使用的分段结构（keywords 由后端保证存在） */
export interface EditorSegment {
  start: number;
  end: number;
  text: string;
  keywords: string[];
}

/** 样式列表项（GET /api/styles 官方模板；GET /api/user-styles 我的模板——无 isDefault） */
interface StyleMeta {
  id: string;
  name: string;
  config: unknown;
  isDefault?: boolean;
}

/** 微调面板的字体候选（烧录由 libass 按字体名匹配，部署机缺失时回退默认字体） */
const FONT_OPTIONS = [
  { value: "Noto Sans SC", label: "思源黑体" },
  { value: "Microsoft YaHei", label: "微软雅黑" },
  { value: "SimHei", label: "黑体" },
  { value: "SimSun", label: "宋体" },
  { value: "KaiTi", label: "楷体" },
  { value: "FangSong", label: "仿宋" },
] as const;

/** 秒 → mm:ss.d 展示 */
function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}

/**
 * 字幕编辑器组件
 * @param projectId       项目 ID（视频流/保存接口地址）
 * @param projectTitle    项目标题（导出系统通知文案用）
 * @param initialSegments 服务端首屏字幕分段
 * @param durationSec     媒体时长（秒），用于导出扣费展示
 * @param mediaKind       媒体类型（audio 时导出卡隐藏成片烧录入口）
 * @param waveformKey     波形 JSON 存储 key（转写时旁路生成；为空不渲染波形时间轴）
 */
export function SubtitleEditor({
  projectId,
  projectTitle,
  initialSegments,
  durationSec,
  mediaKind = "video",
  waveformKey = null,
}: {
  projectId: string;
  projectTitle?: string;
  initialSegments: EditorSegment[];
  durationSec: number;
  mediaKind?: "video" | "audio";
  waveformKey?: string | null;
}) {
  const [segments, setSegments] = useState<EditorSegment[]>(initialSegments);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [styles, setStyles] = useState<StyleMeta[]>([]);
  const [userStyles, setUserStyles] = useState<StyleMeta[]>([]);
  const [activeStyle, setActiveStyle] = useState<StyleConfig | null>(null);
  const [activeStyleId, setActiveStyleId] = useState<string | null>(null);
  const [styleSource, setStyleSource] = useState<"official" | "user">("official");
  const [tweakOpen, setTweakOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [savingTpl, setSavingTpl] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tlOpen, setTlOpen] = useState(false);
  const [offsetSec, setOffsetSec] = useState("0");
  const [scaleRatio, setScaleRatio] = useState("1.00");
  const [tlUndo, setTlUndo] = useState<EditorSegment[] | null>(null);
  const [message, setMessage] = useState<{ type: "ok" | "err" | "warn"; text: string } | null>(null);
  const [containerH, setContainerH] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const videoBoxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  // 已保存基线：dirty 由此计算，保存成功后同步——保证「已保存」按钮态与库内数据自洽
  const savedBaselineRef = useRef(JSON.stringify(initialSegments));

  // 加载样式列表（官方模板 + 我的模板）并选中默认样式
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [styleRes, userRes] = await Promise.all([
          fetch("/api/styles", { cache: "no-store" }),
          fetch("/api/user-styles", { cache: "no-store" }),
        ]);
        const official: StyleMeta[] = styleRes.ok
          ? ((await styleRes.json()) as { styles: StyleMeta[] }).styles
          : [];
        const mine: StyleMeta[] = userRes.ok
          ? ((await userRes.json()) as { styles: StyleMeta[] }).styles
          : [];
        if (cancelled) return;
        setStyles(official);
        setUserStyles(mine);
        const def = official.find((s) => s.isDefault) ?? official[0];
        if (def) {
          setStyleSource("official");
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

  // 剪辑快捷键：空格播放/暂停 · ←/→ 快退/快进 2 秒 · Ctrl/Cmd+S 保存
  // （焦点在输入控件时不劫持；每次渲染重挂监听以捕获最新 dirty/saving 状态）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (video.paused) void video.play().catch(() => {});
        else video.pause();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 2);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        video.currentTime = Math.min(video.duration || Number.MAX_SAFE_INTEGER, video.currentTime + 2);
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty && !saving) void handleSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /** 点击行：跳到该行起点并播放 */
  function seekTo(t: number) {
    if (videoRef.current) {
      videoRef.current.currentTime = t;
      void videoRef.current.play().catch(() => {});
    }
  }

  /** 波形时间轴定位：只 seek 不播放（与行点击「跳转并播放」语义区分） */
  function seekOnly(t: number) {
    if (videoRef.current) videoRef.current.currentTime = t;
  }

  /**
   * 波形上拖拽字幕块后的落位回调：先快照撤销基线（与批量调整共用一步撤销），
   * 再更新该行时间区间——dirty/保存/导出拦截均由既有 setSegments 链路自动联动。
   * 释放后与其他句做重叠检测：重叠仅提示（warn）不拦截——与 PUT 校验一致，
   * 重叠是合法状态（配音重叠场景），但要用户知情
   */
  function handleWaveformEdit(idx: number, next: { start: number; end: number }) {
    setTlUndo(segments);
    setSegments((prev) => prev.map((s, i) => (i === idx ? { ...s, ...next } : s)));
    const clash = segments.findIndex(
      (s, i) => i !== idx && s.start < next.end - 1e-9 && next.start < s.end - 1e-9,
    );
    if (clash >= 0) {
      setMessage({
        type: "warn",
        text: `第 ${idx + 1} 句与第 ${clash + 1} 句时间重叠了，播放时会两句同显，请留意`,
      });
    } else {
      setMessage({ type: "ok", text: `第 ${idx + 1} 句时间已调整，请核对后点「保存修改」` });
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

  /** 是否有未保存修改（相对最近一次保存的基线，而非服务端首屏快照） */
  const dirty = JSON.stringify(segments) !== savedBaselineRef.current;

  /**
   * 应用整体偏移：所有行 start/end 平移 delta 秒（正=后移）
   * 任一行起点 <0 时拒绝（避免负时间被服务端 400）
   */
  function applyTimelineOffset() {
    const delta = Number(offsetSec);
    if (!Number.isFinite(delta) || delta === 0) return;
    const next = segments.map((s) => ({ ...s, start: s.start + delta, end: s.end + delta }));
    if (next.some((s) => s.start < 0)) {
      setMessage({ type: "err", text: "偏移后有字幕行开始时间小于 0，请减小偏移量" });
      return;
    }
    setTlUndo(segments);
    setSegments(next);
    setMessage({
      type: "ok",
      text: `已整体${delta > 0 ? "后" : "前"}移 ${Math.abs(delta)} 秒，请核对后点「保存修改」`,
    });
  }

  /**
   * 应用整体伸缩：以首行起点为锚按比例拉伸时间轴（>1 拉长，<1 压缩）。
   * 锚点取首行起点（≥0）且 ratio>0，数学上保证结果恒合法（start≥0 且 end>start），无需校验
   */
  function applyTimelineScale() {
    const ratio = Number(scaleRatio);
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio === 1) return;
    const anchor = segments[0]?.start ?? 0;
    setTlUndo(segments);
    setSegments(
      segments.map((s) => ({
        ...s,
        start: anchor + (s.start - anchor) * ratio,
        end: anchor + (s.end - anchor) * ratio,
      })),
    );
    setMessage({
      type: "ok",
      text: `已按 ${ratio} 倍伸缩时间轴，请核对后点「保存修改」`,
    });
  }

  /** 撤销最近一次时间轴批量调整（恢复应用前快照，仅保留一步） */
  function undoTimeline() {
    if (!tlUndo) return;
    setSegments(tlUndo);
    setTlUndo(null);
    setMessage({ type: "ok", text: "已撤销最近一次时间轴调整" });
  }

  /** 选择样式（官方模板或我的模板），重置为该模板的库内配置 */
  function selectStyle(source: "official" | "user", s: StyleMeta) {
    setStyleSource(source);
    setActiveStyleId(s.id);
    setActiveStyle(parseStyleConfig(s.config));
  }

  /** 微调当前样式（仅本地预览；导出时随请求快照，另存为模板时随请求保存） */
  function adjustStyle(patch: Partial<StyleConfig>) {
    setActiveStyle((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  /** 另存为我的模板（POST /api/user-styles，成功后选中新模板） */
  async function handleSaveAsTemplate() {
    if (!activeStyle || savingTpl) return;
    const name = saveName.trim();
    if (!name) return;
    setSavingTpl(true);
    try {
      const res = await fetch("/api/user-styles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, config: activeStyle }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        style?: StyleMeta;
        error?: string;
      };
      const created = body.style;
      if (!res.ok || !created) {
        throw new Error(body.error ?? `保存失败（HTTP ${res.status}）`);
      }
      setUserStyles((prev) => [created, ...prev]);
      selectStyle("user", created);
      setSaveOpen(false);
      setSaveName("");
      setMessage({ type: "ok", text: `已保存为我的模板「${created.name}」` });
    } catch (e) {
      setMessage({ type: "err", text: e instanceof Error ? e.message : "保存模板失败" });
    } finally {
      setSavingTpl(false);
    }
  }

  /** 删除我的模板（删除当前选中的则回退默认官方样式） */
  async function handleDeleteUserStyle(id: string) {
    if (!window.confirm("确定删除这个模板吗？（已创建的导出任务不受影响）")) return;
    try {
      const res = await fetch(`/api/user-styles/${id}`, { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `删除失败（HTTP ${res.status}）`);
      setUserStyles((prev) => prev.filter((s) => s.id !== id));
      if (styleSource === "user" && activeStyleId === id) {
        const def = styles.find((s) => s.isDefault) ?? styles[0];
        if (def) {
          selectStyle("official", def);
        } else {
          setStyleSource("official");
          setActiveStyleId(null);
          setActiveStyle(null);
        }
      }
      setMessage({ type: "ok", text: "模板已删除" });
    } catch (e) {
      setMessage({ type: "err", text: e instanceof Error ? e.message : "删除失败" });
    }
  }

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
      // 保存成功：同步基线，dirty 归零（按钮回「已保存」）
      savedBaselineRef.current = JSON.stringify(segments);
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

        {/* 样式切换 + 微调 + 我的模板 */}
        <div className="mt-4 rounded-2xl border border-black/5 bg-white p-4 shadow-sm">
          <p className="text-sm font-medium">字幕样式</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {styles.map((s) => (
              <button
                key={s.id}
                onClick={() => selectStyle("official", s)}
                className={`rounded-full px-3.5 py-1.5 text-sm transition-colors ${
                  styleSource === "official" && activeStyleId === s.id
                    ? "bg-brand text-white"
                    : "border border-neutral-200 text-neutral-600 hover:border-brand/40 hover:text-brand"
                }`}
              >
                {s.name}
              </button>
            ))}
            {styles.length === 0 && (
              <span className="text-sm text-neutral-400">暂无官方样式模板</span>
            )}
          </div>

          {userStyles.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-medium text-neutral-500">我的模板</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {userStyles.map((s) => {
                  const active = styleSource === "user" && activeStyleId === s.id;
                  return (
                    <span
                      key={s.id}
                      className={`inline-flex items-center overflow-hidden rounded-full text-sm transition-colors ${
                        active
                          ? "bg-brand text-white"
                          : "border border-neutral-200 text-neutral-600"
                      }`}
                    >
                      <button
                        onClick={() => selectStyle("user", s)}
                        className={`py-1.5 pl-3.5 pr-1.5 transition-colors ${
                          active ? "" : "hover:text-brand"
                        }`}
                      >
                        {s.name}
                      </button>
                      <button
                        onClick={() => handleDeleteUserStyle(s.id)}
                        title="删除此模板"
                        className={`px-2 py-1.5 text-xs transition-colors ${
                          active
                            ? "text-white/70 hover:text-white"
                            : "text-neutral-300 hover:text-red-500"
                        }`}
                      >
                        ✕
                      </button>
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          <p className="mt-2 text-xs text-neutral-400">
            切换后立即在左侧预览，导出按当前预览效果烧录（微调未保存为模板也生效）
          </p>

          {/* 样式微调面板（调整只影响本地预览与导出快照，不改模板库内配置） */}
          {activeStyle && (
            <div className="mt-3 border-t border-neutral-100 pt-3">
              <button
                type="button"
                onClick={() => setTweakOpen((v) => !v)}
                className="text-xs font-medium text-brand transition-colors hover:text-brand-strong"
              >
                {tweakOpen ? "收起样式微调 ▲" : "微调当前样式 ▼"}
              </button>
              {tweakOpen && (
                <div className="mt-3 space-y-3">
                  {/* 字体 */}
                  <label className="flex items-center gap-3 text-xs text-neutral-500">
                    <span className="w-14 shrink-0">字体</span>
                    <select
                      value={activeStyle.fontFamily}
                      onChange={(e) => adjustStyle({ fontFamily: e.target.value })}
                      className="flex-1 rounded-lg border border-neutral-200 px-2 py-1.5 text-sm outline-none focus:border-brand"
                    >
                      {FONT_OPTIONS.map((f) => (
                        <option key={f.value} value={f.value}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {/* 字号（@1080p 高度百分比） */}
                  <label className="flex items-center gap-3 text-xs text-neutral-500">
                    <span className="w-14 shrink-0">字号</span>
                    <input
                      type="range"
                      min={3}
                      max={12}
                      step={0.1}
                      value={activeStyle.fontSize}
                      onChange={(e) => adjustStyle({ fontSize: Number(e.target.value) })}
                      className="flex-1 accent-brand"
                    />
                    <span className="w-10 text-right font-mono">
                      {activeStyle.fontSize.toFixed(1)}
                    </span>
                  </label>
                  {/* 垂直位置 */}
                  <div className="flex items-center gap-3 text-xs text-neutral-500">
                    <span className="w-14 shrink-0">位置</span>
                    <div className="flex gap-1">
                      {(
                        [
                          ["top", "顶部"],
                          ["center", "居中"],
                          ["bottom", "底部"],
                        ] as const
                      ).map(([v, label]) => (
                        <button
                          key={v}
                          type="button"
                          onClick={() => adjustStyle({ position: v })}
                          className={`rounded-lg px-2.5 py-1 transition-colors ${
                            activeStyle.position === v
                              ? "bg-brand text-white"
                              : "border border-neutral-200 text-neutral-600 hover:border-brand/40"
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* 垂直边距（@1080p 像素；居中定位不参与，禁用滑块） */}
                  <label className="flex items-center gap-3 text-xs text-neutral-500">
                    <span className="w-14 shrink-0">边距</span>
                    <input
                      type="range"
                      min={0}
                      max={400}
                      step={5}
                      value={activeStyle.marginV}
                      disabled={activeStyle.position === "center"}
                      onChange={(e) => adjustStyle({ marginV: Number(e.target.value) })}
                      className="flex-1 accent-brand disabled:opacity-40"
                    />
                    <span className="w-10 text-right font-mono">{activeStyle.marginV}</span>
                  </label>
                  {/* 主颜色 */}
                  <div className="flex items-center gap-3 text-xs text-neutral-500">
                    <span className="w-14 shrink-0">字色</span>
                    <input
                      type="color"
                      value={activeStyle.primaryColor}
                      onChange={(e) => adjustStyle({ primaryColor: e.target.value })}
                      className="h-7 w-12 cursor-pointer rounded border border-neutral-200"
                    />
                    <span className="font-mono text-neutral-400">{activeStyle.primaryColor}</span>
                  </div>
                  {/* 描边（宽度 0 = 不描边） */}
                  <div className="flex items-center gap-3 text-xs text-neutral-500">
                    <span className="w-14 shrink-0">描边</span>
                    <input
                      type="color"
                      value={activeStyle.outlineColor || "#000000"}
                      onChange={(e) => adjustStyle({ outlineColor: e.target.value })}
                      className="h-7 w-12 cursor-pointer rounded border border-neutral-200"
                    />
                    <input
                      type="range"
                      min={0}
                      max={12}
                      step={0.5}
                      value={activeStyle.outlineWidth}
                      onChange={(e) => adjustStyle({ outlineWidth: Number(e.target.value) })}
                      className="flex-1 accent-brand"
                    />
                    <span className="w-14 text-right font-mono">
                      {activeStyle.outlineWidth > 0 ? `${activeStyle.outlineWidth}px` : "无"}
                    </span>
                  </div>
                  {/* 关键词高亮色（空 = 不高亮） */}
                  <div className="flex items-center gap-3 text-xs text-neutral-500">
                    <span className="w-14 shrink-0">高亮</span>
                    <input
                      type="color"
                      value={activeStyle.highlight || "#FFE135"}
                      onChange={(e) => adjustStyle({ highlight: e.target.value })}
                      disabled={!activeStyle.highlight}
                      className="h-7 w-12 cursor-pointer rounded border border-neutral-200 disabled:opacity-40"
                    />
                    <span className="font-mono text-neutral-400">
                      {activeStyle.highlight || "不高亮"}
                    </span>
                    <button
                      type="button"
                      onClick={() => adjustStyle({ highlight: activeStyle.highlight ? "" : "#FFE135" })}
                      className="ml-auto shrink-0 rounded-lg border border-neutral-200 px-2 py-1 transition-colors hover:border-brand/40"
                    >
                      {activeStyle.highlight ? "关闭高亮" : "开启高亮"}
                    </button>
                  </div>

                  {/* 另存为我的模板 */}
                  <div className="border-t border-neutral-100 pt-3">
                    {saveOpen ? (
                      <div className="flex items-center gap-2">
                        <input
                          value={saveName}
                          autoFocus
                          maxLength={20}
                          placeholder="模板名（如：我的黄字大号）"
                          onChange={(e) => setSaveName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void handleSaveAsTemplate();
                          }}
                          className="flex-1 rounded-lg border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-brand"
                        />
                        <button
                          type="button"
                          onClick={() => void handleSaveAsTemplate()}
                          disabled={savingTpl || !saveName.trim()}
                          className="shrink-0 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {savingTpl ? "保存中…" : "保存"}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setSaveOpen(false);
                            setSaveName("");
                          }}
                          className="shrink-0 rounded-lg border border-neutral-200 px-3 py-1.5 text-sm text-neutral-600 transition-colors hover:border-neutral-300"
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setSaveOpen(true)}
                        className="text-xs text-neutral-500 underline underline-offset-2 transition-colors hover:text-brand"
                      >
                        把当前效果另存为我的模板
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* 导出卡片（按当前预览样式快照烧录，完成后可下载；音频项目仅字幕下载） */}
        <ExportCard
          projectId={projectId}
          projectTitle={projectTitle}
          durationSec={durationSec}
          styleId={activeStyleId}
          styleName={
            [...styles, ...userStyles].find((s) => s.id === activeStyleId)?.name ?? null
          }
          styleSource={styleSource}
          styleConfig={activeStyle}
          assQuery={
            activeStyleId
              ? styleSource === "user"
                ? `userStyleId=${activeStyleId}`
                : `styleId=${activeStyleId}`
              : ""
          }
          dirty={dirty}
          mediaKind={mediaKind}
          getCurrentTime={() => videoRef.current?.currentTime ?? 0}
        />
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
        <p className="mt-1 text-xs text-neutral-400">
          快捷键：空格 播放/暂停 · ← → 快退/快进 2 秒 · Ctrl+S 保存
        </p>

        {/* 音频波形时间轴（转写时旁路生成；旧项目/提取失败时不渲染，退化为行内轨道条） */}
        {waveformKey && durationSec > 0 && (
          <div className="mt-3">
            <WaveformStrip
              projectId={projectId}
              durationSec={durationSec}
              currentTime={currentTime}
              segments={segments.map((s) => ({ start: s.start, end: s.end, text: s.text }))}
              onSeek={seekOnly}
              onSegmentChange={handleWaveformEdit}
            />
          </div>
        )}

        {/* 时间轴批量调整（整体与语音不同步时使用；纯前端计算，保存走统一 PUT） */}
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setTlOpen((v) => !v)}
            className="text-xs font-medium text-brand transition-colors hover:text-brand-strong"
          >
            {tlOpen ? "收起时间轴工具 ▲" : "时间轴批量调整 ▼"}
          </button>
          {tlOpen && (
            <div className="mt-2 space-y-2 rounded-xl border border-neutral-100 bg-white p-3">
              <p className="text-xs text-neutral-400">
                字幕整体与语音不同步时使用；调整只改本地预览，需点「保存修改」后导出才生效
              </p>
              <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                <span className="w-16 shrink-0">整体偏移</span>
                <input
                  type="number"
                  step={0.1}
                  min={-30}
                  max={30}
                  value={offsetSec}
                  onChange={(e) => setOffsetSec(e.target.value)}
                  className="w-24 rounded-lg border border-neutral-200 px-2 py-1 outline-none focus:border-brand"
                />
                <span className="text-neutral-400">秒（正 = 后移）</span>
                <button
                  type="button"
                  onClick={applyTimelineOffset}
                  className="rounded-lg border border-neutral-200 px-2.5 py-1 transition-colors hover:border-brand/40 hover:text-brand"
                >
                  应用偏移
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                <span className="w-16 shrink-0">整体伸缩</span>
                <input
                  type="number"
                  step={0.01}
                  min={0.5}
                  max={2}
                  value={scaleRatio}
                  onChange={(e) => setScaleRatio(e.target.value)}
                  className="w-24 rounded-lg border border-neutral-200 px-2 py-1 outline-none focus:border-brand"
                />
                <span className="text-neutral-400">倍（以首行起点为锚，&gt;1 拉长）</span>
                <button
                  type="button"
                  onClick={applyTimelineScale}
                  className="rounded-lg border border-neutral-200 px-2.5 py-1 transition-colors hover:border-brand/40 hover:text-brand"
                >
                  应用伸缩
                </button>
              </div>
              {tlUndo && (
                <button
                  type="button"
                  onClick={undoTimeline}
                  className="text-xs text-neutral-500 underline underline-offset-2 transition-colors hover:text-brand"
                >
                  撤销最近一次调整
                </button>
              )}
            </div>
          )}
        </div>

        {message && (
          <p
            className={`mt-2 text-sm ${
              message.type === "err"
                ? "text-red-600"
                : message.type === "warn"
                  ? "text-amber-600"
                  : "text-green-600"
            }`}
          >
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
                  /* ---------- 展示态（轨道片段语言：时间区间 + 文本 + 整片位置条） ---------- */
                  <div className="space-y-2">
                    <div className="flex items-start gap-3">
                      <button
                        onClick={() => seekTo(seg.start)}
                        className="shrink-0 pt-0.5 font-mono text-xs tabular-nums text-neutral-400 transition-colors hover:text-brand"
                        title="跳转到此句"
                      >
                        {fmt(seg.start)}
                        <span className="text-neutral-300">–{fmt(seg.end)}</span>
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
                    {/* 轨道位置条：该句在整片时间轴上的位置（当前播放句高亮为实色） */}
                    {durationSec > 0 && (
                      <div className="relative h-1 overflow-hidden rounded-full bg-neutral-100">
                        <span
                          aria-hidden
                          className={`absolute inset-y-0 rounded-full transition-colors ${
                            isActive ? "bg-brand" : "bg-brand/25"
                          }`}
                          style={{
                            left: `${Math.min(100, (seg.start / durationSec) * 100)}%`,
                            width: `${Math.max(1.5, ((seg.end - seg.start) / durationSec) * 100)}%`,
                          }}
                        />
                      </div>
                    )}
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
