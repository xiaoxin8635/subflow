/**
 * @file 登录后应用外壳：毛玻璃深青黑侧边栏 + 浅薄荷工作区
 * @description 视觉母题：半透明毛玻璃「工具面板」浮在薄荷奶油白渐变画布上——
 *              侧边栏深青黑半透明 + 20px 背景模糊 + 右缘 1px 青绿描边，
 *              透出画布上的青绿/珊瑚柔光斑；内容区是「画面」。桌面（≥lg）
 *              左侧固定 240px 面板；窄屏收纳为顶部横向标签栏（可横滑，同质感
 *              毛玻璃）。底部用户区含脱敏手机号、通知铃铛、余额与退出登录。
 *              导航部分（SideNav / MobileNavTabs）为客户端组件——共享滑动
 *              高亮层，切换页面时平滑平移；须由 dashboard/layout.tsx（或项目
 *              详情页）渲染以保留跨页 DOM。营销页（首页/价格/法务）仍用
 *              SiteHeader，不套本外壳。
 */
import Link from "next/link";
import { maskPhone } from "@/lib/auth";
import { formatSecondsLabel } from "@/lib/format";
import { NotificationBell } from "@/components/notification-bell";
import { LogoutButton, MobileLogout } from "@/components/logout-button";
import { SideNav, MobileNavTabs } from "@/components/side-nav";

/** AppShell 属性 */
interface AppShellProps {
  /** 当前用户手机号（组件内脱敏展示） */
  phone: string;
  /** 剩余额度（秒） */
  balanceSeconds: number;
  /** 页面内容 */
  children: React.ReactNode;
}

/**
 * 应用外壳组件
 * @param props 用户信息 / 内容
 */
export function AppShell({ phone, balanceSeconds, children }: AppShellProps) {
  return (
    <div className="relative min-h-screen bg-[linear-gradient(155deg,#f2faf6_0%,#f6fbf8_45%,#fbf9f2_100%)]">
      {/* 画布柔光斑：青绿（右上）与珊瑚（左中）两团极淡光晕，毛玻璃面板透光即来自这里 */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-24 right-[8%] h-72 w-72 rounded-full bg-[radial-gradient(circle,rgba(20,184,166,0.10),transparent_70%)]" />
        <div className="absolute left-[28%] top-[38%] h-64 w-64 rounded-full bg-[radial-gradient(circle,rgba(232,93,58,0.05),transparent_70%)]" />
      </div>

      {/* 移动端顶部面板（<lg）：Logo + 横向滚动标签栏（滑动高亮块），同质感毛玻璃 */}
      <div className="sticky top-0 z-40 border-b border-teal-300/15 bg-[#0b1f1d]/85 backdrop-blur-[20px] lg:hidden">
        <div className="flex items-center justify-between px-4 pt-3">
          <Link href="/" className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-[#14b8a6] to-[#0f766e] text-xs font-bold text-white shadow-[0_0_10px_rgba(20,184,166,0.4)]">
              SF
            </span>
            <span className="text-sm font-semibold text-white">字幕工坊</span>
          </Link>
          <NotificationBell variant="dark" />
        </div>
        <MobileNavTabs>
          <span className="shrink-0 self-center pl-2">
            <MobileLogout />
          </span>
        </MobileNavTabs>
      </div>

      <div className="lg:flex">
        {/* 桌面侧边栏（≥lg）：毛玻璃深青黑工具面板，右缘 1px 青绿描边 */}
        <aside className="sticky top-0 isolate hidden h-screen w-60 shrink-0 flex-col border-r border-teal-300/20 bg-[#0b1f1d]/80 backdrop-blur-[20px] lg:flex">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-44 bg-[radial-gradient(70%_100%_at_50%_0%,rgba(20,184,166,0.16),transparent)]"
          />
          {/* Logo 区（SF 青绿渐变辉光方块 + 青绿品牌字） */}
          <div className="px-5 pb-6 pt-6">
            <Link href="/" className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-[#14b8a6] to-[#0f766e] text-sm font-bold text-white shadow-[0_0_14px_rgba(20,184,166,0.45)]">
                SF
              </span>
              <span className="text-base font-semibold tracking-tight text-white">
                字幕工坊
              </span>
            </Link>
          </div>

          {/* 主导航：滑动高亮层（青绿胶囊整体平移），见 side-nav.tsx */}
          <SideNav />

          {/* 底部用户区：同质感毛玻璃余额卡（额度青绿加粗、退出登录收在卡片内最下方） */}
          <div className="border-t border-white/10 px-3 py-4">
            <div className="rounded-xl bg-white/[0.07] px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] ring-1 ring-inset ring-white/10 backdrop-blur-sm">
              <p className="text-xs text-teal-100/50">剩余额度</p>
              <p className="mt-0.5 text-lg font-bold tabular-nums text-teal-300">
                {formatSecondsLabel(balanceSeconds)}
              </p>
              <div className="mt-1 flex items-center justify-between text-xs">
                <span className="text-teal-100/50">{maskPhone(phone)}</span>
                <NotificationBell variant="dark" placement="bottom" />
              </div>
              <div className="mt-1.5 border-t border-white/10 pt-1">
                <LogoutButton />
              </div>
            </div>
          </div>
        </aside>

        {/* 内容区 */}
        <main className="relative min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
