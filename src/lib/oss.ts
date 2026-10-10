/**
 * @file 阿里云 OSS REST 客户端（零第三方依赖，fetch + node:crypto）
 * @description 实现本项目所需的 OSS 能力子集：V1 签名请求头鉴权、预签名 URL
 *              （浏览器分片直传 PUT / 成片下载 GET，含 response-content-disposition
 *              响应头覆盖）、Multipart Upload 全生命周期（Init/ListParts/Complete/
 *              Abort）、HeadObject、Range 读、DeleteObject、Bucket CORS 配置。
 *              签名算法（V1）：
 *                StringToSign = VERB\nContent-MD5\nContent-Type\nDate\n
 *                               CanonicalizedOSSHeaders + CanonicalizedResource
 *                Signature = base64(HMAC-SHA1(AccessKeySecret, StringToSign))
 *              预签名 URL 把 Date 换成 Expires（unix 秒），鉴权信息放查询参数。
 *              CanonicalizedResource = /{bucket}/{key} + 按名排序的白名单子资源。
 * 服务端请求默认走公网 endpoint；配置 OSS_INTERNAL_ENDPOINT 后走内网
 * （同地域 ECS 免流量费）。预签名 URL 永远使用公网 endpoint（浏览器/第三方可达）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

/** OSS 连接配置（自环境变量解析，进程内缓存） */
interface OssConfig {
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  /** 公网 endpoint 主机，如 oss-cn-hangzhou.aliyuncs.com */
  endpointHost: string;
  /** 内网 endpoint 主机（可选），如 oss-cn-hangzhou-internal.aliyuncs.com */
  internalHost: string;
}

/** 环境变量解析后的配置缓存 */
let cachedConfig: OssConfig | null = null;

/**
 * 读取并校验 OSS 环境变量（首次调用解析，之后返回缓存）
 * @returns OSS 连接配置
 * @throws 未配置完整 OSS_* 环境变量时抛错
 */
function ossConfig(): OssConfig {
  if (cachedConfig) return cachedConfig;
  const accessKeyId = process.env.OSS_ACCESS_KEY_ID ?? "";
  const accessKeySecret = process.env.OSS_ACCESS_KEY_SECRET ?? "";
  const bucket = process.env.OSS_BUCKET ?? "";
  const region = process.env.OSS_REGION ?? "";
  if (!accessKeyId || !accessKeySecret || !bucket || !region) {
    throw new Error("OSS 未配置：需要 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / OSS_BUCKET / OSS_REGION");
  }
  const internalEndpoint = (process.env.OSS_INTERNAL_ENDPOINT ?? "").trim();
  cachedConfig = {
    accessKeyId,
    accessKeySecret,
    bucket,
    endpointHost: `${region}.aliyuncs.com`,
    internalHost: internalEndpoint || "",
  };
  return cachedConfig;
}

/** 参与签名的子资源白名单（V1 CanonicalizedResource 只纳入这些查询参数，按名排序；实测不含 max-parts/part-number-marker 等列表控制参数） */
const SIGNED_SUB_RESOURCES = new Set([
  "acl", "uploads", "location", "cors", "lifecycle", "website", "referer", "logging",
  "delete", "append", "tagging", "objectMeta", "uploadId", "partNumber", "position",
  "symlink", "security-token",
  "response-content-type", "response-content-language", "response-expires",
  "response-cache-control", "response-content-disposition", "response-content-encoding",
]);

/**
 * 构造 V1 CanonicalizedResource
 * @param bucket  Bucket 名
 * @param key     对象 key（Bucket 级操作传空串）
 * @param sub     参与签名的子资源参数（仅白名单内的会被纳入）
 */
function canonicalResource(bucket: string, key: string, sub: Record<string, string>): string {
  const base = `/${bucket}/${key}`;
  const names = Object.keys(sub)
    .filter((n) => SIGNED_SUB_RESOURCES.has(n))
    .sort();
  if (names.length === 0) return base;
  const pairs = names.map((n) => (sub[n] ? `${n}=${sub[n]}` : n));
  return `${base}?${pairs.join("&")}`;
}

