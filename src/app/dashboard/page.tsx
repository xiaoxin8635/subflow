/**
 * @file 工作台页面（项目列表）
 * @description 服务端组件：未登录重定向到 /login；已登录显示脱敏手机号与剩余额度。
 *              「新建项目」上传流程在下一模块（上传+转写流水线）接入。
 */
import { redirect } from "next/navigation";
import { getCurrentUser, maskPhone } from "@/lib/auth";
import { SiteHeader } from "@/components/site-header";

/** 秒数格式化为「X 小时 Y 分钟」 */
function formatSeconds(total: number): string {
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  if (minutes > 0) return `${minutes} 分钟`;
  return `${total} 秒`;
}

/** 工作台入口组件 */
export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <div className="flex min-h-screen flex-col bg-neutral-50">
      <SiteHeader />

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10">
        {/* 用户信息条 */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">我的项目</h1>
            <p className="mt-1 text-sm text-neutral-500">
              上传视频，AI 自动生成字幕
            </p>
          </div>
          <div className="flex items-center gap-4">
            <div className="rounded-xl border border-black/5 bg-white px-4 py-2 text-sm shadow-sm">
              <span className="text-neutral-500">{maskPhone(user.phone)}</span>
              <span className="mx-2 text-neutral-300">|</span>
              <span className="font-medium text-brand">
                剩余额度 {formatSeconds(user.balanceSeconds)}
              </span>
            </div>
            {/* TODO: 下一模块接入上传流程后启用 */}
            <button
              disabled
              className="rounded-xl bg-brand px-5 py-2.5 font-medium text-white opacity-60"
            >
              + 新建项目
            </button>
          </div>
        </div>

        {/* 空状态占位 */}
        <div className="mt-10 flex min-h-[400px] flex-col items-center justify-center rounded-2xl border-2 border-dashed border-neutral-200 bg-white text-center">
          <div className="text-5xl">🎬</div>
          <p className="mt-4 font-medium">还没有项目</p>
          <p className="mt-1 text-sm text-neutral-500">
            点击「新建项目」上传第一个视频，AI 将自动生成字幕
          </p>
        </div>
      </main>
    </div>
  );
}
