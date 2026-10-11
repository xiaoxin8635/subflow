"use client";
/**
 * @file 音频波形时间轴（字幕编辑器右列顶部，剪辑台母题的「音轨」元素）
 * @description 渲染转写时旁路生成的音频波形峰值 JSON（GET /api/projects/[id]/waveform）：
 *               Canvas 柱状波形（每 CSS 像素一列，聚合取桶内最大值，整体归一化）+
 *               已播放区域 brand 染色 + 线性播放头；点击/横向拖动定位（只 seek 不播放，
 *               与行点击「跳转并播放」语义区分）。加载失败/旧项目无波形数据时整体不渲染
 *               （编辑器退化为此前的纯轨道位置条形态，绝不阻断编辑）。
 */
import { useEffect, useRef, useState } from "react";

/** 波形 JSON 契约（与 src/lib/media.ts extractWaveformPeaks 输出一致） */
interface WaveformData {
  /** 每秒峰值桶数 */
  rate: number;
  /** 峰值数组（16bit 振幅 0-32767） */
  peaks: number[];
}

/**
 * 波形时间轴组件
 * @param projectId   项目 ID（波形 JSON 接口地址）
 * @param durationSec 媒体时长（秒），播放头进度与点击定位换算用
 * @param currentTime 当前播放时间（秒，父组件 onTimeUpdate 驱动）
 * @param onSeek      定位回调（纯 seek 不播放）
 */
export function WaveformStrip({
  projectId,
  durationSec,
  currentTime,
  onSeek,
}: {
  projectId: string;
  durationSec: number;
  currentTime: number;
  onSeek: (t: number) => void;
}) {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [boxW, setBoxW] = useState(0);
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
    ctx.fillStyle = "#d4d4d8"; // neutral-300：底图中性，播放进度由上层遮罩染色
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
  function seekFromEvent(e: React.PointerEvent<HTMLDivElement>) {
    if (durationSec <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    onSeek(ratio * durationSec);
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
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        seekFromEvent(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons & 1) seekFromEvent(e); // 按住左键拖动 scrub
      }}
      className="relative h-12 cursor-pointer touch-none select-none overflow-hidden rounded-lg bg-neutral-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 focus-visible:ring-offset-1"
      title="点击或拖动定位播放"
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      {/* 已播放区域染色 + 播放头（timeupdate ~4Hz，线性过渡补间让移动连续）；
          波形数据到位前只显示骨架灰底 */}
      {peaks && durationSec > 0 && (
        <>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 bg-brand/10"
            style={{ width: `${progress * 100}%` }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-0.5 bg-brand transition-[left] duration-150 ease-linear"
            style={{ left: `calc(${progress * 100}% - 1px)` }}
          />
        </>
      )}
    </div>
  );
}
