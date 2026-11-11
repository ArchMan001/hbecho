// 上限与有效期（requirements §5.1：写在配置里，不散落在业务代码）。数值来自 G-D44；
// 「MB」按 MiB（1024²）取：比十进制 MB 宽，macOS 显示 50 MB 的文件不会被误拒。
export interface LearningConfig {
  /** 资料（PDF / 图片）单文件上限，字节。 */
  docMaxBytes: number;
  /** 视频单文件上限，字节（G-D44：2 GB）。 */
  videoMaxBytes: number;
  /** 视频时长上限，秒（G-D44：60 分钟）。 */
  videoMaxSeconds: number;
  /** 封面上限，字节。 */
  coverMaxBytes: number;
  /** 直传签名地址有效期，秒。 */
  uploadUrlTtlSeconds: number;
  /** 下载签名地址有效期，秒；实际取它与出口框架上限 MAX_SIGNED_LINK_TTL_SECONDS 的较小值。 */
  downloadUrlTtlSeconds: number;
  /** 封面展示用签名地址有效期，秒。 */
  coverUrlTtlSeconds: number;
}

export const DEFAULT_LEARNING_CONFIG: LearningConfig = {
  docMaxBytes: 50 * 1024 * 1024,
  videoMaxBytes: 2 * 1024 * 1024 * 1024,
  videoMaxSeconds: 60 * 60,
  coverMaxBytes: 5 * 1024 * 1024,
  uploadUrlTtlSeconds: 600,
  downloadUrlTtlSeconds: 300,
  coverUrlTtlSeconds: 300,
};
