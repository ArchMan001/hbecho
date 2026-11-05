// 任务 7 的媒资 Runner 测试挂具：独立的假媒资桶、假图片 / 视频 transport、假转换器 / 能力服务、临时目录。全部离线。
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { FakeCapabilityClient, FakeImageConverter, FakeMediaTransport, FakeVideoTransport } from "./fake-media";
import { FakeObjectStore } from "./fake-oss";
import type { SyncEnv } from "./sync-env";
import { createAccountRunners, createDemandRunners, createMediaRunners, type MediaRunnerDeps, type RunnerRegistry } from "../../src/modules/sync-runner";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

export interface MediaEnvOptions {
  mediaMaxBytes?: number;
  batchMaxBytes?: number | null;
}

export function setupMedia(env: SyncEnv, o: MediaEnvOptions = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), "hbecho-media-test-"));
  dirs.push(tmpDir);
  const mediaStore = new FakeObjectStore(env.clock);
  const imageTransport = new FakeMediaTransport();
  const videoTransport = new FakeVideoTransport();
  const converter = new FakeImageConverter();
  const capability = new FakeCapabilityClient(mediaStore);
  const deps: MediaRunnerDeps = {
    ...env.deps,
    mediaStore,
    location: { providerCode: "aliyun-oss", region: "cn-beijing", bucket: "hbecho-media-test" },
    imageTransport,
    videoTransport,
    converter,
    capability,
    tmpDir,
    mediaMaxBytes: o.mediaMaxBytes ?? 1024 * 1024 * 1024,
    batchMaxBytes: o.batchMaxBytes ?? null,
  };
  const registry = (): RunnerRegistry => ({ ...createAccountRunners(env.deps), ...createDemandRunners(env.deps), ...createMediaRunners(deps) });
  const run = () => env.worker(registry()).run({ untilIdle: true });
  return { deps, tmpDir, mediaStore, imageTransport, videoTransport, converter, capability, registry, run, tmpFiles: () => readdirSync(tmpDir) };
}
export type MediaEnv = ReturnType<typeof setupMedia>;
