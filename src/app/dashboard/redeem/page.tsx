/**
 * @file 激活码兑换页（服务端壳，/dashboard/redeem）
 * @description 未登录重定向到 /login；深色侧边栏外壳由 dashboard/layout.tsx
 *              统一提供，本页只负责渲染兑换表单（客户端组件）。
 */
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { RedeemForm } from "./redeem-form";

// 登录态页面：读取 cookie，按需阻塞渲染（Cache Components 下必须显式声明）
export const instant = false;

/** 兑换页入口组件 */
export default async function RedeemPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-8 sm:px-6 lg:py-10">
      <RedeemForm balanceSeconds={user.balanceSeconds} />
    </div>
  );
}