/**
 * 计算 V1 签名
 * @param verb             HTTP 方法
 * @param contentMd5       Content-MD5 头（可空）
 * @param contentType      Content-Type 头（可空）
 * @param dateOrExpires    Date 头（GMT）或预签名 Expires（unix 秒字符串）
 * @param ossHeaders       x-oss-* 头（可空；预签名 URL 传空对象）
 * @param canonicalRes     CanonicalizedResource
 * @param secret           AccessKeySecret
 */
function signV1(
  verb: string,
  contentMd5: string,
  contentType: string,
  dateOrExpires: string,
  ossHeaders: Record<string, string>,
  canonicalRes: string,
  secret: string,
): string {
  // CanonicalizedOSSHeaders 只纳入 x-oss-* 头（Date/Authorization 等标准头不参与此段）
  const ossPart = Object.keys(ossHeaders)
    .filter((n) => n.toLowerCase().startsWith("x-oss-"))
    .sort()
    .map((n) => `${n.toLowerCase()}:${ossHeaders[n].trim()}\n`)
    .join("");
  const stringToSign = `${verb}\n${contentMd5}\n${contentType}\n${dateOrExpires}\n${ossPart}${canonicalRes}`;
  return crypto.createHmac("sha1", secret).update(stringToSign, "utf8").digest("base64");
}

/**
 * 生成预签名 URL（浏览器直传分片 PUT / 成片下载 GET 用）
 * @param objectKey  对象 key
 * @param method     HTTP 方法（PUT / GET）
 * @param expiresSec 有效期（秒）
 * @param sub        参与签名的子资源（如 partNumber/uploadId/response-content-disposition）
 */
function presignedUrl(objectKey: string, method: string, expiresSec: number, sub: Record<string, string>): string {
  const cfg = ossConfig();
  const expires = String(Math.floor(Date.now() / 1000) + Math.floor(expiresSec));
  const resource = canonicalResource(cfg.bucket, objectKey, sub);
  const signature = signV1(method, "", "", expires, {}, resource, cfg.accessKeySecret);
  const base = `https://${cfg.bucket}.${cfg.endpointHost}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
  const params = new URLSearchParams();
  for (const [n, v] of Object.entries(sub)) {
    if (SIGNED_SUB_RESOURCES.has(n)) params.set(n, v);
  }
  params.set("OSSAccessKeyId", cfg.accessKeyId);
  params.set("Expires", expires);
  params.set("Signature", signature);
  return `${base}?${params.toString()}`;
}

/**
 * 预签名「上传单个分片」PUT URL（浏览器直传）
 * @param objectKey  目标对象 key
 * @param uploadId   Multipart Upload 会话 ID
 * @param partNumber 分片号（OSS 约定从 1 开始）
 * @param expiresSec 有效期秒数（建议 ≤ 18h）
 */
export function presignPartPutUrl(objectKey: string, uploadId: string, partNumber: number, expiresSec: number): string {
  return presignedUrl(objectKey, "PUT", expiresSec, { partNumber: String(partNumber), uploadId });
}

/**
 * 预签名「下载」GET URL
 * @param objectKey   对象 key
 * @param expiresSec  有效期秒数
 * @param disposition 下载方式：inline（视频预览）或 attachment（强制下载）
 * @param fileName    disposition=attachment 时的下载文件名（RFC 5987 UTF-8 编码）
 */
export function presignGetUrl(
  objectKey: string,
  expiresSec: number,
  disposition?: "inline" | "attachment",
  fileName?: string,
): string {
  const sub: Record<string, string> = {};
  if (disposition) {
    const ascii = fileName ? fileName.replace(/[^\x20-\x7e]/g, "_") : "download";
    const encoded = fileName ? encodeURIComponent(fileName) : "download";
    sub["response-content-disposition"] =
      disposition === "attachment"
        ? `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
        : "inline";
  }
  return presignedUrl(objectKey, "GET", expiresSec, sub);
}

