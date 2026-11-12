// 任务 12：CLI 全集（design §9）。真实 MySQL + 假依赖；每个子命令的成功与拒绝路径、退出码、JSON 输出不含原文。
import { describe, expect, it } from "vitest";
import { useTestDb } from "../../tests/harness/db";
import { insertAccount } from "../../tests/harness/factories";
import { SIGNALS_T0 as T0, seedContent } from "../../tests/harness/signals";
import { createWorld, drain, makeSubject, png, type World } from "../../tests/harness/signals-world";
import { CAP_ACCOUNT_READ, CAP_CONTENT_READ, CAP_SCORE_REQUEST, CAP_SEGMENT_MANAGE, CAP_SEGMENT_READ, type SignalActor } from "../modules/signals";
import { runSignalsCli } from "./signals-cli";

const t = useTestDb();
const ALL = [CAP_SEGMENT_MANAGE, CAP_SEGMENT_READ, CAP_SCORE_REQUEST, CAP_CONTENT_READ, CAP_ACCOUNT_READ];
const actorOf = (caps: string[]): SignalActor => ({ actor: "user:ops", capabilities: new Set(caps), brandScope: "all" });
const SECRET_TITLE = "机密标题XYZ";

async function cli(w: World, argv: string[], o: { actor?: SignalActor; files?: Record<string, Uint8Array>; run?: () => Promise<void> } = {}) {
  let out = "";
  let err = "";
  const code = await runSignalsCli(argv, {
    signals: w.signals,
    actor: o.actor ?? actorOf(ALL),
    readFile: (p) => o.files?.[p] ?? (() => { throw new Error(`ENOENT ${p}`); })(),
    ...(o.run ? { run: o.run } : {}),
    stdout: (s) => void (out += s),
    stderr: (s) => void (err += s),
  });
  return { code, out, err, json: out ? (JSON.parse(out.trim()) as Record<string, any>) : undefined };
}

