// 页面进程里的学习模块装配：进程内只建一次，复用访问控制运行时的数据库连接。
import { getAccessRuntime } from "../../modules/access-control/runtime";
import { assembleLearning, type LearningDeps } from "../../modules/learning";

const KEY = Symbol.for("hbecho.learning.deps");
export function learning(): LearningDeps {
  const g = globalThis as unknown as Record<symbol, LearningDeps | undefined>;
  const rt = getAccessRuntime();
  return (g[KEY] ??= assembleLearning({ db: rt.db, clock: { now: () => new Date() }, env: process.env }));
}
