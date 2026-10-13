/**
 * @file 工作台页面（项目列表）
 * @description 服务端组件：未登录重定向到 /login。深色侧边栏外壳由
 *              dashboard/layout.tsx 统一提供（「剪辑台」结构——深色工具面板 +
 *              浅色工作区）。工作区含：
 *              页头（标题 + 新建按钮）、内联统计条（项目总数/累计转写/剩余额度，
 *              非卡片式）、状态筛选标签（URL 参数驱动，滑动指示条）、
 *              封面缩略图项目卡（转写中带扫描线动画）、分页。
 *              存在转写中项目时自动每 10 秒刷新（AutoRefresh）。
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ProjectStatus } from "@prisma/client";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatSecondsLabel, formatRelativeTime } from "@/lib/format";
import { ProjectStatusBadge } from "@/components/project-status";
import { ProjectCover } from "@/components/project-cover";
import { FilterTabs, type StatusFilter } from "@/components/filter-tabs";
import { AutoRefresh } from "@/components/auto-refresh";
import { FolderEmpty3D, SearchEmpty3D } from "@/components/empty-illustration";

// 登录态页面：读取 cookie + 数据库，按需阻塞渲染（Cache Components 下必须显式声明）
export const instant = false;

/** 每页项目数 */
const PAGE_SIZE = 20;

/** 「进行中」状态集合（筛选与轮询判定共用） */
const ACTIVE_STATUSES: ProjectStatus[] = ["UPLOADED", "TRANSCRIBING", "POLISHING"];

/** 筛选参数 → Prisma where 条件的 status 部分 */
const STATUS_WHERE: Record<Exclude<StatusFilter, "">, { status: { in: ProjectStatus[] } | ProjectStatus }> = {
  active: { status: { in: ACTIVE_STATUSES } },
  ready: { status: "READY" },
  failed: { status: "FAILED" },
};