describe("segment：创建 → 设条目 → 传图 → 检查 → 发布 → 新草稿 → 删图 → 清除", () => {
  it("完整流程；已发布后写入被拒；purge 没有 --apply 不删任何东西", async () => {
    const w = await createWorld(t);
    const files = { "std.png": png("cli-standard") };
    expect((await cli(w, ["segment", "create", "--plan", "2", "--platform", "douyin"])).json).toMatchObject({ ok: true, segment: { planId: "2", version: 1 } });
    expect((await cli(w, ["segment", "set-items", "--plan", "2", "--version", "1", "--items", '[{"signal":"content.cover_template_score"}]'])).json).toMatchObject({ ok: true, items: [{ signal: "content.cover_template_score" }] });
    const noImage = await cli(w, ["segment", "check", "--plan", "2", "--version", "1"]);
    expect(noImage.json!.executability).toMatchObject({ executable: false, blockers: [{ code: "image_missing" }] });
    const put = await cli(w, ["segment", "put-image", "--plan", "2", "--version", "1", "--kind", "template", "--target", "cover", "--file", "std.png"], { files });
    expect(put.json).toMatchObject({ ok: true, image: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect((await cli(w, ["segment", "check", "--plan", "2", "--version", "1"])).json!.executability).toMatchObject({ executable: true, blockers: [] });
    expect((await cli(w, ["segment", "publish", "--plan", "2", "--version", "1"])).code).toBe(0);
    const frozen = await cli(w, ["segment", "set-items", "--plan", "2", "--version", "1", "--items", "[]"]);
    expect(frozen.code).toBe(3);
    expect(frozen.json).toMatchObject({ ok: false, error: { code: "segment_immutable" } });

    expect((await cli(w, ["segment", "new-draft", "--plan", "2", "--from-version", "1"])).json).toMatchObject({ ok: true, segment: { planId: "2", version: 2 } });
    expect((await cli(w, ["segment", "show", "--plan", "2", "--version", "2"])).json).toMatchObject({ ok: true });
    expect((await cli(w, ["segment", "remove-image", "--plan", "2", "--version", "2", "--kind", "template", "--target", "cover"])).code).toBe(0);
    expect((await cli(w, ["segment", "check", "--plan", "2", "--version", "2"])).json!.executability.executable).toBe(false);

    const noApply = await cli(w, ["segment", "purge", "--plan", "2"]);
    expect(noApply.code).toBe(2);
    expect((await cli(w, ["segment", "show", "--plan", "2", "--version", "1"])).code).toBe(0); // 还在
    expect((await cli(w, ["segment", "purge", "--plan", "2", "--apply"])).code).toBe(0);
    expect((await cli(w, ["segment", "show", "--plan", "2", "--version", "1"])).code).toBe(4);
  });

  it("拒绝路径：缺 Capability、参数不合法、目录外信号、文件不存在是内部错误", async () => {
    const w = await createWorld(t);
    expect((await cli(w, ["segment", "create", "--plan", "3", "--platform", "douyin"], { actor: actorOf([CAP_SEGMENT_READ]) })).json).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect((await cli(w, ["segment", "create", "--plan", "03", "--platform", "douyin"])).code).toBe(2);
    expect((await cli(w, ["segment", "put-image", "--plan", "1", "--version", "1", "--kind", "x", "--target", "cover", "--file", "a"])).code).toBe(2);
    expect((await cli(w, ["segment", "set-items", "--plan", "1", "--version", "1", "--items", "{bad"])).code).toBe(2);
    expect((await cli(w, ["segment", "set-items", "--plan", "1", "--version", "1", "--items", '[{"signal":"nope"}]'])).json).toMatchObject({ error: { code: "signal_unregistered" } });
    expect((await cli(w, ["segment"])).code).toBe(2);
    expect((await cli(w, ["segment", "bogus"])).code).toBe(2);
    const missing = await cli(w, ["segment", "put-image", "--plan", "1", "--version", "1", "--kind", "template", "--target", "cover", "--file", "nope.png"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("内部错误");
  });
});

describe("score 与 tasks", () => {
  it("score：按 ID 清单与文件提交；输出分布而不是逐主体；tasks list 看到任务；revive 非 dead 任务被拒", async () => {
    const w = await createWorld(t);
    const a = await makeSubject(t, "archived");
    const b = await makeSubject(t, "archived");
    const c = await makeSubject(t, "pending");
    const r = await cli(w, ["score", "--plan", "1", "--version", "1", "--contents", `${a.id},${b.id}`]);
    expect(r.json).toMatchObject({ ok: true, tasks: { created: 2, revived: 0, requeued: 0, reused: 0 }, items: [{ signal: "content.cover_template_score", dispositions: { queued: 2 } }], needMedia: [] });
    const viaFile = await cli(w, ["score", "--plan", "1", "--version", "1", "--contents", "ids.txt"], { files: { "ids.txt": new TextEncoder().encode(`${a.id}\n${b.id}, ${c.id}\n`) } });
    expect(viaFile.json).toMatchObject({ tasks: { created: 0, reused: 2 }, items: [{ dispositions: { queued: 2, missing: 1 } }] });
    expect(viaFile.json!.needMedia).toHaveLength(1);

    const list = await cli(w, ["tasks", "list"]);
    expect(list.json!.tasks).toHaveLength(2);
    expect(list.json!.tasks[0]).toMatchObject({ kind: "score_template", status: "pending" });
    expect((await cli(w, ["tasks", "list", "--status", "dead"])).json!.tasks).toEqual([]);
    expect((await cli(w, ["tasks", "list", "--status", "bogus"])).code).toBe(2);
    expect((await cli(w, ["tasks", "list", "--limit", "0"])).code).toBe(2);
    const revive = await cli(w, ["tasks", "revive", String(list.json!.tasks[0].taskId)]);
    expect(revive.code).toBe(3);
    expect(revive.json).toMatchObject({ error: { code: "task_not_dead" } });
    expect((await cli(w, ["tasks", "revive", "999999"])).code).toBe(4);
    expect((await cli(w, ["tasks", "revive"])).code).toBe(2);
    await drain(w);
    expect((await cli(w, ["tasks", "list", "--status", "succeeded"])).json!.tasks).toHaveLength(2);
  });

  it("score 的参数：--contents 与 --accounts 恰有一个；缺 rule.run.execute 被拒；监控段不存在 → 4", async () => {
    const w = await createWorld(t);
    expect((await cli(w, ["score", "--plan", "1", "--version", "1"])).code).toBe(2);
    expect((await cli(w, ["score", "--plan", "1", "--version", "1", "--contents", "1", "--accounts", "1"])).code).toBe(2);
    expect((await cli(w, ["score", "--plan", "1", "--version", "1", "--contents", "1"], { actor: actorOf([CAP_SEGMENT_READ]) })).json).toMatchObject({ error: { code: "forbidden" } });
    expect((await cli(w, ["score", "--plan", "9", "--version", "1", "--contents", "1"])).code).toBe(4);
    expect((await cli(w, ["tasks", "list"], { actor: actorOf([CAP_SEGMENT_READ]) })).json).toMatchObject({ error: { code: "forbidden" } });
  });
});

describe("recompute", () => {
  it("preview 不写表；没有范围 / 未知键被拒（没有 --all）；apply 建 run；cancel 一次成功、再次 run_not_cancellable", async () => {
    const w = await createWorld(t);
    const acct = await insertAccount(t.db, "douyin", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "rc", title: SECRET_TITLE });
    await cli(w, ["scan", "--once"]);
    const scope = JSON.stringify({ contentIds: [String(c.contentId)] });
    const pv = await cli(w, ["recompute", "preview", "--signal", "text.title_normalized", "--scope", scope]);
    expect(pv.json).toMatchObject({ ok: true, preview: { signal: "text.title_normalized", count: 1 } });
    expect(pv.out).not.toContain(SECRET_TITLE);

    expect((await cli(w, ["recompute", "preview", "--signal", "text.title_normalized", "--scope", "{}"])).json).toMatchObject({ error: { code: "scope_required" } });
    expect((await cli(w, ["recompute", "apply", "--signal", "text.title_normalized", "--scope", '{"all":true}'])).code).toBe(2);
    expect((await cli(w, ["recompute", "apply", "--signal", "text.title_normalized"])).code).toBe(2);
    expect((await cli(w, ["recompute", "apply", "--signal", "text.title_normalized", "--scope", "[1]"])).code).toBe(2);
    expect((await cli(w, ["recompute", "--all"])).code).toBe(2);
    expect((await cli(w, ["recompute", "apply", "--signal", "text.title_normalized", "--scope", scope], { actor: actorOf([CAP_SEGMENT_READ]) })).json).toMatchObject({ error: { code: "forbidden" } });

    const ap = await cli(w, ["recompute", "apply", "--signal", "text.title_normalized", "--scope", scope]);
    expect(ap.json).toMatchObject({ ok: true, run: { runId: expect.stringMatching(/^\d+$/), resumed: false, count: 1 } });
    const runId = ap.json!.run.runId as string;
    expect((await cli(w, ["recompute", "cancel", "--run", runId])).code).toBe(0);
    const again = await cli(w, ["recompute", "cancel", "--run", runId]);
    expect(again.code).toBe(3);
    expect(again.json).toMatchObject({ error: { code: "run_not_cancellable" } });
    expect((await cli(w, ["recompute", "cancel", "--run", "999"])).code).toBe(4);
  });
});

describe("scan / reconcile / retention", () => {
  it("需要 --once 与 rule.definition.manage；扫描后特征行可读；输出只有计数", async () => {
    const w = await createWorld(t);
    const acct = await insertAccount(t.db, "douyin", T0);
    const c = await seedContent(t.db, { accountId: acct, pcid: "sc", title: SECRET_TITLE });
    expect((await cli(w, ["scan"])).code).toBe(2);
    expect((await cli(w, ["scan", "--once"], { actor: actorOf([CAP_SEGMENT_READ]) })).json).toMatchObject({ error: { code: "forbidden" } });
    const scan = await cli(w, ["scan", "--once"]);
    expect(scan.json).toMatchObject({ ok: true, contents: { scanned: 1, created: 1 }, comments: { scanned: 0 } });
    expect(scan.out).not.toContain(SECRET_TITLE);
    expect((await cli(w, ["show", "--content", String(c.contentId)])).json!.signals.find((s: { signal: string }) => s.signal === "text.title_normalized")).toMatchObject({ state: "valid" });
    expect((await cli(w, ["reconcile", "--once"])).json).toMatchObject({ ok: true, reconcile: { scanned: 0, wrapped: true } }); // 对账只补缺失的，此时没有缺失
    expect((await cli(w, ["retention", "--once"])).json).toMatchObject({ ok: true, retention: { results: 0, history: 0, tasks: 0, completed: true } });
  });
});

describe("run 与严格解析", () => {
  it("run 调用常驻循环；没有装配时是配置错误；多余参数被拒", async () => {
    const w = await createWorld(t);
    let called = 0;
    expect((await cli(w, ["run"], { run: async () => void called++ })).code).toBe(0);
    expect(called).toBe(1);
    expect((await cli(w, ["run"])).code).toBe(1);
    expect((await cli(w, ["run", "--force"], { run: async () => undefined })).code).toBe(2);
    expect((await cli(w, ["run"], { run: async () => undefined, actor: actorOf([CAP_SEGMENT_READ]) })).json).toMatchObject({ error: { code: "forbidden" } });
  });
  it("没有 --force / --skip-auth 旁路", async () => {
    const w = await createWorld(t);
    for (const flag of ["--force", "--skip-auth"]) {
      expect((await cli(w, ["segment", "publish", "--plan", "1", "--version", "1", flag])).code, flag).toBe(2);
      expect((await cli(w, ["score", "--plan", "1", "--version", "1", "--contents", "1", flag])).code, flag).toBe(2);
    }
  });
});
