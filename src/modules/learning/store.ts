// 课程资料的对象存储端口（`hbecho-course` 桶，design §3.6）。默认测试换入 tests/harness/fake-course-store.ts；
// 真实实现见 oss-course-store.ts，只在部署与已批准的 smoke 里出现。
export interface CourseObjectStore {
  /** 浏览器直传用的签名 PUT 地址；签名里绑定 Content-Type。 */
  signedPutUrl(key: string, contentType: string, ttlSeconds: number): Promise<string>;
  /** 对象元数据；不存在返回 null。 */
  head(key: string): Promise<{ size: number; contentType: string } | null>;
  /** 读取 [start, endInclusive] 字节（校验文件魔数用）；对象不存在返回 null。 */
  getRange(key: string, start: number, endInclusive: number): Promise<Uint8Array | null>;
  /** 以流读取整个对象（预览由本服务转发，见 playback.ts）；对象不存在返回 null。 */
  getObject(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>;
  /** 短期签名下载地址；给了 downloadName 就以附件形式下载。 */
  signedGetUrl(key: string, ttlSeconds: number, opts?: { downloadName?: string }): Promise<string>;
  /** 幂等：对象不存在也成功。 */
  delete(key: string): Promise<void>;
  /** 列出前缀下的对象与最后修改时间（残渣清理用）。 */
  list(prefix: string): Promise<Array<{ key: string; lastModified: Date }>>;
}
