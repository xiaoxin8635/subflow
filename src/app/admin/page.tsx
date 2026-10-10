/**
 * @file 管理后台（/admin，服务端壳）
 * @description 仅 ADMIN_PHONES 白名单用户可见（其余一律 404，不暴露后台存在）。
 *              页面组成：经营统计卡片、发码表单（客户端组件 AdminCodeForm）、
 *              未用激活码列表、失败任务列表（客户端组件 AdminFailures，
 *              含一键重试）、用户总览。数据服务端直查，无需额外 GET API。
 */
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser, maskPhone } from "@/lib/auth";
import { isAdminPhone } from "@/lib/admin";
import { SiteHeader } from "@/components/site-header";
import { formatDuration } from "@/components/project-status";
import { TRANSCRIPT_QUEUE_NAME, EXPORT_QUEUE_NAME, queueFailedCount } from "@/lib/queue/queues";
import { AdminCodeForm } from "./admin-code-form";
import { AdminFailures } from "./admin-failures";

// 登录态页面：读取 cookie + 数据库，按需阻塞渲染
export const instant = false;

/** 管理后台入口组件 */
export default async function AdminPage() {
  const user = await getCurrentUser();
  if (!user || !isAdminPhone(user.phone)) notFound();

  // 经营统计（并行查询）
  const [userCount, balanceSum, projectCount, exportDoneCount, consumedSum] = await Promise.all([
    db.user.count(),
    db.user.aggregate({ _sum: { balanceSeconds: true } }),
    db.project.count(),
    db.exportTask.count({ where: { status: "DONE" } }),
    db.creditLedger.aggregate({ _sum: { changeSeconds: true }, where: { changeSeconds: { lt: 0 } } }),
  ]);

  const [recentCodes, recentUsers, plans] = await Promise.all([
    db.redeemCode.findMany({
      where: { status: "UNUSED" },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { code: true, bonusSeconds: true, planId: true, createdAt: true },
    }),
    db.user.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        phone: true,
        balanceSeconds: true,
        createdAt: true,
        _count: { select: { projects: true } },
      },
    }),
    db.plan.findMany({ where: { isActive: true }, orderBy: { priceCents: "asc" } }),
  ]);

  // 失败任务（P1.6 可观测性）：DB 终态失败记录 + 队列侧 failed 积压数
  const [failedProjects, failedExports, transcriptFailed, exportFailed] = await Promise.all([
    db.project.findMany({
      where: { status: "FAILED" },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, title: true, error: true, createdAt: true },
    }),
    db.exportTask.findMany({
      where: { status: "FAILED" },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, error: true, createdAt: true, project: { select: { title: true } } },
    }),
    queueFailedCount(TRANSCRIPT_QUEUE_NAME),
    queueFailedCount(EXPORT_QUEUE_NAME),
  ]);

  /** 套餐名映射（码列表展示用） */
  const planNameById = new Map(plans.map((p) => [p.id, p.name]));

  const stats = [
    { label: "用户数", value: String(userCount) },
    { label: "未耗总额度", value: formatDuration(balanceSum._sum.balanceSeconds ?? 0) },
    { label: "项目数", value: String(projectCount) },
    { label: "导出成片", value: `${exportDoneCount} 次` },
    { label: "累计消耗", value: formatDuration(Math.abs(consumedSum._sum.changeSeconds ?? 0)) },
  ];

  return (
    <div className="flex min-h-screen flex-col bg-neutral-50">
      <SiteHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10">
        <h1 className="text-2xl font-bold tracking-tight">管理后台</h1>

        {/* 经营统计 */}
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {stats.map((s) => (
            <div key={s.label} className="rounded-2xl border border-black/5 bg-white px-4 py-3 shadow-sm">
              <p className="text-xs text-neutral-400">{s.label}</p>
              <p className="mt-1 font-semibold">{s.value}</p>
            </div>
          ))}
        </div>

        {/* 发码表单 */}
        <AdminCodeForm plans={plans.map((p) => ({ id: p.id, name: p.name }))} />

        {/* 未用激活码 */}
        <section className="mt-8">
          <h2 className="text-sm font-medium text-neutral-500">未使用的激活码（最近 20 枚）</h2>
          {recentCodes.length === 0 ? (
            <p className="mt-2 text-sm text-neutral-400">暂无未用码</p>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {recentCodes.map((c) => (
                <li
                  key={c.code}
                  className="flex items-center gap-3 rounded-xl border border-black/5 bg-white px-4 py-2.5 font-mono text-sm shadow-sm"
                >
                  <span className="tracking-wider">{c.code}</span>
                  <span className="font-sans text-xs text-neutral-400">
                    {c.planId ? (planNameById.get(c.planId) ?? "套餐码") : formatDuration(c.bonusSeconds ?? 0)}
                    {" · "}
                    {new Date(c.createdAt).toLocaleString("zh-CN", { hour12: false })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 失败任务（含重试按钮） */}
        <AdminFailures
          projects={failedProjects.map((p) => ({
            id: p.id,
            title: p.title,
            error: p.error ?? "",
            createdAt: p.createdAt.toISOString(),
          }))}
          exports={failedExports.map((t) => ({
            id: t.id,
            projectTitle: t.project.title,
            error: t.error ?? "",
            createdAt: t.createdAt.toISOString(),
          }))}
          queueFailed={{ transcript: transcriptFailed, export: exportFailed }}
        />

        {/* 用户总览 */}
        <section className="mt-8">
          <h2 className="text-sm font-medium text-neutral-500">用户（最近注册 20 个）</h2>
          <ul className="mt-3 space-y-1.5">
            {recentUsers.map((u) => (
              <li
                key={u.phone}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-black/5 bg-white px-4 py-2.5 text-sm shadow-sm"
              >
                <span>{maskPhone(u.phone)}</span>
                <span className="text-brand">余额 {formatDuration(u.balanceSeconds)}</span>
                <span className="text-neutral-400">{u._count.projects} 个项目</span>
                <span className="ml-auto text-xs text-neutral-400">
                  {new Date(u.createdAt).toLocaleString("zh-CN", { hour12: false })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
