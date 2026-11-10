// access CLI（任务 11；AX-12）：退出码、JSON、缺身份、--apply 语义、没有旁路。用真实装配（access-wiring）+ 真实测试库。
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { accessEnv, insertAccessUser, seedAccessOrg, type AccessEnv, type AccessOrg } from "../../tests/harness/access";
import { useTestDb } from "../../tests/harness/db";
import { accessUsers, auditEvents, importBatches } from "../db/schema";
import { runAccessCli } from "./access-cli";
import { buildAccessCliDeps } from "./access-wiring";

const t = useTestDb();
let env: AccessEnv;
let org: AccessOrg;
let files: Map<string, Uint8Array>;
let written: Map<string, string>;

beforeEach(async () => {
  env = accessEnv(t);
  org = await seedAccessOrg(env);
  files = new Map();
  written = new Map();
});

interface Out {
  code: number;
  json: Array<Record<string, unknown>>;
  stderr: string;
}
async function run(argv: string[], actorId?: string, internal?: (e: unknown) => void): Promise<Out> {
  const out: string[] = [];
  let err = "";
  const code = await runAccessCli(
    argv,
    buildAccessCliDeps({
      db: t.db,
      clock: env.clock,
      actorId,
      io: {
        readFile: (p) => {
          const f = files.get(p);
          if (!f) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          return f;
        },
        writeFile: (p, c) => void written.set(p, c),
        stdout: (s) => void out.push(s),
        stderr: (s) => void (err += s),
        ...(internal ? { onInternalError: internal } : {}),
      },
    }),
  );
  return { code, json: out.join("").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>), stderr: err };
}
const first = (o: Out) => o.json[0]!;
const err = (o: Out) => (first(o).error as { code: string }).code;

async function admin() {
  const id = await insertAccessUser(env, { role: "platform_admin", phone: "13000000001" });
  return { id, actor: `user:${id}` };
}

describe("身份", () => {
  it("需要身份的命令缺 HBECHO_ACCESS_ACTOR → 启动失败（退出码 1），不退化成任何默认身份", async () => {
    const r = await run(["user", "list"]);
    expect(r.code).toBe(1);
    expect(err(r)).toBe("actor_missing");
  });

  it("身份必须是 user:<id>；服务身份不能管理用户；用户必须有效", async () => {
    expect(err(await run(["user", "list"], "service:plan-worker"))).toBe("actor_invalid");
    expect(err(await run(["user", "list"], "user:999999"))).toBe("actor_not_active");
    const dis = await insertAccessUser(env, { role: "platform_admin", phone: "13000000009", status: "disabled" });
    expect(await run(["user", "list"], `user:${dis}`)).toMatchObject({ code: 2 });
  });

  it("角色与范围从数据库现算：分公司人员即使知道命令也建不了总部", async () => {
    const bm = await insertAccessUser(env, { role: "branch_manager", phone: "13000000003", brandIds: [org.hisense], branchIds: [org.bj] });
    const r = await run(["user", "invite", "--name", "甲", "--role", "总部人员", "--phone", "13911110001", "--brand", "HISENSE", "--apply"], `user:${bm}`);
    expect(r.code).toBe(2);
    expect(err(r)).toBe("role_not_grantable");
    expect(await t.db.select().from(accessUsers).where(eq(accessUsers.phone, "13911110001"))).toHaveLength(0);
  });
});

describe("首个超管（不需要身份，只要数据库凭证）", () => {
  it("token create → bootstrap-superadmin；令牌只显示一次；再用被拒", async () => {
    const tok = await run(["token", "create"]);
    expect(tok.code).toBe(0);
    const token = first(tok).token as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ok = await run(["bootstrap-superadmin", "--token", token, "--phone", "13000000001", "--name", "首个超管"]);
    expect(ok.code).toBe(0);
    expect(first(ok)).toMatchObject({ ok: true, userId: expect.stringMatching(/^\d+$/) });
    const again = await run(["bootstrap-superadmin", "--token", token, "--phone", "13000000002", "--name", "二"]);
    expect(again.code).toBe(2);
    expect(err(again)).toBe("token_used");
    expect(await run(["bootstrap-superadmin", "--phone", "13000000002", "--name", "二"])).toMatchObject({ code: 2 }); // 缺 --token
  });
});

