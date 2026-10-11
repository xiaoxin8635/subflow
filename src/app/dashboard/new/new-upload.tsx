"use client";
/**
 * @file 新建项目上传主体（客户端组件，由 page.tsx 服务端壳包在 AppShell 内）
 * @description 支持一次选择/拖入多个视频或音频（mp3/m4a/wav），串行逐个分片上传：
 *   ① POST /api/uploads/init 创建会话（或凭 sessionStorage 中的 uploadId 断点续传）
 *   ② 3 片并发上传分片（每片失败自动重试 2 次）：
 *      local 模式 → PUT /api/uploads/[id]/chunks/[index]（经服务器）；
 *      oss   模式 → 直接 PUT init/status 返回的 partUrls[index]（浏览器直传 OSS）。
 *   ③ POST /api/uploads/[id]/complete 合并入库 → 转写自动入队。
 *   单文件完成直接跳转项目页；多文件全部完成后跳回项目列表（每个项目独立排队，
 *   串行上传避免多文件分片并发打满浏览器连接；单个文件失败不阻断后续文件，
 *   结束后可一键重传失败项）。上传中刷新后重选同一文件可断点续传。
 */
import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ASR_LANGUAGES, ASR_SCENES, MAX_UPLOAD_BYTES } from "@/lib/constants";

/** 允许的媒体扩展名与 MIME（视频 + 纯音频，与后端 EXT_BY_TYPE 保持一致） */
const ACCEPT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
};

/** 分片并发数（太大易触发浏览器同域连接上限，3 是稳妥值） */
const CONCURRENCY = 3;

/** 单片失败最大重试次数 */
const CHUNK_RETRIES = 2;

/** 单批最多文件数（防误选整目录拖垮带宽） */
const MAX_BATCH_FILES = 20;

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

/** 分片上传的会话状态（运行期） */
interface UploadRun {
  uploadId: string;
  chunkSize: number;
  chunkCount: number;
  /** 已确认到齐的分片索引集合 */
  received: Set<number>;
  /** oss 模式：各分片直传 PUT 签名 URL */
  partUrls?: string[];
}

/** 单个文件的批内状态机 */
type RowStatus = "pending" | "uploading" | "done" | "failed" | "canceled";

/** 文件列表行 */
interface FileRow {
  id: number;
  file: File;
  status: RowStatus;
  progress: number;
  error?: string;
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

/** 文件格式是否在白名单 */
function extOf(file: File): string {
  return file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
}

/** 新建项目上传主体组件（在 AppShell 内容区内渲染） */
export function NewUploadClient() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const rowIdRef = useRef(0);
  const [rows, setRows] = useState<FileRow[]>([]);
  const [uploading, setUploading] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [processMode, setProcessMode] = useState<"asr" | "ocr">("asr");
  // 识别设置（P2.11 场景自适应）：场景预设 / 识别主语言 / 自定义热词 / 噪声抑制
  const [scene, setScene] = useState<string>("general");
  const [language, setLanguage] = useState<string>("zh");
  const [hotwords, setHotwords] = useState("");
  const [denoise, setDenoise] = useState(false);

  const hasInvalid = rows.some((r) => r.status === "pending" && !ACCEPT_TYPES[extOf(r.file)]);
  const oversize = (r: FileRow) => r.file.size > MAX_UPLOAD_BYTES;
  const doneCount = rows.filter((r) => r.status === "done").length;
  // 最新 rows 镜像（latest ref）：handleUpload 为 async 长流程，结束后 pendingRows()
  // 若读 state 闭包会拿到点击时刻的旧值（全部仍 pending），导致上传成功也不跳转
  const rowsRef = useRef<FileRow[]>([]);
  rowsRef.current = rows;
  const pendingRows = () =>
    rowsRef.current.filter((r) => r.status === "pending" || r.status === "canceled" || r.status === "failed");

  /** 追加文件（点击选择/拖拽共用）：去重、限流到 MAX_BATCH_FILES。
   *  必须传已快照的 File 数组——React 的 setState updater 延迟到渲染期才执行，
   *  若直接传 input 的 FileList，随后 onChange 里的 value 重置会把 files 清空，
   *  updater 迭代到空列表导致「选了文件但列表没反应」 */
  function addFiles(list: File[]) {
    setSummary(null);
    setRows((prev) => {
      const existing = new Set(prev.map((r) => `${r.file.name}:${r.file.size}`));
      const incoming = list
        .filter((f) => !existing.has(`${f.name}:${f.size}`))
        .slice(0, MAX_BATCH_FILES - prev.length);
      return [
        ...prev,
        ...incoming.map((file) => ({
          id: ++rowIdRef.current,
          file,
          status: "pending" as RowStatus,
          progress: 0,
        })),
      ];
    });
  }

