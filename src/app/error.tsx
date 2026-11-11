"use client";
// 全局错误页：一句人话 + 稳定错误码 + 重试，不显示堆栈（ui-foundation §5）。
import { ErrorState } from "./_components/ui";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const code = error.message === "auth_unavailable" ? "auth_unavailable" : error.digest;
  return (
    <main className="page" style={{ maxWidth: 560, margin: "12vh auto" }}>
      <ErrorState code={code} onRetry={reset} />
    </main>
  );
}
