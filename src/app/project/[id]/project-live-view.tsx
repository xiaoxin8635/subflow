"use client";
/**
 * @file 项目实时视图（客户端轮询组件）
 * @description 接收服务端首屏数据，项目处于中间态（UPLOADED/TRANSCRIBING/POLISHING）时
 *              每 3 秒轮询 GET /api/projects/[id]，直至 READY/FAILED。
 *              READY 渲染字幕编辑器（批次①：翻译/导出收进编辑器顶部按钮唤起的抽屉）。
 */
import { useEffect, useRef, useState } from "react";
import type { ProjectStatus } from "@prisma/client";
import { formatDuration, ProjectStatusBadge } from "@/components/project-status";
import { ProjectCover } from "@/components/project-cover";
import {
  browserNotify,
  notificationPermission,
  requestNotificationPermission,
} from "@/lib/browser-notify";
import { SubtitleEditor } from "./subtitle-editor";
import type { EditorSegment } from "./subtitle-editor";

/** 详情接口返回的项目结构（与 /api/projects/[id] GET 响应一致） */
export interface ProjectDetail {
  id: string;
  title: string;
  status: ProjectStatus;
  /** 媒体类型：video（可烧录成片）/ audio（仅字幕文件下载） */
  mediaKind?: "video" | "audio";
  /** 封面存储 key（转写开始后由 pipeline 旁路生成；音频项目恒为 null） */
  coverKey?: string | null;
  waveformKey?: string | null;
  durationSec: number | null;
  error: string | null;
  /** UPLOADED（排队中）时的转写队列位置（1 起；null = 队列信息不可用/已在处理） */
  queuePosition?: number | null;
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
  // 浏览器通知授权状态（SSR 首帧为 unsupported，挂载后读取真实值）
  const [perm, setPerm] = useState<string>("unsupported");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 上一轮状态（检测 ACTIVE → 终态跃迁时弹系统通知）
  const prevStatus = useRef<ProjectStatus>(initial.status);

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

  // 轮询：仅在中间态启动；卸载/终态时清理
  useEffect(() => {
    if (!ACTIVE_STATUSES.has(project.status)) return;

    timerRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}`, { cache: "no-store" });
        if (!res.ok) return; // 瞬时错误（如 dev 重编译）静默跳过，下个周期重试
        const body = (await res.json()) as { project: ProjectDetail };
        const from = prevStatus.current;
        const to = body.project.status;
        setProject(body.project);
        prevStatus.current = to;
        // ACTIVE → READY/FAILED 跃迁：弹系统通知（仅授权且页面不可见时生效）
        if (from !== to && ACTIVE_STATUSES.has(from) && !ACTIVE_STATUSES.has(to)) {
          browserNotify(
            to === "READY" ? "字幕转写完成" : "转写失败",
            to === "READY"
              ? `「${body.project.title}」字幕已就绪，可编辑与导出`
              : `「${body.project.title}」处理失败，请回页面查看原因`,
          );
        }
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
      {/* 标题与状态（字幕条徽章紧挨标题，剪辑台项目头语言） */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{project.title}</h1>
        <ProjectStatusBadge status={project.status} />
      </div>
      <p className="mt-1 text-sm text-neutral-500">
        {project.durationSec != null && <>时长 {formatDuration(project.durationSec)} · </>}
        {project.transcript?.asrProvider && <>引擎 {project.transcript.asrProvider} · </>}
        {project.transcript?.llmPolished ? "已经 AI 润色" : "未润色"}
      </p>

      {/* 处理中：监视器占位（转写中封面带扫描线，与工作台列表同款母语）+ 状态行 */}
      {ACTIVE_STATUSES.has(project.status) && (
        <div className="mx-auto mt-6 max-w-2xl rounded-2xl border border-black/5 bg-white p-4 text-center shadow-sm sm:p-5">
          <ProjectCover
            projectId={projectId}
            coverKey={project.coverKey ?? null}
            mediaKind={project.mediaKind ?? "video"}
            durationSec={project.durationSec}
            status={project.status}
          />
          <div className="mt-4 flex items-center justify-center gap-2.5">
            <span
              aria-hidden
              className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-brand/20 border-t-brand"
            />
            <p className="font-medium">
              {project.status === "TRANSCRIBING"
                ? "AI 正在识别语音…"
                : project.status === "POLISHING"
                  ? "AI 正在润色字幕…"
                  : project.queuePosition
                    ? `排队中（第 ${project.queuePosition} 位）…`
                    : "任务排队中…"}
            </p>
          </div>
          <p className="mt-1 text-sm text-neutral-500">
            {project.status === "UPLOADED" && project.queuePosition
              ? "前面的任务完成后自动开始，页面自动刷新，无需手动操作"
              : "页面每 3 秒自动刷新，无需手动操作"}
          </p>
          {perm === "default" && (
            <button
              type="button"
              onClick={() => void requestNotificationPermission().then(setPerm)}
              className="mt-3 text-xs text-neutral-400 underline underline-offset-2 transition-colors hover:text-brand"
            >
              开启完成提醒（切到其他页面时通知你）
            </button>
          )}
        </div>
      )}

      {/* 失败提示 */}
      {project.status === "FAILED" && (
        <div className="mx-auto mt-6 max-w-2xl rounded-2xl border border-red-100 bg-red-50 p-6 text-center">
          <div className="text-3xl">⚠️</div>
          <p className="mt-3 font-medium text-red-700">处理失败</p>
          <p className="mt-1 text-sm text-red-600">{project.error ?? "未知错误"}</p>
          <p className="mt-3 text-xs text-red-400">可返回项目列表重新上传；额度不会被消耗</p>
        </div>
      )}

      {/* 字幕编辑器（READY；翻译/导出在编辑器顶部按钮唤起的抽屉内） */}
      {project.status === "READY" &&
        (segments.length === 0 ? (
          <div className="mx-auto mt-6 max-w-2xl rounded-2xl border border-black/5 bg-white p-10 text-center shadow-sm">
            <p className="text-sm text-neutral-500">未识别到字幕内容</p>
          </div>
        ) : (
          <SubtitleEditor
            projectId={projectId}
            projectTitle={project.title}
            initialSegments={segments}
            durationSec={project.durationSec ?? 0}
            mediaKind={project.mediaKind ?? "video"}
            waveformKey={project.waveformKey ?? null}
          />
        ))}
    </div>
  );
}
