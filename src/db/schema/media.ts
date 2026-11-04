// v2 §11 OSS 与正式媒资。ODS 对象与正式媒资对象由 object_category + 复合 FK 做用途隔离。
import { sql } from "drizzle-orm";
import { type AnyMySqlColumn, boolean, check, foreignKey, index, int, longtext, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { asciiBin, id, inList, sha256, utc } from "../columns";
import { contentSnapshots } from "./content";
import { accountProfileSnapshots } from "./accounts";
import { odsProviderCalls } from "./sync";

export const ossObjects = mysqlTable(
  "oss_objects",
  {
    ossObjectId: id("oss_object_id").primaryKey().autoincrement(),
    objectCategory: varchar("object_category", { length: 32 }).notNull(),
    providerCode: asciiBin("provider_code", { length: 32 }).notNull(),
    region: asciiBin("region", { length: 64 }).notNull(),
    bucket: asciiBin("bucket", { length: 255 }).notNull(),
    objectKey: asciiBin("object_key", { length: 1024 }).notNull(),
    objectVersion: asciiBin("object_version", { length: 512 }).notNull().default(""),
    etag: varchar("etag", { length: 256 }),
    byteLength: id("byte_length"),
    sha256: sha256("sha256"),
    contentType: varchar("content_type", { length: 255 }),
    storageClass: varchar("storage_class", { length: 32 }).notNull(),
    encryptionMode: varchar("encryption_mode", { length: 32 }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    expiresAt: utc("expires_at"),
    verifiedAt: utc("verified_at"),
    deletedAt: utc("deleted_at"),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_oss_objects_location").on(t.providerCode, t.region, t.bucket, t.objectKey, t.objectVersion),
    // 供子表复合 FK 强制用途隔离
    uniqueIndex("uq_oss_objects_id_category").on(t.ossObjectId, t.objectCategory),
    index("idx_oss_objects_status_expires").on(t.status, t.expiresAt),
    index("idx_oss_objects_sha").on(t.sha256),
    check("ck_oss_objects_category", inList(t.objectCategory, ["ods", "media", "temp"])),
    // v2 未列举状态；deleting/deleted 来自 §12.7，available 来自本节约束描述
    check("ck_oss_objects_status", inList(t.status, ["pending", "available", "deleting", "deleted", "quarantined"])),
    check(
      "ck_oss_objects_available",
      sql`${t.status} <> 'available' OR (${t.byteLength} IS NOT NULL AND ${t.sha256} IS NOT NULL AND ${t.verifiedAt} IS NOT NULL)`,
    ),
  ],
);

export const mediaAssets = mysqlTable(
  "media_assets",
  {
    mediaAssetId: id("media_asset_id").primaryKey().autoincrement(),
    sha256: sha256("sha256").notNull(),
    byteLength: id("byte_length").notNull(),
    mediaKind: varchar("media_kind", { length: 32 }).notNull(),
    mimeType: varchar("mime_type", { length: 255 }).notNull(),
    width: int("width"),
    height: int("height"),
    durationMs: id("duration_ms"),
    ossObjectId: id("oss_object_id").notNull(),
    objectCategory: varchar("object_category", { length: 32 }).notNull().default("media"),
    verificationStatus: varchar("verification_status", { length: 32 }).notNull(),
    verifiedAt: utc("verified_at").notNull(),
    createdAt: utc("created_at").notNull(),
  },
  (t) => [
    foreignKey({
      name: "fk_media_assets_oss_object",
      columns: [t.ossObjectId, t.objectCategory],
      foreignColumns: [ossObjects.ossObjectId, ossObjects.objectCategory],
    }),
    uniqueIndex("uq_media_assets_sha").on(t.sha256),
    uniqueIndex("uq_media_assets_oss_object").on(t.ossObjectId),
    index("idx_media_assets_kind_created").on(t.mediaKind, t.createdAt),
    check("ck_media_assets_category", sql`${t.objectCategory} = 'media'`),
    check("ck_media_assets_kind", inList(t.mediaKind, ["image", "video", "audio", "unknown"])),
    check("ck_media_assets_verification", inList(t.verificationStatus, ["verified", "quarantined"])),
    check(
      "ck_media_assets_nonneg",
      sql`${t.byteLength} >= 0 AND (${t.width} IS NULL OR ${t.width} >= 0) AND (${t.height} IS NULL OR ${t.height} >= 0) AND (${t.durationMs} IS NULL OR ${t.durationMs} >= 0)`,
    ),
  ],
);

export const MEDIA_ROLES = [
  "avatar",
  "background",
  "avatar_normalized",
  "background_normalized",
  "cover",
  "cover_normalized",
  "gallery_image",
  "video",
  "audio",
] as const;

export const mediaReferences = mysqlTable(
  "media_references",
  {
    mediaReferenceId: id("media_reference_id").primaryKey().autoincrement(),
    profileSnapshotId: id("profile_snapshot_id"),
    contentSnapshotId: id("content_snapshot_id"),
    role: varchar("role", { length: 32 }).notNull(),
    slotIndex: int("slot_index").notNull().default(0),
    sourceLocator: longtext("source_locator"),
    sourceLocatorSha256: sha256("source_locator_sha256"),
    sourceJsonPath: varchar("source_json_path", { length: 1024 }),
    observedAt: utc("observed_at").notNull(),
    mediaAssetId: id("media_asset_id").references((): AnyMySqlColumn => mediaAssets.mediaAssetId),
    archiveStatus: varchar("archive_status", { length: 32 }).notNull(),
    isCarriedForward: boolean("is_carried_forward").notNull().default(false),
    lastErrorCode: varchar("last_error_code", { length: 128 }),
    sourceProviderCallId: id("source_provider_call_id"),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (t) => [
    foreignKey({ name: "fk_media_refs_profile_snap", columns: [t.profileSnapshotId], foreignColumns: [accountProfileSnapshots.profileSnapshotId] }),
    foreignKey({ name: "fk_media_refs_content_snap", columns: [t.contentSnapshotId], foreignColumns: [contentSnapshots.contentSnapshotId] }),
    foreignKey({ name: "fk_media_refs_call", columns: [t.sourceProviderCallId], foreignColumns: [odsProviderCalls.providerCallId] }).onDelete("set null"),
    uniqueIndex("uq_media_refs_profile_slot").on(t.profileSnapshotId, t.role, t.slotIndex),
    uniqueIndex("uq_media_refs_content_slot").on(t.contentSnapshotId, t.role, t.slotIndex),
    index("idx_media_refs_asset").on(t.mediaAssetId),
    index("idx_media_refs_status_updated").on(t.archiveStatus, t.updatedAt),
    check("ck_media_refs_role", inList(t.role, MEDIA_ROLES)),
    check(
      "ck_media_refs_one_snapshot",
      sql`(${t.profileSnapshotId} IS NULL) <> (${t.contentSnapshotId} IS NULL)`,
    ),
    check("ck_media_refs_slot", sql`${t.slotIndex} >= 0`),
    check("ck_media_refs_locator_pair", sql`(${t.sourceLocator} IS NULL) = (${t.sourceLocatorSha256} IS NULL)`),
    check("ck_media_refs_archive_status", inList(t.archiveStatus, ["pending", "archived", "carried_forward", "failed"])),
    // pending / archived / carried_forward / failed 的 asset、错误、carried 组合（§11.3）
    check(
      "ck_media_refs_state_shape",
      sql`(${t.archiveStatus} = 'pending' AND ${t.mediaAssetId} IS NULL AND ${t.lastErrorCode} IS NULL AND NOT ${t.isCarriedForward})
        OR (${t.archiveStatus} = 'archived' AND ${t.mediaAssetId} IS NOT NULL AND ${t.lastErrorCode} IS NULL AND NOT ${t.isCarriedForward})
        OR (${t.archiveStatus} = 'carried_forward' AND ${t.mediaAssetId} IS NOT NULL AND ${t.lastErrorCode} IS NOT NULL AND ${t.isCarriedForward})
        OR (${t.archiveStatus} = 'failed' AND ${t.mediaAssetId} IS NULL AND ${t.lastErrorCode} IS NOT NULL AND NOT ${t.isCarriedForward})`,
    ),
  ],
);
