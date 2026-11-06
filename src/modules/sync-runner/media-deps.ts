// 媒资 Runner（download_media：周期的账号级任务、按需的视频 / 音频任务）的注入依赖。
import type { ImageConverter, MediaArchiveHooks, MediaPolicy, MediaTransport, CapabilityClient, VideoTransport } from "../media-archive";
import type { MediaObjectStore } from "../raw-capture";
import type { AccountRunnerDeps } from "./account-deps";

export interface MediaRunnerDeps extends AccountRunnerDeps {
  /** 正式媒资桶（与 ODS 桶分开，ADR-0001）。 */
  mediaStore: MediaObjectStore;
  location: { providerCode: string; region: string; bucket: string };
  imageTransport: MediaTransport;
  videoTransport: VideoTransport;
  converter: ImageConverter;
  capability: CapabilityClient;
  imagePolicy?: MediaPolicy;
  videoPolicy?: MediaPolicy;
  /** 视频流式下载的临时目录（HBECHO_MEDIA_TMP_DIR）；每个任务一个 `<task_id>.part`，finally 删除。 */
  tmpDir: string;
  /** 单个视频的字节上限（HBECHO_MEDIA_MAX_BYTES）；音频上限 = 源视频字节数与它的较小者。 */
  mediaMaxBytes: number;
  /** 单批次视频 / 音频总字节上限（HBECHO_MEDIA_BATCH_MAX_BYTES）；null = 不限。 */
  batchMaxBytes: number | null;
  archiveHooks?: MediaArchiveHooks;
}
