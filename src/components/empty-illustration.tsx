/**
 * @file 空状态立体插画图标（内联 SVG，零外部依赖）
 * @description 用「双色渐变 + 高光 + 软阴影」模拟 3D 图标的柔和质感（灵感来自
 *              3dicons 一类素材，但不引入外部图片资产——空状态是低频展示元素，
 *              内联 SVG 体积小、随主题色一致、无网络依赖）。四个图标对应四类
 *              空态场景：文件夹（还没有项目）、放大镜（筛选无结果）、信封
 *              （邀请/通知）、胶片（未识别到字幕）。父容器通常配合
 *              `empty-float` 缓浮动画（globals.css，尊重 reduced-motion）。
 *              尺寸三档：lg（整页大空态）/ md（默认，卡片内）/ sm（下拉面板）。
 */

/** 图标尺寸三档：lg 用于整页大空态，md（默认）用于卡片内空态，sm 用于下拉面板 */
const ICON_SIZE = { sm: "h-11 w-11", md: "h-16 w-16", lg: "h-24 w-24" } as const;

/** 图标公共外壳：三档尺寸 + 底部椭圆软阴影 */
function IconShell({ children, size = "md" }: { children: React.ReactNode; size?: keyof typeof ICON_SIZE }) {
  return (
    <svg viewBox="0 0 96 96" fill="none" className={ICON_SIZE[size]} aria-hidden>
      {/* 底部软阴影（椭圆，模拟悬浮投影） */}
      <ellipse cx="48" cy="82" rx="26" ry="5" fill="#4f46e5" opacity="0.12" />
      {children}
    </svg>
  );
}

/** 文件夹（还没有项目） */
export function FolderEmpty3D({ size = "md" }: { size?: keyof typeof ICON_SIZE }) {
  return (
    <IconShell size={size}>
      {/* 后板 */}
      <path
        d="M20 34a6 6 0 0 1 6-6h14l6 7h24a6 6 0 0 1 6 6v6H20V34Z"
        fill="url(#folderBack)"
      />
      {/* 前板（亮面，带高光描边） */}
      <path
        d="M14 44a6 6 0 0 1 6-6h56a6 6 0 0 1 6 6v26a6 6 0 0 1-6 6H20a6 6 0 0 1-6-6V44Z"
        fill="url(#folderFront)"
      />
      <path
        d="M14 44a6 6 0 0 1 6-6h56a6 6 0 0 1 6 6v4H14v-4Z"
        fill="#fff"
        opacity="0.18"
      />
      <defs>
        <linearGradient id="folderBack" x1="20" y1="28" x2="76" y2="53" gradientUnits="userSpaceOnUse">
          <stop stopColor="#818cf8" />
          <stop offset="1" stopColor="#4f46e5" />
        </linearGradient>
        <linearGradient id="folderFront" x1="14" y1="38" x2="82" y2="76" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6366f1" />
          <stop offset="1" stopColor="#4338ca" />
        </linearGradient>
      </defs>
    </IconShell>
  );
}

/** 放大镜（筛选无结果） */
export function SearchEmpty3D({ size = "md" }: { size?: keyof typeof ICON_SIZE }) {
  return (
    <IconShell size={size}>
      {/* 镜片 */}
      <circle cx="43" cy="42" r="22" fill="url(#lens)" />
      <circle cx="43" cy="42" r="22" stroke="#a5b4fc" strokeWidth="3" />
      {/* 镜片高光弧 */}
      <path d="M32 34a13 13 0 0 1 12-6" stroke="#fff" strokeWidth="4" strokeLinecap="round" opacity="0.5" />
      {/* 手柄 */}
      <path
        d="M59 58 72 71"
        stroke="url(#handle)"
        strokeWidth="9"
        strokeLinecap="round"
      />
      <defs>
        <radialGradient id="lens" cx="0.35" cy="0.3" r="1">
          <stop stopColor="#c7d2fe" />
          <stop offset="1" stopColor="#6366f1" />
        </radialGradient>
        <linearGradient id="handle" x1="59" y1="58" x2="72" y2="71" gradientUnits="userSpaceOnUse">
          <stop stopColor="#4f46e5" />
          <stop offset="1" stopColor="#3730a3" />
        </linearGradient>
      </defs>
    </IconShell>
  );
}

/** 信封（邀请 / 通知空态） */
export function MailEmpty3D({ size = "md" }: { size?: keyof typeof ICON_SIZE }) {
  return (
    <IconShell size={size}>
      {/* 信封主体 */}
      <rect x="16" y="30" width="64" height="44" rx="7" fill="url(#mailBody)" />
      {/* 顶盖折线（亮面） */}
      <path d="M16 37a7 7 0 0 1 7-7h50a7 7 0 0 1 7 7l-28.4 19a7 7 0 0 1-7.2 0L16 37Z" fill="#fff" opacity="0.16" />
      {/* 盖口折线（描线） */}
      <path d="M18 36l26.6 17.6a7 7 0 0 0 7.6 0L79 36" stroke="#eef2ff" strokeWidth="3" strokeLinecap="round" fill="none" />
      <defs>
        <linearGradient id="mailBody" x1="16" y1="30" x2="80" y2="74" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6366f1" />
          <stop offset="1" stopColor="#4338ca" />
        </linearGradient>
      </defs>
    </IconShell>
  );
}

/** 胶片（未识别到字幕内容） */
export function FilmEmpty3D({ size = "md" }: { size?: keyof typeof ICON_SIZE }) {
  return (
    <IconShell size={size}>
      {/* 片身 */}
      <rect x="22" y="26" width="52" height="44" rx="7" fill="url(#filmBody)" />
      {/* 齿孔（左右两列） */}
      <g fill="#eef2ff" opacity="0.75">
        <rect x="28" y="33" width="7" height="6" rx="1.6" />
        <rect x="28" y="45" width="7" height="6" rx="1.6" />
        <rect x="28" y="57" width="7" height="6" rx="1.6" />
        <rect x="61" y="33" width="7" height="6" rx="1.6" />
        <rect x="61" y="45" width="7" height="6" rx="1.6" />
        <rect x="61" y="57" width="7" height="6" rx="1.6" />
      </g>
      {/* 中央画面区（亮面） */}
      <rect x="40" y="36" width="16" height="24" rx="3" fill="#fff" opacity="0.2" />
      <defs>
        <linearGradient id="filmBody" x1="22" y1="26" x2="74" y2="70" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6366f1" />
          <stop offset="1" stopColor="#4338ca" />
        </linearGradient>
      </defs>
    </IconShell>
  );
}
