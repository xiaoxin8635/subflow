import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // ffmpeg-static / ffprobe-static 携带平台二进制并依赖 __dirname 定位 exe，
  // 必须保持 external（Turbopack 打包会把 __dirname 替换成占位符导致 ENOENT）
  serverExternalPackages: ["ffmpeg-static", "ffprobe-static"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
