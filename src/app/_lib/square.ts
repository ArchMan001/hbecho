// 页面进程里的视频广场装配：进程内只建一次，复用访问控制运行时的数据库连接。
import pino from "pino";
import { getAccessRuntime } from "../../modules/access-control/runtime";
import { assembleSquare, type SquareDeps } from "../../modules/video-square";

const KEY = Symbol.for("hbecho.square.deps");

export function square(): SquareDeps {
  const g = globalThis as unknown as Record<symbol, SquareDeps | undefined>;
  const rt = getAccessRuntime();
  return (g[KEY] ??= assembleSquare({ db: rt.db, clock: { now: () => new Date() }, env: process.env, logger: pino({ name: "square" }, pino.destination(2)) }));
}
