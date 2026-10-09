/**
 * @file 应用根布局
 * @description 全局 HTML 结构、字体加载与 SEO 元信息。lang 设为 zh-CN。
 */
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "SubFlow 字幕工坊 — AI 视频字幕生成工具",
    template: "%s | SubFlow 字幕工坊",
  },
  description:
    "上传视频，AI 自动生成精准字幕：智能润色、关键词高亮、多套样式模板，一键导出成品。为短视频创作者打造。",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
