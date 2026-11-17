// Echo 品牌标记：E 三横 + 声源点（2026-11-16 刘学奎选定）。用 currentColor，跟随所在处的前景色。
export function EchoMark({ size = 24 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="13" y="16" width="28" height="6.6" rx="3.3" fill="currentColor" />
      <rect x="13" y="28.7" width="20" height="6.6" rx="3.3" fill="currentColor" />
      <rect x="13" y="41.4" width="28" height="6.6" rx="3.3" fill="currentColor" />
      <circle cx="49" cy="32" r="4.6" fill="currentColor" />
    </svg>
  );
}