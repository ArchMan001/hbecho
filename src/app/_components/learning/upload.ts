"use client";
// 浏览器直传：资料与封面 PUT 到 OSS 签名地址；视频按 VOD 凭证用 ali-oss 浏览器版分片上传（官方上传 SDK 也是这样做的）。
// 服务端不中转字节；文件校验（大小、类型、文件头）由服务端在「保存」时再做一遍，这里的检查只是少走冤枉路。
import type { UploadTicket, VodUploadTicket } from "../../../modules/learning";

export type Progress = (percent: number) => void;

/** 签名里绑定了 Content-Type，必须原样带上。用 XHR 是为了拿到上传进度。 */
export function putToOss(ticket: Pick<UploadTicket, "uploadUrl" | "contentType">, file: File, onProgress?: Progress): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", ticket.uploadUrl);
    xhr.setRequestHeader("Content-Type", ticket.contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`upload_failed_${xhr.status}`)));
    xhr.onerror = () => reject(new Error("upload_network_error"));
    xhr.send(file);
  });
}

interface VodAddress {
  Endpoint: string;
  Bucket: string;
  FileName: string;
}
interface VodAuth {
  AccessKeyId: string;
  AccessKeySecret: string;
  SecurityToken: string;
}
const decode = <T,>(b64: string): T => JSON.parse(atob(b64)) as T;

/** VOD 上传：UploadAddress / UploadAuth 是 base64 的 JSON，换成临时凭证后走 OSS 分片上传。 */
export async function uploadToVod(ticket: Pick<VodUploadTicket, "uploadAddress" | "uploadAuth">, file: File, onProgress?: Progress): Promise<void> {
  const addr = decode<VodAddress>(ticket.uploadAddress);
  const auth = decode<VodAuth>(ticket.uploadAuth);
  const { default: OSS } = await import("ali-oss");
  const client = new OSS({
    accessKeyId: auth.AccessKeyId,
    accessKeySecret: auth.AccessKeySecret,
    stsToken: auth.SecurityToken,
    endpoint: addr.Endpoint,
    bucket: addr.Bucket,
    secure: true,
  });
  await client.multipartUpload(addr.FileName, file, {
    partSize: 5 * 1024 * 1024,
    parallel: 3,
    progress: (p: number) => onProgress?.(Math.round(p * 100)),
  });
}
