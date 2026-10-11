"use client";
/**
 * @file 音频波形时间轴 + 字幕段落块拖拽编辑（字幕编辑器右列顶部，剪辑台母题的「音轨」元素）
 * @description 渲染转写时旁路生成的音频波形峰值 JSON（GET /api/projects/[id]/waveform）：
 *               Canvas 柱状波形（每 CSS 像素一列，聚合取桶内最大值，整体归一化）+
 *               已播放区域 brand 染色 + 线性播放头 + 字幕段落块（半透明覆盖在波形上，
 *               块内截断显示句文字）。交互：点击空白处定位播放头（只 seek 不播放）；
 *               段落块支持三种拖拽——左缘改起点 / 右缘改终点 / 整体平移，
 *               拖拽中仅更新本地预览（不重渲染列表），释放时一次性回调
 *               onSegmentChange（父组件负责快照撤销与 dirty）。与其他句时间重叠的块
 *               显示琥珀警示色（仅提示不拦截）。加载失败/旧项目无波形数据时整体
 *               不渲染（编辑器退化为行内轨道位置条形态）。
 */
import { useEffect, useRef, useState } from "react";

/** 波形 JSON 契约（与 src/lib/media.ts extractWaveformPeaks 输出一致） */
interface WaveformData {
  /** 每秒峰值桶数 */
  rate: number;
  /** 峰值数组（16bit 振幅 0-32767） */
  peaks: number[];
}

/** 波形上叠加的字幕段落（与行列表同序；编辑经 onSegmentChange 回传） */
export interface WaveformSegment {
  start: number;
  end: number;
  /** 句文字（块内截断展示；缺省不显示） */
  text?: string;
}

/** 拖拽模式：左缘调起点 / 右缘调终点 / 中间整体平移 */
type DragMode = "start" | "end" | "move";

/** 拖拽中的本地预览（释放前不落 segments，避免拖拽过程高频重渲染列表） */
interface DragPreview {
  idx: number;
  mode: DragMode;
  /** 按下的 clientX（move 模式计算位移用） */
  downX: number;
  /** 按下时该句原始时间 */
  origStart: number;
  origEnd: number;
  /** 预览中的当前时间区间 */
  start: number;
  end: number;
}

/** 单句最小可识别时长（秒）：防止拖拽把句子拖没 */
const MIN_SEG_SEC = 0.1;

/** 两句时间是否重叠（开区间相交；邻接不算，1e-9 容浮点误差） */
function segOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end - 1e-9 && b.start < a.end - 1e-9;
}

/**
 * 波形时间轴组件
 * @param projectId       项目 ID（波形 JSON 接口地址）
 * @param durationSec     媒体时长（秒），播放头进度与拖拽换算用
 * @param currentTime     当前播放时间（秒，父组件 onTimeUpdate 驱动）
 * @param segments        字幕时间区间列表（渲染段落块；与行列表同序）
 * @param onSeek          定位回调（纯 seek 不播放）
 * @param onSegmentChange 拖拽释放回调：某句时间被调整（父组件负责撤销快照与保存）
 */
