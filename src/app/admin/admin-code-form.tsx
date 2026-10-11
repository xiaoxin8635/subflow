"use client";
/**
 * @file 管理后台发码表单（客户端组件）
 * @description 加油包（档位快捷生成对应秒数的时长码，P2.8）、时长码（秒数 × 数量）
 *              或套餐码（套餐 × 数量），提交 POST /api/admin/codes（加油包在本地
 *              折算成 seconds，后端零改动），结果展示为一键复制的码列表。
 *              生成后 router.refresh() 同步未用码列表。
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ADDON_PACKAGES } from "@/lib/constants";

/** 套餐下拉项 */
interface PlanOption {
  id: string;
  name: string;
}

/**
 * 发码表单组件
 * @param props.plans 在售套餐列表（服务端注入）
 */
export function AdminCodeForm({ plans }: { plans: PlanOption[] }) {
  const router = useRouter();
  const [mode, setMode] = useState<"addon" | "seconds" | "plan">(plans.length > 0 ? "plan" : "addon");
  const [planId, setPlanId] = useState(plans[0]?.id ?? "");
  const [addonId, setAddonId] = useState<string>(ADDON_PACKAGES[0].id);
  const [seconds, setSeconds] = useState(600);
  const [count, setCount] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<string[]>([]);

  /**
   * 提交发码请求（加油包折算为对应秒数的时长码）
   * @param e 表单事件
   */
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    setGenerated([]);
    try {
      const payload =
        mode === "plan"
          ? { planId, count }
          : mode === "addon"
            ? {
                seconds: ADDON_PACKAGES.find((p) => p.id === addonId)?.seconds ?? 0,
                count,
              }
            : { seconds, count };
      const res = await fetch("/api/admin/codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json()) as { codes?: string[]; error?: string };
      if (!res.ok || !body.codes) {
        setError(body.error ?? `生成失败（HTTP ${res.status}）`);
      } else {
        setGenerated(body.codes);
        router.refresh(); // 同步「未用激活码」列表
      }
    } catch {
      setError("网络异常，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * 复制全部生成的码到剪贴板
   */
  async function copyAll() {
    await navigator.clipboard.writeText(generated.join("\n"));
  }

  const modeBtn = (value: typeof mode, label: string, disabled = false) => (
    <button
      type="button"
      onClick={() => setMode(value)}
      disabled={disabled}
      className={`rounded-lg px-3 py-1.5 transition-colors disabled:opacity-40 ${
        mode === value ? "bg-brand text-white" : "text-neutral-600"
      }`}
    >
      {label}
    </button>
  );

  return (
    <section className="mt-8 rounded-2xl border border-black/5 bg-white p-6 shadow-sm">
      <h2 className="text-sm font-medium">生成激活码</h2>

      <form onSubmit={handleSubmit} className="mt-4 flex flex-wrap items-end gap-3">
        {/* 类型切换 */}
        <div className="flex rounded-xl border border-neutral-200 p-1 text-sm">
          {modeBtn("plan", "套餐码", plans.length === 0)}
          {modeBtn("addon", "加油包")}
          {modeBtn("seconds", "时长码")}
        </div>

        {mode === "plan" && (
          <label className="text-sm text-neutral-600">
            套餐
            <select
              value={planId}
              onChange={(e) => setPlanId(e.target.value)}
              className="ml-2 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 outline-none focus:border-brand"
            >
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {mode === "addon" && (
          <label className="text-sm text-neutral-600">
            档位
            <select
              value={addonId}
              onChange={(e) => setAddonId(e.target.value)}
              className="ml-2 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 outline-none focus:border-brand"
            >
              {ADDON_PACKAGES.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}（¥{(p.priceCents / 100).toFixed(1)} / {Math.round(p.seconds / 60)} 分钟）
                </option>
              ))}
            </select>
          </label>
        )}
        {mode === "seconds" && (
          <label className="text-sm text-neutral-600">
            时长（秒）
            <input
              type="number"
              min={60}
              step={60}
              value={seconds}
              onChange={(e) => setSeconds(Number(e.target.value))}
              className="ml-2 w-24 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 outline-none focus:border-brand"
            />
          </label>
        )}

        <label className="text-sm text-neutral-600">
          数量
          <input
            type="number"
            min={1}
            max={50}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            className="ml-2 w-20 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 outline-none focus:border-brand"
          />
        </label>

        <button
          type="submit"
          disabled={submitting}
          className="rounded-xl bg-brand px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-strong disabled:opacity-50"
        >
          {submitting ? "生成中…" : "生成"}
        </button>
      </form>

      {mode === "addon" && (
        <p className="mt-2 text-xs text-neutral-400">
          加油包码 = 对应档位秒数的时长码（用户购买页看到的档位与此同源），兑换后直接进余额
        </p>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {generated.length > 0 && (
        <div className="mt-4 rounded-xl bg-emerald-50 p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-emerald-700">已生成 {generated.length} 枚（仅本次展示，请立即复制）</p>
            <button
              onClick={copyAll}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-700"
            >
              复制全部
            </button>
          </div>
          <ul className="mt-2 space-y-1 font-mono text-sm tracking-wider text-emerald-900">
            {generated.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
