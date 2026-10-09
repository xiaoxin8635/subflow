"use client";
/**
 * @file 项目实时视图（客户端轮询组件）
 * @description 接收服务端首屏数据，项目处于中间态（UPLOADED/TRANSCRIBING/POLISHING）时
 *              每 3 秒轮询 GET /api/projects/[id]，直至 READY/FAILED。
 *              READY 渲染字幕编辑器（视频预览 + 逐行编辑 + 样式切换）。
 */
import { useEffect, useRef, useState } from "react";
import type { ProjectStatus } from "@prisma/client";
import { formatDuration, ProjectStatusBadge } from "@/components/project-status";
import { SubtitleEditor } from "./subtitle-editor";
import type { EditorSegment } from "./subtitle-editor";

/** 详情接口返回的项目结构（与 /api/projects/[id] GET 响应一致） */
export interface ProjectDetail {
  id: string;
  title: string;
  status: ProjectStatus;
  durationSec: number | null;
  error: string | null;
  transcript: {
    segments: unknown;
    asrProvider: string | null;
    llmPolished: boolean;
  } | null;
}

/** 入库的分段结构（Transcript.segments JSON） */
interface SegmentRow {
  start: number;
  end: number;
  text: string;
  keywords?: string[];
}

/** 处于中间态时是否需要继续轮询 */
const ACTIVE_STATUSES = new Set(["UPLOADED", "TRANSCRIBING", "POLISHING"]);

/**
 * 项目实时视图组件
 * @param projectId 项目 ID（轮询地址）
 * @param initial   服务端首屏数据
 */
export function ProjectLiveView({
  projectId,
  initial,
}: {
  projectId: string;
  initial: ProjectDetail;
}) {
  const [project, setProject] = useState<ProjectDetail>(initial);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 轮询：仅在中间态启动；卸载/终态时清理
  useEffect(() => {
    if (!ACTIVE_STATUSES.has(project.status)) return;

    timerRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}`, { cache: "no-store" });
        if (!res.ok) return; // 瞬时错误（如 dev 重编译）静默跳过，下个周期重试
        const body = (await res.json()) as { project: ProjectDetail };
        setProject(body.project);
      } catch {
        // 网络抖动：忽略，等待下一轮
      }
    }, 3000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [project.status, projectId]);

  // 解析分段（JSON 存储按 unknown 读取，运行时校验形状并补齐 keywords）
  const segments: EditorSegment[] = Array.isArray(project.transcript?.segments)
    ? (project.transcript.segments as SegmentRow[])
        .filter(
          (s) =>
            typeof s?.start === "number" &&
            typeof s?.end === "number" &&
            typeof s?.text === "string",
        )
        .map((s) => ({
          start: s.start,
          end: s.end,
          text: s.text,
          keywords: Array.isArray(s.keywords) ? s.keywords : [],
        }))
    : [];

  return (
    <div className="mt-4">
      {/* 标题与状态 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{project.title}</h1>
        <ProjectStatusBadge status={project.status} />
      </div>
      <p className="mt-1 text-sm text-neutral-500">
        {project.durationSec != null && <>时长 {formatDuration(project.durationSec)} · </>}
        {project.transcript?.asrProvider && <>引擎 {project.transcript.asrProvider} · </>}
        {project.transcript?.llmPolished ? "已经 AI 润色" : "未润色"}
      </p>

      {/* 处理中提示 */}
      {ACTIVE_STATUSES.has(project.status) && (
        <div className="mt-10 flex min-h-[300px] flex-col items-center justify-center rounded-2xl border border-black/5 bg-white text-center shadow-sm">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-brand/20 border-t-brand" />
          <p className="mt-5 font-medium">
            {project.status === "TRANSCRIBING" ? "AI 正在识别语音…" : project.status === "POLISHING" ? "AI 正在润色字幕…" : "任务排队中…"}
          </p>
          <p className="mt-1 text-sm text-neutral-500">页面每 3 秒自动刷新，无需手动操作</p>
        </div>
      )}

      {/* 失败提示 */}
      {project.status === "FAILED" && (
        <div className="mt-10 rounded-2xl border border-red-100 bg-red-50 p-6 text-center">
          <div className="text-3xl">⚠️</div>
          <p className="mt-3 font-medium text-red-700">处理失败</p>
          <p className="mt-1 text-sm text-red-600">{project.error ?? "未知错误"}</p>
          <p className="mt-3 text-xs text-red-400">可返回项目列表重新上传；额度不会被消耗</p>
        </div>
      )}

      {/* 字幕编辑器（READY） */}
      {project.status === "READY" &&
        (segments.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-black/5 bg-white p-10 text-center shadow-sm">
            <p className="text-sm text-neutral-500">未识别到字幕内容</p>
          </div>
        ) : (
          <SubtitleEditor projectId={projectId} initialSegments={segments} durationSec={project.durationSec ?? 0} />
        ))}
    </div>
  );
}
