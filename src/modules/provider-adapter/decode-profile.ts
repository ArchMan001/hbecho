import { ADAPTER_VERSION, type DecodeOutcome, type IdentifierNamespace, type Platform, type ProfileData } from "./contract";
import { openEnvelope } from "./envelope";
import { readCount, readExternalId, readText } from "./value-state";

const PROFILE_NAMESPACE: Record<Platform, IdentifierNamespace> = {
  douyin: "douyin.user_id",
  xiaohongshu: "xiaohongshu.profile.user_id",
};

export function decodeProfile(platform: Platform, bytes: Uint8Array): DecodeOutcome<ProfileData> {
  const opened = openEnvelope(platform, "media_user_info", bytes);
  if (!opened.ok) return opened.outcome;
  const r = opened.result;

  // 头像与背景只对抖音形成候选（背景取 cover 字段）；小红书主页响应不返回，不臆造（R12.2）。
  const mediaCandidates: ProfileData["mediaCandidates"] = [];
  if (platform === "douyin") {
    const avatar = readText(r, "avatar");
    const background = readText(r, "cover");
    if (avatar.state === "value" && avatar.value !== "") mediaCandidates.push({ role: "avatar", url: avatar.value, jsonPath: "$.data.result.avatar" });
    if (background.state === "value" && background.value !== "") {
      mediaCandidates.push({ role: "background", url: background.value, jsonPath: "$.data.result.cover" });
    }
  }

  return {
    outcome: "decoded",
    adapterVersion: ADAPTER_VERSION,
    platform,
    exchange: opened.exchange,
    taskId: opened.taskId,
    data: {
      account: { namespace: PROFILE_NAMESPACE[platform], id: readExternalId(r, "user_id") },
      nickname: readText(r, "nickname"),
      signature: readText(r, "signature"),
      location: readText(r, "location"),
      followerCount: readCount(r, "follower_number", "follower_count"),
      followingCount: readCount(r, "following_number", "following_count"),
      likeCount: readCount(r, "like_number", "like_count"),
      postCount: readCount(r, "post_number", "post_count"),
      providerUpdatedAtMs: readCount(r, "updated"),
      mediaCandidates,
    },
  };
}

/** 粉丝数与作品数都是真实 0（缺失、null、非法都不算）→ 疑似空账号（R19.2）。 */
export function isSuspectedEmptyProfile(p: ProfileData): boolean {
  return (
    p.followerCount.state === "value" &&
    p.followerCount.value === 0n &&
    p.postCount.state === "value" &&
    p.postCount.value === 0n
  );
}