  /** 更新某行状态（不可变替换） */
  function patchRow(id: number, patch: Partial<FileRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  /** 移除一行（仅未上传/失败/取消状态可移除） */
  function removeRow(id: number) {
    setRows((prev) => prev.filter((r) => !(r.id === id && r.status !== "uploading" && r.status !== "done")));
  }

  /**
   * 上传单个分片（带重试）：oss 模式直传签名 URL，local 模式走服务器分片接口
   * @param file  当前文件
   * @param run   会话状态
   * @param index 分片索引（0 起）
   * @param signal 取消信号
   */
  async function uploadChunk(file: File, run: UploadRun, index: number, signal: AbortSignal): Promise<void> {
    const start = index * run.chunkSize;
    const blob = file.slice(start, Math.min(start + run.chunkSize, file.size));
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

  /**
   * 上传单个文件到完成入库（断点续传 + 分片并发），返回项目 ID
   * @param row      当前行
   * @param signal   取消信号
   */
  async function uploadOne(row: FileRow, signal: AbortSignal): Promise<string> {
    const file = row.file;
    const mime = ACCEPT_TYPES[extOf(file)];

    // ① 尝试断点续传：sessionStorage 里有同文件未完成会话则查询已传分片
    let run: UploadRun | null = null;
    let resumed = false;
    const savedId = sessionStorage.getItem(sessionKey(file));
    if (savedId) {
      const res = await fetch(`/api/uploads/${savedId}`, { signal });
      if (res.ok) {
        const body = (await res.json()) as ResumeBody;
        run = {
          uploadId: savedId,
          chunkSize: body.chunkSize,
          chunkCount: body.chunkCount,
          received: new Set(body.uploadedIndexes),
          partUrls: body.partUrls,
        };
        resumed = body.uploadedIndexes.length > 0;
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
        signal,
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
    if (resumed) patchRow(row.id, { progress: Math.round((run.received.size / run.chunkCount) * 100) });

    // ③ 并发上传未到齐的分片（简单工作队列），完成后推进度
    const pending = Array.from({ length: run.chunkCount }, (_, i) => i).filter(
      (i) => !run!.received.has(i),
    );
    let cursor = 0;
    const worker = async () => {
      while (cursor < pending.length) {
        const idx = pending[cursor++];
        await uploadChunk(file, run!, idx, signal);
        patchRow(row.id, { progress: Math.round((run!.received.size / run!.chunkCount) * 100) });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));

    // ④ 全部到齐：通知服务端合并入库（音频项目强制 asr，与后端双重校验一致）
    const isAudio = mime.startsWith("audio/");
    const completeRes = await fetch(`/api/uploads/${run.uploadId}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        processMode: isAudio ? "asr" : processMode,
        scene,
        language,
        hotwords,
        denoise, // 噪声抑制（P2.11）：asr 模式下勾选生效，音频项目同样适用
      }),
      signal,
    });
    const completeBody = (await completeRes.json().catch(() => ({}))) as {
      projectId?: string;
      error?: string;
    };
    if (!completeRes.ok || !completeBody.projectId) {
      throw new Error(completeBody.error ?? `合并失败（HTTP ${completeRes.status}）`);
    }
    sessionStorage.removeItem(sessionKey(file));
    return completeBody.projectId;
  }

  /** 批量上传：串行逐个文件，单个失败不阻断；单文件成功即跳详情页，多文件完成跳列表 */
  async function handleUpload() {
    const queue = pendingRows().filter((r) => ACCEPT_TYPES[extOf(r.file)] && !oversize(r));
    if (uploading || queue.length === 0) return;
    setUploading(true);
    setSummary(null);

    const abort = new AbortController();
    abortRef.current = abort;
    let lastProjectId: string | null = null;
    let failCount = 0;
    let canceled = false;

    try {
      for (const row of queue) {
        patchRow(row.id, { status: "uploading", progress: 0, error: undefined });
        try {
          const projectId = await uploadOne(row, abort.signal);
          patchRow(row.id, { status: "done", progress: 100 });
          lastProjectId = projectId;
        } catch (e) {
          if (e instanceof Error && (e.name === "AbortError" || e.message === "ABORTED")) {
            patchRow(row.id, { status: "canceled", error: "已取消（可续传）" });
            canceled = true;
            break;
          }
          failCount++;
          patchRow(row.id, { status: "failed", error: e instanceof Error ? e.message : "上传失败" });
        }
      }
    } finally {
      setUploading(false);
      abortRef.current = null;
    }

    // 结果汇总与跳转：有取消留在本页；否则全部成功时单文件跳详情、多文件跳列表
    if (canceled) {
      setSummary("上传已取消，未完成文件可从断点继续");
      return;
    }
    if (failCount === 0 && !pendingRows().length) {
      if (lastProjectId && queue.length === 1) {
        router.push(`/project/${lastProjectId}`);
      } else {
        router.push("/dashboard");
      }
      return;
    }
    setSummary(`完成 ${queue.length - failCount} 个，失败 ${failCount} 个（可重传失败项）`);
  }

  /** 取消剩余上传（当前文件已传分片保留，可断点续传） */
  function handleCancel() {
    abortRef.current?.abort();
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 lg:py-10">
        <div className="flex items-center gap-2 text-sm text-neutral-500">
          <Link href="/dashboard" className="transition-colors hover:text-brand">
            ← 返回项目列表
          </Link>
        </div>

        <h1 className="mt-4 text-2xl font-bold tracking-tight">新建项目</h1>
        <p className="mt-1 text-sm text-neutral-500">
          支持一次选择多个视频/音频批量上传（mp4 / mov / mkv / webm / mp3 / m4a / wav，单个最大 500MB；分片上传，中断可续传）
        </p>

        {/* 处理模式：语音转写（默认）/ OCR 硬字幕提取（仅视频，音频恒走语音转写） */}
        <fieldset className="mt-6" disabled={uploading}>
          <legend className="text-sm font-medium">处理方式</legend>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label
              className={`cursor-pointer rounded-xl border-2 px-4 py-3 transition-colors ${
                processMode === "asr"
                  ? "border-brand bg-brand-soft/40"
                  : "border-neutral-200 bg-white hover:border-neutral-300"
              }`}
            >
              <input
                type="radio"
                name="process-mode"
                value="asr"
                className="sr-only"
                checked={processMode === "asr"}
                onChange={() => setProcessMode("asr")}
              />
              <span className="block text-sm font-medium">语音转写</span>
              <span className="mt-0.5 block text-xs text-neutral-500">
                识别视频/音频中的人声，逐句生成字幕（默认）
              </span>
            </label>
            <label
              className={`cursor-pointer rounded-xl border-2 px-4 py-3 transition-colors ${
                processMode === "ocr"
                  ? "border-brand bg-brand-soft/40"
                  : "border-neutral-200 bg-white hover:border-neutral-300"
              }`}
            >
              <input
                type="radio"
                name="process-mode"
                value="ocr"
                className="sr-only"
                checked={processMode === "ocr"}
                onChange={() => setProcessMode("ocr")}
              />
              <span className="block text-sm font-medium">
                提取画面字幕<span className="ml-1 rounded bg-neutral-900 px-1 py-0.5 text-[10px] font-medium text-white">OCR</span>
              </span>
              <span className="mt-0.5 block text-xs text-neutral-500">
                视频画面已有字幕时直接提取文字；混选的音频仍按语音转写
              </span>
            </label>
          </div>
        </fieldset>

        {/* 识别设置（P2.11 场景自适应）：语音转写显示全部；OCR 模式仅热词（用于 AI 润色纠错） */}
        <fieldset className="mt-6" disabled={uploading}>
          <legend className="text-sm font-medium">识别设置（可选）</legend>

          {processMode === "asr" && (
            <>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {ASR_SCENES.map((s) => (
                  <label
                    key={s.code}
                    className={`cursor-pointer rounded-xl border-2 px-3 py-2.5 transition-colors ${
                      scene === s.code
                        ? "border-brand bg-brand-soft/40"
                        : "border-neutral-200 bg-white hover:border-neutral-300"
                    }`}
                  >
                    <input
                      type="radio"
                      name="asr-scene"
                      value={s.code}
                      className="sr-only"
                      checked={scene === s.code}
                      onChange={() => setScene(s.code)}
                    />
                    <span className="block text-sm font-medium">{s.label}</span>
                    <span className="mt-0.5 block text-xs text-neutral-500">{s.hint}</span>
                  </label>
                ))}
              </div>

              <label className="mt-4 block">
                <span className="text-sm font-medium">视频主要语言</span>
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className="mt-2 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-sm transition-colors focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 sm:w-64"
                >
                  {ASR_LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-xs text-neutral-400">
                  指定语言可提高识别准确率；数字将自动转阿拉伯数字（如「一百二十三」→「123」）
                </span>
              </label>
            </>
          )}

          <label className="mt-4 block">
            <span className="text-sm font-medium">专有名词热词</span>
            <input
              type="text"
              value={hotwords}
              onChange={(e) => setHotwords(e.target.value)}
              maxLength={600}
              placeholder={processMode === "asr" ? "如：API, agent, RPA, token, 昆明, 螺蛳粉" : "如：API, agent, RPA, token"}
              className="mt-2 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-sm transition-colors placeholder:text-neutral-300 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
            />
            <span className="mt-1 block text-xs text-neutral-400">
              {processMode === "asr"
                ? "多个词用逗号分隔（最多 50 个）。视频里的品牌名、人名、专业术语识别不准时填这里，识别和 AI 润色都会纠正"
                : "多个词用逗号分隔（最多 50 个）。画面字幕里的专有名词写错时，AI 润色会按这里的写法纠正"}
            </span>
          </label>

          {processMode === "asr" && (
            <label className="mt-4 flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={denoise}
                onChange={(e) => setDenoise(e.target.checked)}
                className="mt-0.5 size-4 accent-[var(--color-brand)]"
              />
              <span>
                <span className="text-sm font-medium">噪声抑制</span>
                <span className="mt-0.5 block text-xs text-neutral-400">
                  户外、街头、嘈杂环境的录音建议开启（AI 降噪后再识别，稍慢几秒）；安静的口播/课程不必开
                </span>
              </span>
            </label>
          )}
        </fieldset>

        {/* 拖放/点击选择区域 */}
        <label
          className="mt-8 flex min-h-[160px] cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-neutral-300 bg-white px-6 py-8 text-center transition-colors hover:border-brand/50 hover:bg-brand-soft/40"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.files?.length) addFiles(Array.from(e.dataTransfer.files));
          }}
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            accept="video/mp4,video/quicktime,video/x-matroska,video/webm,audio/mpeg,audio/mp4,audio/wav"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) addFiles(Array.from(e.target.files));
              e.target.value = ""; // 允许重复选择同一文件
            }}
            disabled={uploading}
          />
          <div className="text-4xl">📹</div>
          <p className="mt-3 font-medium">点击选择 或 拖拽视频/音频到这里（可多选）</p>
          <p className="mt-1 text-sm text-neutral-500">
            视频 mp4 / mov / mkv / webm · 音频 mp3 / m4a / wav · 单个 ≤ 500MB · 每批 ≤ {MAX_BATCH_FILES} 个
          </p>
        </label>

        {/* 文件列表 */}
        {rows.length > 0 && (
          <ul className="mt-6 space-y-2">
            {rows.map((r) => {
              const bad = !ACCEPT_TYPES[extOf(r.file)];
              const tooBig = oversize(r);
              return (
                <li key={r.id} className="rounded-xl border border-black/5 bg-white px-4 py-3 shadow-sm">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{r.file.name}</p>
                      <p className={`mt-0.5 text-xs ${bad || tooBig ? "text-red-500" : "text-neutral-400"}`}>
                        {formatBytes(r.file.size)}
                        {bad && " · 不支持的格式"}
                        {tooBig && " · 超过大小上限"}
                        {r.error && ` · ${r.error}`}
                        {r.status === "done" && " · 上传完成，转写已排队"}
                      </p>
                    </div>
                    {r.status === "uploading" ? (
                      <span className="shrink-0 text-xs text-neutral-500">{r.progress}%</span>
                    ) : (
                      (r.status === "pending" || r.status === "failed" || r.status === "canceled") && (
                        <button
                          type="button"
                          onClick={() => removeRow(r.id)}
                          className="shrink-0 text-xs text-neutral-400 transition-colors hover:text-red-500"
                        >
                          移除
                        </button>
                      )
                    )}
                  </div>
                  {r.status === "uploading" && (
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-neutral-200">
                      <div className="h-full rounded-full bg-brand transition-[width] duration-200" style={{ width: `${r.progress}%` }} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {/* 批量结果汇总 */}
        {summary && <p className="mt-4 text-center text-sm text-amber-600">{summary}</p>}

        {/* 提交按钮 */}
        <button
          onClick={handleUpload}
          disabled={uploading || rows.length === 0 || hasInvalid || rows.every((r) => r.status === "done")}
          className="mt-8 w-full rounded-xl bg-brand py-3 font-medium text-white transition-colors hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-50"
        >
          {uploading
            ? `上传中（${doneCount}/${rows.length}）…`
            : rows.length > 1
              ? `批量上传 ${rows.length} 个文件`
              : "开始上传并转写"}
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
  </div>
  );
}