/**
 * 发起服务端签名的 OSS 请求（内网 endpoint 优先，需配置 OSS_INTERNAL_ENDPOINT）
 * @param method  HTTP 方法
 * @param key     对象 key（空串 = Bucket 级操作）
 * @param opts    headers / body / 子资源 / Content-Type / 超时毫秒
 */
async function ossRequest(
  method: string,
  key: string,
  opts: {
    headers?: Record<string, string>;
    body?: Buffer | string;
    /** 参与签名的子资源（白名单过滤后进 CanonicalizedResource 与 URL） */
    sub?: Record<string, string>;
    /** 仅放 URL、不参与签名的普通查询参数（如 max-parts） */
    extraQuery?: Record<string, string>;
    contentType?: string;
    timeoutMs?: number;
    /** 强制公网 endpoint（默认 false：配置了内网则走内网） */
    forcePublic?: boolean;
  } = {},
): Promise<Response> {
  const cfg = ossConfig();
  const host = opts.forcePublic ? cfg.endpointHost : cfg.internalHost || cfg.endpointHost;
  const contentType = opts.contentType ?? "";
  const bodyBuf = opts.body == null ? null : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, "utf8");
  const contentMd5 = bodyBuf ? crypto.createHash("md5").update(bodyBuf).digest("base64") : "";
  const date = new Date().toUTCString();
  const headers: Record<string, string> = { Date: date, ...opts.headers };
  if (contentType) headers["Content-Type"] = contentType;
  if (contentMd5) headers["Content-MD5"] = contentMd5;

  const resource = canonicalResource(cfg.bucket, key, opts.sub ?? {});
  const signature = signV1(method, contentMd5, contentType, date, headers, resource, cfg.accessKeySecret);
  headers["Authorization"] = `OSS ${cfg.accessKeyId}:${signature}`;

  // 虚拟主机风格（OSS 必须三级域名：bucket.endpoint；path 风格会报 SecondLevelDomainForbidden）
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const query = new URLSearchParams();
  for (const [n, v] of Object.entries(opts.sub ?? {})) {
    if (SIGNED_SUB_RESOURCES.has(n)) query.set(n, v);
  }
  for (const [n, v] of Object.entries(opts.extraQuery ?? {})) {
    query.set(n, v);
  }
  const url = `https://${cfg.bucket}.${host}/${encodedKey}${query.size > 0 ? `?${query.toString()}` : ""}`;
  return fetch(url, {
    method,
    headers,
    // Node Buffer 是合法请求体，但 TS DOM 类型未收录，需显式断言
    body: bodyBuf ? (bodyBuf as unknown as BodyInit) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
}

/**
 * 从 XML 文本中提取指定标签的首个文本值
 * @param xml 响应 XML
 * @param tag 标签名（不含尖括号）
 */
function xmlText(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : "";
}

/**
 * 发起 Multipart Upload（返回 OSS uploadId）
 * @param objectKey   目标对象 key
 * @param contentType 对象 MIME（决定最终对象的 Content-Type，影响浏览器预览行为）
 */
export async function ossInitMultipart(objectKey: string, contentType: string): Promise<string> {
  const res = await ossRequest("POST", objectKey, { sub: { uploads: "" }, contentType });
  const xml = await res.text();
  if (!res.ok) throw new Error(`OSS InitiateMultipartUpload 失败（HTTP ${res.status}）：${xml.slice(0, 300)}`);
  const uploadId = xmlText(xml, "UploadId");
  if (!uploadId) throw new Error("OSS InitiateMultipartUpload 响应缺少 UploadId");
  return uploadId;
}

/** ListParts 单个分片信息 */
export interface OssPart {
  /** 分片号（1 起） */
  partNumber: number;
  /** ETag（含引号，原样保留供 Complete 使用） */
  etag: string;
  /** 分片字节数 */
  size: number;
}

/**
 * 列出某 uploadId 已上传的全部分片（自动翻页）
 * @param objectKey 对象 key
 * @param uploadId  Multipart Upload 会话 ID
 */
export async function ossListParts(objectKey: string, uploadId: string): Promise<OssPart[]> {
  const parts: OssPart[] = [];
  let marker = 0;
  while (true) {
    // max-parts / part-number-marker 不参与 V1 签名（非子资源白名单成员），仅作普通查询参数
    const extra: Record<string, string> = { "max-parts": "1000" };
    if (marker > 0) extra["part-number-marker"] = String(marker);
    const res = await ossRequest("GET", objectKey, { sub: { uploadId }, extraQuery: extra });
    const xml = await res.text();
    if (!res.ok) throw new Error(`OSS ListParts 失败（HTTP ${res.status}）：${xml.slice(0, 300)}`);
    // 逐块提取 <Part>…</Part>，再取字段（避免嵌套正则贪心问题）
    for (const chunk of xml.split(/<\/Part>/)) {
      if (!/<Part>/.test(chunk)) continue;
      parts.push({
        partNumber: Number(xmlText(chunk, "PartNumber")),
        etag: xmlText(chunk, "ETag"),
        size: Number(xmlText(chunk, "Size")),
      });
    }
    if (xmlText(xml, "IsTruncated") !== "true") break;
    marker = Number(xmlText(xml, "NextPartNumberMarker"));
  }
  return parts.sort((a, b) => a.partNumber - b.partNumber);
}

/**
 * 提交 CompleteMultipartUpload 合并对象
 * @param objectKey 对象 key
 * @param uploadId  会话 ID
 * @param parts     全部分片（PartNumber 升序，ETag 用 ListParts 返回的原值）
 */
export async function ossCompleteMultipart(
  objectKey: string,
  uploadId: string,
  parts: OssPart[],
): Promise<void> {
  const bodyXml =
    `<CompleteMultipartUpload>` +
    parts.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`).join("") +
    `</CompleteMultipartUpload>`;
  const res = await ossRequest("POST", objectKey, { sub: { uploadId }, body: bodyXml, contentType: "application/xml", timeoutMs: 120_000 });
  const xml = await res.text();
  // OSS 特性：Complete 可能返回 HTTP 200 但 body 是 <Error>（如分片不齐），必须检查内容
  if (!res.ok || /<Error>/.test(xml)) {
    throw new Error(`OSS CompleteMultipartUpload 失败（HTTP ${res.status}）：${xml.slice(0, 300)}`);
  }
}

/**
 * 放弃 Multipart Upload（清理已传分片，避免存储费用残留）
 * @param objectKey 对象 key
 * @param uploadId  会话 ID
 */
export async function ossAbortMultipart(objectKey: string, uploadId: string): Promise<void> {
  const res = await ossRequest("DELETE", objectKey, { sub: { uploadId } });
  if (!res.ok && res.status !== 404) {
    throw new Error(`OSS AbortMultipartUpload 失败（HTTP ${res.status}）`);
  }
}

/**
 * HeadObject：读取对象元信息
 * @param objectKey 对象 key
 * @returns 对象字节数
 * @throws 对象不存在（404）时抛错
 */
export async function ossHead(objectKey: string): Promise<{ size: number }> {
  const res = await ossRequest("HEAD", objectKey);
  if (!res.ok) throw new Error(`OSS HeadObject 失败（HTTP ${res.status}）：${objectKey}`);
  return { size: Number(res.headers.get("content-length") ?? 0) };
}

/**
 * Range 读对象片段（文件魔数校验用）
 * @param objectKey 对象 key
 * @param start     起始字节（含）
 * @param end       结束字节（含）
 */
export async function ossGetRange(objectKey: string, start: number, end: number): Promise<Buffer> {
  const res = await ossRequest("GET", objectKey, { headers: { Range: `bytes=${start}-${end}` } });
  if (!res.ok) throw new Error(`OSS Range 读失败（HTTP ${res.status}）：${objectKey}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 删除对象（不存在视为成功）
 * @param objectKey 对象 key
 */
export async function ossDelete(objectKey: string): Promise<void> {
  const res = await ossRequest("DELETE", objectKey);
  if (!res.ok && res.status !== 404) {
    throw new Error(`OSS DeleteObject 失败（HTTP ${res.status}）：${objectKey}`);
  }
}

/**
 * 全量下载对象到本地文件（worker 拉源视频用；已存在且大小一致时跳过下载）
 * @param objectKey  对象 key
 * @param destPath   本地目标绝对路径
 * @returns 实际是否执行了下载
 */
export async function ossDownloadToFile(objectKey: string, destPath: string): Promise<boolean> {
  const head = await ossHead(objectKey);
  // 本地已有同大小副本：直接复用（重试/重入场景免重复下载）
  try {
    const st = await fs.promises.stat(destPath);
    if (st.size === head.size) return false;
  } catch {
    // 本地不存在：继续下载
  }
  const res = await ossRequest("GET", objectKey, { timeoutMs: 600_000 });
  if (!res.ok || !res.body) throw new Error(`OSS 下载失败（HTTP ${res.status}）：${objectKey}`);
  // 流式写盘（源视频可达 500MB，避免整体进内存）
  await pipeline(
    Readable.fromWeb(res.body as unknown as NodeWebReadableStream<Uint8Array>),
    fs.createWriteStream(destPath),
  );
  return true;
}

/** Multipart 分片大小（服务端中转上传用，5MB 满足 OSS 除最后片外 ≥100KB 的要求） */
const UPLOAD_PART_SIZE = 5 * 1024 * 1024;

/**
 * 将本地文件以 Multipart 方式上传为 OSS 对象（导出成片上传用）
 * @param objectKey   目标对象 key
 * @param absPath     本地文件绝对路径
 * @param contentType 对象 MIME
 */
export async function ossUploadFile(objectKey: string, absPath: string, contentType: string): Promise<void> {
  const uploadId = await ossInitMultipart(objectKey, contentType);
  try {
    const stat = await fs.promises.stat(absPath);
    const chunkCount = Math.max(1, Math.ceil(stat.size / UPLOAD_PART_SIZE));
    const parts: OssPart[] = [];
    for (let i = 0; i < chunkCount; i++) {
      const start = i * UPLOAD_PART_SIZE;
      const end = Math.min(start + UPLOAD_PART_SIZE, stat.size);
      const buf = Buffer.alloc(end - start);
      const fd = await fs.promises.open(absPath, "r");
      try {
        await fd.read(buf, 0, buf.length, start);
      } finally {
        await fd.close();
      }
      // 服务端分片 PUT 走签名请求头鉴权（无需预签名 URL）
      const res = await ossRequest("PUT", objectKey, {
        body: buf,
        sub: { partNumber: String(i + 1), uploadId },
        contentType,
        timeoutMs: 300_000,
      });
      if (!res.ok) throw new Error(`OSS 分片上传失败（part ${i + 1}，HTTP ${res.status}）`);
      parts.push({ partNumber: i + 1, etag: `"${res.headers.get("etag")?.replaceAll('"', "") ?? ""}"`, size: buf.length });
    }
    await ossCompleteMultipart(objectKey, uploadId, parts);
  } catch (err) {
    // 上传失败：放弃会话清理分片，避免残留存储费用
    await ossAbortMultipart(objectKey, uploadId).catch(() => {});
    throw err;
  }
}

/** 单条 CORS 规则 */
export interface OssCorsRule {
  allowedOrigins: string[];
  allowedMethods: string[];
  allowedHeaders: string[];
  exposeHeaders: string[];
  maxAgeSeconds: number;
}

/**
 * 读取 Bucket 当前 CORS 配置（XML 文本原样返回，供校验）
 */
export async function ossGetBucketCors(): Promise<string> {
  const res = await ossRequest("GET", "", { sub: { cors: "" }, forcePublic: true });
  return await res.text();
}

/**
 * 覆盖写入 Bucket CORS 配置（浏览器直传必需）
 * @param rules CORS 规则数组（整体覆盖）
 */
export async function ossPutBucketCors(rules: OssCorsRule[]): Promise<void> {
  const bodyXml =
    `<CORSConfiguration>` +
    rules
      .map(
        (r) =>
          `<CORSRule>` +
          r.allowedOrigins.map((o) => `<AllowedOrigin>${o}</AllowedOrigin>`).join("") +
          r.allowedMethods.map((m) => `<AllowedMethod>${m}</AllowedMethod>`).join("") +
          (r.allowedHeaders.length ? r.allowedHeaders.map((h) => `<AllowedHeader>${h}</AllowedHeader>`).join("") : "") +
          (r.exposeHeaders.length ? r.exposeHeaders.map((h) => `<ExposeHeader>${h}</ExposeHeader>`).join("") : "") +
          `<MaxAgeSeconds>${r.maxAgeSeconds}</MaxAgeSeconds>` +
          `</CORSRule>`,
      )
      .join("") +
    `</CORSConfiguration>`;
  const res = await ossRequest("PUT", "", { sub: { cors: "" }, body: bodyXml, contentType: "application/xml", forcePublic: true });
  if (!res.ok) {
    const xml = await res.text();
    throw new Error(`OSS PutBucketCors 失败（HTTP ${res.status}）：${xml.slice(0, 300)}`);
  }
}

/**
 * 将 Web ReadableStream 以 Multipart 方式中转上传为 OSS 对象（服务端流式收流用）
 * 注意：走服务端带宽，仅用于无法直传的场景；浏览器上传一律用预签名直传。
 * @param objectKey   目标对象 key
 * @param stream      Web 可读流
 * @param contentType 对象 MIME
 */
export async function ossUploadWebStream(
  objectKey: string,
  stream: ReadableStream<Uint8Array>,
  contentType: string,
): Promise<void> {
  const uploadId = await ossInitMultipart(objectKey, contentType);
  try {
    const nodeStream = Readable.fromWeb(stream as unknown as NodeWebReadableStream<Uint8Array>);
    const parts: OssPart[] = [];
    let partNumber = 1;
    let pending: Buffer[] = [];
    let pendingSize = 0;

    /** 把累积缓冲作为一片上传并清空 */
    const flush = async (): Promise<void> => {
      if (pendingSize === 0) return;
      const buf = Buffer.concat(pending);
      pending = [];
      pendingSize = 0;
      const res = await ossRequest("PUT", objectKey, {
        body: buf,
        sub: { partNumber: String(partNumber), uploadId },
        contentType,
        timeoutMs: 300_000,
      });
      if (!res.ok) throw new Error(`OSS 分片上传失败（part ${partNumber}，HTTP ${res.status}）`);
      parts.push({ partNumber, etag: `"${res.headers.get("etag")?.replaceAll('"', "") ?? ""}"`, size: buf.length });
      partNumber++;
    };

    for await (const chunk of nodeStream) {
      pending.push(chunk as Buffer);
      pendingSize += (chunk as Buffer).length;
      if (pendingSize >= UPLOAD_PART_SIZE) await flush();
    }
    await flush();
    // 空流保护：至少需要一片
    if (parts.length === 0) throw new Error("上传内容为空");
    await ossCompleteMultipart(objectKey, uploadId, parts);
  } catch (err) {
    await ossAbortMultipart(objectKey, uploadId).catch(() => {});
    throw err;
  }
}
