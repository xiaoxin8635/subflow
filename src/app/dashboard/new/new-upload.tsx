"use client";
/**
 * @file 新建项目上传主体（客户端组件，渲染于 dashboard/layout.tsx 的外壳内容区）
 * @description 支持一次选择/拖入多个视频或音频（mp3/m4a/wav），串行逐个分片上传：
 *   ① POST /api/uploads/init 创建会话（或凭 sessionStorage 中的 uploadId 断点续传）
 *   ② 3 片并发上传分片（每片失败自动重试 2 次）：
 *      local 模式 → PUT /api/uploads/[id]/chunks/[index]（经服务器）；
 *      oss   模式 → 直接 PUT init/status 返回的 partUrls[index]（浏览器直传 OSS）。
 *   ③ POST /api/uploads/[id]/complete 合并入库 → 转写自动入队。
 *   单文件完成直接跳转项目页；多文件全部完成后跳回项目列表（每个项目独立排队，
 *   串行上传避免多文件分片并发打满浏览器连接；单个文件失败不阻断后续文件，
 *   结束后可一键重传失败项）。上传中刷新后重选同一文件可断点续传。
 *   界面为「投料台」版式：大拖放区（拖入时整块响应）+ 文件行（类型图标/进度/
 *   进入与完成动效）+ 处理方式选择卡 + 识别设置折叠条（收起时显示当前值摘要）。
 *   上传状态机与网络逻辑与旧版完全一致，仅视图层重构。
 */
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ASR_LANGUAGES, ASR_SCENES, MAX_UPLOAD_BYTES } from "@/lib/constants";
import { BackLink } from "@/components/back-link";

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

/** 文件选择框 accept 属性串（由 ACCEPT_TYPES 派生，保持同源） */
const ACCEPT_ATTR = Object.values(ACCEPT_TYPES).join(",");

/** 视频扩展名集合（文件行类型图标区分视频/音频用） */
const VIDEO_EXTS = new Set([".mp4", ".mov", ".mkv", ".webm"]);

/** 拖放区展示的格式 chips（分组展示，代替标题下的长说明文） */
const FORMAT_CHIPS = [
  { group: "视频", items: ["mp4", "mov", "mkv", "webm"] },
  { group: "音频", items: ["mp3", "m4a", "wav"] },
] as const;

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

