// VodClient 的真实实现。错误一律去掉可能夹带凭证的原始 message，只保留可分类的错误码（同 oss-course-store.ts）。
import { mapVodStatus, VOD_ENDPOINT, VOD_REGION, VOD_TEMPLATE_GROUP_ID, type VodClient } from "./vod";

/** SDK 里本模块用到的那部分形状；单测注入同形的假 SDK。 */
export interface VodSdkLike {
  createUploadVideo(r: { title: string; fileName: string; fileSize: number; templateGroupId: string }): Promise<{ body?: { videoId?: string; uploadAddress?: string; uploadAuth?: string } }>;
  getVideoInfo(r: { videoId: string }): Promise<{ body?: { video?: { status?: string; duration?: number; size?: number } } }>;
  getVideoPlayAuth(r: { videoId: string }): Promise<{ body?: { playAuth?: string } }>;
  deleteVideo(r: { videoIds: string }): Promise<unknown>;
  updateVideoInfo(r: { videoId: string; title: string }): Promise<unknown>;
  getVideoList(r: { endTime: string; pageNo: number; pageSize: number; sortBy: string }): Promise<{ body?: { total?: number; videoList?: { video?: Array<{ videoId?: string; creationTime?: string }> } } }>;
}

export interface VodCredentials {
  accessKeyId: string;
  accessKeySecret: string;
}

function code(e: unknown): string {
  const c = (e as { code?: unknown })?.code;
  return typeof c === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(c) ? c : "unknown";
}
const notFound = (e: unknown): boolean => /NotFound/i.test(code(e));
const wrap = (e: unknown, op: string): Error => new Error(`VOD ${op} 失败（${code(e)}）`);
const isoUtc = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const PAGE = 100;

export function createVodClient(sdk: VodSdkLike): VodClient {
  return {
    async createUpload(input) {
      try {
        const b = (await sdk.createUploadVideo({ ...input, templateGroupId: VOD_TEMPLATE_GROUP_ID })).body;
        if (!b?.videoId || !b.uploadAddress || !b.uploadAuth) throw new Error("incomplete");
        return { videoId: b.videoId, uploadAddress: b.uploadAddress, uploadAuth: b.uploadAuth };
      } catch (e) {
        throw wrap(e, "CreateUploadVideo");
      }
    },
    async getVideo(videoId) {
      try {
        const v = (await sdk.getVideoInfo({ videoId })).body?.video;
        if (!v) return null;
        return { status: mapVodStatus(v.status), durationSec: typeof v.duration === "number" ? Math.ceil(v.duration) : null, sizeBytes: typeof v.size === "number" ? v.size : null };
      } catch (e) {
        if (notFound(e)) return null;
        throw wrap(e, "GetVideoInfo");
      }
    },
    async getPlayAuth(videoId) {
      try {
        const a = (await sdk.getVideoPlayAuth({ videoId })).body?.playAuth;
        if (!a) throw new Error("incomplete");
        return { playAuth: a };
      } catch (e) {
        throw wrap(e, "GetVideoPlayAuth");
      }
    },
    async deleteVideo(videoId) {
      try {
        await sdk.deleteVideo({ videoIds: videoId });
      } catch (e) {
        if (notFound(e)) return;
        throw wrap(e, "DeleteVideo");
      }
    },
    async updateTitle(videoId, title) {
      try {
        await sdk.updateVideoInfo({ videoId, title });
      } catch (e) {
        throw wrap(e, "UpdateVideoInfo");
      }
    },
    async listVideosBefore(createdBefore) {
      const out: Array<{ videoId: string; createdAt: Date }> = [];
      try {
        for (let pageNo = 1; ; pageNo++) {
          const b = (await sdk.getVideoList({ endTime: isoUtc(createdBefore), pageNo, pageSize: PAGE, sortBy: "CreationTime:Asc" })).body;
          const list = b?.videoList?.video ?? [];
          for (const v of list) if (v.videoId && v.creationTime) out.push({ videoId: v.videoId, createdAt: new Date(v.creationTime) });
          if (list.length < PAGE || pageNo * PAGE >= (b?.total ?? 0)) return out;
        }
      } catch (e) {
        throw wrap(e, "GetVideoList");
      }
    },
  };
}

/** 构造真实 SDK 客户端（首次调用时才加载 SDK）。 */
export async function createAliyunVodClient(cred: VodCredentials): Promise<VodClient> {
  const m = await import("@alicloud/vod20170321");
  // SDK 构造函数只读取这几个普通属性，类型上要求 Config 实例，在这一处收口（同 sms-aliyun.ts）
  const sdk = new m.default({ accessKeyId: cred.accessKeyId, accessKeySecret: cred.accessKeySecret, endpoint: VOD_ENDPOINT, regionId: VOD_REGION } as never);
  return createVodClient({
    createUploadVideo: (r) => sdk.createUploadVideo(new m.CreateUploadVideoRequest(r)),
    getVideoInfo: (r) => sdk.getVideoInfo(new m.GetVideoInfoRequest(r)),
    getVideoPlayAuth: (r) => sdk.getVideoPlayAuth(new m.GetVideoPlayAuthRequest(r)),
    deleteVideo: (r) => sdk.deleteVideo(new m.DeleteVideoRequest(r)),
    updateVideoInfo: (r) => sdk.updateVideoInfo(new m.UpdateVideoInfoRequest(r)),
    getVideoList: (r) => sdk.getVideoList(new m.GetVideoListRequest(r)),
  } as VodSdkLike);
}