/** 工作台入口组件 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string | string[]; status?: string | string[] }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // 解析页码与筛选（非法值回退默认）
  const raw = await searchParams;
  const pageParam = Array.isArray(raw.page) ? raw.page[0] : raw.page;
  const page = Math.max(1, Math.floor(Number(pageParam) || 1));
  const rawStatus = Array.isArray(raw.status) ? raw.status[0] : raw.status;
  const status: StatusFilter =
    rawStatus === "active" || rawStatus === "ready" || rawStatus === "failed" ? rawStatus : "";

  const where = { userId: user.id, ...(status ? STATUS_WHERE[status] : {}) };

  const [total, projects, byStatus, durationAgg] = await Promise.all([
    db.project.count({ where }),
    db.project.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        title: true,
        status: true,
        mediaKind: true,
        coverKey: true,
        durationSec: true,
        error: true,
        updatedAt: true,
      },
    }),
    // 各状态计数（筛选标签上的角标；与当前筛选无关，反映全量）
    db.project.groupBy({ by: ["status"], where: { userId: user.id }, _count: { _all: true } }),
    // 累计转写时长（统计条）
    db.project.aggregate({ where: { userId: user.id }, _sum: { durationSec: true } }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // 状态计数归并（groupBy 只返回存在的状态）
  const countOf = (s: ProjectStatus) => byStatus.find((r) => r.status === s)?._count._all ?? 0;
  const counts = {
    all: byStatus.reduce((acc, r) => acc + r._count._all, 0),
    active: ACTIVE_STATUSES.reduce((acc, s) => acc + countOf(s), 0),
    ready: countOf("READY"),
    failed: countOf("FAILED"),
  };
  const hasActive = counts.active > 0;
  const totalDuration = durationAgg._sum.durationSec ?? 0;

  /** 分页链接构造（保留当前筛选） */
  const pageHref = (p: number) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return qs ? `/dashboard?${qs}` : "/dashboard";
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:py-10">
      {hasActive && <AutoRefresh intervalSec={10} />}

      {/* 页头 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">我的项目</h1>
          <p className="mt-1 text-sm text-neutral-500">上传视频，AI 自动生成字幕</p>
        </div>
        <Link
          href="/dashboard/new"
          className="rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white shadow-[0_4px_0_0_#4338ca] transition-all duration-150 hover:-translate-y-0.5 hover:bg-brand-strong hover:shadow-[0_6px_0_0_#4338ca] active:translate-y-0.5 active:shadow-[0_1px_0_0_#4338ca] motion-reduce:transition-none motion-reduce:hover:translate-y-0 motion-reduce:active:translate-y-0"
        >
          新建项目
        </Link>
      </div>

      {/* 内联统计条：数字即界面，不做卡片（累计时长不区分筛选，余额直达兑换） */}
      <div className="mt-6 flex flex-wrap items-end gap-x-10 gap-y-4">
        <div>
          <p className="text-2xl font-semibold tabular-nums leading-none">{counts.all}</p>
          <p className="mt-1.5 text-xs text-neutral-400">个项目</p>
        </div>
        <div className="border-l border-neutral-200 pl-10">
          <p className="text-2xl font-semibold tabular-nums leading-none">{formatSecondsLabel(totalDuration)}</p>
          <p className="mt-1.5 text-xs text-neutral-400">累计转写</p>
        </div>
        <div className="border-l border-neutral-200 pl-10">
          <p className="text-2xl font-semibold tabular-nums leading-none text-brand">
            {formatSecondsLabel(user.balanceSeconds)}
          </p>
          <p className="mt-1.5 flex items-center gap-2 text-xs text-neutral-400">
            剩余额度
            <Link
              href="/dashboard/redeem"
              className="rounded-full bg-brand-soft px-2 py-0.5 font-medium text-brand transition-colors hover:bg-brand hover:text-white motion-reduce:transition-none"
            >
              兑换
            </Link>
          </p>
        </div>
      </div>

      {/* 状态筛选（滑动指示条） */}
      <div className="mt-8">
        <FilterTabs current={status} counts={counts} />
      </div>

      {/* 项目列表 / 空状态 */}
      {projects.length === 0 ? (
        <div className="mt-8">
          {counts.all === 0 ? (
            // 从未有过项目：引导上传
            <div className="flex min-h-[380px] flex-col items-center justify-center rounded-xl border-2 border-dashed border-neutral-200 text-center">
              <div className="empty-float">
                <FolderEmpty3D size="lg" />
              </div>
              <p className="mt-5 font-medium">还没有项目</p>
              <p className="mt-1 text-sm text-neutral-500">上传第一个视频，AI 自动生成字幕</p>
              <Link
                href="/dashboard/new"
                className="mt-5 rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-white shadow-[0_4px_0_0_#4338ca] transition-all duration-150 hover:-translate-y-0.5 hover:bg-brand-strong hover:shadow-[0_6px_0_0_#4338ca] active:translate-y-0.5 active:shadow-[0_1px_0_0_#4338ca]"
              >
                新建项目
              </Link>
            </div>
          ) : (
            // 筛选无结果：给出回到全部的出口
            <div className="flex min-h-[240px] flex-col items-center justify-center text-center">
              <div className="empty-float">
                <SearchEmpty3D />
              </div>
              <p className="mt-4 text-sm text-neutral-500">没有符合筛选的项目</p>
              <Link
                href="/dashboard"
                className="mt-3 text-sm font-medium text-brand underline-offset-2 hover:underline"
              >
                查看全部
              </Link>
            </div>
          )}
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                href={`/project/${p.id}`}
                className="group flex gap-4 rounded-xl border border-neutral-200/80 bg-white p-3 transition-all hover:border-brand/40 hover:shadow-md motion-reduce:transition-none"
              >
                {/* 封面（监视器一帧 / 占位 + 扫描线 + 时长角标） */}
                <div className="w-28 shrink-0 sm:w-44">
                  <ProjectCover
                    projectId={p.id}
                    coverKey={p.coverKey}
                    mediaKind={p.mediaKind}
                    durationSec={p.durationSec}
                    status={p.status}
                  />
                </div>
                <div className="min-w-0 flex-1 self-center">
                  <p className="truncate font-medium transition-colors group-hover:text-brand">{p.title}</p>
                  <p className="mt-1.5 flex items-center gap-1.5 text-xs text-neutral-400">
                    <span aria-hidden className="inline-flex items-center text-neutral-400">
                      {p.mediaKind === "audio" ? (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" className="h-3.5 w-3.5">
                          <path d="M3 10v4M7 8v8M11 5v14M15 8v8M19 10v4" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                          <rect x="3" y="5" width="18" height="14" rx="2" />
                          <path d="M10 9.5v5l4-2.5-4-2.5Z" />
                        </svg>
                      )}
                    </span>
                    {p.mediaKind === "audio" ? "音频" : "视频"}
                  </p>
                  {p.status === "FAILED" && p.error && (
                    <p className="mt-1.5 truncate text-xs text-red-500">失败原因：{p.error}</p>
                  )}
                </div>
                <div className="flex flex-col items-end justify-center gap-1.5 self-center pr-1">
                  <ProjectStatusBadge status={p.status} />
                  <time
                    dateTime={new Date(p.updatedAt).toISOString()}
                    title={new Date(p.updatedAt).toLocaleString("zh-CN", { hour12: false })}
                    className="text-xs tabular-nums text-neutral-400"
                  >
                    {formatRelativeTime(new Date(p.updatedAt))}
                  </time>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {/* 分页控件（多于 1 页时展示） */}
      {totalPages > 1 && (
        <nav className="mt-8 flex items-center justify-center gap-2 text-sm" aria-label="分页">
          {page > 1 ? (
            <Link
              href={pageHref(page - 1)}
              className="rounded-lg border border-neutral-200 bg-white px-3 py-1.5 transition-colors hover:border-neutral-300"
            >
              上一页
            </Link>
          ) : (
            <span className="rounded-lg border border-neutral-100 bg-neutral-100 px-3 py-1.5 text-neutral-300">
              上一页
            </span>
          )}
          <span className="px-2 tabular-nums text-neutral-500">
            第 {page} / {totalPages} 页 · 共 {total} 个
          </span>
          {page < totalPages ? (
            <Link
              href={pageHref(page + 1)}
              className="rounded-lg border border-neutral-200 bg-white px-3 py-1.5 transition-colors hover:border-neutral-300"
            >
              下一页
            </Link>
          ) : (
            <span className="rounded-lg border border-neutral-100 bg-neutral-100 px-3 py-1.5 text-neutral-300">
              下一页
            </span>
          )}
        </nav>
      )}
    </div>
  );
}
