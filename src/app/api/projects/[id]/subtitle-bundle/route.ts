/**
 * @file GET /api/projects/[id]/subtitle-bundle — 字幕产物打包下载（zip，P2.11）
 * @description 把项目全部字幕产物打包为一个 zip：
 *              原文 SRT/VTT/ASS（默认样式）+ 文稿 TXT/MD（与编辑器导出同格式）+
 *              每个已完成翻译的目标语言 SRT/VTT/ASS 与双语 SRT（原文在上译文在下）。
 *              纯文本生成零成本不扣额度。校验链：登录（401）→ 项目归属
 *              （不存在/非本人统一 404）→ 转写完成且有内容（409）。
 *              文件名取项目标题并清洗 Windows 非法字符；SRT/文稿带 UTF-8 BOM
 *              （与单格式下载行为一致，防 Windows 记事本/剪映乱码）。
 * 说明：Next.js 15+ 动态路由参数为 Promise，必须 await；
 *      Cache Components 模式下禁止 export const runtime 路由配置。
 */
import { NextResponse } from "next/server";
import JSZip from "jszip";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { loadOwnedProjectSegments, mergeBilingual } from "@/lib/subtitle-download";
import { buildSrt } from "@/lib/srt";
import { buildVtt } from "@/lib/vtt";
import { buildAss, buildBilingualAss, DEFAULT_ASS_CONFIG } from "@/lib/ass";
import type { TranslatedSegment } from "@/lib/translate-pipeline";

/** UTF-8 BOM（zip 内 SRT/文稿与单格式下载保持一致，Windows 记事本/剪映不乱码） */
const BOM = String.fromCharCode(0xfeff);

/**
 * 秒 → mm:ss.d 展示（与编辑器文稿导出的 Markdown 时间戳格式一致）
 * @param t 秒
 */
function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}

/**
 * 清洗文件名中的 Windows 非法字符（与编辑器文稿导出同一规则）
 * @param title 项目标题
 */
function safeTitle(title: string): string {
  return title.replace(/[\\/:*?"<>|]/g, "_");
}

/**
 * 打包下载项目全部字幕产物
 * @param _request 原始请求（无查询参数）
 * @param params   路由参数（Promise<{ id: string }>）
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const { id } = await params;
  const loaded = await loadOwnedProjectSegments(id, user.id);
  if (!loaded.ok) {
    return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  }
  const { segments } = loaded;
  const base = safeTitle(loaded.title);

  const zip = new JSZip();

  // ① 原文：三格式字幕 + 文稿 TXT/MD（与编辑器导出同格式）
  zip.file(`${base}.srt`, BOM + buildSrt(segments));
  zip.file(`${base}.vtt`, buildVtt(segments));
  zip.file(`${base}.ass`, buildAss(DEFAULT_ASS_CONFIG, segments));
  zip.file(`${base}_文稿.txt`, BOM + segments.map((s) => s.text).join("\n"));
  zip.file(
    `${base}_文稿.md`,
    BOM + segments.map((s) => `**${fmt(s.start)}** ${s.text}`).join("\n"),
  );

  // ② 已完成翻译：目标语言三格式 + 双语 SRT/ASS
  const translations = await db.translation.findMany({
    where: { projectId: id, status: "DONE" },
    select: { targetLang: true, segments: true },
  });
  for (const t of translations) {
    const tSegs = Array.isArray(t.segments) ? (t.segments as TranslatedSegment[]) : [];
    if (tSegs.length === 0) continue;
    zip.file(`${base}.${t.targetLang}.srt`, BOM + buildSrt(tSegs));
    zip.file(`${base}.${t.targetLang}.vtt`, buildVtt(tSegs));
    zip.file(`${base}.${t.targetLang}.ass`, buildAss(DEFAULT_ASS_CONFIG, tSegs));
    zip.file(`${base}_双语_${t.targetLang}.srt`, BOM + buildSrt(mergeBilingual(segments, tSegs)));
    zip.file(
      `${base}_双语_${t.targetLang}.ass`,
      buildBilingualAss(
        DEFAULT_ASS_CONFIG,
        segments,
        tSegs.map((s) => s.text),
      ),
    );
  }

  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const filename = encodeURIComponent(`${base}_字幕.zip`);
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="subtitles.zip"; filename*=UTF-8''${filename}`,
      "Cache-Control": "no-store",
    },
  });
}
