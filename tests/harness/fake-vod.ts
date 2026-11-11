import type { VodClient, VodUploadTicket, VodVideoInfo } from "../../src/modules/learning/vod";

/** 内存版 VOD，记录调用便于断言（模板组、播放凭证次数、删除次数）。 */
export class FakeVod implements VodClient {
  readonly videos = new Map<string, VodVideoInfo & { title: string; createdAt: Date }>();
  readonly uploads: Array<{ title: string; fileName: string; fileSize: number }> = [];
  readonly playAuthCalls: string[] = [];
  readonly deleted: string[] = [];
  readonly titleUpdates: Array<{ videoId: string; title: string }> = [];
  failNext: Partial<Record<"createUpload" | "getVideo" | "getPlayAuth" | "deleteVideo" | "updateTitle" | "listVideosBefore", number>> = {};
  now: () => Date = () => new Date();
  private seq = 0;

  private maybeFail(op: keyof FakeVod["failNext"]): void {
    const n = this.failNext[op] ?? 0;
    if (n > 0) {
      this.failNext[op] = n - 1;
      throw new Error(`fake vod: ${op} 失败（注入）`);
    }
  }
  /** 测试直接造一个 VOD 里已有的视频。 */
  add(info: Partial<VodVideoInfo> & { videoId?: string; title?: string; createdAt?: Date } = {}): string {
    const videoId = info.videoId ?? `${String(++this.seq).padStart(32, "0")}`;
    this.videos.set(videoId, { status: info.status ?? "normal", durationSec: info.durationSec === undefined ? 600 : info.durationSec, sizeBytes: info.sizeBytes === undefined ? 1_000_000 : info.sizeBytes, title: info.title ?? "", createdAt: info.createdAt ?? this.now() });
    return videoId;
  }
  async createUpload(input: { title: string; fileName: string; fileSize: number }): Promise<VodUploadTicket> {
    this.maybeFail("createUpload");
    this.uploads.push(input);
    const videoId = this.add({ status: "uploading", durationSec: null, sizeBytes: null, title: input.title });
    return { videoId, uploadAddress: "fake-address", uploadAuth: "fake-auth" };
  }
  async getVideo(videoId: string): Promise<VodVideoInfo | null> {
    this.maybeFail("getVideo");
    const v = this.videos.get(videoId);
    return v ? { status: v.status, durationSec: v.durationSec, sizeBytes: v.sizeBytes } : null;
  }
  async getPlayAuth(videoId: string): Promise<{ playAuth: string }> {
    this.maybeFail("getPlayAuth");
    this.playAuthCalls.push(videoId);
    return { playAuth: `play-auth-for-${videoId}` };
  }
  async deleteVideo(videoId: string): Promise<void> {
    this.maybeFail("deleteVideo");
    this.videos.delete(videoId);
    this.deleted.push(videoId);
  }
  async updateTitle(videoId: string, title: string): Promise<void> {
    this.maybeFail("updateTitle");
    this.titleUpdates.push({ videoId, title });
    const v = this.videos.get(videoId);
    if (v) v.title = title;
  }
  async listVideosBefore(createdBefore: Date): Promise<Array<{ videoId: string; createdAt: Date }>> {
    this.maybeFail("listVideosBefore");
    return [...this.videos].filter(([, v]) => v.createdAt < createdBefore).map(([videoId, v]) => ({ videoId, createdAt: v.createdAt }));
  }
}
