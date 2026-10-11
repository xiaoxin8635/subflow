/**
 * @file 项目详情页（转写状态轮询 + 字幕分段展示）
 * @description 服务端负责鉴权与首屏数据（未登录跳 /login，项目不存在/非本人 404）；
 *              登录态统一套「剪辑台」深色侧边栏外壳（AppShell，与工作台一致），
 *              内容区放宽为监视器主导布局（max-w-7xl，视频预览是最大幅面）。
 *              客户端组件 ProjectLiveView 负责轮询 GET /api/projects/[id]：
 *              UPLOADED/TRANSCRIBING/POLISHING 每 3 秒刷新，READY 渲染分段字幕，
 *              FAILED 显示失败原因与重试引导。
 */
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { transcribeQueuePosition } from "@/lib/queue/queues";
import { AppShell } from "@/components/app-shell";
import { ProjectLiveView } from "./project-live-view";

// 登录态页面：读取 cookie + 数据库，按需阻塞渲染（Cache Components 下必须显式声明）
export const instant = false;

/** 项目详情页入口（服务端首屏） */
export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { id } = await params;
  const project = await db.project.findUnique({
    where: { id },
    include: { transcript: true },
  });
  // 不存在或非本人：404（与 API 行为一致，避免探测）
  if (!project || project.userId !== user.id) notFound();

  return (
    <AppShell active="projects" phone={user.phone} balanceSeconds={user.balanceSeconds}>
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
        <div className="text-sm text-neutral-500">
          <Link href="/dashboard" className="transition-colors hover:text-brand">
            ← 返回项目列表
          </Link>
        </div>
        <ProjectLiveView
          projectId={project.id}
          initial={{
            id: project.id,
            title: project.title,
            status: project.status,
            mediaKind: project.mediaKind === "audio" ? "audio" : "video",
            coverKey: project.coverKey,
            durationSec: project.durationSec,
            error: project.error,
            queuePosition:
              project.status === "UPLOADED"
                ? ((await transcribeQueuePosition(`transcribe-${project.id}`))?.position ?? null)
                : null,
            transcript: project.transcript
              ? {
                  segments: project.transcript.segments,
                  asrProvider: project.transcript.asrProvider,
                  llmPolished: project.transcript.llmPolished,
                }
              : null,
          }}
        />
      </div>
    </AppShell>
  );
}
