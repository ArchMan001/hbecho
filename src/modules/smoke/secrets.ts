// smoke 的 secret / 配置读取。**只从环境变量读**，绝不读文件、命令行或数据库。
// 缺失或不合法时在构造 transport / store 之前失败；错误信息只带变量名，不带值。
//
// 变量名对齐运维手册 §8.5（OSS_REGION / OSS_BUCKET_ODS / OSS_ENDPOINT），
// 另加两个**仅本机**使用的长期 AccessKey 变量：服务器走 ECS 实例角色，本机没有实例元数据可依赖。

export const SMOKE_ENV_VARS = {
  apiKey: "AIMASTER_API_KEY",
  baseUrl: "AIMASTER_BASE_URL",
  ossAccessKeyId: "OSS_ACCESS_KEY_ID",
  ossAccessKeySecret: "OSS_ACCESS_KEY_SECRET",
  ossRegion: "OSS_REGION",
  ossBucketOds: "OSS_BUCKET_ODS",
  ossEndpoint: "OSS_ENDPOINT",
  databaseUrl: "HBECHO_DATABASE_URL",
} as const;

export type SmokeConfigErrorCode = "missing_env" | "invalid_env";

export class SmokeConfigError extends Error {
  constructor(
    readonly code: SmokeConfigErrorCode,
    readonly variable: string,
    detail = "",
  ) {
    super(`环境变量 ${variable} ${code === "missing_env" ? "缺失" : "不合法"}${detail ? `：${detail}` : ""}`);
    this.name = "SmokeConfigError";
  }
}

export interface SmokeSecrets {
  apiKey: string;
  baseUrl: string;
  oss: {
    accessKeyId: string;
    accessKeySecret: string;
    region: string;
    bucket: string;
    endpoint?: string;
  };
}

function required(env: Record<string, string | undefined>, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new SmokeConfigError("missing_env", name);
  return v;
}

/** 读取并校验 smoke 需要的全部 secret 与 OSS 配置。幂等、无副作用。 */
export function readSmokeSecrets(env: Record<string, string | undefined>): SmokeSecrets {
  const apiKey = required(env, SMOKE_ENV_VARS.apiKey);
  const baseUrl = required(env, SMOKE_ENV_VARS.baseUrl);
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new SmokeConfigError("invalid_env", SMOKE_ENV_VARS.baseUrl, "不是合法 URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new SmokeConfigError("invalid_env", SMOKE_ENV_VARS.baseUrl, "必须是 http(s)");

  const region = required(env, SMOKE_ENV_VARS.ossRegion);
  if (!/^[a-z0-9-]{2,32}$/.test(region)) throw new SmokeConfigError("invalid_env", SMOKE_ENV_VARS.ossRegion, "形如 cn-beijing");

  const bucket = required(env, SMOKE_ENV_VARS.ossBucketOds);
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new SmokeConfigError("invalid_env", SMOKE_ENV_VARS.ossBucketOds, "不符合 OSS 桶名规则");

  const endpoint = env[SMOKE_ENV_VARS.ossEndpoint]?.trim();

  return {
    apiKey,
    baseUrl,
    oss: {
      accessKeyId: required(env, SMOKE_ENV_VARS.ossAccessKeyId),
      accessKeySecret: required(env, SMOKE_ENV_VARS.ossAccessKeySecret),
      region,
      bucket,
      ...(endpoint ? { endpoint } : {}),
    },
  };
}