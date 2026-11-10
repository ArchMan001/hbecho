CREATE TABLE `access_bootstrap_tokens` (
	`token_id` bigint AUTO_INCREMENT NOT NULL,
	`token_sha256` binary(32) NOT NULL,
	`created_by_actor` varchar(128) NOT NULL,
	`created_at` datetime(6) NOT NULL,
	`expires_at` datetime(6) NOT NULL,
	`consumed_at` datetime(6),
	`consumed_user_id` bigint,
	CONSTRAINT `access_bootstrap_tokens_token_id` PRIMARY KEY(`token_id`),
	CONSTRAINT `uq_access_bootstrap_token` UNIQUE(`token_sha256`),
	CONSTRAINT `ck_access_bootstrap_consumed` CHECK((`access_bootstrap_tokens`.`consumed_at` IS NULL) = (`access_bootstrap_tokens`.`consumed_user_id` IS NULL))
);
--> statement-breakpoint
CREATE TABLE `access_login_failures` (
	`phone_norm` varchar(32) NOT NULL,
	`fail_count` int NOT NULL,
	`locked_until` datetime(6),
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `access_login_failures_phone_norm` PRIMARY KEY(`phone_norm`),
	CONSTRAINT `ck_access_login_failures_count` CHECK(`access_login_failures`.`fail_count` >= 0)
);
--> statement-breakpoint
CREATE TABLE `access_sms_sends` (
	`send_id` bigint AUTO_INCREMENT NOT NULL,
	`phone_norm` varchar(32) NOT NULL,
	`purpose` varchar(16) NOT NULL,
	`requested_at` datetime(6) NOT NULL,
	`outcome` varchar(16) NOT NULL,
	`provider_ref` varchar(64),
	CONSTRAINT `access_sms_sends_send_id` PRIMARY KEY(`send_id`),
	CONSTRAINT `ck_access_sms_purpose` CHECK(`access_sms_sends`.`purpose` IN ('activate','login','reset')),
	CONSTRAINT `ck_access_sms_outcome` CHECK(`access_sms_sends`.`outcome` IN ('sent','suppressed','failed','rate_limited'))
);
--> statement-breakpoint
CREATE TABLE `access_user_branches` (
	`user_id` bigint NOT NULL,
	`branch_id` bigint NOT NULL,
	CONSTRAINT `pk_access_user_branches` PRIMARY KEY(`user_id`,`branch_id`)
);
--> statement-breakpoint
CREATE TABLE `access_user_brands` (
	`user_id` bigint NOT NULL,
	`brand_id` bigint NOT NULL,
	CONSTRAINT `pk_access_user_brands` PRIMARY KEY(`user_id`,`brand_id`)
);
--> statement-breakpoint
CREATE TABLE `access_users` (
	`user_id` bigint NOT NULL,
	`role_code` varchar(32) NOT NULL,
	`display_name` varchar(100) NOT NULL,
	`phone` varchar(32) NOT NULL,
	`status` varchar(24) NOT NULL,
	`active_phone` varchar(32) GENERATED ALWAYS AS ((CASE WHEN status IN ('pending_activation','active') THEN phone END)) STORED,
	`status_before_disable` varchar(24),
	`disabled_at` datetime(6),
	`disabled_by_actor` varchar(128),
	`disabled_reason` varchar(48),
	`auto_disabled_staff_id` bigint,
	`media_staff_id` bigint,
	`active_media_staff` bigint GENERATED ALWAYS AS ((CASE WHEN status <> 'disabled' THEN media_staff_id END)) STORED,
	`activated_at` datetime(6),
	`created_by_actor` varchar(128) NOT NULL,
	`created_by_user_id` bigint,
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `access_users_user_id` PRIMARY KEY(`user_id`),
	CONSTRAINT `uq_access_users_active_phone` UNIQUE(`active_phone`),
	CONSTRAINT `uq_access_users_active_staff` UNIQUE(`active_media_staff`),
	CONSTRAINT `ck_access_users_role` CHECK(`access_users`.`role_code` IN ('platform_admin','hq_manager','branch_manager','store_staff')),
	CONSTRAINT `ck_access_users_status` CHECK(`access_users`.`status` IN ('pending_activation','active','disabled')),
	CONSTRAINT `ck_access_users_disabled_at` CHECK((`access_users`.`status` = 'disabled') = (`access_users`.`disabled_at` IS NOT NULL)),
	CONSTRAINT `ck_access_users_before_disable` CHECK((`access_users`.`status` = 'disabled') = (`access_users`.`status_before_disable` IS NOT NULL)),
	CONSTRAINT `ck_access_users_before_values` CHECK(`access_users`.`status_before_disable` IS NULL OR `access_users`.`status_before_disable` IN ('pending_activation','active')),
	CONSTRAINT `ck_access_users_reason` CHECK(`access_users`.`disabled_reason` IS NULL OR `access_users`.`disabled_reason` IN ('manual','media_staff_disabled')),
	CONSTRAINT `ck_access_users_staff_role` CHECK(`access_users`.`role_code` = 'store_staff' OR `access_users`.`media_staff_id` IS NULL)
);
--> statement-breakpoint
CREATE TABLE `audit_events` (
	`audit_id` bigint AUTO_INCREMENT NOT NULL,
	`occurred_at` datetime(6) NOT NULL,
	`actor` varchar(128) NOT NULL,
	`actor_user_id` bigint,
	`event_type` varchar(64) NOT NULL,
	`outcome` varchar(16) NOT NULL,
	`reason_code` varchar(64) NOT NULL,
	`target_type` varchar(32),
	`target_id` varchar(64),
	`batch_ref` bigint,
	`scope_summary` json,
	`detail` json,
	`request_id` varchar(64),
	`idempotency_key` binary(32),
	CONSTRAINT `audit_events_audit_id` PRIMARY KEY(`audit_id`),
	CONSTRAINT `uq_audit_events_idem` UNIQUE(`idempotency_key`),
	CONSTRAINT `ck_audit_events_outcome` CHECK(`audit_events`.`outcome` IN ('succeeded','denied','failed'))
);
--> statement-breakpoint
CREATE TABLE `auth_accounts` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`account_id` varchar(191) NOT NULL,
	`provider_id` varchar(64) NOT NULL,
	`user_id` bigint NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` datetime(6),
	`refresh_token_expires_at` datetime(6),
	`scope` text,
	`password` text,
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `auth_accounts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`expires_at` datetime(6) NOT NULL,
	`token` varchar(191) NOT NULL,
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	`ip_address` varchar(64),
	`user_agent` varchar(255),
	`user_id` bigint NOT NULL,
	CONSTRAINT `auth_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_auth_sessions_token` UNIQUE(`token`)
);
--> statement-breakpoint
CREATE TABLE `auth_users` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`name` varchar(100) NOT NULL,
	`email` varchar(191) NOT NULL,
	`email_verified` boolean NOT NULL DEFAULT false,
	`image` text,
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	`phone_number` varchar(64),
	`phone_number_verified` boolean,
	CONSTRAINT `auth_users_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_auth_users_email` UNIQUE(`email`),
	CONSTRAINT `uq_auth_users_phone` UNIQUE(`phone_number`)
);
--> statement-breakpoint
CREATE TABLE `auth_verifications` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`identifier` varchar(191) NOT NULL,
	`value` varchar(255) NOT NULL,
	`expires_at` datetime(6) NOT NULL,
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `auth_verifications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `import_batches` DROP CONSTRAINT `ck_import_batches_kind`;--> statement-breakpoint
ALTER TABLE `access_user_branches` ADD CONSTRAINT `fk_access_user_branches_user` FOREIGN KEY (`user_id`) REFERENCES `access_users`(`user_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `access_user_branches` ADD CONSTRAINT `fk_access_user_branches_branch` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`branch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `access_user_brands` ADD CONSTRAINT `fk_access_user_brands_user` FOREIGN KEY (`user_id`) REFERENCES `access_users`(`user_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `access_user_brands` ADD CONSTRAINT `fk_access_user_brands_brand` FOREIGN KEY (`brand_id`) REFERENCES `brands`(`brand_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `access_users` ADD CONSTRAINT `fk_access_users_auth` FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `access_users` ADD CONSTRAINT `fk_access_users_staff` FOREIGN KEY (`media_staff_id`) REFERENCES `media_staff`(`staff_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `access_users` ADD CONSTRAINT `fk_access_users_auto_staff` FOREIGN KEY (`auto_disabled_staff_id`) REFERENCES `media_staff`(`staff_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `auth_accounts` ADD CONSTRAINT `fk_auth_accounts_user` FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `auth_sessions` ADD CONSTRAINT `fk_auth_sessions_user` FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_access_login_failures_updated` ON `access_login_failures` (`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_access_sms_phone_time` ON `access_sms_sends` (`phone_norm`,`requested_at`);--> statement-breakpoint
CREATE INDEX `idx_access_sms_time_outcome` ON `access_sms_sends` (`requested_at`,`outcome`);--> statement-breakpoint
CREATE INDEX `idx_access_user_branches_branch` ON `access_user_branches` (`branch_id`);--> statement-breakpoint
CREATE INDEX `idx_access_user_brands_brand` ON `access_user_brands` (`brand_id`);--> statement-breakpoint
CREATE INDEX `idx_access_users_role_status` ON `access_users` (`role_code`,`status`);--> statement-breakpoint
CREATE INDEX `idx_access_users_phone` ON `access_users` (`phone`);--> statement-breakpoint
CREATE INDEX `idx_audit_events_time` ON `audit_events` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_events_actor` ON `audit_events` (`actor`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_events_target` ON `audit_events` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_events_type` ON `audit_events` (`event_type`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_auth_accounts_user` ON `auth_accounts` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_auth_sessions_user` ON `auth_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_auth_verifications_identifier` ON `auth_verifications` (`identifier`);--> statement-breakpoint
ALTER TABLE `import_batches` ADD CONSTRAINT `ck_import_batches_kind` CHECK (`import_batches`.`import_kind` IN ('master_data','roster','user_import'));