ALTER TABLE `content_snapshots` ADD `seeded_from_snapshot_id` bigint;--> statement-breakpoint
-- purpose 三步（a-full-sync R4）：先建可空列 → 回填已有批次 → 改 NOT NULL，不留 DEFAULT。
-- 此前所有批次都是 tracer 根批次或 smoke，全部是 intake。schema 快照仍是 notNull()，所以 drizzle-kit generate 不会再产生新文件。
ALTER TABLE `sync_batches` ADD `purpose` varchar(32);--> statement-breakpoint
UPDATE `sync_batches` SET `purpose` = 'intake' WHERE `purpose` IS NULL;--> statement-breakpoint
ALTER TABLE `sync_batches` MODIFY `purpose` varchar(32) NOT NULL;--> statement-breakpoint
ALTER TABLE `sync_batches` ADD `media_finished_at` datetime(6);--> statement-breakpoint
ALTER TABLE `content_snapshots` ADD CONSTRAINT `ck_content_snapshots_seeded` CHECK (`content_snapshots`.`seeded_from_snapshot_id` IS NULL OR (`content_snapshots`.`list_observed` = FALSE AND `content_snapshots`.`detail_observed` = TRUE));--> statement-breakpoint
ALTER TABLE `sync_batches` ADD CONSTRAINT `ck_sync_batches_purpose` CHECK (`sync_batches`.`purpose` IN ('full','supplement','demand','intake'));--> statement-breakpoint
ALTER TABLE `content_snapshots` ADD CONSTRAINT `fk_content_snap_seeded_from` FOREIGN KEY (`seeded_from_snapshot_id`) REFERENCES `content_snapshots`(`content_snapshot_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_content_snapshots_seeded_from` ON `content_snapshots` (`seeded_from_snapshot_id`);--> statement-breakpoint
CREATE INDEX `idx_sync_batches_purpose_status_logical` ON `sync_batches` (`purpose`,`status`,`logical_at`);