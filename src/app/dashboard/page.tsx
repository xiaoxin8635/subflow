/**
 * @file 工作台页面（项目列表）
 * @description 用户登录后的主界面：新建项目入口 + 项目列表。
 *              当前为骨架版：接入认证（middleware 保护）与项目查询 API 后，
 *              将改为服务端读取当前用户的项目数据并渲染真实列表。
 */
import { SiteHeader } from "@/components/site-header";

/** 工作台入口组件（骨架版） */
export default function DashboardPage() {
  return (
    <div className="flex min-h-screen flex-col bg-neutral-50">
      <SiteHeader />

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">我的项目</h1>
            <p className="mt-1 text-sm text-neutral-500">
              上传视频，AI 自动生成字幕（骨架版：功能开发中）
            </p>
          </div>
          {/* TODO: 接入认证后显示剩余额度；点击触发上传流程 */}
          <button
            disabled
            className="rounded-xl bg-brand px-5 py-2.5 font-medium text-white opacity-60"
          >
            + 新建项目
          </button>
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
