/**
 * @file 新建项目页（服务端壳）
 * @description 未登录重定向 /login；深色侧边栏外壳由 dashboard/layout.tsx
 *              统一提供（跨页保留 DOM，侧边栏滑动高亮才有平移动画），
 *              本页只负责渲染 NewUploadClient（多文件批量上传主体，客户端组件）。
 */
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { NewUploadClient } from "./new-upload";

// 登录态页面：读取 cookie，按需阻塞渲染（Cache Components 下必须显式声明）
export const instant = false;

/** 新建项目页入口组件 */
export default async function NewProjectPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <NewUploadClient />
  );
}
