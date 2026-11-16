CREATE TABLE `judgement_plan_versions` (
	`plan_id` bigint NOT NULL,
	`version` int NOT NULL,
	`status` varchar(16) NOT NULL,
	`wizard_step` varchar(16) NOT NULL,
	`config` json NOT NULL,
	`config_schema_version` int NOT NULL,
	`config_sha256` binary(32) NOT NULL,
	`based_on_version` int,
	`draft_key` bigint GENERATED ALWAYS AS ((CASE WHEN status IN ('draft','publishing') THEN plan_id END)) STORED,
	`published_at` datetime(6),
	`published_by_actor` varchar(128),
	`created_by_actor` varchar(128) NOT NULL,
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `pk_jpv` PRIMARY KEY(`plan_id`,`version`),
	CONSTRAINT `uq_jpv_draft` UNIQUE(`draft_key`),
	CONSTRAINT `ck_jpv_status` CHECK(`judgement_plan_versions`.`status` IN ('draft','publishing','published')),
	CONSTRAINT `ck_jpv_wizard` CHECK(`judgement_plan_versions`.`wizard_step` IN ('draft','circled','compared')),
	CONSTRAINT `ck_jpv_version` CHECK(`judgement_plan_versions`.`version` > 0),
	CONSTRAINT `ck_jpv_published` CHECK((`judgement_plan_versions`.`status` = 'published') = (`judgement_plan_versions`.`published_at` IS NOT NULL)),
	CONSTRAINT `ck_jpv_config` CHECK(JSON_TYPE(`judgement_plan_versions`.`config`) = 'OBJECT')
);
--> statement-breakpoint
CREATE TABLE `judgement_plans` (
	`plan_id` bigint AUTO_INCREMENT NOT NULL,
	`activity_plan_id` bigint NOT NULL,
	`platform_id` bigint NOT NULL,
	`alias` varchar(200) NOT NULL,
	`description` varchar(2000),
	`status` varchar(16) NOT NULL,
	`latest_version` int NOT NULL,
	`created_by_actor` varchar(128) NOT NULL,
	`created_by_user_id` bigint,
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `judgement_plans_plan_id` PRIMARY KEY(`plan_id`),
	CONSTRAINT `uq_jp_alias` UNIQUE(`activity_plan_id`,`alias`),
	CONSTRAINT `ck_jp_status` CHECK(`judgement_plans`.`status` IN ('provisioning','active','archived')),
	CONSTRAINT `ck_jp_latest_version` CHECK(`judgement_plans`.`latest_version` > 0)
);
--> statement-breakpoint
CREATE TABLE `judgement_runs` (
	`run_id` bigint AUTO_INCREMENT NOT NULL,
	`plan_id` bigint NOT NULL,
	`version` int NOT NULL,
	`run_kind` varchar(16) NOT NULL,
	`status` varchar(16) NOT NULL,
	`phase` varchar(32),
	`phase_cursor` bigint,
	`phase_detail` json,
	`frozen` json NOT NULL,
	`idempotency_key` binary(32),
	`active_key` binary(32),
	`submitted_by_actor` varchar(128) NOT NULL,
	`submitted_by_user_id` bigint,
	`scope_summary` json,
	`lease_owner` varchar(128),
	`lease_expires_at` datetime(6),
	`fencing_token` bigint NOT NULL DEFAULT 0,
	`next_tick_at` datetime(6),
	`attempt_count` int NOT NULL DEFAULT 0,
	`last_error_code` varchar(64),
	`last_error_detail` json,
	`participant_count` int,
	`content_total` int,
	`c1_count` int,
	`c2_count` int,
	`c3_count` int,
	`stale_used` boolean NOT NULL DEFAULT false,
	`started_at` datetime(6),
	`completed_at` datetime(6),
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	`expires_at` datetime(6),
	CONSTRAINT `judgement_runs_run_id` PRIMARY KEY(`run_id`),
	CONSTRAINT `uq_jr_idempotency` UNIQUE(`idempotency_key`),
	CONSTRAINT `uq_jr_active` UNIQUE(`active_key`),
	CONSTRAINT `ck_jr_kind` CHECK(`judgement_runs`.`run_kind` IN ('circle','compare','execution')),
	CONSTRAINT `ck_jr_status` CHECK(`judgement_runs`.`status` IN ('planned','running','waiting','completed','failed','cancelled')),
	CONSTRAINT `ck_jr_active` CHECK((`judgement_runs`.`status` IN ('planned','running','waiting')) = (`judgement_runs`.`active_key` IS NOT NULL)),
	CONSTRAINT `ck_jr_lease` CHECK(`judgement_runs`.`status` <> 'running' OR (`judgement_runs`.`lease_owner` IS NOT NULL AND `judgement_runs`.`lease_expires_at` IS NOT NULL)),
	CONSTRAINT `ck_jr_completed` CHECK((`judgement_runs`.`status` = 'completed') = (`judgement_runs`.`completed_at` IS NOT NULL)),
	CONSTRAINT `ck_jr_expires` CHECK(`judgement_runs`.`expires_at` IS NULL OR `judgement_runs`.`run_kind` <> 'execution'),
	CONSTRAINT `ck_jr_submitter` CHECK(`judgement_runs`.`submitted_by_actor` REGEXP '^user:[0-9]{1,19}$')
);
--> statement-breakpoint
CREATE TABLE `run_contents` (
	`run_id` bigint NOT NULL,
	`content_id` bigint NOT NULL,
	`account_id` bigint NOT NULL,
	`content_snapshot_id` bigint NOT NULL,
	`published_at` datetime(6),
	`like_value` bigint,
	`like_state` varchar(32) NOT NULL,
	`layer1_selected` boolean,
	`layer1_rank` int,
	`l0` varchar(16),
	`l1` varchar(16),
	`l2` varchar(16),
	`l3` varchar(16),
	`final` varchar(16),
	`reason_code` varchar(64),
	`stop_layer` varchar(8),
	`stale` boolean NOT NULL DEFAULT false,
	`cm_total` int,
	`cm_pass` int,
	`cm_unobtained` int,
	`cm_samples` json,
	`evidence` json,
	CONSTRAINT `pk_run_contents` PRIMARY KEY(`run_id`,`content_id`),
	CONSTRAINT `ck_rc_like` CHECK((`run_contents`.`like_state` = 'value' AND `run_contents`.`like_value` IS NOT NULL AND `run_contents`.`like_value` >= 0) OR (`run_contents`.`like_state` IN ('missing','explicit_null','invalid','unsupported') AND `run_contents`.`like_value` IS NULL)),
	CONSTRAINT `ck_rc_l0` CHECK(`run_contents`.`l0` IS NULL OR `run_contents`.`l0` IN ('pass','unobtained')),
	CONSTRAINT `ck_rc_l1` CHECK(`run_contents`.`l1` IS NULL OR `run_contents`.`l1` IN ('pass','fail','unobtained','skipped','not_configured')),
	CONSTRAINT `ck_rc_l2` CHECK(`run_contents`.`l2` IS NULL OR `run_contents`.`l2` IN ('pass','fail','unobtained','skipped','not_configured')),
	CONSTRAINT `ck_rc_l3` CHECK(`run_contents`.`l3` IS NULL OR `run_contents`.`l3` IN ('pass','fail','unobtained','skipped','not_configured')),
	CONSTRAINT `ck_rc_final` CHECK(`run_contents`.`final` IS NULL OR `run_contents`.`final` IN ('pass','fail','unobtained','skipped')),
	CONSTRAINT `ck_rc_selected` CHECK(`run_contents`.`layer1_selected` IS NULL OR COALESCE(`run_contents`.`l1` = 'pass', FALSE)),
	CONSTRAINT `ck_rc_rank` CHECK(`run_contents`.`layer1_rank` IS NULL OR (`run_contents`.`layer1_selected` IS NOT NULL AND `run_contents`.`layer1_rank` > 0)),
	CONSTRAINT `ck_rc_skipped` CHECK(COALESCE(`run_contents`.`final` = 'skipped', FALSE) = COALESCE(`run_contents`.`l1` = 'pass' AND `run_contents`.`layer1_selected` = FALSE, FALSE))
);
--> statement-breakpoint
CREATE TABLE `run_participants` (
	`run_id` bigint NOT NULL,
	`account_id` bigint NOT NULL,
	`staff_id` bigint NOT NULL,
	`store_id` bigint NOT NULL,
	`dealer_id` bigint NOT NULL,
	`brand_id` bigint NOT NULL,
	`sector_id` bigint NOT NULL,
	`branch_id` bigint NOT NULL,
	`region_id` bigint NOT NULL,
	`sync_complete` boolean,
	`sync_reason` varchar(32),
	`content_total` int,
	`content_pass` int,
	`content_fail` int,
	`content_unobtained` int,
	`content_skipped` int,
	`c1_count` int,
	`c2_count` int,
	`c3_count` int,
	`comment_total` int,
	`comment_pass` int,
	`comment_unobtained` int,
	`content_result` varchar(16),
	`comment_result` varchar(16),
	`account_result` varchar(16),
	`plan_result` varchar(16),
	`primary_reason` varchar(64),
	`reason_detail` json,
	`account_detail` json,
	`stale_used` boolean NOT NULL DEFAULT false,
	`state` varchar(16) NOT NULL DEFAULT 'pending',
	CONSTRAINT `pk_run_participants` PRIMARY KEY(`run_id`,`account_id`),
	CONSTRAINT `uq_rp_run_staff` UNIQUE(`run_id`,`staff_id`),
	CONSTRAINT `ck_rp_state` CHECK(`run_participants`.`state` IN ('pending','done')),
	CONSTRAINT `ck_rp_content_result` CHECK(`run_participants`.`content_result` IS NULL OR `run_participants`.`content_result` IN ('success','not_met','unobtained')),
	CONSTRAINT `ck_rp_comment_result` CHECK(`run_participants`.`comment_result` IS NULL OR `run_participants`.`comment_result` IN ('success','not_met','unobtained')),
	CONSTRAINT `ck_rp_account_result` CHECK(`run_participants`.`account_result` IS NULL OR `run_participants`.`account_result` IN ('success','not_met','unobtained')),
	CONSTRAINT `ck_rp_plan_result` CHECK(`run_participants`.`plan_result` IS NULL OR `run_participants`.`plan_result` IN ('success','not_met','unobtained')),
	CONSTRAINT `ck_rp_done` CHECK((`run_participants`.`state` = 'done') = (`run_participants`.`plan_result` IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE `judgement_plan_versions` ADD CONSTRAINT `fk_jpv_plan` FOREIGN KEY (`plan_id`) REFERENCES `judgement_plans`(`plan_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `judgement_plans` ADD CONSTRAINT `fk_jp_activity_plan` FOREIGN KEY (`activity_plan_id`,`platform_id`) REFERENCES `activity_plans`(`plan_id`,`platform_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `judgement_runs` ADD CONSTRAINT `fk_jr_version` FOREIGN KEY (`plan_id`,`version`) REFERENCES `judgement_plan_versions`(`plan_id`,`version`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `run_contents` ADD CONSTRAINT `fk_rc_participant` FOREIGN KEY (`run_id`,`account_id`) REFERENCES `run_participants`(`run_id`,`account_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `run_contents` ADD CONSTRAINT `fk_rc_snapshot` FOREIGN KEY (`content_id`,`content_snapshot_id`) REFERENCES `content_snapshots`(`content_id`,`content_snapshot_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `run_participants` ADD CONSTRAINT `fk_rp_run` FOREIGN KEY (`run_id`) REFERENCES `judgement_runs`(`run_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `run_participants` ADD CONSTRAINT `fk_rp_account` FOREIGN KEY (`account_id`) REFERENCES `external_accounts`(`account_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `run_participants` ADD CONSTRAINT `fk_rp_staff` FOREIGN KEY (`staff_id`) REFERENCES `media_staff`(`staff_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `run_participants` ADD CONSTRAINT `fk_rp_store` FOREIGN KEY (`store_id`) REFERENCES `stores`(`store_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `run_participants` ADD CONSTRAINT `fk_rp_dealer` FOREIGN KEY (`dealer_id`) REFERENCES `dealers`(`dealer_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `run_participants` ADD CONSTRAINT `fk_rp_brand` FOREIGN KEY (`brand_id`) REFERENCES `brands`(`brand_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `run_participants` ADD CONSTRAINT `fk_rp_sector` FOREIGN KEY (`sector_id`) REFERENCES `sectors`(`sector_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `run_participants` ADD CONSTRAINT `fk_rp_branch` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`branch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `run_participants` ADD CONSTRAINT `fk_rp_region` FOREIGN KEY (`region_id`) REFERENCES `regions`(`region_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_jp_activity_status` ON `judgement_plans` (`activity_plan_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_jr_claim` ON `judgement_runs` (`status`,`next_tick_at`,`run_id`);--> statement-breakpoint
CREATE INDEX `idx_jr_plan_version` ON `judgement_runs` (`plan_id`,`version`,`run_kind`,`status`);--> statement-breakpoint
CREATE INDEX `idx_jr_completed` ON `judgement_runs` (`run_kind`,`status`,`completed_at`,`run_id`);--> statement-breakpoint
CREATE INDEX `idx_rc_account_final` ON `run_contents` (`run_id`,`account_id`,`final`);--> statement-breakpoint
CREATE INDEX `idx_rc_l1` ON `run_contents` (`run_id`,`l1`);--> statement-breakpoint
CREATE INDEX `idx_rc_account_selected` ON `run_contents` (`run_id`,`account_id`,`layer1_selected`);--> statement-breakpoint
CREATE INDEX `idx_rp_result` ON `run_participants` (`run_id`,`plan_result`);--> statement-breakpoint
CREATE INDEX `idx_rp_branch` ON `run_participants` (`run_id`,`branch_id`);--> statement-breakpoint
CREATE INDEX `idx_rp_store` ON `run_participants` (`run_id`,`store_id`);