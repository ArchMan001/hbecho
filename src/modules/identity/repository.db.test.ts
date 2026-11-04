// acceptance C2（R5.2）：标识查找同时带 platform 的 namespace 与原文，哈希命中后必须复核原文。
// 摘要碰撞在现实中造不出来，所以直接在库里放一行"摘要对、原文不同"的标识，证明查找会拒绝而不是合并。
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../../tests/harness/db";
import { insertAccount, sha } from "../../../tests/harness/factories";
import { platformIdOf } from "../../../tests/harness/seed";
import { externalAccountIdentifiers } from "../../db/schema";
import { IdentityError, intakeAccount } from "./repository";

const t = useTestDb();
const NOW = new Date("2026-11-04T12:00:00.000Z");

describe("哈希命中后复核原文（R5.2）", () => {
  it("摘要相同、原文不同 → identifier_text_mismatch，不合并、不建账号", async () => {
    const accountId = await insertAccount(t.db, "douyin", NOW);
    const platformId = await platformIdOf(t.db, "douyin");
    await t.db.insert(externalAccountIdentifiers).values({
      accountId,
      namespaceCode: "douyin.user_id",
      identifierValue: "OTHER-TEXT", // 原文与摘要不对应
      identifierSha256: sha("HITACHI1"),
      bindingMethod: "same_payload",
      confidence: "observed",
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      createdAt: NOW,
    });
    const err = await t.db
      .transaction((tx) =>
        intakeAccount(tx, {
          platformId,
          staffId: 1n,
          primary: { namespace: "douyin.user_id", value: "HITACHI1" },
          submittedLocator: "x",
          cleanedLocator: "x",
          intakeStatus: "normal",
          now: NOW,
        }),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdentityError);
    expect((err as IdentityError).code).toBe("identifier_text_mismatch");
  });
});
