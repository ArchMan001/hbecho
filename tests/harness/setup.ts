// vitest setupFiles：每个测试文件加载前安装禁网；测试结束时若发生过被拒的网络尝试，测试失败，
// 即使被测代码把错误吞掉了。需要故意触发的测试（harness.test.ts）自己调用 drainDeniedAttempts()。
import { afterEach } from "vitest";
import { denyNetwork, drainDeniedAttempts } from "./network-deny";

denyNetwork();

afterEach(() => {
  const attempts = drainDeniedAttempts();
  if (attempts.length > 0) {
    throw new Error(`测试期间发生了被拒绝的真实网络尝试：${attempts.join(", ")}`);
  }
});
