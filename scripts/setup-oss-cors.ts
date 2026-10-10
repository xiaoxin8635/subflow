/**
 * @file OSS Bucket CORS 配置脚本（一次性运维脚本）
 * @description 为 subflow-video Bucket 覆盖写入浏览器直传所需的 CORS 规则：
 *              PUT/POST（分片直传）、GET/HEAD（签名 URL 预览下载），
 *              AllowedHeader *，ExposeHeader ETag（complete 校验需要）。
 *              运行方式：npx tsx scripts/setup-oss-cors.ts（自动读取项目 .env）
 */
import fs from "node:fs";
import path from "node:path";

/** 极简 .env 加载器：仅填充 process.env 中不存在的键（与 worker/index.ts 同规则） */
function loadDotEnv(): void {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"?([^"\r\n#]*)"?\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const { ossGetBucketCors, ossPutBucketCors } = await import("../src/lib/oss");

  const before = await ossGetBucketCors();
  console.log("配置前 CORS：", before.slice(0, 400) || "(空)");

  await ossPutBucketCors([
    {
      // 浏览器直传与签名 URL 读：源不限（桶为私有，CORS 只约束浏览器 JS 行为）
      allowedOrigins: ["*"],
      allowedMethods: ["PUT", "POST", "GET", "HEAD"],
      allowedHeaders: ["*"],
      // complete 前服务端 ListParts 需要 ETag；预检结果缓存 1 小时
      exposeHeaders: ["ETag"],
      maxAgeSeconds: 3600,
    },
  ]);

  const after = await ossGetBucketCors();
  console.log("配置后 CORS：", after);
  if (!/CORSRule/.test(after)) {
    console.error("校验失败：配置后未读到 CORSRule");
    process.exit(1);
  }
  console.log("CORS 配置完成 ✓");
}

main().catch((e) => {
  console.error("CORS 配置失败：", e);
  process.exit(1);
});
