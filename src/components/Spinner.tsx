/**
 * 加载指示器 —— 全局只用这一个。
 *
 * 用 SVG 画而不是「CSS 画半个边框再转」：后者是拿一个圆的四边描边假装进度弧，
 * 端点只能是方的，在深色背景上看着很脏；SVG 能让弧线收成圆头，
 * 粗细也能和其他图标的 2.4 保持一致。
 */
export function Spinner({ size = 20 }: { size?: number }) {
  return (
    <svg
      className="spin"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      {/* 一圈暗底 + 一段高亮弧，这样转起来能看出方向 */}
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.18"
        strokeWidth="2.5"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
