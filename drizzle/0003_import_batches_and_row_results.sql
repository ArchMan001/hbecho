CREATE TABLE `import_batches` (
	`import_batch_id` bigint AUTO_INCREMENT NOT NULL,
	`import_kind` varchar(16) NOT NULL,
	`plan_id` bigint,
	`uploaded_by_actor` varchar(128) NOT NULL,
	`uploaded_by_user_id` bigint,
	`uploaded_at` datetime(6) NOT NULL,
	`file_name` varchar(512),
	`file_sha256` binary(32),
	`template_version` varchar(32),
	`brand_scope` json,
	`total_rows` int NOT NULL,
	`new_rows` int NOT NULL DEFAULT 0,
	`skipped_rows` int NOT NULL DEFAULT 0,
	`error_rows` int NOT NULL DEFAULT 0,
	`conflict_rows` int NOT NULL DEFAULT 0,
	`summary` json,
	`status` varchar(16) NOT NULL,
	`writing_token` varchar(36),
	`heartbeat_at` datetime(6),
	`confirmed_by_actor` varchar(128),
	`confirmed_by_user_id` bigint,
	`confirmed_at` datetime(6),
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `import_batches_import_batch_id` PRIMARY KEY(`import_batch_id`),
	CONSTRAINT `ck_import_batches_kind` CHECK(`import_batches`.`import_kind` IN ('master_data','roster')),
	CONSTRAINT `ck_import_batches_status` CHECK(`import_batches`.`status` IN ('prechecking','precheck_failed','awaiting_confirm','writing','completed','failed')),
	CONSTRAINT `ck_import_batches_rows` CHECK(`import_batches`.`total_rows` >= 0)
);
--> statement-breakpoint
CREATE TABLE `import_row_results` (
	`import_row_result_id` bigint AUTO_INCREMENT NOT NULL,
	`import_batch_id` bigint NOT NULL,
	`row_no` int NOT NULL,
	`raw_row` json NOT NULL,
	`precheck_class` varchar(32),
	`outcome` varchar(32),
	`reason_code` varchar(64),
	`reason_detail` varchar(1024),
	`store_id` bigint,
	`account_id` bigint,
	`staff_id` bigint,
	`resolved_at` datetime(6),
	`resolved_by_actor` varchar(128),
	`resolved_by_user_id` bigint,
	`created_at` datetime(6) NOT NULL,
	CONSTRAINT `import_row_results_import_row_result_id` PRIMARY KEY(`import_row_result_id`),
	CONSTRAINT `uq_import_rows_batch_row` UNIQUE(`import_batch_id`,`row_no`),
	CONSTRAINT `ck_import_rows_precheck` CHECK(`import_row_results`.`precheck_class` IS NULL OR `import_row_results`.`precheck_class` IN ('new','update','unchanged','error','needs_superadmin')),
	CONSTRAINT `ck_import_rows_outcome` CHECK(`import_row_results`.`outcome` IS NULL OR `import_row_results`.`outcome` IN ('imported','unchanged','conflict','invalid')),
	CONSTRAINT `ck_import_rows_row_no` CHECK(`import_row_results`.`row_no` >= 1)
);
--> statement-breakpoint
ALTER TABLE `data_quality_issues` ADD `import_batch_id` bigint;--> statement-breakpoint
ALTER TABLE `data_quality_issues` ADD `resolved_by_actor` varchar(128);--> statement-breakpoint
ALTER TABLE `import_row_results` ADD CONSTRAINT `fk_import_rows_batch` FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`import_batch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_import_batches_kind` ON `import_batches` (`import_kind`,`uploaded_at`);--> statement-breakpoint
CREATE INDEX `idx_import_batches_plan` ON `import_batches` (`plan_id`,`uploaded_at`);--> statement-breakpoint
CREATE INDEX `idx_import_rows_precheck` ON `import_row_results` (`precheck_class`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_import_rows_outcome` ON `import_row_results` (`outcome`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_import_rows_store` ON `import_row_results` (`store_id`);--> statement-breakpoint
CREATE INDEX `idx_import_rows_account` ON `import_row_results` (`account_id`);--> statement-breakpoint
ALTER TABLE `data_quality_issues` ADD CONSTRAINT `ck_issues_one_batch_kind` CHECK (`data_quality_issues`.`batch_id` IS NULL OR `data_quality_issues`.`import_batch_id` IS NULL);--> statement-breakpoint
ALTER TABLE `stores` ADD CONSTRAINT `stores_source_batch_id_import_batches_import_batch_id_fk` FOREIGN KEY (`source_batch_id`) REFERENCES `import_batches`(`import_batch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `data_quality_issues` ADD CONSTRAINT `fk_issues_import_batch` FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`import_batch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_issues_import_batch` ON `data_quality_issues` (`import_batch_id`);