import type { CourseObjectStore } from "../../src/modules/learning/store";

/** 内存版 `hbecho-course` 桶，记录签名与删除，便于断言。 */
export class FakeCourseStore implements CourseObjectStore {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string; at: Date }>();
  /** 使 delete 对匹配的 key 抛错（验证删除失败进重试）。 */
  failDelete: ((key: string) => boolean) | null = null;
  now: () => Date = () => new Date();
  readonly signedPut: Array<{ key: string; contentType: string; ttlSeconds: number }> = [];
  readonly signedGet: Array<{ key: string; ttlSeconds: number; downloadName?: string }> = [];
  readonly deleted: string[] = [];
  failSignGet = false;

  /** 模拟浏览器按签名地址直传。 */
  upload(key: string, bytes: Uint8Array, contentType: string): void {
    this.objects.set(key, { bytes: bytes.slice(), contentType, at: this.now() });
  }
  async signedPutUrl(key: string, contentType: string, ttlSeconds: number): Promise<string> {
    this.signedPut.push({ key, contentType, ttlSeconds });
    return `https://fake-course.test/${key}?put&ttl=${ttlSeconds}`;
  }
  async head(key: string) {
    const o = this.objects.get(key);
    return o ? { size: o.bytes.byteLength, contentType: o.contentType } : null;
  }
  async getRange(key: string, start: number, endInclusive: number) {
    return this.objects.get(key)?.bytes.slice(start, endInclusive + 1) ?? null;
  }
  failGetObject = false;
  async getObject(key: string) {
    if (this.failGetObject) throw new Error("fake course store: getObject 失败（注入）");
    const o = this.objects.get(key);
    if (!o) return null;
    const bytes = o.bytes.slice();
    return { size: bytes.byteLength, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }) };
  }
  async signedGetUrl(key: string, ttlSeconds: number, opts: { downloadName?: string } = {}) {
    if (this.failSignGet) throw new Error("fake course store: 签名失败（注入）");
    this.signedGet.push({ key, ttlSeconds, ...(opts.downloadName === undefined ? {} : { downloadName: opts.downloadName }) });
    return `https://fake-course.test/${key}?ttl=${ttlSeconds}`;
  }
  async delete(key: string): Promise<void> {
    if (this.failDelete?.(key)) throw new Error(`fake course store: delete 失败（注入）：${key}`);
    this.objects.delete(key);
    this.deleted.push(key);
  }
  async list(prefix: string) {
    return [...this.objects].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, lastModified: v.at }));
  }
}

/** 带正确文件头的最小样例字节。 */
export const SAMPLE = {
  pdf: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25]),
  jpg: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
  png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
  /** Windows 可执行文件头 "MZ"，用来伪装成 PDF。 */
  exe: new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]),
};
