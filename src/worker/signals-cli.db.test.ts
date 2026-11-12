import { describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { FakeClock } from "../../tests/harness/fake-clock";
import { useTestDb } from "../../tests/harness/db";
import { insertAccount } from "../../tests/harness/factories";
import { QueryCounter, SIGNALS_T0 as T0, seedContent } from "../../tests/harness/signals";
import { CAP_ACCOUNT_READ, CAP_CONTENT_READ, DEFAULT_ENABLED_CAPABILITIES, createReader, scanContents, type SignalActor } from "../modules/signals";
import { runSignalsCli } from "./signals-cli";

const t = useTestDb();
const clock = new FakeClock(new Date("2026-11-12T03:00:00.000Z"));
const enabled = new Set(DEFAULT_ENABLED_CAPABILITIES);
const actorOf = (caps: string[]): SignalActor => ({ actor: "service:test", capabilities: new Set(caps), brandScope: "all" });

async function run(argv: string[], actor = actorOf([CAP_CONTENT_READ, CAP_ACCOUNT_READ]), counter?: QueryCounter) {
  let out = "";
  let err = "";
  const db = counter ? createDb(t.pool, { logger: counter }) : t.db;
  const code = await runSignalsCli(argv, { reader: createReader({ db, enabled }), actor, enabled, stdout: (s) => void (out += s), stderr: (s) => void (err += s) });
  return { code, json: out ? (JSON.parse(out.trim()) as Record<string, any>) : undefined, err };
}

describe("signals catalog", () => {
  it("列出目录；--platform 过滤；快手不含 account.* 与 comment.*；每个能力带版本与启用状态", async () => {
    const all = await run(["catalog"]);
    expect(all.code).toBe(0);
    expect(all.json!.signals).toHaveLength(12);
    const ks = await run(["catalog", "--platform", "kuaishou"]);
    const keys = ks.json!.signals.map((s: { signal: string }) => s.signal);
    expect(keys.filter((k: string) => /^(account|comment)\./.test(k))).toEqual([]);
    const tags = ks.json!.signals.find((s: { signal: string }) => s.signal === "text.hashtags");
    expect(tags.capabilities).toEqual([{ id: "text.hashtags.kuaishou", version: 1, enabled: true }]);
    const img = (await run(["catalog", "--object", "content"])).json!.signals.find((s: { signal: string }) => s.signal === "content.cover_template_score");
    expect(img.capabilities).toEqual([{ id: "image.template", version: 1, enabled: false }]); // 默认只启用文本类
  });
  it("参数不合法 → 退出码 2", async () => {
    expect((await run(["catalog", "--object", "x"])).code).toBe(2);
    expect((await run(["catalog", "--nope"])).code).toBe(2);
    expect((await run([])).code).toBe(2);
    expect((await run(["frobnicate"])).code).toBe(2);
  });
});

describe("signals show（第一条纵向的演示）", () => {
  it("内容：推进 current → 扫描 → show 看到话题与归一化标题，版本与时间齐全；参数化信号只列名字", async () => {
    const acct = await insertAccount(t.db, "douyin", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "a", title: "ＨＩＴＡＣＨＩ　空调", tagText: "#日立 #618" });
    await scanContents({ db: t.db, clock, config: { scanBatch: 10, lookbackMs: 60_000 } });
    const r = await run(["show", "--content", String(c.contentId)]);
    expect(r.code).toBe(0);
    const by = Object.fromEntries(r.json!.signals.map((s: { signal: string }) => [s.signal, s]));
    expect(by["text.title_normalized"]).toMatchObject({ state: "valid", value: "hitachi 空调", normalizerVersion: 1, capability: { id: "text.normalize", version: 1 }, producedAt: clock.now().toISOString() });
    expect(by["text.hashtags"]).toMatchObject({ state: "valid", value: ["日立", "618"], capability: { id: "text.hashtags.douyin", version: 1 } });
    expect(by["content.asr_text"]).toMatchObject({ state: "missing", reason: "audio_not_archived" });
    expect(r.json!.requiresParam).toEqual(["content.cover_template_score", "content.cover_element_score", "content.asr_judgement"]);
    expect(r.json!.subject).toEqual({ kind: "content", id: String(c.contentId) });
  });
  it("账号 ID 超过 2^53 时输出为十进制字符串；账号没有当前主页快照 → missing", async () => {
    const big = 9007199254740993n;
    await insertAccount(t.db, "douyin", T0, big);
    const r = await run(["show", "--account", String(big)]);
    expect(r.code).toBe(0);
    expect(r.json!.subject.id).toBe("9007199254740993");
    expect(r.json!.requiresParam).toHaveLength(4);
  });
  it("缺 Capability → 退出码 2，且一次查询都没有发出", async () => {
    const counter = new QueryCounter();
    const r = await run(["show", "--content", "1"], actorOf([CAP_ACCOUNT_READ]), counter);
    expect([r.code, r.json!.error.code, counter.count]).toEqual([2, "forbidden", 0]);
  });
  it("不存在的对象 → 退出码 4；参数错误 → 2", async () => {
    expect((await run(["show", "--content", "999999"])).code).toBe(4);
    expect((await run(["show"])).code).toBe(2);
    expect((await run(["show", "--content", "1", "--account", "1"])).code).toBe(2);
    expect((await run(["show", "--content", "01"])).code).toBe(2);
    expect((await run(["show", "--content", "abc"])).code).toBe(2);
  });
});
