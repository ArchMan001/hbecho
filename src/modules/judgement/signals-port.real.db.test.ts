// SignalsPort 契约对**真实 C**（createSignals + 真实 MySQL + FakeObjectStore / FakeMatcher）：与 FakeSignals 共用同一份契约（design §10.3）。
// 这里证明的是「端口形状与 C 在 main 上的实现一致」；C 的真实 OSS、真实匹配服务与真实模型不在离线范围（ENV-1 的其余部分仍未验证）。
import { signalsPortContract } from "../../../tests/contracts/signals-port.contract";
import { useTestDb } from "../../../tests/harness/db";
import { actor, createWorld } from "../../../tests/harness/signals-world";
import { realSignalsPort } from "./real-ports";
const t = useTestDb();
signalsPortContract("真实 C（realSignalsPort(createSignals)）", async () => {
  const w = await createWorld(t);
  let n = 100n; // 1 号计划已被测试世界占用
  return { port: realSignalsPort(w.signals), actor, nextPlanId: () => ++n };
});
