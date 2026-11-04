// 主页快照投影（R8）：每个账号每个批次最多一份终态快照，创建成功即不可变；头像 / 背景只形成媒资引用（pending）。
import { and, eq } from "drizzle-orm";
import type { DbTx } from "../../db/client";
import { accountProfileSnapshots, mediaReferences } from "../../db/schema";
import type { ProfileData } from "../provider-adapter";
import { countColumns, fit, msToDate, textOrNull } from "./columns";
import { sha256Utf8 } from "../canonical-json";
import { selectCurrentProfile } from "./current";

export interface ProjectProfileInput {
  batchId: bigint;
  accountId: bigint;
  assignmentId: bigint;
  providerId: bigint;
  sourceProviderCallId: bigint;
  adapterVersion: string;
  responseReceivedAt: Date;
  data: ProfileData;
  now: Date;
}

export async function projectProfile(tx: DbTx, p: ProjectProfileInput): Promise<{ profileSnapshotId: bigint; created: boolean }> {
  const [existing] = await tx
    .select()
    .from(accountProfileSnapshots)
    .where(and(eq(accountProfileSnapshots.batchId, p.batchId), eq(accountProfileSnapshots.accountId, p.accountId)));
  if (existing) return { profileSnapshotId: existing.profileSnapshotId, created: false }; // 重放：不新增、不改写

  const d = p.data;
  const follower = countColumns(d.followerCount);
  const following = countColumns(d.followingCount);
  const like = countColumns(d.likeCount);
  const post = countColumns(d.postCount);
  const [res] = await tx.insert(accountProfileSnapshots).values({
    batchId: p.batchId,
    accountId: p.accountId,
    assignmentId: p.assignmentId,
    providerId: p.providerId,
    sourceProviderCallId: p.sourceProviderCallId,
    nickname: fit(textOrNull(d.nickname), 512),
    signature: textOrNull(d.signature),
    location: fit(textOrNull(d.location), 256),
    followerValue: follower.value,
    followerState: follower.state,
    followingValue: following.value,
    followingState: following.state,
    likeValue: like.value,
    likeState: like.state,
    postValue: post.value,
    postState: post.state,
    providerUpdatedAt: msToDate(d.providerUpdatedAtMs),
    responseReceivedAt: p.responseReceivedAt,
    adapterVersion: p.adapterVersion,
    createdAt: p.now,
  });
  const profileSnapshotId = BigInt(res.insertId);

  for (const m of d.mediaCandidates) {
    await tx.insert(mediaReferences).values({
      profileSnapshotId,
      role: m.role,
      slotIndex: 0,
      sourceLocator: m.url, // 临时地址，只是下载入口，不是媒资身份
      sourceLocatorSha256: sha256Utf8(m.url),
      sourceJsonPath: m.jsonPath,
      observedAt: p.responseReceivedAt,
      archiveStatus: "pending",
      sourceProviderCallId: p.sourceProviderCallId,
      createdAt: p.now,
      updatedAt: p.now,
    });
  }
  await selectCurrentProfile(tx, p.accountId, profileSnapshotId, p.now);
  return { profileSnapshotId, created: true };
}

