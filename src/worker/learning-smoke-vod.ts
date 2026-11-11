// `pnpm learning-smoke-vod`：对真实阿里云 VOD 验证视频链路（g-learning-min acceptance E1）。
// 只在人工批准后运行（2026-11-11 刘学奎授权）。门槛：HBECHO_LEARNING_SMOKE_VOD=approved。
// 固定预算：1 个 3 秒的 MP4（约 20–30 KB，需要本机有 ffmpeg 生成）→ 转码 → 取凭证 → 删除；全程不留视频。
// 不读写数据库，不打印密钥与凭证内容（只打印长度、状态与主机名）。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadEnvFile } from "node:process";
import OSS from "ali-oss";
import { parseLearningEnv } from "../modules/learning/runtime";
import { VOD_ENDPOINT, VOD_REGION } from "../modules/learning/vod";
import { createAliyunVodClient } from "../modules/learning/vod-aliyun";

try {
  loadEnvFile(".env");
} catch (e) {
  if ((e as { code?: unknown }).code !== "ENOENT") throw e;
}
if (process.env.HBECHO_LEARNING_SMOKE_VOD !== "approved") {
  process.stderr.write("门槛未满足，未发起任何请求：HBECHO_LEARNING_SMOKE_VOD=approved\n");
  process.exit(2);
}
const cfg = parseLearningEnv(process.env);
const cred = await cfg.credentials();
const vod = await createAliyunVodClient(cred);
const steps: Array<{ step: string; ok: boolean; note?: string }> = [];
const rec = (step: string, ok: boolean, note?: string) => steps.push({ step, ok, ...(note ? { note } : {}) });
const errText = (e: unknown) => (e instanceof Error ? e.message.slice(0, 160) : typeof e);

const file = "/tmp/hbecho-smoke.mp4";
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=15", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
const bytes = readFileSync(file);

let videoId: string | undefined;
try {
  const ticket = await vod.createUpload({ title: "hbecho-smoke", fileName: "hbecho-smoke.mp4", fileSize: bytes.byteLength });
  videoId = ticket.videoId;
  rec("CreateUploadVideo（带转码模板组，cn-beijing）", /^[0-9a-f]{32}$/i.test(videoId), `videoId 长度 ${videoId.length}`);
  const first = await vod.getVideo(videoId);
  rec("上传前 GetVideoInfo 状态为 uploading", first?.status === "uploading", `status=${first?.status}`);

  // 与浏览器端 uploadToVod 同一套：base64 JSON → STS 凭证 → ali-oss 分片上传
  const addr = JSON.parse(Buffer.from(ticket.uploadAddress, "base64").toString()) as { Endpoint: string; Bucket: string; FileName: string };
  const auth = JSON.parse(Buffer.from(ticket.uploadAuth, "base64").toString()) as { AccessKeyId: string; AccessKeySecret: string; SecurityToken: string };
  const oss = new OSS({ accessKeyId: auth.AccessKeyId, accessKeySecret: auth.AccessKeySecret, stsToken: auth.SecurityToken, endpoint: addr.Endpoint, bucket: addr.Bucket, secure: true });
  await oss.multipartUpload(addr.FileName, file, { partSize: 100 * 1024 });
  rec("用 UploadAddress / UploadAuth 分片上传到 VOD 存储", true, `host=${new URL(addr.Endpoint).host} bucket=${addr.Bucket}`);

  const seen: string[] = [];
  let last = first;
  for (let i = 0; i < 40; i++) {
    last = await vod.getVideo(videoId);
    if (last && seen.at(-1) !== last.status) seen.push(last.status);
    if (last?.status === "normal" || last?.status === "failed") break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  rec("转码完成（status=normal）并回填时长", last?.status === "normal" && (last.durationSec ?? 0) >= 3, `状态序列=${seen.join("→")} duration=${last?.durationSec} size=${last?.sizeBytes}`);

  const pa = await vod.getPlayAuth(videoId);
  rec("GetVideoPlayAuth 返回播放凭证", pa.playAuth.length > 20, `长度 ${pa.playAuth.length}`);

  // 播放可用性：Aliplayer 用 playauth 去 GetPlayInfo 取地址，没有播放域名会失败——只记录事实
  const m = await import("@alicloud/vod20170321");
  const sdk = new m.default({ accessKeyId: cred.accessKeyId, accessKeySecret: cred.accessKeySecret, ...(cred.securityToken ? { securityToken: cred.securityToken } : {}), endpoint: VOD_ENDPOINT, regionId: VOD_REGION } as never);
  try {
    const info = await sdk.getPlayInfo(new m.GetPlayInfoRequest({ videoId }));
    const list = info.body?.playInfoList?.playInfo ?? [];
    rec("GetPlayInfo（记录事实：是否已有播放域名）", list.length > 0, `条数=${list.length} 主机=${[...new Set(list.map((p) => new URL(p.playURL!).host))].join(",")} 清晰度=${list.map((p) => p.definition).join(",")}`);
  } catch (e) {
    rec("GetPlayInfo（记录事实：是否已有播放域名）", false, `${(e as { code?: string }).code ?? "unknown"}`);
  }

  await vod.updateTitle(videoId, "hbecho-smoke-renamed");
  rec("UpdateVideoInfo 同步标题", true);
  const listed = await vod.listVideosBefore(new Date(Date.now() + 60_000));
  rec("GetVideoList 能列出刚传的视频（带 hbecho-course 标签才会被清理任务看见）", listed.some((v) => v.videoId === videoId), `共 ${listed.length} 个`);
  rec("GetVideoList 在时间截止之前没有视频时返回空列表（真实服务报 NotFound，适配器已转换）", (await vod.listVideosBefore(new Date("2020-01-01T00:00:00Z"))).length === 0);
} catch (e) {
  rec("异常中止", false, errText(e));
} finally {
  if (videoId) {
    try {
      await vod.deleteVideo(videoId);
      // 真实 VOD 的删除不是立刻可见（实测删除后几秒内 GetVideoInfo 仍可能返回），轮询到消失为止
      let gone = false;
      for (let i = 0; i < 12 && !gone; i++) {
        gone = (await vod.getVideo(videoId)) === null;
        if (!gone) await new Promise((r) => setTimeout(r, 5000));
      }
      rec("DeleteVideo 删除（最终不可见）", gone);
      await vod.deleteVideo(videoId);
      rec("DeleteVideo 幂等", true);
    } catch (e) {
      rec("清理失败（需要人工在 VOD 控制台删除）", false, `${videoId}: ${errText(e)}`);
    }
  }
}
const failed = steps.filter((s) => !s.ok);
process.stdout.write(`${JSON.stringify({ region: VOD_REGION, credentials: cfg.credentialsKind, steps, failed: failed.length }, null, 2)}\n`);
process.exit(failed.length ? 1 : 0);
