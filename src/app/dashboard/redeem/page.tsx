/**
 * @file 激活码兑换页（服务端壳，/dashboard/redeem，AppShell 布局）
 * @description 未登录重定向到 /login；已登录把兑换表单（客户端组件）包在
 *              AppShell（深色侧边栏）内容区内。
 */
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";
import { RedeemForm } from "./redeem-form";

// 登录态页面：读取 cookie，按需阻塞渲染（Cache Components 下必须显式声明）
export const instant = false;

/** 兑换页入口组件 */
export default async function RedeemPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <AppShell active="redeem" phone={user.phone} balanceSeconds={user.balanceSeconds}>
      <div className="mx-auto w-full max-w-xl px-4 py-8 sm:px-6 lg:py-10">
        <RedeemForm balanceSeconds={user.balanceSeconds} />
      </div>
    </AppShell>
  );
}
