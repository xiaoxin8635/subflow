/**
 * @file 项目状态徽章与时长格式化（前后端共用小组件/工具）
 * @description ProjectStatusBadge 将 ProjectStatus 枚举渲染为带色的中文徽章；
 *              formatDuration 将秒数格式化为 mm:ss / hh:mm:ss。
 */
import type { ProjectStatus } from "@prisma/client";

/** 状态 → 中文文案与配色 */
const STATUS_META: Record<ProjectStatus, { label: string; className: string }> = {
  UPLOADED: { label: "排队中", className: "bg-neutral-100 text-neutral-600" },
  TRANSCRIBING: { label: "转写中", className: "bg-blue-50 text-blue-600" },
  POLISHING: { label: "AI 润色中", className: "bg-amber-50 text-amber-600" },
  READY: { label: "已完成", className: "bg-green-50 text-green-600" },
  FAILED: { label: "失败", className: "bg-red-50 text-red-600" },
};

/**
 * 项目状态徽章
 * @param status Prisma ProjectStatus 枚举值
 */
export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.UPLOADED;
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${meta.className}`}>
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
