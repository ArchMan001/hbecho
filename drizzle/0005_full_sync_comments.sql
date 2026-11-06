CREATE TABLE `comments` (
	`comment_id` bigint AUTO_INCREMENT NOT NULL,
	`content_id` bigint NOT NULL,
	`platform_comment_id` varchar(2048) character set utf8mb4 collate utf8mb4_bin NOT NULL,
	`platform_comment_id_sha256` binary(32) NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'active',
	`author_identifier` varchar(2048) character set utf8mb4 collate utf8mb4_bin,
	`author_name` varchar(512),
	`content_text` longtext,
	`like_value` bigint,
	`like_state` varchar(32) NOT NULL,
	`reply_value` bigint,
	`reply_state` varchar(32) NOT NULL,
	`platform_created_at` datetime(6),
	`provider_updated_at` datetime(6),
	`first_seen_at` datetime(6) NOT NULL,
	`last_seen_at` datetime(6) NOT NULL,
	`suspected_deleted_at` datetime(6),
	`deleted_at` datetime(6),
	`last_provider_call_id` bigint,
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `comments_comment_id` PRIMARY KEY(`comment_id`),
	CONSTRAINT `uq_comments_content_comment` UNIQUE(`content_id`,`platform_comment_id_sha256`),
	CONSTRAINT `ck_comments_status` CHECK(`comments`.`status` IN ('active','suspected_deleted','deleted')),
	CONSTRAINT `ck_comments_like` CHECK((`comments`.`like_state` = 'value' AND `comments`.`like_value` IS NOT NULL AND `comments`.`like_value` >= 0) OR (`comments`.`like_state` IN ('missing','explicit_null','invalid','unsupported') AND `comments`.`like_value` IS NULL)),
	CONSTRAINT `ck_comments_reply` CHECK((`comments`.`reply_state` = 'value' AND `comments`.`reply_value` IS NOT NULL AND `comments`.`reply_value` >= 0) OR (`comments`.`reply_state` IN ('missing','explicit_null','invalid','unsupported') AND `comments`.`reply_value` IS NULL))
);
--> statement-breakpoint
ALTER TABLE `comments` ADD CONSTRAINT `comments_content_id_contents_content_id_fk` FOREIGN KEY (`content_id`) REFERENCES `contents`(`content_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `comments` ADD CONSTRAINT `fk_comments_call` FOREIGN KEY (`last_provider_call_id`) REFERENCES `ods_provider_calls`(`provider_call_id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_comments_content_status_created` ON `comments` (`content_id`,`status`,`platform_created_at`);--> statement-breakpoint
CREATE INDEX `idx_comments_last_seen` ON `comments` (`last_seen_at`);