describe("--apply 语义", () => {
  it("invite：不带 --apply 只预览（库无变化，含手机号占用提示）；带 --apply 才创建", async () => {
    const a = await admin();
    const before = (await t.db.select().from(accessUsers)).length;
    const args = ["user", "invite", "--name", "甲", "--role", "总部人员", "--phone", "139 1111 0001", "--brand", "HISENSE,HITACHI"];
    const p = await run(args, a.actor);
    expect(p.code).toBe(0);
    expect(first(p)).toMatchObject({ ok: true, applied: false, preview: { role: "hq_manager", phone: "13911110001", phoneExists: false } });
    expect((await t.db.select().from(accessUsers)).length).toBe(before);
    const x = await run([...args, "--apply"], a.actor);
    expect(first(x)).toMatchObject({ ok: true, applied: true, userId: expect.stringMatching(/^\d+$/) });
    expect((await t.db.select().from(accessUsers)).length).toBe(before + 1);
    // 同号再预览：提示已被占用
    expect(first(await run(args, a.actor)).preview).toMatchObject({ phoneExists: true });
  });

  it("change / disable / restore / force-logout：不带 --apply 无变化；带 --apply 生效", async () => {
    const a = await admin();
    const u = await insertAccessUser(env, { role: "branch_manager", phone: "13000000003", name: "原名", brandIds: [org.hisense], branchIds: [org.bj] });
    const status = async () => (await t.db.select().from(accessUsers).where(eq(accessUsers.userId, u)))[0]!;
    expect(first(await run(["user", "change", String(u), "--name", "新名"], a.actor))).toMatchObject({ applied: false });
    expect((await status()).displayName).toBe("原名");
    expect(first(await run(["user", "change", String(u), "--name", "新名", "--apply"], a.actor))).toMatchObject({ applied: true });
    expect((await status()).displayName).toBe("新名");

    await run(["user", "disable", String(u)], a.actor);
    expect((await status()).status).toBe("active");
    expect(first(await run(["user", "disable", String(u), "--apply"], a.actor))).toMatchObject({ applied: true, changed: true });
    expect((await status()).status).toBe("disabled");
    await run(["user", "restore", String(u)], a.actor);
    expect((await status()).status).toBe("disabled");
    expect(first(await run(["user", "restore", String(u), "--apply"], a.actor))).toMatchObject({ applied: true, status: "active", removedBrandIds: [], removedBranchIds: [] });
    expect(first(await run(["user", "force-logout", String(u)], a.actor))).toMatchObject({ applied: false });
    expect(first(await run(["user", "force-logout", String(u), "--apply"], a.actor))).toMatchObject({ applied: true, revoked: 0 });
  });

  it("越界对象预览也是「不存在」（退出码 4），不暴露其存在", async () => {
    const bm = await insertAccessUser(env, { role: "branch_manager", phone: "13000000003", brandIds: [org.hisense], branchIds: [org.bj] });
    const other = await insertAccessUser(env, { role: "store_staff", phone: "13800000003", mediaStaffId: org.staffC }); // 上海店
    const r = await run(["user", "disable", String(other)], `user:${bm}`);
    expect(r.code).toBe(4);
    expect(err(r)).toBe("user_not_found");
  });

  it("导入：precheck 不写用户；confirm 不带 --apply 只预览；带 --apply 才写；report 写出回流文件", async () => {
    const a = await admin();
    const csv = ["姓名,角色,手机号,品牌,分公司,门店编码", "甲,总部人员,13911110001,HISENSE,,", "乙,老板,13911110002,HISENSE,,"].join("\r\n") + "\r\n";
    files.set("/tmp/u.csv", new TextEncoder().encode(csv));
    const before = (await t.db.select().from(accessUsers)).length;
    const pre = await run(["user", "import", "precheck", "--file", "/tmp/u.csv"], a.actor);
    expect(pre.code).toBe(0);
    expect(first(pre)).toMatchObject({ ok: true, totalRows: 2, newRows: 1, errorRows: 1, status: "awaiting_confirm" });
    expect((await t.db.select().from(accessUsers)).length).toBe(before);
    const batch = first(pre).batchId as string;

    const pv = await run(["user", "import", "confirm", "--batch", batch], a.actor);
    expect(first(pv)).toMatchObject({ applied: false });
    expect((await t.db.select().from(accessUsers)).length).toBe(before);
    expect((await t.db.select().from(importBatches))[0]!.status).toBe("awaiting_confirm");

    const done = await run(["user", "import", "confirm", "--batch", batch, "--apply"], a.actor);
    expect(first(done)).toMatchObject({ ok: true, applied: true, status: "completed" });
    expect((await t.db.select().from(accessUsers)).length).toBe(before + 1);

    expect(first(await run(["user", "import", "batches"], a.actor)).batches).toHaveLength(1);
    expect(first(await run(["user", "import", "rows", batch], a.actor)).rows).toHaveLength(2);
    const rep = await run(["user", "import", "report", batch, "--out", "/tmp/r.csv"], a.actor);
    expect(first(rep)).toMatchObject({ ok: true, rows: 1, out: "/tmp/r.csv" });
    expect(written.get("/tmp/r.csv")).toContain("role_invalid");
  });

  it("导入文件级失败 → 退出码 2、无批次；找不到文件 → 退出码 2", async () => {
    const a = await admin();
    files.set("/tmp/bad.csv", new TextEncoder().encode("a,b\r\n1,2\r\n"));
    const r = await run(["user", "import", "precheck", "--file", "/tmp/bad.csv"], a.actor);
    expect(r.code).toBe(2);
    expect(err(r)).toBe("header_mismatch");
    expect(await t.db.select().from(importBatches)).toHaveLength(0);
    expect(err(await run(["user", "import", "precheck", "--file", "/tmp/none.csv"], a.actor))).toBe("file_not_found");
  });
});

