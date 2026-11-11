// 云凭证来源。两种：固定 AccessKey（本机 / 与短信相同的专用子账号做法），或 ECS 实例 RAM 角色（runbook §7.7：免长期 AccessKey）。
// 实例角色的临时凭证由元数据服务给出，会过期——所以调用方每次操作前都 `await source()`，不要缓存结果。
export interface Credentials {
  accessKeyId: string;
  accessKeySecret: string;
  /** STS 临时凭证才有。 */
  securityToken?: string;
}
export type CredentialSource = () => Promise<Credentials>;

export const staticCredentials = (c: Credentials): CredentialSource => async () => c;

const METADATA = "http://100.100.100.200";
const REFRESH_BEFORE_MS = 5 * 60_000;

/**
 * ECS 元数据服务取实例角色的临时凭证。先尝试加固模式（PUT 取 token，失败则回退普通模式），到期前 5 分钟重新取。
 * 错误一律是不含任何凭证内容的固定文案。
 */
export function ecsRoleCredentials(opts: { fetchImpl?: typeof fetch; now?: () => Date; roleName?: string; baseUrl?: string } = {}): CredentialSource {
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  const base = opts.baseUrl ?? METADATA;
  let cached: { c: Credentials; expiresAt: number } | undefined;
  let inflight: Promise<Credentials> | undefined;

  const get = async (path: string, headers: Record<string, string>): Promise<Response> => f(`${base}${path}`, { headers, signal: AbortSignal.timeout(3000) });

  async function load(): Promise<Credentials> {
    const headers: Record<string, string> = {};
    try {
      const t = await f(`${base}/latest/api/token`, { method: "PUT", headers: { "X-aliyun-ecs-metadata-token-ttl-seconds": "600" }, signal: AbortSignal.timeout(3000) });
      if (t.ok) headers["X-aliyun-ecs-metadata-token"] = (await t.text()).trim();
    } catch {
      // 非加固模式：不带 token 直接取
    }
    try {
      let role = opts.roleName;
      if (!role) {
        const r = await get("/latest/meta-data/ram/security-credentials/", headers);
        if (!r.ok) throw new Error("role");
        role = (await r.text()).trim().split("\n")[0];
      }
      const res = await get(`/latest/meta-data/ram/security-credentials/${encodeURIComponent(role!)}`, headers);
      if (!res.ok) throw new Error("creds");
      const j = (await res.json()) as { Code?: string; AccessKeyId?: string; AccessKeySecret?: string; SecurityToken?: string; Expiration?: string };
      if (j.Code !== "Success" || !j.AccessKeyId || !j.AccessKeySecret || !j.SecurityToken || !j.Expiration) throw new Error("shape");
      cached = { c: { accessKeyId: j.AccessKeyId, accessKeySecret: j.AccessKeySecret, securityToken: j.SecurityToken }, expiresAt: Date.parse(j.Expiration) };
      return cached.c;
    } catch {
      throw new Error("无法从 ECS 元数据服务取得实例角色凭证");
    }
  }

  return async () => {
    if (cached && cached.expiresAt - now().getTime() > REFRESH_BEFORE_MS) return cached.c;
    return (inflight ??= load().finally(() => (inflight = undefined)));
  };
}
