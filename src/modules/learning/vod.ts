// 阿里云 VOD 端口（ADR-0007）。默认测试换入 tests/harness/fake-vod.ts；真实实现（官方 SDK @alicloud/vod20170321，ADR-0017）
// 只在部署与已批准的 smoke 里出现。
// 地域与模板组是写进代码的常量：VOD 默认模板组是 NoTranscode，不显式传就不转码（ADR-0007 §3）；
// 媒资相关调用必须用 cn-beijing，用 cn-shanghai 会静默失败。
export const VOD_REGION = "cn-beijing";
export const VOD_ENDPOINT = "vod.cn-beijing.aliyuncs.com";
export const VOD_TEMPLATE_GROUP_ID = "3ca24a90956dbbfa16f1f6cf2fe6ad3a";

export type VodVideoStatus = "uploading" | "transcoding" | "normal" | "failed";

export interface VodUploadTicket {
  videoId: string;
  /** base64 的 JSON：Endpoint / Bucket / FileName，交给浏览器上传。 */
  uploadAddress: string;
  /** base64 的 JSON：临时凭证，交给浏览器上传。 */
  uploadAuth: string;
}
export interface VodVideoInfo {
  status: VodVideoStatus;
  /** 秒，向上取整；转码前可能还没有。 */
  durationSec: number | null;
  sizeBytes: number | null;
}

export interface VodClient {
  /** 取上传凭证；必须带转码模板组。 */
  createUpload(input: { title: string; fileName: string; fileSize: number }): Promise<VodUploadTicket>;
  /** 视频不存在返回 null。 */
  getVideo(videoId: string): Promise<VodVideoInfo | null>;
  /** 短期播放凭证；有效期取 VOD 返回值，不缓存（D14）。 */
  getPlayAuth(videoId: string): Promise<{ playAuth: string }>;
  /** 幂等：视频不存在也成功。 */
  deleteVideo(videoId: string): Promise<void>;
  /** 课程标题改动时同步（G-D36）。 */
  updateTitle(videoId: string, title: string): Promise<void>;
  /** 创建时间早于 createdBefore 的全部视频（残渣清理用）。 */
  listVideosBefore(createdBefore: Date): Promise<Array<{ videoId: string; createdAt: Date }>>;
}

/** VOD 的状态串 → 本系统四态。未知值按「转码中」处理：不可播，但会被继续轮询，不会被误判为失败。 */
export function mapVodStatus(raw: string | undefined): VodVideoStatus {
  switch (raw) {
    case "Normal":
      return "normal";
    case "Uploading":
      return "uploading";
    case "UploadFail":
    case "TranscodeFail":
    case "Blocked":
      return "failed";
    default:
      return "transcoding"; // UploadSucc、Transcoding、Checking、Checked 及未知值
  }
}