/** 上传托盘图标（拖放区主视觉，stroke 风格与侧边栏导航一致） */
function UploadTrayIcon({ active }: { active: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-10 w-10 transition-transform duration-200 ${active ? "scale-110 -translate-y-0.5" : ""}`}
      aria-hidden
    >
      <path d="M12 15V4.5" />
      <path d="m7.5 8.5 4.5-4.5 4.5 4.5" />
      <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
    </svg>
  );
}

/** 视频文件图标（文件行：圆角框 + 播放三角） */
function VideoFileIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5 shrink-0" aria-hidden>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <path d="m10.2 9.3 4.6 2.7-4.6 2.7V9.3Z" />
    </svg>
  );
}

/** 音频文件图标（文件行：波形条） */
function AudioFileIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" className="h-5 w-5 shrink-0" aria-hidden>
      <path d="M4 10v4M8 7v10M12 4.5v15M16 8v8M20 10.5v3" />
    </svg>
  );
}

/** 格式警示图标（文件行：不支持的格式 / 超限） */
function WarnFileIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5 shrink-0 text-red-500" aria-hidden>
      <path d="M12 4 3.5 19h17L12 4Z" />
      <path d="M12 10.5v3.5" />
      <path d="M12 16.8v.2" />
    </svg>
  );
}

/** 完成勾图标（文件行：上传完成，pop-in 动效） */
function CheckBadgeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="pop-in h-5 w-5 shrink-0 text-emerald-600" aria-hidden>
      <circle cx="12" cy="12" r="8.5" className="fill-emerald-50" />
      <path d="m8.5 12.2 2.4 2.4 4.6-5" />
    </svg>
  );
}

/** 语音转写图标（处理方式卡） */
function AsrModeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" className="h-5 w-5" aria-hidden>
      <rect x="9" y="3.5" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
      <path d="M12 18v2.5" />
    </svg>
  );
}

/** OCR 提取图标（处理方式卡：画面取字） */
function OcrModeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden>
      <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
      <path d="M8 10h8M8 13.5h5" />
    </svg>
  );
}

/** 下拉折叠箭头（识别设置折叠条） */
function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={`h-4 w-4 transition-transform duration-200 ${open ? "rotate-180" : ""}`} aria-hidden>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/** 场景图标（识别设置场景 chips：随文字色继承，stroke 1.7 线性风格） */
function SceneIcon({ code }: { code: string }) {
  const paths: Record<string, string[]> = {
    // 通用 = 话筒（日常口播/vlog/访谈）
    general: ["M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z", "M19 10v1a7 7 0 0 1-14 0v-1", "M12 18v4"],
    // 技术讲解 = 烧杯（编程/软件教程）
    tech: ["M10 2v6l-5.3 9.1A2 2 0 0 0 6.4 20h11.2a2 2 0 0 0 1.7-2.9L14 8V2", "M8 15h8"],
    // 直播带货 = 购物袋（商品/价格口播）
    live: ["M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z", "M3 6h18", "M16 10a4 4 0 0 1-8 0"],
    // 课堂讲课 = 学士帽（知识讲授/课程录屏）
    course: ["M22 10 12 5 2 10l10 5 10-5Z", "M6 12v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5"],
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
      {(paths[code] ?? paths.general).map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
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

/** 文件行左侧类型图标：视频 / 音频 / 非法格式警示 */
function FileKindIcon({ file }: { file: File }) {
  const ext = extOf(file);
  if (!ACCEPT_TYPES[ext]) return <WarnFileIcon />;
  return VIDEO_EXTS.has(ext) ? <VideoFileIcon /> : <AudioFileIcon />;
}

/** 新建项目上传主体组件（在 layout 外壳的内容区内渲染） */
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
  // 视图层状态：拖放悬停高亮（dragenter/leave 计数器防子元素抖动）、识别设置折叠
  const [dragActive, setDragActive] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const dragDepth = useRef(0);

  const hasInvalid = rows.some((r) => r.status === "pending" && !ACCEPT_TYPES[extOf(r.file)]);
  const oversize = (r: FileRow) => r.file.size > MAX_UPLOAD_BYTES;
  const doneCount = rows.filter((r) => r.status === "done").length;
  const pendingRows = () => rows.filter((r) => r.status === "pending" || r.status === "canceled" || r.status === "failed");

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

  /** 失败行重新入队（状态回 pending，点击「开始上传」时重传） */
  function retryRow(id: number) {
    patchRow(id, { status: "pending", progress: 0, error: undefined });
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
    // 点击时刻的快照：pendingRows() 此处读闭包 state 是准确的（事件触发时渲染已提交）。
    // queue 之外被跳过的 pending 行（格式不支持/超限）不会参与循环，也不应触发自动跳转
    const beforePending = pendingRows();
    const queue = beforePending.filter((r) => ACCEPT_TYPES[extOf(r.file)] && !oversize(r));
    const skippedCount = beforePending.length - queue.length;
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
    // skippedCount 用点击时快照而非实时 pendingRows()——async 循环后闭包 state 是旧值
    if (failCount === 0 && skippedCount === 0) {
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

  /** 热词实时计数（逗号/中文逗号分隔，去空段；与摘要、输入框 N/50 同一口径） */
  const hotwordCount = hotwords.split(/[,，]/).filter((w) => w.trim()).length;

  /** 识别设置折叠条收起时的摘要文案（编码当前值，展开才见表单） */
  function settingsSummary(): string {
    if (processMode === "ocr") {
      const hw = hotwordCount > 0 ? `热词 ${hotwordCount} 个` : "未设热词";
      return `提取画面字幕 · ${hw}`;
    }
    const sceneLabel = ASR_SCENES.find((s) => s.code === scene)?.label ?? "通用";
    const langLabel = ASR_LANGUAGES.find((l) => l.code === language)?.label ?? "中文（普通话）";
    const parts: string[] = [sceneLabel, langLabel];
    if (hotwordCount > 0) parts.push(`热词 ${hotwordCount} 个`);
    if (denoise) parts.push("降噪");
    return parts.join(" · ");
  }

  /** 批内整体进度（主按钮内衬进度条用） */
  const totalProgress =
    rows.length === 0 ? 0 : Math.round(rows.reduce((sum, r) => sum + r.progress, 0) / rows.length);

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 lg:py-10">
      <BackLink href="/dashboard" label="返回项目列表" />

      <h1 className="mt-4 text-2xl font-bold tracking-tight">新建项目</h1>
      <p className="mt-1 text-sm text-neutral-500">
        把素材交给我们，几分钟后拿回能直接用的字幕
      </p>

      {/* ============ 投料口：大拖放区（拖入时整块响应） ============ */}
      <label
        className={`mt-6 flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-all duration-200 ${
          dragActive
            ? "border-brand bg-brand-soft shadow-inner"
            : "border-neutral-300 bg-white hover:border-brand/50 hover:bg-brand-soft/40"
        }`}
        onDragEnter={(e) => {
          e.preventDefault();
          dragDepth.current += 1;
          setDragActive(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragActive(false);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          dragDepth.current = 0;
          setDragActive(false);
          if (e.dataTransfer.files?.length) addFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT_ATTR}
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) addFiles(Array.from(e.target.files));
            e.target.value = ""; // 允许重复选择同一文件
          }}
          disabled={uploading}
        />
        <span
          className={`flex h-16 w-16 items-center justify-center rounded-2xl transition-colors duration-200 ${
            dragActive ? "bg-brand text-white" : "bg-brand-soft text-brand"
          }`}
        >
          <UploadTrayIcon active={dragActive} />
        </span>
        <span className="mt-4 block font-medium">
          {dragActive ? "松手就开始上传" : "把视频或音频拖到这里，或点击选择文件"}
        </span>
        <span className="mt-1 block text-sm text-neutral-500">
          可一次选多个，中断后重新选同一文件能接着传
        </span>
        {/* 格式与限制 chips（信息从标题段移到这里，靠近操作位置） */}
        <span className="mt-5 flex flex-wrap items-center justify-center gap-1.5">
          {FORMAT_CHIPS.map((g) => (
            <span key={g.group} className="inline-flex items-center gap-1.5 rounded-lg bg-neutral-100 px-2 py-1">
              <span className="text-[11px] font-medium text-neutral-500">{g.group}</span>
              {g.items.map((ext) => (
                <span key={ext} className="text-[11px] tabular-nums text-neutral-400">
                  {ext}
                </span>
              ))}
            </span>
          ))}
          <span className="rounded-lg bg-neutral-100 px-2 py-1 text-[11px] text-neutral-400">
            单个 ≤ 500MB · 每批 ≤ {MAX_BATCH_FILES} 个
          </span>
        </span>
      </label>

      {/* ============ 文件队列（类型图标 + 进度 + 动效） ============ */}
      {rows.length > 0 && (
        <ul className="mt-5 space-y-2">
          {rows.map((r) => {
            const bad = !ACCEPT_TYPES[extOf(r.file)];
            const tooBig = oversize(r);
            const invalid = bad || tooBig;
            return (
              <li
                key={r.id}
                className={`rise-in rounded-xl border bg-white px-4 py-3 shadow-sm transition-colors ${
                  invalid
                    ? "border-red-200"
                    : r.status === "failed"
                      ? "border-red-200 bg-red-50/40"
                      : r.status === "done"
                        ? "border-emerald-200/70"
                        : "border-black/5"
                }`}
              >
                <div className="flex items-center gap-3">
                  {/* 类型图标（视频/音频/非法），上传中显品牌色 */}
                  <span
                    className={`${
                      invalid ? "text-red-500" : r.status === "uploading" ? "text-brand" : "text-neutral-400"
                    }`}
                  >
                    <FileKindIcon file={r.file} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{r.file.name}</p>
                    <p className={`mt-0.5 text-xs ${invalid || r.status === "failed" ? "text-red-500" : "text-neutral-400"}`}>
                      {formatBytes(r.file.size)}
                      {bad && " · 不支持的格式"}
                      {tooBig && " · 超过 500MB 上限"}
                      {r.error && ` · ${r.error}`}
                      {r.status === "done" && " · 上传完成，转写已排队"}
                    </p>
                  </div>
                  {/* 右侧状态区：百分比 / 完成勾 / 操作（移除、重试） */}
                  {r.status === "uploading" ? (
                    <span className="shrink-0 text-xs tabular-nums text-neutral-500">{r.progress}%</span>
                  ) : r.status === "done" ? (
                    <CheckBadgeIcon />
                  ) : (
                    <span className="flex shrink-0 items-center gap-3">
                      {r.status === "failed" && (
                        <button
                          type="button"
                          onClick={() => retryRow(r.id)}
                          className="text-xs font-medium text-brand transition-colors hover:text-brand-strong"
                        >
                          重试
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => removeRow(r.id)}
                        className="text-xs text-neutral-400 transition-colors hover:text-red-500"
                      >
                        移除
                      </button>
                    </span>
                  )}
                </div>
                {/* 进度条（上传中显示；完成/失败行不显示，靠边框与图标表达状态） */}
                {r.status === "uploading" && (
                  <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-neutral-200">
                    <div
                      className="h-full rounded-full bg-brand transition-[width] duration-200"
                      style={{ width: `${r.progress}%` }}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* ============ 处理方式：选择卡（图标 + 选中勾角标） ============ */}
      <fieldset className="mt-8" disabled={uploading}>
        <legend className="text-sm font-medium">处理方式</legend>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {(
            [
              {
                value: "asr" as const,
                icon: <AsrModeIcon />,
                title: "语音转写",
                desc: "识别视频/音频中的人声，逐句生成字幕（默认）",
                badge: null,
              },
              {
                value: "ocr" as const,
                icon: <OcrModeIcon />,
                title: "提取画面字幕",
                desc: "视频画面已有字幕时直接提取文字；混选的音频仍按语音转写",
                badge: "OCR",
              },
            ] satisfies Array<{
              value: "asr" | "ocr";
              icon: React.ReactNode;
              title: string;
              desc: string;
              badge: string | null;
            }>
          ).map((m) => {
            const selected = processMode === m.value;
            return (
              <label
                key={m.value}
                className={`relative cursor-pointer rounded-xl border-2 px-4 py-3.5 transition-all duration-150 ${
                  selected
                    ? "border-brand bg-brand-soft/50"
                    : "border-neutral-200 bg-white hover:border-neutral-300 hover:bg-neutral-50"
                }`}
              >
                <input
                  type="radio"
                  name="process-mode"
                  value={m.value}
                  className="sr-only"
                  checked={selected}
                  onChange={() => setProcessMode(m.value)}
                />
                {/* 选中勾角标：右上角，视觉确认比单纯描边更明确 */}
                {selected && (
                  <span className="pop-in absolute right-2.5 top-2.5 flex h-4.5 w-4.5 items-center justify-center rounded-full bg-brand text-white">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-2.5 w-2.5" aria-hidden>
                      <path d="m5 12.5 4.5 4.5L19 7.5" />
                    </svg>
                  </span>
                )}
                <span className="flex items-center gap-2">
                  <span className={selected ? "text-brand" : "text-neutral-400"}>{m.icon}</span>
                  <span className="text-sm font-medium">{m.title}</span>
                  {m.badge && (
                    <span className="rounded bg-neutral-900 px-1 py-0.5 text-[10px] font-medium text-white">
                      {m.badge}
                    </span>
                  )}
                </span>
                <span className="mt-1 block text-xs leading-5 text-neutral-500">{m.desc}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {/* ============ 识别设置：折叠条（收起显示当前值摘要，展开可改） ============ */}
      <fieldset className="mt-6" disabled={uploading}>
        <button
          type="button"
          onClick={() => setSettingsOpen((v) => !v)}
          disabled={uploading}
          aria-expanded={settingsOpen}
          className="flex w-full items-center justify-between rounded-xl border border-neutral-200 bg-white px-4 py-3 text-left transition-colors hover:border-neutral-300 disabled:cursor-not-allowed"
        >
          <span>
            <span className="block text-sm font-medium">识别设置</span>
            <span className="mt-0.5 block text-xs text-neutral-400">{settingsSummary()}</span>
          </span>
          <span className="text-neutral-400">
            <ChevronIcon open={settingsOpen} />
          </span>
        </button>

        {settingsOpen && (
          <div className="rise-in mt-3 rounded-xl border border-neutral-200 bg-white p-4">
            {processMode === "asr" && (
              <>
                {/* 场景预设 chips：图标 + 文字（选中哪档，下方一行显示该档说明，固定高防跳动） */}
                <div className="flex flex-wrap gap-2">
                  {ASR_SCENES.map((s) => (
                    <label
                      key={s.code}
                      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border py-1.5 pl-3 pr-3.5 text-sm transition-colors ${
                        scene === s.code
                          ? "border-brand bg-brand-soft font-medium text-brand"
                          : "border-neutral-200 bg-white text-neutral-600 hover:border-neutral-300 hover:bg-neutral-50"
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
                      <span aria-hidden className={scene === s.code ? "" : "text-neutral-400"}>
                        <SceneIcon code={s.code} />
                      </span>
                      {s.label}
                    </label>
                  ))}
                </div>
                <p className="mt-2.5 flex min-h-5 items-center text-xs text-neutral-500">
                  {ASR_SCENES.find((s) => s.code === scene)?.hint}
                </p>

                {/* 语言 + 噪声抑制两列（桌面并排缩短表单纵向长度；窄屏自动堆叠） */}
                <div className="mt-5 grid gap-x-6 gap-y-4 sm:grid-cols-2">
                  <label className="block">
                    <span className="text-sm font-medium">视频主要语言</span>
                    <span className="relative mt-2 block">
                      <select
                        value={language}
                        onChange={(e) => setLanguage(e.target.value)}
                        className="w-full appearance-none rounded-xl border border-neutral-200 bg-white py-2.5 pl-3 pr-9 text-sm shadow-[0_1.5px_0_0_#e5e5e5] transition-colors focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
                      >
                        {ASR_LANGUAGES.map((l) => (
                          <option key={l.code} value={l.code}>
                            {l.label}
                          </option>
                        ))}
                      </select>
                      <span aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400">
                        <ChevronIcon open={false} />
                      </span>
                    </span>
                  </label>

                  <label className="flex cursor-pointer items-start gap-3 sm:pt-7">
                    <span className="relative mt-0.5 inline-flex shrink-0">
                      <input
                        type="checkbox"
                        checked={denoise}
                        onChange={(e) => setDenoise(e.target.checked)}
                        className="peer sr-only"
                      />
                      {/* switch 轨道 + 圆点（纯 CSS peer 状态；表单语义仍是 checkbox） */}
                      <span aria-hidden className="h-6 w-10 rounded-full bg-neutral-200 transition-colors peer-checked:bg-brand peer-focus-visible:ring-2 peer-focus-visible:ring-brand/30" />
                      <span aria-hidden className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-150 peer-checked:translate-x-4" />
                    </span>
                    <span>
                      <span className="text-sm font-medium">噪声抑制</span>
                      <span className="mt-0.5 block text-xs text-neutral-400">
                        嘈杂环境建议开启（AI 降噪后再识别，稍慢几秒）
                      </span>
                    </span>
                  </label>
                </div>
                <p className="mt-1.5 text-xs text-neutral-400">
                  指定语言可提高识别准确率；数字将自动转阿拉伯数字（如「一百二十三」→「123」）
                </p>
              </>
            )}

            <label className={`${processMode === "asr" ? "mt-5" : ""} block`}>
              <span className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium">专有名词热词</span>
                {hotwordCount > 0 && (
                  <span className="text-xs tabular-nums text-neutral-400">{hotwordCount} / 50</span>
                )}
              </span>
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
                  ? "多个词用逗号分隔（最多 50 个）。品牌名、人名、专业术语识别不准时填这里，识别和 AI 润色都会纠正"
                  : "多个词用逗号分隔（最多 50 个）。画面字幕里的专有名词写错时，AI 润色会按这里的写法纠正"}
              </span>
            </label>
          </div>
        )}
      </fieldset>

      {/* 批量结果汇总 */}
      {summary && <p className="mt-4 text-center text-sm text-amber-600">{summary}</p>}

      {/* 提交按钮（实体按键感：底部硬阴影，hover 抬升 / 按下下沉；上传中内衬整体进度条） */}
      <button
        onClick={handleUpload}
        disabled={uploading || rows.length === 0 || hasInvalid || rows.every((r) => r.status === "done")}
        className="relative mt-8 w-full overflow-hidden rounded-xl bg-brand py-3 font-medium text-white shadow-[0_4px_0_0_#4338ca] transition-all duration-150 hover:-translate-y-0.5 hover:bg-brand-strong hover:shadow-[0_6px_0_0_#4338ca] active:translate-y-0.5 active:shadow-[0_1px_0_0_#4338ca] disabled:cursor-not-allowed disabled:opacity-50 disabled:translate-y-0 disabled:shadow-none"
      >
        {uploading && (
          <span
            className="absolute inset-y-0 left-0 bg-white/20 transition-[width] duration-200"
            style={{ width: `${totalProgress}%` }}
            aria-hidden
          />
        )}
        <span className="relative">
          {uploading
            ? `上传中 ${doneCount + 1 > rows.length ? rows.length : Math.max(doneCount + 1, 1)}/${rows.length} · ${totalProgress}%`
            : rows.length > 1
              ? `批量上传 ${rows.length} 个文件`
              : "开始上传并转写"}
        </span>
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
