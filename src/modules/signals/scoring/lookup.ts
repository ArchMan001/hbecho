// 读取口的结果行取数（给 reader.ts 的 ResultLookup 接口）：只读，不建任务。
import type { Db } from "../../../db/client";
import type { StoredSignal } from "../compose";
import type { AiGatewayPort } from "../speech/ports";
import { pendingHints, idempotencyKeyOf } from "../tasks/queue";
import type { ResultLookup } from "../reader";
import { reuseKeyOf, resolveParam, taskKindOf } from "./params";
import { latestResults } from "./results";

export function createResultLookup(deps: { db: Db; gateway?: Pick<AiGatewayPort, "activeModel"> }): ResultLookup {
  return {
    async lookup(entry, subjects, param) {
      const out = new Map<bigint, { stored?: StoredSignal; pending?: "queued" | "running" | "dead" }>();
      // 判定的参数指纹含模型版本：模型不可用时算不出指纹，读取按未启用处理（已存的旧模型结果要换模型版本后再请求）
      const p = await resolveParam(deps.db, deps.gateway, entry, param);
      if (!p.available) return out;
      const shas = [...new Map(subjects.map((s) => [s.material.sha256.toString("hex"), s.material.sha256])).values()];
      const results = await latestResults(deps.db, entry, shas, p.paramSha);
      const keys = new Map(shas.map((sha) => [sha.toString("hex"), idempotencyKeyOf(taskKindOf(entry.key), reuseKeyOf(entry, sha, p.paramSha))]));
      const hints = await pendingHints(deps.db, [...keys.values()]);
      for (const s of subjects) {
        const hex = s.material.sha256.toString("hex");
        const stored = results.get(hex);
        const pending = hints.get(keys.get(hex)!.toString("hex"));
        out.set(s.id, { ...(stored ? { stored } : {}), ...(pending ? { pending } : {}) });
      }
      return out;
    },
  };
}
