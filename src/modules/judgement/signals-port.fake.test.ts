// FakeSignals 过 SignalsPort 契约；真实 C 的契约测试在任务 12（C 已合入 main，届时共用同一份）。
import { CATALOG } from "../signals/catalog";
import { signalsPortContract } from "../../../tests/contracts/signals-port.contract";
import { FakeSignals } from "./fakes";

signalsPortContract("FakeSignals", async () => {
  let n = 0n;
  const fake = new FakeSignals();
  for (const p of ["douyin", "xiaohongshu", "kuaishou"]) fake.platformMap.set(p, new Set(CATALOG.filter((e) => (e.platforms as readonly string[]).includes(p)).map((e) => e.key)));
  return { port: fake, actor: { actor: "user:7", capabilities: new Set(), brandScope: "all" }, nextPlanId: () => ++n };
});
