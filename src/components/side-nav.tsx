/**
 * @file 侧边栏导航（客户端组件）：滑动高亮层
 * @description 桌面竖向导航与移动端横向标签栏共用「共享高亮层」交互——
 *              激活底色不再由各导航项自持，而是 nav 内一个绝对定位的滑动层，
 *              切换目标时通过 CSS transition 平滑平移到新位置（剪辑软件轨道
 *              滑块的质感）。服务端渲染与水合前仍由导航项自持高亮（SSR 直出、
 *              无闪烁），水合后在首帧绘制前切换为滑动层模式（useLayoutEffect）。
 *              点击导航时乐观更新目标（不等路由完成），指示层立即起步平移。
 *              本组件须渲染在 dashboard/layout.tsx（跨页保留 DOM）中，
 *              放进各页面内部会随页面切换整树重建，动画无从发生。
 */
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** 侧边栏导航项 */
const NAV_ITEMS = [
  { href: "/dashboard", label: "我的项目", key: "projects" },
  { href: "/dashboard/new", label: "新建项目", key: "new" },
  { href: "/dashboard/invite", label: "邀请好友", key: "invite" },
  { href: "/dashboard/redeem", label: "兑换额度", key: "redeem" },
  { href: "/pricing", label: "购买额度", key: "pricing" },
] as const;

/** 导航项 key 类型 */
type NavKey = (typeof NAV_ITEMS)[number]["key"];

/** 导航项图标（stroke 1.7 线性风格，随文字色继承；projects=胶片格呼应剪辑母题） */
const NAV_ICONS: Record<NavKey, string[]> = {
  projects: [
    "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z",
    "M8 5v14",
    "M16 5v14",
    "M3 10h5",
    "M3 14h5",
    "M16 10h5",
    "M16 14h5",
  ],
  new: ["M12 8v8", "M8 12h8"],
  invite: [
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
    "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
    "M19 8v6",
    "M22 11h-6",
  ],
  redeem: [
    "M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z",
    "M13 5v2",
    "M13 11v2",
    "M13 17v2",
  ],
  pricing: ["M13 2 3 14h9l-1 8 10-12h-9l1-8Z"],
};

/** 导航图标组件 */
function NavIcon({ paths }: { paths: string[] }) {
  return (
    <svg
      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0" aria-hidden
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/**
 * 由路径解析当前激活的导航 key
 * @param pathname 当前路径（usePathname，不含 query）
 * @returns 匹配的导航 key；未知路径兜底归「我的项目」
 */
function resolveActiveKey(pathname: string): NavKey {
  if (pathname.startsWith("/dashboard/new")) return "new";
  if (pathname.startsWith("/dashboard/invite")) return "invite";
  if (pathname.startsWith("/dashboard/redeem")) return "redeem";
  return "projects";
}

/** 滑动指示层矩形（相对 nav 的偏移与尺寸，absolute 定位直接可用） */
interface IndicatorBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * 滑动指示层 Hook：测量激活导航项在 nav 内的位置（水合后启用）
 * @param activeIndex 激活项下标
 * @returns nav ref / 导航项 ref 列表 / 是否已切换滑动层模式 / 指示层矩形
 */
function useSlidingIndicator(activeIndex: number) {
  const navRef = useRef<HTMLElement | null>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  const [ready, setReady] = useState(false);
  const [box, setBox] = useState<IndicatorBox | null>(null);

  /** 读取激活项的 offset 矩形并写入状态（offsetTop 与 absolute 定位同为 padding box 参照） */
  const measure = () => {
    const el = itemRefs.current[activeIndex];
    if (el) {
      setBox({
        top: el.offsetTop,
        left: el.offsetLeft,
        width: el.offsetWidth,
        height: el.offsetHeight,
      });
    }
  };

  // 水合与激活项变化：首帧绘制前测量定位（ready 置位后 transition 生效）。
  // DOM 测量后回写状态必须发生在 layout effect 内（React 官方测量模式），
  // 此处豁免 set-state-in-effect。
  useLayoutEffect(() => {
    measure();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex]);

  // nav 尺寸变化（窗口缩放 / 字体加载完成）后重新测量，避免指示层错位
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || !ready) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(nav);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, activeIndex]);

  return { navRef, itemRefs, ready, box };
}

/**
 * 乐观激活管理：点击导航项立即切换高亮目标（不等路由），路径变化后回落到真实路径解析
 * @returns 当前激活 key / 点击回调
 */
