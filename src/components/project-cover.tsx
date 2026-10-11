/**
 * @file 项目封面缩略图（工作台列表用，服务端组件）
 * @description 视觉母题是「监视器里的一帧」：有封面时请求本人专属封面接口；
 *              无封面（音频项目/未转写/抽帧失败）时渲染占位图——视频为播放三角、
 *              音频为声波竖线。转写中的封面叠加自上而下的扫描线动画
 *              （globals.css cover-scanline，reduced-motion 下静止），
 *              右下角叠播放器风格的时长角标。
 */
import { formatDuration } from "@/components/project-status";
import type { ProjectStatus } from "@prisma/client";

/** ProjectCover 属性 */
interface ProjectCoverProps {
  /** 项目 ID（拼封面接口地址） */
  projectId: string;
  /** 封面存储 key（空 = 渲染占位，不发起请求） */
  coverKey: string | null;
  /** 媒体类型（决定占位图标） */
  mediaKind: string;
  /** 时长（秒，空则不显示角标） */
  durationSec: number | null;
  /** 项目状态（转写中叠加扫描线） */
  status: ProjectStatus;
}

/** 占位图：视频播放三角 */
function PlayGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-7 w-7 fill-neutral-400" aria-hidden>
      <path d="M8 5.5v13a.7.7 0 0 0 1.07.6l10.2-6.5a.7.7 0 0 0 0-1.2L9.07 4.9A.7.7 0 0 0 8 5.5Z" />
    </svg>
  );
}

/** 占位图：音频声波（四条圆头竖线） */
function WaveGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-7 w-7 stroke-neutral-400" aria-hidden>
      <g strokeLinecap="round" strokeWidth="2.2" fill="none">
        <path d="M4 10v4" />
        <path d="M9.3 6.5v11" />
        <path d="M14.7 8.5v7" />
        <path d="M20 10v4" />
      </g>
    </svg>
  );
}

/**
 * 项目封面组件
 * @param props projectId / coverKey / mediaKind / durationSec / status
 */
export function ProjectCover({ projectId, coverKey, mediaKind, durationSec, status }: ProjectCoverProps) {
  const isAudio = mediaKind === "audio";
  const transcribing = status === "TRANSCRIBING" || status === "UPLOADED";

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-neutral-200 transition-[filter] group-hover:brightness-105">
      {coverKey ? (
        // 本人专属鉴权接口（local 流式 / oss 签名 URL 302）
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/projects/${projectId}/cover`}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : (
        <div
          className={`flex h-full w-full items-center justify-center bg-gradient-to-br ${
            isAudio ? "from-neutral-200 to-neutral-300" : "from-neutral-100 to-neutral-300"
          }`}
        >
          {isAudio ? <WaveGlyph /> : <PlayGlyph />}
        </div>
      )}

      {/* 转写进行中：扫描线自上而下循环（reduced-motion 静止） */}
      {transcribing && (
        <div
          aria-hidden
          className="cover-scanline pointer-events-none absolute inset-x-0 h-[12%] bg-gradient-to-b from-transparent via-white/45 to-transparent"
        />
      )}

      {/* 播放器风格时长角标 */}
      {durationSec != null && (
        <span className="absolute bottom-1.5 right-1.5 rounded bg-black/75 px-1 py-0.5 text-[11px] font-medium tabular-nums text-white">
          {formatDuration(durationSec)}
        </span>
      )}
    </div>
  );
}