export function WaveformStrip({
  projectId,
  durationSec,
  currentTime,
  segments,
  onSeek,
  onSegmentChange,
}: {
  projectId: string;
  durationSec: number;
  currentTime: number;
  segments: WaveformSegment[];
  onSeek: (t: number) => void;
  onSegmentChange: (idx: number, next: { start: number; end: number }) => void;
}) {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [boxW, setBoxW] = useState(0);
  const [drag, setDrag] = useState<DragPreview | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // 拉取波形 JSON（404/解析失败置 loadFailed → 整体不渲染；成功前容器作骨架占位，
  // 保证 boxRef 恒绑定、ResizeObserver 能测到宽度——若「加载完才渲染容器」，
  // 首挂载时 ref 为空，effect 早退后永不重跑，canvas 将永远拿不到宽度）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/waveform`, { cache: "no-store" });
        if (!res.ok) {
          if (!cancelled) setLoadFailed(true);
          return;
        }
        const data = (await res.json()) as WaveformData;
        if (cancelled) return;
        if (Array.isArray(data.peaks) && data.peaks.length > 0) {
          setPeaks(data.peaks);
        } else {
          setLoadFailed(true);
        }
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // 容器宽度监听（canvas 按 CSS 宽度绘制，窗口/布局变化时重绘）
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBoxW(el.clientWidth));
    ro.observe(el);
    setBoxW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // 绘制波形：每 CSS 像素一列，映射到峰值区间取 max（peaks 密于像素时聚合），
  // 高度按全局最大峰值归一化（小音量素材也可见波形轮廓），最低 2px 保证平语音轨有基线
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks || boxW <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const h = canvas.clientHeight;
    canvas.width = Math.round(boxW * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, boxW, h);
    ctx.fillStyle = "#4b4d5a"; // 暗色主题波形柱：亮于面板底、暗于字幕块，层次居中
    let max = 0;
    for (const p of peaks) if (p > max) max = p;
    if (max === 0) max = 1;
    const half = h / 2;
    for (let x = 0; x < boxW; x++) {
      const s0 = Math.floor((x / boxW) * peaks.length);
      const s1 = Math.max(s0 + 1, Math.floor(((x + 1) / boxW) * peaks.length));
      let v = 0;
      for (let i = s0; i < s1 && i < peaks.length; i++) {
        if (peaks[i] > v) v = peaks[i];
      }
      const barH = Math.max(2, (v / max) * (h - 4));
      ctx.fillRect(x, half - barH / 2, 1, barH);
    }
  }, [peaks, boxW]);

  if (loadFailed) return null;

  const progress = durationSec > 0 ? Math.min(1, Math.max(0, currentTime / durationSec)) : 0;

  /** 指针事件 → 时间（横向 clamp 到 [0, durationSec]） */
  function timeFromEvent(clientX: number): number {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || durationSec <= 0) return 0;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * durationSec;
  }

  /**
   * 段落块按下：按命中位置决定拖拽模式（左右 8px 为调边，中间为平移），
   * 记录原始时间——后续 move 全部以按下时快照为基准计算（免累积误差）
   */
  function onBlockDown(e: React.PointerEvent<HTMLDivElement>, idx: number) {
    if (durationSec <= 0 || drag) return;
    e.stopPropagation(); // 不触发底层的空白定位
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    const seg = segments[idx];
    const relX = e.clientX - rect.left;
    const mode: DragMode = relX <= 8 ? "start" : relX >= rect.width - 8 ? "end" : "move";
    setDrag({ idx, mode, downX: e.clientX, origStart: seg.start, origEnd: seg.end, start: seg.start, end: seg.end });
  }

  /** 拖拽移动：按模式换算新时间区间（start≥0、end≤duration、end-start≥最小句长） */
  function onDragMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!drag) return;
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const secPerPx = durationSec / rect.width;
    const dt = (e.clientX - drag.downX) * secPerPx;
    let start = drag.origStart;
    let end = drag.origEnd;
    if (drag.mode === "start") {
      start = Math.min(Math.max(0, drag.origStart + dt), drag.origEnd - MIN_SEG_SEC);
    } else if (drag.mode === "end") {
      end = Math.max(Math.min(durationSec, drag.origEnd + dt), drag.origStart + MIN_SEG_SEC);
    } else {
      const span = drag.origEnd - drag.origStart;
      start = Math.min(Math.max(0, drag.origStart + dt), durationSec - span);
      end = start + span;
    }
    setDrag({ ...drag, start, end });
  }

  /** 拖拽释放：无实际变化则丢弃预览，有变化一次性回调父组件落 segments */
  function onDragUp() {
    if (!drag) return;
    const changed =
      Math.abs(drag.start - drag.origStart) > 1e-6 || Math.abs(drag.end - drag.origEnd) > 1e-6;
    if (changed) onSegmentChange(drag.idx, { start: Math.round(drag.start * 100) / 100, end: Math.round(drag.end * 100) / 100 });
    setDrag(null);
  }

  /** 空白处（非段落块）按下 → 定位播放头（复用指针坐标换算；不播放） */
  function onBackgroundDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    onSeek(timeFromEvent(e.clientX));
  }

  return (
    <div
      ref={boxRef}
      role="slider"
      aria-label="音频波形时间轴"
      aria-valuemin={0}
      aria-valuemax={Math.round(durationSec)}
      aria-valuenow={Math.round(currentTime)}
      tabIndex={0}
      onKeyDown={(e) => {
        // 键盘定位：与全局剪辑快捷键同刻度（±2 秒），role=slider 的键盘语义
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          const delta = e.key === "ArrowLeft" ? -2 : 2;
          onSeek(Math.min(durationSec, Math.max(0, currentTime + delta)));
        }
      }}
      onPointerDown={onBackgroundDown}
      onPointerMove={(e) => {
        if (drag) onDragMove(e);
        else if (e.buttons & 1) onSeek(timeFromEvent(e.clientX)); // 空白处按住左键拖动 scrub
      }}
      onPointerUp={() => onDragUp()}
      className="relative h-16 cursor-pointer touch-none select-none overflow-visible rounded-lg bg-white/[0.05] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      title="点击定位 · 拖动字幕块边缘调时间 · 拖动块整体平移"
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full rounded-lg" />
      {/* 已播放区域染色 + 播放头（timeupdate ~4Hz，线性过渡补间让移动连续）；
          波形数据到位前只显示骨架灰底。拖拽预览中的播放染色冻结（progress 暂停更新）以免视觉抖动 */}
      {peaks && durationSec > 0 && (
        <>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 rounded-l-lg bg-accent/15"
            style={{ width: `${progress * 100}%` }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-accent transition-[left] duration-150 ease-linear"
            style={{ left: `calc(${progress * 100}% - 1px)` }}
          />
        </>
      )}

      {/* 字幕段落块：波形上的可拖拽「字幕轨」（与行列表同序；拖拽中该块用预览时间）。
          与其他句重叠的块显示琥珀警示色（仅提示不拦截——重叠合法但要用户知情，
          拖拽中按预览区间实时检测，拖出重叠立刻变色） */}
      {peaks &&
        durationSec > 0 &&
        segments.map((seg, idx) => {
          const s = drag?.idx === idx ? drag.start : seg.start;
          const e_ = drag?.idx === idx ? drag.end : seg.end;
          const live = { start: s, end: e_ };
          const overlapping = segments.some(
            (o, j) => j !== idx && segOverlap(live, drag?.idx === j ? { start: o.start, end: o.end } : o),
          );
          const left = Math.max(0, (s / durationSec) * 100);
          const width = Math.max(0.5, Math.min(100 - left, ((e_ - s) / durationSec) * 100));
          const isDragging = drag?.idx === idx;
          return (
            <div
              key={idx}
              onPointerDown={(e) => onBlockDown(e, idx)}
              onPointerMove={onDragMove}
              onPointerUp={onDragUp}
              className={`group absolute inset-y-1 rounded-md border transition-colors ${
                isDragging
                  ? "z-20 cursor-ew-resize border-brand bg-brand/50 shadow-sm"
                  : overlapping
                    ? "cursor-grab border-amber-400/80 bg-amber-400/30 hover:bg-amber-400/40"
                    : "cursor-grab border-brand/60 bg-brand/30 hover:bg-brand/45"
              }`}
              style={{ left: `${left}%`, width: `${width}%` }}
              title={
                overlapping
                  ? `第 ${idx + 1} 句（与其他句时间重叠，播放时会同显）`
                  : `第 ${idx + 1} 句（拖动边缘调时间，拖动中间平移）`
              }
            >
              {/* 句文字（剪辑软件字幕轨样式：截断展示、不拦截拖拽；块太窄自然裁掉） */}
              {seg.text && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 flex items-center overflow-hidden px-2.5 text-[10px] leading-tight text-white/90"
                >
                  <span className="truncate">{seg.text}</span>
                </span>
              )}
              {/* 左右拖拽手柄（视觉提示：hover 时边缘竖条加深） */}
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 w-2 rounded-l-md bg-brand/0 transition-colors group-hover:bg-brand/50"
              />
              <span
                aria-hidden
                className="absolute inset-y-0 right-0 w-2 rounded-r-md bg-brand/0 transition-colors group-hover:bg-brand/50"
              />
              {/* 拖拽中的时间提示（暗底上反转为亮底暗字，保证可读） */}
              {isDragging && (
                <span className="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-[#e8e9ee] px-2 py-0.5 font-mono text-xs tabular-nums text-[#0b0c10]">
                  {fmtWave(s)}–{fmtWave(e_)}
                </span>
              )}
            </div>
          );
        })}
    </div>
  );
}

/** 波形拖拽提示用时间格式（mm:ss.d，与编辑器 fmt 一致） */
function fmtWave(t: number): string {
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}