function useOptimisticActiveKey() {
  const pathname = usePathname();
  const [pending, setPending] = useState<NavKey | null>(null);

  // 路由变化后在渲染期间重置乐观目标（React 官方「跨渲染调整状态」模式——
  // 同一次渲染内立即生效，避免 effect 后置重置造成的一帧目标漂移；
  // 浏览器前进/后退同样适用）
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (prevPathname !== pathname) {
    setPrevPathname(pathname);
    setPending(null);
  }

  return {
    activeKey: pending ?? resolveActiveKey(pathname),
    onNavigate: (key: NavKey) => setPending(key),
  };
}

/**
 * 桌面侧边栏导航（≥lg，竖向）：渐变底 + 左缘发光指示条整体平滑平移
 */
export function SideNav() {
  const { activeKey, onNavigate } = useOptimisticActiveKey();
  const activeIndex = NAV_ITEMS.findIndex((i) => i.key === activeKey);
  const { navRef, itemRefs, ready, box } = useSlidingIndicator(activeIndex);

  return (
    <nav ref={navRef} className="relative flex-1 space-y-0.5 px-3" aria-label="主导航">
      {/* 滑动高亮层：水合后接管导航项自持高亮；pointer-events-none 防止挡住下层交互 */}
      {ready && box && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-3 rounded-lg bg-gradient-to-r from-brand/25 to-brand/5 transition-[top] duration-300 ease-out motion-reduce:transition-none"
          style={{ top: box.top, height: box.height }}
        >
          <span
            className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand shadow-[0_0_8px_2px_rgba(79,70,229,0.55)]"
          />
        </div>
      )}
      {NAV_ITEMS.map((item, i) => {
        const isActive = item.key === activeKey;
        return (
          <Link
            key={item.key}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            href={item.href}
            onClick={() => onNavigate(item.key)}
            aria-current={isActive ? "page" : undefined}
            className={`group relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors duration-150 ${
              isActive
                ? ready
                  ? "font-medium text-white"
                  : "bg-gradient-to-r from-brand/25 to-brand/5 font-medium text-white"
                : "text-neutral-400 hover:bg-white/5 hover:text-white"
            }`}
          >
            {/* 未水合阶段的临时指示条（SSR 直出）；水合后由滑动层渲染 */}
            {isActive && !ready && (
              <span
                aria-hidden
                className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand shadow-[0_0_8px_2px_rgba(79,70,229,0.55)]"
              />
            )}
            <span
              aria-hidden
              className={`transition-all duration-150 group-hover:translate-x-0.5 ${
                isActive
                  ? "text-indigo-300"
                  : "text-neutral-500 group-hover:text-neutral-300"
              }`}
            >
              <NavIcon paths={NAV_ICONS[item.key]} />
            </span>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * 移动端横向标签栏（<lg，可横滑）：品牌软底高亮块横向平滑平移
 * @param children 追加在导航末尾的节点（如退出入口）
 */
export function MobileNavTabs({ children }: { children?: React.ReactNode }) {
  const { activeKey, onNavigate } = useOptimisticActiveKey();
  const activeIndex = NAV_ITEMS.findIndex((i) => i.key === activeKey);
  const { navRef, itemRefs, ready, box } = useSlidingIndicator(activeIndex);

  return (
    <nav
      ref={navRef}
      className="relative flex gap-1 overflow-x-auto px-3 pb-2 pt-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      aria-label="主导航"
    >
      {/* 滑动高亮层：absolute 在滚动容器内随内容横滚，测量值与滚动坐标系一致 */}
      {ready && box && (
        <div
          aria-hidden
          className="pointer-events-none absolute rounded-lg bg-brand/20 transition-[left,top,width] duration-300 ease-out motion-reduce:transition-none"
          style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
        />
      )}
      {NAV_ITEMS.map((item, i) => {
        const isActive = item.key === activeKey;
        return (
          <Link
            key={item.key}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            href={item.href}
            onClick={() => onNavigate(item.key)}
            aria-current={isActive ? "page" : undefined}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors ${
              isActive
                ? ready
                  ? "font-medium text-white"
                  : "bg-brand/20 font-medium text-white"
                : "text-neutral-400 hover:text-white"
            }`}
          >
            <span
              aria-hidden
              className={isActive ? "text-indigo-300" : "text-neutral-500"}
            >
              <NavIcon paths={NAV_ICONS[item.key]} />
            </span>
            {item.label}
          </Link>
        );
      })}
      {/* 移动端无侧边栏用户区，退出入口挂在标签栏末尾 */}
      {children}
    </nav>
  );
}
