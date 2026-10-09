"use client";
/**
 * @file 新建项目页（视频上传）
 * @description 客户端组件：选择文件 → 前端预校验（类型/大小）→ XHR 流式上传
 *              （fetch 无法获取上传进度，故用 XMLHttpRequest 的 upload.onprogress）
 *              → 成功后跳转项目详情页开始轮询转写状态。
 *              请求体为原始文件二进制，元数据（文件名）放请求头，与 POST /api/projects 约定一致。
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

/** 字节数格式化为可读大小 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 新建项目页组件 */
export default function NewProjectPage() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 扩展名是否在白名单 */
  const extOk = file ? ACCEPT_TYPES[file.name.slice(file.name.lastIndexOf(".")).toLowerCase()] : true;

  /** 选中文件后的前端预校验 */
  function handleSelect(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null);
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    if (f && f.size > MAX_UPLOAD_BYTES) {
      setError(`文件超过大小上限（${formatBytes(MAX_UPLOAD_BYTES)}）`);
    }
  }

  /** 发起上传（XHR 以获取进度），成功后跳详情页 */
  function handleUpload() {
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
    setError(null);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/projects");
    xhr.setRequestHeader("Content-Type", mime);
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      setUploading(false);
      try {
        const body = JSON.parse(xhr.responseText) as { projectId?: string; error?: string };
        if (xhr.status >= 200 && xhr.status < 300 && body.projectId) {
          router.push(`/project/${body.projectId}`);
        } else {
          setError(body.error ?? `上传失败（HTTP ${xhr.status}）`);
        }
      } catch {
        setError(`上传失败（HTTP ${xhr.status}）`);
      }
    };
    xhr.onerror = () => {
      setUploading(false);
      setError("网络错误，上传中断");
    };
    xhr.send(file);
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
          上传视频后 AI 将自动转写并生成字幕（支持 mp4 / mov / mkv / webm，最大 500MB）
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
              上传中 {progress}%（大文件上传后需要数十秒完成转写）
            </p>
          </div>
        )}

        {/* 错误提示 */}
        {error && <p className="mt-4 text-center text-sm text-red-600">{error}</p>}

        {/* 提交按钮 */}
        <button
          onClick={handleUpload}
          disabled={!file || !extOk || uploading || !!error && file && file.size > MAX_UPLOAD_BYTES}
          className="mt-8 w-full rounded-xl bg-brand py-3 font-medium text-white transition-colors hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-50"
        >
          {uploading ? "上传中…" : "开始上传并转写"}
        </button>
      </main>
    </div>
  );
}
