/**
 * @file 新建项目页（服务端壳，AppShell 布局）
 * @description 未登录重定向 /login；登录态把 AppShell（深色侧边栏）套在
 *              NewUploadClient（多文件批量上传主体，客户端组件）外层。
 */
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";
import { NewUploadClient } from "./new-upload";

// 登录态页面：读取 cookie，按需阻塞渲染（Cache Components 下必须显式声明）
export const instant = false;

/** 新建项目页入口组件 */
export default async function NewProjectPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <AppShell active="new" phone={user.phone} balanceSeconds={user.balanceSeconds}>
      <NewUploadClient />
    </AppShell>
  );
}
