/**
 * @file dashboard 布局（AppShell 深色侧边栏）
 * @description 登录守卫 + 应用外壳。侧边栏必须放在 layout 而非各页面内：
 *              Next.js 页面切换时 layout 的 DOM 会被保留，客户端导航时
 *              SideNav 的滑动高亮层才能播放平移动画（放页面内会随页面
 *              整树重建，动画无从发生）。项目详情页（/project/[id]）位于
 *              本路由段之外，自行渲染 AppShell，视觉一致但无跨段动画。
 */
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";

// 登录态布局：读取 cookie，按需阻塞渲染（Cache Components 下必须显式声明）
export const instant = false;

/**
 * dashboard 布局入口
 * @param props.children 当前路由段的页面内容
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <AppShell phone={user.phone} balanceSeconds={user.balanceSeconds}>
      {children}
    </AppShell>
  );
}
