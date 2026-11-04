// OSS ObjectStore 的单元测试：假客户端，不联网。证明 put 的摘要来自实际提交的字节、
// 读回与删除的「不存在」语义、list 的分页与时间映射，以及错误信息不夹带凭证。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OssObjectStore, type OssClientLike } from "./oss-store";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const enc = (s: string) => new TextEncoder().encode(s);

interface Recorded {
  put: Array<{ name: string; bytes: Uint8Array }>;
  get: string[];
  del: string[];
  list: Array<Record<string, unknown>>;
}

function fake(over: Partial<OssClientLike> = {}) {
  const objects = new Map<string, Uint8Array>();
  const rec: Recorded = { put: [], get: [], del: [], list: [] };
  const client: OssClientLike = {
    async put(name, bytes) {
      rec.put.push({ name, bytes });
      objects.set(name, bytes);
      return {};
    },
    async get(name) {
      rec.get.push(name);
      const b = objects.get(name);
      if (!b) throw Object.assign(new Error("NoSuchKey"), { code: "NoSuchKey", status: 404 });
      return { content: Buffer.from(b) };
    },
    async delete(name) {
      rec.del.push(name);
      if (!objects.delete(name)) throw Object.assign(new Error("NoSuchKey"), { code: "NoSuchKey", status: 404 });
      return {};
    },
    async list(query) {
      rec.list.push(query);
      const all = [...objects.keys()].filter((k) => !query.prefix || k.startsWith(query.prefix)).sort();
      const after = query.marker ? all.filter((k) => k > query.marker!) : all;
      const page = after.slice(0, 2); // 强制分页
      return {
        objects: page.map((name) => ({ name, lastModified: "2026-11-04T12:00:00.000Z" })),
        isTruncated: after.length > page.length,
        nextMarker: page.at(-1) ?? "",
      };
    },
    ...over,
  };
  return { store: new OssObjectStore({ accessKeyId: "id", accessKeySecret: "secret", region: "cn-beijing", bucket: "hbecho-ods", client }), rec, objects };
}

describe("OssObjectStore", () => {
  it("put：返回实际提交字节的 SHA-256 与长度，键原样交给客户端（不做隐式前缀）", async () => {
    const { store, rec } = fake();
    const bytes = enc("hello");
    const out = await store.put("smoke/ods/20261104/request_body/x", bytes);
    expect(out).toEqual({ sha256: sha(bytes), byteLength: 5 });
    expect(rec.put[0]!.name).toBe("smoke/ods/20261104/request_body/x");
  });

  it("get：不存在返回 null，其余错误上抛", async () => {
    const { store } = fake();
    expect(await store.get("missing")).toBeNull();
    const { store: broken } = fake({
      async get() {
        throw Object.assign(new Error("AccessDenied: <secret>"), { code: "AccessDenied", status: 403 });
      },
    });
    await expect(broken.get("k")).rejects.toThrow("OSS get 失败（AccessDenied）");
    await expect(broken.get("k")).rejects.not.toThrow(/secret/);
  });

  it("delete：对象不存在也算成功（幂等）", async () => {
    const { store, rec } = fake();
    await expect(store.delete("never-existed")).resolves.toBeUndefined();
    expect(rec.del).toEqual(["never-existed"]);
  });

  it("list：按 marker 翻页、映射 lastModified、传对 prefix", async () => {
    const { store, rec, objects } = fake();
    for (const k of ["a/1", "a/2", "a/3", "a/4", "b/1"]) objects.set(k, enc(k));
    const out = await store.list("a/");
    expect(out.map((o) => o.key)).toEqual(["a/1", "a/2", "a/3", "a/4"]);
    expect(out[0]!.createdAt.toISOString()).toBe("2026-11-04T12:00:00.000Z");
    expect(rec.list.every((q) => q.prefix === "a/" && q["max-keys"] === 1000)).toBe(true);
    expect(rec.list).toHaveLength(2);
  });

  it("错误信息只留错误码，不夹带客户端 message 里的内容", async () => {
    const { store } = fake({
      async put() {
        throw Object.assign(new Error("InvalidAccessKeySecret: secretvalue"), { code: "InvalidAccessKeyId" });
      },
    });
    await expect(store.put("k", enc("x"))).rejects.toThrow("OSS put 失败（InvalidAccessKeyId）");
    await expect(store.put("k", enc("x"))).rejects.not.toThrow(/secretvalue/);
  });
});