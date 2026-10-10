"use client";
/**
 * @file 新建项目页（视频分片上传）
 * @description 客户端组件：选择文件 → 前端预校验（类型/大小）→ 分片上传：
 *   ① POST /api/uploads/init 创建会话（或凭 sessionStorage 中的 uploadId 断点续传）
 *   ② 3 片并发上传分片（每片失败自动重试 2 次）：
 *      local 模式 → PUT /api/uploads/[id]/chunks/[index]（经服务器）；
 *      oss   模式 → 直接 PUT init/status 返回的 partUrls[index]（浏览器直传 OSS）。
 *   ③ POST /api/uploads/[id]/complete 合并入库 → 跳转项目页开始转写
 * 上传中刷新页面后重新选择同一文件，会自动查询已传分片并跳过（断点续传；
 * oss 模式的直传签名 URL 过期后由 status 接口重发）。
 */
import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { MAX_UPLOAD_BYTES } from "@/lib/constants";

/** 允许的视频扩展名与 MIME（与后端 EXT_BY_TYPE 保持一致） */
const ACCEPT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
};

/** 分片并发数（太大易触发浏览器同域连接上限，3 是稳妥值） */
const CONCURRENCY = 3;

/** 单片失败最大重试次数 */
const CHUNK_RETRIES = 2;

/** init 接口响应 */
interface InitBody {
  uploadId: string;
  chunkSize: number;
  chunkCount: number;
  /** 存储驱动：local 走服务器分片；oss 走浏览器直传 */
  mode: "local" | "oss";
  /** oss 模式：各分片直传 PUT 签名 URL（index 与 0 起分片索引对应） */
  partUrls?: string[];
}

/** resume 接口响应 */
interface ResumeBody {
  chunkSize: number;
  chunkCount: number;
  mode: "local" | "oss";
  uploadedIndexes: number[];
  partUrls?: string[];
}

/** 分片上传的会话状态（运行期保存在 ref 中） */
interface UploadRun {
  uploadId: string;
  chunkSize: number;
  chunkCount: number;
  /** 已确认到齐的分片索引集合 */
  received: Set<number>;
  /** oss 模式：各分片直传 PUT 签名 URL */
  partUrls?: string[];
}

/** 字节数格式化为可读大小 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** sessionStorage 键：文件名+大小 唯一标识一次未完成的会话 */
function sessionKey(file: File): string {
  return `subflow-upload:${file.name}:${file.size}`;
}

