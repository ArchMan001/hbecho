CREATE TABLE `activity_plan_branches` (
	`plan_id` bigint NOT NULL,
	`branch_id` bigint NOT NULL,
	`status` varchar(16) NOT NULL,
	`joined_at` datetime(6) NOT NULL,
	`joined_by_actor` varchar(128) NOT NULL,
	`exited_at` datetime(6),
	`exited_by_actor` varchar(128),
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `pk_plan_branches` PRIMARY KEY(`plan_id`,`branch_id`),
	CONSTRAINT `ck_plan_branches_status` CHECK(`activity_plan_branches`.`status` IN ('joined','exited')),
	CONSTRAINT `ck_plan_branches_exited` CHECK((`activity_plan_branches`.`status` = 'exited') = (`activity_plan_branches`.`exited_at` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `activity_plan_changes` (
	`change_id` bigint AUTO_INCREMENT NOT NULL,
	`plan_id` bigint NOT NULL,
	`branch_id` bigint,
	`event_type` varchar(48) NOT NULL,
	`actor` varchar(128) NOT NULL,
	`occurred_at` datetime(6) NOT NULL,
	`detail` json,
	CONSTRAINT `activity_plan_changes_change_id` PRIMARY KEY(`change_id`)
);
--> statement-breakpoint
CREATE TABLE `activity_plan_owners` (
	`plan_id` bigint NOT NULL,
	`branch_id` bigint NOT NULL,
	`slot_no` tinyint NOT NULL,
	`owner_actor` varchar(128) NOT NULL,
	`owner_user_id` bigint,
	`owner_display_name` varchar(100),
	`claimed_at` datetime(6) NOT NULL,
	`claimed_via` varchar(16) NOT NULL,
	`claimed_batch_id` bigint,
	CONSTRAINT `pk_plan_owners` PRIMARY KEY(`plan_id`,`branch_id`,`slot_no`),
	CONSTRAINT `uq_plan_owners_actor` UNIQUE(`plan_id`,`branch_id`,`owner_actor`),
	CONSTRAINT `ck_plan_owners_slot` CHECK(`activity_plan_owners`.`slot_no` IN (1,2)),
	CONSTRAINT `ck_plan_owners_via` CHECK(`activity_plan_owners`.`claimed_via` IN ('import','replace'))
);
--> statement-breakpoint
CREATE TABLE `activity_plan_roster` (
	`roster_entry_id` bigint AUTO_INCREMENT NOT NULL,
	`plan_id` bigint NOT NULL,
	`platform_id` bigint NOT NULL,
	`account_id` bigint NOT NULL,
	`branch_id` bigint NOT NULL,
	`store_id` bigint NOT NULL,
	`staff_id` bigint NOT NULL,
	`entry_state` varchar(16) NOT NULL,
	`added_at` datetime(6) NOT NULL,
	`added_by_actor` varchar(128) NOT NULL,
	`added_batch_id` bigint,
	`removed_at` datetime(6),
	`removed_by_actor` varchar(128),
	`removed_reason` varchar(16),
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `activity_plan_roster_roster_entry_id` PRIMARY KEY(`roster_entry_id`),
	CONSTRAINT `uq_roster_plan_account` UNIQUE(`plan_id`,`account_id`),
	CONSTRAINT `ck_roster_state` CHECK(`activity_plan_roster`.`entry_state` IN ('in_roster','removed')),
	CONSTRAINT `ck_roster_removed_reason` CHECK(`activity_plan_roster`.`removed_reason` IS NULL OR `activity_plan_roster`.`removed_reason` IN ('manual_remove','branch_exit')),
	CONSTRAINT `ck_roster_removed_fields` CHECK((`activity_plan_roster`.`entry_state` = 'removed') = (`activity_plan_roster`.`removed_at` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `activity_plan_sectors` (
	`plan_id` bigint NOT NULL,
	`sector_key` varchar(16) NOT NULL,
	CONSTRAINT `pk_plan_sectors` PRIMARY KEY(`plan_id`,`sector_key`),
	CONSTRAINT `ck_plan_sectors_key` CHECK(`activity_plan_sectors`.`sector_key` IN ('water','home'))
);
--> statement-breakpoint
CREATE TABLE `activity_plans` (
	`plan_id` bigint AUTO_INCREMENT NOT NULL,
	`plan_name` varchar(200) NOT NULL,
	`description` varchar(2000),
	`brand_id` bigint NOT NULL,
	`platform_id` bigint NOT NULL,
	`starts_on` date NOT NULL,
	`ends_on` date,
	`status` varchar(16) NOT NULL,
	`status_changed_at` datetime(6) NOT NULL,
	`status_before_delete` varchar(16),
	`deleted_at` datetime(6),
	`deleted_by_actor` varchar(128),
	`purge_after` datetime(6),
	`created_by_actor` varchar(128) NOT NULL,
	`created_by_user_id` bigint,
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `activity_plans_plan_id` PRIMARY KEY(`plan_id`),
	CONSTRAINT `uq_plans_id_platform` UNIQUE(`plan_id`,`platform_id`),
	CONSTRAINT `ck_plans_status` CHECK(`activity_plans`.`status` IN ('collecting','paused','archived','deleted')),
	CONSTRAINT `ck_plans_dates` CHECK(`activity_plans`.`ends_on` IS NULL OR `activity_plans`.`ends_on` >= `activity_plans`.`starts_on`),
	CONSTRAINT `ck_plans_before_delete` CHECK(`activity_plans`.`status_before_delete` IS NULL OR `activity_plans`.`status_before_delete` IN ('collecting','paused','archived')),
	CONSTRAINT `ck_plans_deleted_fields` CHECK((`activity_plans`.`status` = 'deleted') = (`activity_plans`.`deleted_at` IS NOT NULL AND `activity_plans`.`status_before_delete` IS NOT NULL AND `activity_plans`.`purge_after` IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE `import_batches` DROP CONSTRAINT `ck_import_batches_status`;--> statement-breakpoint
ALTER TABLE `import_row_results` DROP CONSTRAINT `ck_import_rows_precheck`;--> statement-breakpoint
ALTER TABLE `import_row_results` DROP CONSTRAINT `ck_import_rows_outcome`;--> statement-breakpoint
DROP INDEX `idx_assignments_watch_monitoring` ON `staff_account_assignments`;--> statement-breakpoint
ALTER TABLE `staff_account_assignments` ADD `unreferenced_since` datetime(6);--> statement-breakpoint
ALTER TABLE `import_batches` ADD `submitter_branch_id` bigint;--> statement-breakpoint
ALTER TABLE `import_row_results` ADD `resolve_task_id` bigint;--> statement-breakpoint
ALTER TABLE `activity_plan_branches` ADD CONSTRAINT `fk_plan_branches_plan` FOREIGN KEY (`plan_id`) REFERENCES `activity_plans`(`plan_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `activity_plan_branches` ADD CONSTRAINT `fk_plan_branches_branch` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`branch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `activity_plan_changes` ADD CONSTRAINT `fk_plan_changes_plan` FOREIGN KEY (`plan_id`) REFERENCES `activity_plans`(`plan_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `activity_plan_owners` ADD CONSTRAINT `fk_plan_owners_participation` FOREIGN KEY (`plan_id`,`branch_id`) REFERENCES `activity_plan_branches`(`plan_id`,`branch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `activity_plan_owners` ADD CONSTRAINT `fk_plan_owners_batch` FOREIGN KEY (`claimed_batch_id`) REFERENCES `import_batches`(`import_batch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `activity_plan_roster` ADD CONSTRAINT `fk_roster_plan_platform` FOREIGN KEY (`plan_id`,`platform_id`) REFERENCES `activity_plans`(`plan_id`,`platform_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `activity_plan_roster` ADD CONSTRAINT `fk_roster_account_platform` FOREIGN KEY (`account_id`,`platform_id`) REFERENCES `external_accounts`(`account_id`,`platform_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `activity_plan_roster` ADD CONSTRAINT `fk_roster_branch` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`branch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `activity_plan_roster` ADD CONSTRAINT `fk_roster_store` FOREIGN KEY (`store_id`) REFERENCES `stores`(`store_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `activity_plan_roster` ADD CONSTRAINT `fk_roster_staff` FOREIGN KEY (`staff_id`) REFERENCES `media_staff`(`staff_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `activity_plan_roster` ADD CONSTRAINT `fk_roster_batch` FOREIGN KEY (`added_batch_id`) REFERENCES `import_batches`(`import_batch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `activity_plan_sectors` ADD CONSTRAINT `fk_plan_sectors_plan` FOREIGN KEY (`plan_id`) REFERENCES `activity_plans`(`plan_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `activity_plans` ADD CONSTRAINT `fk_plans_brand` FOREIGN KEY (`brand_id`) REFERENCES `brands`(`brand_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `activity_plans` ADD CONSTRAINT `fk_plans_platform` FOREIGN KEY (`platform_id`) REFERENCES `platforms`(`platform_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_plan_branches_branch_status` ON `activity_plan_branches` (`branch_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_plan_changes_plan_time` ON `activity_plan_changes` (`plan_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_plan_owners_batch` ON `activity_plan_owners` (`claimed_batch_id`);--> statement-breakpoint
CREATE INDEX `idx_roster_plan_branch_state` ON `activity_plan_roster` (`plan_id`,`branch_id`,`entry_state`);--> statement-breakpoint
CREATE INDEX `idx_roster_account_state` ON `activity_plan_roster` (`account_id`,`entry_state`);--> statement-breakpoint
CREATE INDEX `idx_roster_staff` ON `activity_plan_roster` (`staff_id`);--> statement-breakpoint
CREATE INDEX `idx_roster_batch` ON `activity_plan_roster` (`added_batch_id`);--> statement-breakpoint
CREATE INDEX `idx_plans_brand_status` ON `activity_plans` (`brand_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_plans_creator_status` ON `activity_plans` (`created_by_actor`,`status`);--> statement-breakpoint
CREATE INDEX `idx_plans_status_purge` ON `activity_plans` (`status`,`purge_after`);--> statement-breakpoint
ALTER TABLE `import_batches` ADD CONSTRAINT `ck_import_batches_roster_plan` CHECK (`import_batches`.`import_kind` <> 'roster' OR `import_batches`.`plan_id` IS NOT NULL);--> statement-breakpoint
ALTER TABLE `import_batches` ADD CONSTRAINT `ck_import_batches_status` CHECK (`import_batches`.`status` IN ('prechecking','precheck_failed','awaiting_confirm','writing','resolving','completed','failed'));--> statement-breakpoint
ALTER TABLE `import_row_results` ADD CONSTRAINT `ck_import_rows_precheck` CHECK (`import_row_results`.`precheck_class` IS NULL OR `import_row_results`.`precheck_class` IN ('new','new_staff','update','unchanged','error','needs_superadmin'));--> statement-breakpoint
ALTER TABLE `import_row_results` ADD CONSTRAINT `ck_import_rows_outcome` CHECK (`import_row_results`.`outcome` IS NULL OR `import_row_results`.`outcome` IN ('imported','unchanged','conflict','invalid','pending_account','suspected_empty','resolve_failed'));--> statement-breakpoint
ALTER TABLE `import_batches` ADD CONSTRAINT `fk_import_batches_submitter_branch` FOREIGN KEY (`submitter_branch_id`) REFERENCES `branches`(`branch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `import_row_results` ADD CONSTRAINT `fk_import_rows_resolve_task` FOREIGN KEY (`resolve_task_id`) REFERENCES `sync_tasks`(`task_id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_import_batches_plan_branch` ON `import_batches` (`plan_id`,`submitter_branch_id`);--> statement-breakpoint
CREATE INDEX `idx_import_rows_resolve_task` ON `import_row_results` (`resolve_task_id`);--> statement-breakpoint
CREATE INDEX `idx_assignments_watch_monitoring` ON `staff_account_assignments` (`watch_type`,`monitoring_enabled`,`unreferenced_since`);