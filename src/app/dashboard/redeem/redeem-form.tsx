"use client";
/**
 * @file 激活码兑换表单（客户端组件）
 * @description 输入激活码兑换额度：时长码直接加余额，套餐码开通月订阅并按月额度入账。
 *              兑换成功展示入账秒数与最新余额；router.refresh() 同步服务端余额显示。
 */
import { useState } from "react";
import { useRouter } from "next/navigation";

/** 兑换接口成功响应结构 */
interface RedeemOk {
  ok: true;
  addedSeconds: number;
  balanceSeconds: number;
  planName: string | null;
}

/**
 * 秒数格式化为「X 小时 Y 分钟」
 * @param total 总秒数
 */
function formatSeconds(total: number): string {
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  if (minutes > 0) return `${minutes} 分钟`;
  return `${total} 秒`;
}

/**
 * 兑换表单组件
 * @param props.balanceSeconds 当前余额（服务端注入，成功后用接口返回值更新）
 */
export function RedeemForm({ balanceSeconds }: { balanceSeconds: number }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [balance, setBalance] = useState(balanceSeconds);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<RedeemOk | null>(null);

  /**
   * 提交兑换请求
   * @param e 表单提交事件
   */
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = (await res.json()) as RedeemOk | { error: string };
      if (!("ok" in body)) {
        setError(("error" in body && body.error) || "兑换失败，请稍后重试");
      } else {
        setSuccess(body);
        setBalance(body.balanceSeconds);
        setCode("");
        router.refresh(); // 刷新服务端组件中的余额显示
      }
    } catch {
      setError("网络异常，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-2xl border border-black/5 bg-white p-8 shadow-sm">
      <h1 className="text-xl font-bold tracking-tight">兑换激活码</h1>
      <p className="mt-1 text-sm text-neutral-500">
        输入购买或活动获得的激活码，额度将立即到账 · 当前余额{" "}
        <span className="font-medium text-brand">{formatSeconds(balance)}</span>
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div>
          <label htmlFor="redeem-code" className="block text-sm font-medium text-neutral-700">
            激活码
          </label>
          <input
            id="redeem-code"
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="例如：SUBF-XXXX-XXXX-XXXX"
            autoComplete="off"
            spellCheck={false}
            className="mt-1.5 w-full rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-2.5 font-mono tracking-wider outline-none transition focus:border-brand focus:bg-white focus:ring-2 focus:ring-brand/20"
          />
        </div>

        {error && (
          <p className="rounded-xl bg-red-50 px-4 py-2.5 text-sm text-red-600">{error}</p>
        )}
        {success && (
          <div className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            <p className="font-medium">
              兑换成功！{success.planName ? `「${success.planName}」套餐已开通，` : ""}
              到账 {formatSeconds(success.addedSeconds)}
            </p>
            <p className="mt-1">当前余额：{formatSeconds(success.balanceSeconds)}</p>
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || !code.trim()}
          className="w-full rounded-xl bg-brand px-5 py-3 font-medium text-white transition-colors hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "兑换中…" : "立即兑换"}
        </button>
      </form>
    </div>
  );
}
