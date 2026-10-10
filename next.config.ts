import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // 独立输出：build 后产出 .next/standalone（自带精简 node_modules），
  // Docker 镜像 / 服务器部署只复制该目录 + static + public 即可运行
  output: "standalone",
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
