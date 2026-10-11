"use client";
/**
 * @file 工作台自动刷新（客户端组件，无可视输出）
 * @description 存在转写中的项目时由服务端条件渲染本组件：每 intervalSec 秒调用
 *              router.refresh() 重取服务端列表；页面切到后台（document.hidden）
 *              时跳过本轮，避免无谓请求。项目全部完成后服务端不再渲染本组件，
 *              轮询自然停止。
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** AutoRefresh 属性 */
interface AutoRefreshProps {
  /** 刷新间隔（秒，默认 10） */
  intervalSec?: number;
}

/**
 * 自动刷新组件（渲染为 null）
 * @param props intervalSec 刷新间隔
 */
export function AutoRefresh({ intervalSec = 10 }: AutoRefreshProps) {
  const router = useRouter();

  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) router.refresh();
    }, intervalSec * 1000);
    return () => clearInterval(timer);
  }, [router, intervalSec]);

  return null;
}