describe("读取", () => {
  it("user list / show 输出 JSON，BIGINT 为十进制字符串", async () => {
    const a = await admin();
    const u = await insertAccessUser(env, { role: "hq_manager", phone: "13000000002", brandIds: [org.hisense] });
    const list = first(await run(["user", "list", "--role", "总部人员"], a.actor)).users as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ userId: String(u), role: "hq_manager", brandIds: [String(org.hisense)], manageable: true });
    expect(first(await run(["user", "show", String(u)], a.actor)).user).toMatchObject({ userId: String(u) });
    expect(err(await run(["user", "list", "--status", "weird"], a.actor))).toBe("invalid_input");
  });

  it("audit list：超管可读，总部被拒（退出码 2）", async () => {
    const a = await admin();
    const hq = await insertAccessUser(env, { role: "hq_manager", phone: "13000000002", brandIds: [org.hisense] });
    await run(["user", "invite", "--name", "甲", "--role", "总部人员", "--phone", "13911110001", "--brand", "HISENSE", "--apply"], a.actor);
    const ok = await run(["audit", "list", "--event-type", "user_created", "--limit", "10"], a.actor);
    expect(ok.code).toBe(0);
    expect((first(ok).events as unknown[]).length).toBe(1);
    const denied = await run(["audit", "list"], `user:${hq}`);
    expect(denied.code).toBe(2);
    expect(err(denied)).toBe("forbidden");
    expect(await t.db.select().from(auditEvents)).not.toHaveLength(0);
  });

  it("maintain 跑一轮并报告", async () => {
    const r = await run(["maintain"]);
    expect(r.code).toBe(0);
    expect(first(r)).toMatchObject({ ok: true, report: { failedSteps: [] } });
  });
});

describe("没有旁路与错误处理", () => {
  it("没有 --force / --skip-auth / --as：未知选项一律退出码 2，且不改变任何数据", async () => {
    const a = await admin();
    const before = (await t.db.select().from(accessUsers)).length;
    for (const extra of ["--force", "--skip-auth", "--as", "--no-check"]) {
      const r = await run(["user", "invite", "--name", "甲", "--role", "总部人员", "--phone", "13911110001", "--brand", "HISENSE", "--apply", extra], a.actor);
      expect(r.code).toBe(2);
      expect(err(r)).toBe("invalid_input");
    }
    expect((await t.db.select().from(accessUsers)).length).toBe(before);
  });

  it("未知子命令 → 2；品牌编码不存在 → 2；用户 ID 不是数字 → 2", async () => {
    const a = await admin();
    expect(err(await run(["nope"], a.actor))).toBe("invalid_input");
    expect(err(await run(["user", "nope"], a.actor))).toBe("invalid_input");
    expect(err(await run(["user", "invite", "--name", "甲", "--role", "总部人员", "--phone", "13911110001", "--brand", "NOPE"], a.actor))).toBe("brand_not_found");
    expect(err(await run(["user", "show", "abc"], a.actor))).toBe("invalid_input");
  });

  it("内部错误 → 退出码 1，对外只说内部错误；详情给 onInternalError", async () => {
    const a = await admin();
    let seen: unknown = null;
    const out: string[] = [];
    const deps = buildAccessCliDeps({ db: t.db, clock: env.clock, actorId: a.actor, io: { readFile: () => new Uint8Array(), writeFile: () => {}, stdout: (s) => void out.push(s), stderr: () => {}, onInternalError: (e) => void (seen = e) } });
    deps.admin = { ...deps.admin, list: async () => { throw new Error("db password=hunter2 leaked?"); } };
    const code = await runAccessCli(["user", "list"], deps);
    expect(code).toBe(1);
    expect(out.join("")).toContain("internal_error");
    expect(out.join("")).not.toContain("hunter2");
    expect(seen).toBeInstanceOf(Error);
  });
});
