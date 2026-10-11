/**
 * @file 项目状态徽章与时长格式化（前后端共用小组件/工具）
 * @description ProjectStatusBadge 将 ProjectStatus 枚举渲染为「字幕条」样式徽章
 *              （视频字幕的黑底白字小圆角条——本产品世界的视觉母题；批次②暗色主题下
 *              母题反转为白玻璃底 + 深字，进行中用品牌紫并带呼吸点，完成用亮青字
 *              提示「就绪」，失败用红玻璃底）。formatDuration 将秒数格式化为 mm:ss / hh:mm:ss。
 */
import type { ProjectStatus } from "@prisma/client";

/** 状态 → 中文文案与字幕条配色 */
const STATUS_META: Record<ProjectStatus, { label: string; className: string; live: boolean }> = {
  UPLOADED: { label: "排队中", className: "bg-white/10 text-neutral-300", live: false },
  TRANSCRIBING: { label: "转写中", className: "bg-brand text-white", live: true },
  POLISHING: { label: "AI 润色中", className: "bg-brand text-white", live: true },
  READY: { label: "已完成", className: "bg-accent/15 text-accent", live: false },
  FAILED: { label: "失败", className: "bg-red-500/15 text-red-400", live: false },
};

/**
 * 项目状态徽章（字幕条样式）
 * @param status Prisma ProjectStatus 枚举值
 */
export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.UPLOADED;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium ${meta.className}`}
    >
      {meta.live && (
        <span
          aria-hidden
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/90 motion-reduce:animate-none"
        />
      )}
      {meta.label}
    </span>
  );
}

/**
 * 秒数格式化为 mm:ss（超过 1 小时为 hh:mm:ss）
 * @param total 秒（浮点，向下取整显示）
 */
export function formatDuration(total: number): string {
  const sec = Math.floor(total);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