/** 新建项目页组件 */
export default function NewProjectPage() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [resumed, setResumed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 扩展名是否在白名单 */
  const extOk = file ? ACCEPT_TYPES[file.name.slice(file.name.lastIndexOf(".")).toLowerCase()] : true;

  /** 选中文件后的前端预校验 */
  function handleSelect(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null);
    setResumed(false);
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    if (f && f.size > MAX_UPLOAD_BYTES) {
      setError(`文件超过大小上限（${formatBytes(MAX_UPLOAD_BYTES)}）`);
    }
  }

  /**
   * 上传单个分片（带重试）：oss 模式直传签名 URL，local 模式走服务器分片接口
   * @param run   会话状态
   * @param index 分片索引（0 起）
   * @param signal 取消信号
   */
  async function uploadChunk(run: UploadRun, index: number, signal: AbortSignal): Promise<void> {
    const start = index * run.chunkSize;
    const blob = file!.slice(start, Math.min(start + run.chunkSize, file!.size));
    // oss 直传目标 URL；local 模式为 undefined 走服务器接口
    const ossUrl = run.partUrls?.[index];
    for (let attempt = 0; attempt <= CHUNK_RETRIES; attempt++) {
      if (signal.aborted) throw new Error("ABORTED");
      try {
        const res = ossUrl
          ? await fetch(ossUrl, { method: "PUT", body: blob, signal })
          : await fetch(`/api/uploads/${run.uploadId}/chunks/${index}`, {
              method: "PUT",
              headers: { "Content-Type": "application/octet-stream" },
              body: blob,
              signal,
            });
        if (res.ok) {
          run.received.add(index);
          setProgress(Math.round((run.received.size / run.chunkCount) * 100));
          return;
        }
        // 4xx 且非限流：重试无意义，直接抛出
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `分片上传失败（HTTP ${res.status}）`);
        }
      } catch (e) {
        if (e instanceof Error && (e.name === "AbortError" || e.message === "ABORTED")) throw e;
        if (attempt === CHUNK_RETRIES) throw e instanceof Error ? e : new Error("分片上传失败");
      }
    }
  }

  /** 发起分片上传，成功后跳详情页 */
  async function handleUpload() {
    if (!file || uploading) return;
    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    const mime = ACCEPT_TYPES[ext];
    if (!mime) {
      setError("仅支持 mp4 / mov / mkv / webm 格式");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`文件超过大小上限（${formatBytes(MAX_UPLOAD_BYTES)}）`);
      return;
    }

    setUploading(true);
    setProgress(0);
    setResumed(false);
    setError(null);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      // ① 尝试断点续传：sessionStorage 里有同文件未完成会话则查询已传分片
      let run: UploadRun | null = null;
      const savedId = sessionStorage.getItem(sessionKey(file));
      if (savedId) {
        const res = await fetch(`/api/uploads/${savedId}`, { signal: abort.signal });
        if (res.ok) {
          const body = (await res.json()) as ResumeBody;
          run = {
            uploadId: savedId,
            chunkSize: body.chunkSize,
            chunkCount: body.chunkCount,
            received: new Set(body.uploadedIndexes),
            partUrls: body.partUrls,
          };
          setResumed(body.uploadedIndexes.length > 0);
          setProgress(Math.round((body.uploadedIndexes.length / body.chunkCount) * 100));
        } else {
          sessionStorage.removeItem(sessionKey(file)); // 会话已过期，清掉
        }
      }

      // ② 无可续传会话：创建新会话
      if (!run) {
        const res = await fetch("/api/uploads/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileName: file.name, contentType: mime, size: file.size }),
          signal: abort.signal,
        });
        const body = (await res.json().catch(() => ({}))) as InitBody & { error?: string };
        if (!res.ok || !body.uploadId) {
          throw new Error(body.error ?? `创建上传会话失败（HTTP ${res.status}）`);
        }
        run = {
          uploadId: body.uploadId,
          chunkSize: body.chunkSize,
          chunkCount: body.chunkCount,
          received: new Set<number>(),
          partUrls: body.partUrls,
        };
      }
      sessionStorage.setItem(sessionKey(file), run.uploadId);

      // ③ 并发上传未到齐的分片（简单工作队列）
      const pending = Array.from({ length: run.chunkCount }, (_, i) => i).filter(
        (i) => !run!.received.has(i),
      );
      let cursor = 0;
      const worker = async () => {
        while (cursor < pending.length) {
          const idx = pending[cursor++];
          await uploadChunk(run!, idx, abort.signal);
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));

      // ④ 全部到齐：通知服务端合并入库
      const completeRes = await fetch(`/api/uploads/${run.uploadId}/complete`, {
        method: "POST",
        signal: abort.signal,
      });
      const completeBody = (await completeRes.json().catch(() => ({}))) as {
        projectId?: string;
        error?: string;
      };
      if (!completeRes.ok || !completeBody.projectId) {
        throw new Error(completeBody.error ?? `合并失败（HTTP ${completeRes.status}）`);
      }
      sessionStorage.removeItem(sessionKey(file));
      router.push(`/project/${completeBody.projectId}`);
    } catch (e) {
      if (e instanceof Error && (e.name === "AbortError" || e.message === "ABORTED")) {
        setError("上传已取消。重新选择同一文件可从断点继续。");
      } else {
        setError(e instanceof Error ? e.message : "上传失败，请重试");
      }
    } finally {
      setUploading(false);
      abortRef.current = null;
    }
  }

  /** 取消当前上传（分片已落盘，可断点续传） */
  function handleCancel() {
    abortRef.current?.abort();
  }

  return (
    <div className="flex min-h-screen flex-col bg-neutral-50">
      <SiteHeader />

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-12">
        <div className="flex items-center gap-2 text-sm text-neutral-500">
          <Link href="/dashboard" className="transition-colors hover:text-brand">
            ← 返回项目列表
          </Link>
        </div>

        <h1 className="mt-4 text-2xl font-bold tracking-tight">新建项目</h1>
        <p className="mt-1 text-sm text-neutral-500">
          上传视频后 AI 将自动转写并生成字幕（支持 mp4 / mov / mkv / webm，最大 500MB；分片上传，中断可续传）
        </p>

        {/* 拖放/点击选择区域 */}
        <label
          className="mt-8 flex min-h-[240px] cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-neutral-300 bg-white transition-colors hover:border-brand/50 hover:bg-brand-soft/40"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f && inputRef.current) {
              const dt = new DataTransfer();
              dt.items.add(f);
              inputRef.current.files = dt.files;
              handleSelect({ target: inputRef.current } as React.ChangeEvent<HTMLInputElement>);
            }
          }}
        >
          <input ref={inputRef} type="file" accept="video/mp4,video/quicktime,video/x-matroska,video/webm" className="hidden" onChange={handleSelect} disabled={uploading} />
          <div className="text-4xl">📹</div>
          {file ? (
            <div className="mt-4 px-6 text-center">
              <p className="max-w-md truncate font-medium">{file.name}</p>
              <p className={`mt-1 text-sm ${extOk ? "text-neutral-500" : "text-red-500"}`}>
                {formatBytes(file.size)}
                {!extOk && " · 不支持的格式"}
              </p>
            </div>
          ) : (
            <div className="mt-4 px-6 text-center">
              <p className="font-medium">点击选择 或 拖拽视频到这里</p>
              <p className="mt-1 text-sm text-neutral-500">mp4 / mov / mkv / webm · ≤ 500MB</p>
            </div>
          )}
        </label>

        {/* 上传进度条 */}
        {uploading && (
          <div className="mt-6">
            <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-200">
              <div
                className="h-full rounded-full bg-brand transition-[width] duration-200"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="mt-2 text-center text-sm text-neutral-500">
              上传中 {progress}%（分片并发上传，转写将在上传完成后自动开始）
            </p>
          </div>
        )}

        {/* 断点续传提示 */}
        {resumed && !uploading && (
          <p className="mt-4 text-center text-sm text-emerald-600">
            检测到上次未完成的上传，将自动从断点继续
          </p>
        )}

        {/* 错误提示 */}
        {error && <p className="mt-4 text-center text-sm text-red-600">{error}</p>}

        {/* 提交按钮 */}
        <button
          onClick={handleUpload}
          disabled={!file || !extOk || uploading || (!!error && !!file && file.size > MAX_UPLOAD_BYTES)}
          className="mt-8 w-full rounded-xl bg-brand py-3 font-medium text-white transition-colors hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-50"
        >
          {uploading ? "上传中…" : "开始上传并转写"}
        </button>

        {/* 取消按钮（上传中显示） */}
        {uploading && (
          <button
            onClick={handleCancel}
            className="mt-3 w-full rounded-xl border border-neutral-200 bg-white py-2.5 text-sm text-neutral-600 transition-colors hover:border-neutral-300"
          >
            取消上传（已传分片保留，可续传）
          </button>
        )}
      </main>
    </div>
  );
}
