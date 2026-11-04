// 默认套件禁网（R16.1/R16.2）：任何非回环的 socket / fetch 立即失败，并记录尝试。
// 回环放行：后续任务要连本机一次性 MySQL 容器；真实供应商与媒资地址都不是回环。
import net from "node:net";

export class NetworkDeniedError extends Error {
  constructor(readonly target: string) {
    super(`默认测试禁止网络访问：${target}`);
    this.name = "NetworkDeniedError";
  }
}

const attempts: string[] = [];

/** 取出并清空已记录的被拒尝试。setup 的 afterEach 会拿它判定「测试里发生过真实网络尝试」。 */
export function drainDeniedAttempts(): string[] {
  return attempts.splice(0, attempts.length);
}

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || h === "::ffff:127.0.0.1" || /^127(\.\d{1,3}){3}$/.test(h);
}

function deny(target: string): never {
  attempts.push(target);
  throw new NetworkDeniedError(target);
}

// net.Socket.prototype.connect 的参数：(options) | (path) | (port[, host][, cb])
function targetOf(args: unknown[]): { host: string; unix: boolean } {
  const [a, b] = args;
  // net.createConnection 内部以 normalizeArgs 的结果（数组 [options, cb]）调用 socket.connect
  if (Array.isArray(a)) return targetOf(a);
  if (typeof a === "object" && a !== null) {
    const o = a as { path?: string; host?: string; port?: number };
    if (typeof o.path === "string") return { host: o.path, unix: true };
    return { host: o.host ?? "localhost", unix: false };
  }
  if (typeof a === "string") return { host: a, unix: true };
  return { host: typeof b === "string" ? b : "localhost", unix: false };
}

let installed = false;

export function denyNetwork(): void {
  if (installed) return;
  installed = true;

  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function patched(this: net.Socket, ...args: unknown[]) {
    const { host, unix } = targetOf(args);
    if (!unix && !isLoopbackHost(host)) deny(host);
    return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function patchedFetch(input: Parameters<typeof fetch>[0], init?: RequestInit) {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!isLoopbackHost(url.hostname)) deny(url.host);
    return originalFetch(input, init);
  } as typeof fetch;
}
