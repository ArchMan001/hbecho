import { createHash } from "node:crypto";
import type { ObjectStore, StoredObject } from "../../src/modules/raw-capture/ports";

/** 内存对象存储。故障注入（写失败、哈希不符、截断）在任务 3 按需加入。 */
export class FakeObjectStore implements ObjectStore {
  private readonly objects = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array): Promise<StoredObject> {
    const copy = bytes.slice();
    this.objects.set(key, copy);
    return { sha256: createHash("sha256").update(copy).digest("hex"), byteLength: copy.byteLength };
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key)?.slice() ?? null;
  }
}
