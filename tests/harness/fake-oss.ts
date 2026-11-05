import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Clock, MediaObjectStore, StoredObject } from "../../src/modules/raw-capture/ports";

export type OssFault = "fail" | "corrupt" | "truncate";

/**
 * 内存对象存储，带故障注入：
 *  - fail：put 抛错（写失败）；
 *  - corrupt：存下被改动的字节，返回的摘要是「实际存下的字节」的摘要（哈希不一致）；
 *  - truncate：只存前半（截断）。
 * 故障按 key 匹配、按次数消耗。
 */
export class FakeObjectStore implements MediaObjectStore {
  private readonly objects = new Map<string, { bytes: Uint8Array; createdAt: Date }>();
  private faults: Array<{ match: (key: string) => boolean; fault: OssFault; times: number }> = [];
  readonly deleted: string[] = [];
  failDelete: ((key: string) => boolean) | null = null;

  constructor(private readonly clock: Clock = { now: () => new Date() }) {}

  inject(match: (key: string) => boolean, fault: OssFault, times = 1): void {
    this.faults.push({ match, fault, times });
  }

  async put(key: string, bytes: Uint8Array): Promise<StoredObject> {
    let stored = bytes.slice();
    const f = this.faults.find((x) => x.times > 0 && x.match(key));
    if (f) {
      f.times--;
      if (f.fault === "fail") throw new Error(`fake oss: put 失败（注入）：${key}`);
      if (f.fault === "corrupt") {
        stored = stored.slice();
        stored[0] = (stored[0] ?? 0) ^ 0xff;
      }
      if (f.fault === "truncate") stored = stored.slice(0, Math.max(0, Math.floor(stored.length / 2)));
    }
    this.objects.set(key, { bytes: stored, createdAt: this.clock.now() });
    return { sha256: createHash("sha256").update(stored).digest("hex"), byteLength: stored.byteLength };
  }

  /** 视频：测试里文件不大（大文件测试直接断言上传的是文件而不是内存缓冲）；记录调用便于断言。 */
  readonly uploadedFiles: Array<{ key: string; path: string; byteLength: number }> = [];
  readonly signed: Array<{ key: string; ttlSeconds: number }> = [];
  async putFile(key: string, path: string): Promise<StoredObject> {
    const bytes = readFileSync(path);
    this.uploadedFiles.push({ key, path, byteLength: bytes.byteLength });
    return this.put(key, bytes);
  }
  async signedGetUrl(key: string, ttlSeconds: number): Promise<string> {
    this.signed.push({ key, ttlSeconds });
    return `https://fake-oss.test/${key}?ttl=${ttlSeconds}`;
  }
  async get(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key)?.bytes.slice() ?? null;
  }

  async delete(key: string): Promise<void> {
    if (this.failDelete?.(key)) throw new Error(`fake oss: delete 失败（注入）：${key}`);
    this.objects.delete(key);
    this.deleted.push(key);
  }

  async list(prefix: string): Promise<Array<{ key: string; createdAt: Date }>> {
    return [...this.objects].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, createdAt: v.createdAt }));
  }

  keys(prefix = ""): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  /** 测试用：直接改写已存对象（模拟存储侧被篡改）。 */
  tamper(key: string, bytes: Uint8Array): void {
    const cur = this.objects.get(key);
    if (cur) this.objects.set(key, { bytes: bytes.slice(), createdAt: cur.createdAt });
  }
}
