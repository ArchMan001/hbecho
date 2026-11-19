import { describe, expect, it } from "vitest";
import { parseSquareEnv } from "./assemble";

describe("parseSquareEnv", () => {
  it("生产：ecs_role + 地域即可，桶缺省 hbecho-media，不需要任何 AccessKey", () => {
    const c = parseSquareEnv({ HBECHO_SQUARE_CREDENTIALS: "ecs_role", HBECHO_COURSE_OSS_REGION: "cn-beijing" })!;
    expect(c).toMatchObject({ credentialsKind: "ecs_role", region: "cn-beijing", bucket: "hbecho-media", ttlSeconds: 300 });
  });
  it("本机：不设来源时有 AccessKey 就用，没有就 null（封面全部占位）", () => {
    expect(parseSquareEnv({ OSS_REGION: "cn-beijing", OSS_ACCESS_KEY_ID: "a", OSS_ACCESS_KEY_SECRET: "b", OSS_BUCKET_MEDIA: "m" })).toMatchObject({ credentialsKind: "env_access_key", bucket: "m" });
    expect(parseSquareEnv({ OSS_REGION: "cn-beijing" })).toBeNull();
    expect(parseSquareEnv({})).toBeNull();
  });
  it("来源写错或缺地域 → null，不静默退回别的来源；TTL 越界用缺省", () => {
    expect(parseSquareEnv({ HBECHO_SQUARE_CREDENTIALS: "role", OSS_REGION: "cn-beijing", OSS_ACCESS_KEY_ID: "a", OSS_ACCESS_KEY_SECRET: "b" })).toBeNull();
    expect(parseSquareEnv({ HBECHO_SQUARE_CREDENTIALS: "ecs_role" })).toBeNull();
    expect(parseSquareEnv({ HBECHO_SQUARE_CREDENTIALS: "ecs_role", OSS_REGION: "cn-beijing", HBECHO_SQUARE_COVER_TTL_S: "86400" })!.ttlSeconds).toBe(300);
    expect(parseSquareEnv({ HBECHO_SQUARE_CREDENTIALS: "ecs_role", OSS_REGION: "cn-beijing", HBECHO_SQUARE_COVER_TTL_S: "600" })!.ttlSeconds).toBe(600);
  });
});
