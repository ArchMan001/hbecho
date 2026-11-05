// 身份与残缺校验（FS-4.3、FS-4.8、FS-5.13；design §7.6.1；design-task5 §8）。纯函数。
// 旧系统最大的教训：「成功」不等于「对」——采到别人的号、厂商返回 200 但字段残缺，状态仍是 success。
import type { IdentifierNamespace, ListEntry, Platform, ProfileData, ValueState } from "../provider-adapter";

/** 主页标识必须等于已登记的值（文本精确比较，同命名空间）。入参里没有入口（locator）：身份基准是**本次供应商返回值**，不是我们发出去的链接。 */
export type ProfileIdentity = { state: "verified" } | { state: "mismatch"; expected: readonly string[]; actual: string | null };
export function checkProfileIdentity(input: { registered: readonly string[]; actual: ValueState<string> }): ProfileIdentity {
  const actual = input.actual.state === "value" ? input.actual.value : null;
  // 没有登记值（不应发生）也算不一致：宁可停采集，也不写一份无法归属的快照
  if (actual !== null && input.registered.includes(actual)) return { state: "verified" };
  return { state: "mismatch", expected: input.registered, actual };
}

/** 粉丝、关注、获赞、作品数四项全部不是有效值 → 响应残缺，不能写出「全部缺失」的快照冒充成功。 */
export function checkProfileFields(d: Pick<ProfileData, "followerCount" | "followingCount" | "likeCount" | "postCount">): "ok" | "all_invalid" {
  return [d.followerCount, d.followingCount, d.likeCount, d.postCount].some((c) => c.state === "value") ? "ok" : "all_invalid";
}

export type ListIdentityState = "pending" | "verified" | "unverifiable" | "mismatch";
export const MIN_AUTHOR_ENTRIES = 5;

/**
 * 列表作者三态。校验的是「是否一条都没有」而不是「是否全部是」：异作者共创是常态（抖音 20 条里有 1 条异作者）。
 *  - 任务开始时没有登记的作者标识 → 整次 unverifiable（小红书首次主导作者绑定是本任务自己造的，拿它验证本任务是循环论证）；
 *  - 只数作者 ID 为 value 的条目；< 5 条 → unverifiable（避免小账号误报）；
 *  - ≥ 5 条且一条都不是登记作者 → mismatch；否则 verified。
 */
export function checkListAuthors(c: { baselineHasRegistered: boolean; knownAuthorEntries: number; matchedEntries: number }): ListIdentityState {
  if (!c.baselineHasRegistered) return "unverifiable";
  if (c.knownAuthorEntries < MIN_AUTHOR_ENTRIES) return "unverifiable";
  return c.matchedEntries > 0 ? "verified" : "mismatch";
}

/** 一页里「作者 ID 可用」的条目数，以及其中由登记作者创作的条目数（抖音的第二标识 sec_uid 也算）。 */
export function countListAuthors(
  entries: ReadonlyArray<Pick<ListEntry, "author" | "authorSecUid">>,
  registered: ReadonlySet<string>,
): { known: number; matched: number } {
  let known = 0;
  let matched = 0;
  for (const e of entries) {
    const id = e.author.id.state === "value" ? e.author.id.value : null;
    const sec = e.authorSecUid?.state === "value" ? e.authorSecUid.value : null;
    if (id === null && sec === null) continue; // 作者字段缺失 / 非法：不数，契约漂移不是串号
    known++;
    if ((id !== null && registered.has(id)) || (sec !== null && registered.has(sec))) matched++;
  }
  return { known, matched };
}

/** 主页响应里的账号标识所在命名空间（与 decodeProfile 一致）。 */
export const PROFILE_NAMESPACE: Readonly<Record<Platform, IdentifierNamespace>> = {
  douyin: "douyin.user_id",
  xiaohongshu: "xiaohongshu.profile.user_id",
  kuaishou: "kuaishou.user_id",
};
/** 列表条目作者可能落在的命名空间（匹配「是否由登记作者创作」时查这些）。 */
export const AUTHOR_NAMESPACES: Readonly<Record<Platform, readonly IdentifierNamespace[]>> = {
  douyin: ["douyin.user_id", "douyin.sec_uid"],
  xiaohongshu: ["xiaohongshu.content.user_id"],
  kuaishou: ["kuaishou.user_id"],
};
