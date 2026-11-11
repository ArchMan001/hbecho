CREATE TABLE `course_brand_scopes` (
	`course_id` bigint NOT NULL,
	`brand_id` bigint NOT NULL,
	CONSTRAINT `pk_course_brand_scopes` PRIMARY KEY(`course_id`,`brand_id`)
);
--> statement-breakpoint
CREATE TABLE `course_tags` (
	`course_id` bigint NOT NULL,
	`tag_id` bigint NOT NULL,
	CONSTRAINT `pk_course_tags` PRIMARY KEY(`course_id`,`tag_id`)
);
--> statement-breakpoint
CREATE TABLE `courses` (
	`course_id` bigint AUTO_INCREMENT NOT NULL,
	`title` varchar(200) NOT NULL,
	`kind` varchar(16) NOT NULL,
	`description` text,
	`status` varchar(16) NOT NULL,
	`brand_scope` varchar(16) NOT NULL,
	`audience_level` varchar(24) NOT NULL DEFAULT 'all',
	`cover_key` varchar(512) character set ascii collate ascii_bin,
	`vod_video_id` varchar(64),
	`vod_video_status` varchar(16),
	`file_key` varchar(512) character set ascii collate ascii_bin,
	`file_mime` varchar(128),
	`file_size` bigint,
	`duration_sec` int,
	`created_by` bigint NOT NULL,
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `courses_course_id` PRIMARY KEY(`course_id`),
	CONSTRAINT `uq_courses_file_key` UNIQUE(`file_key`),
	CONSTRAINT `uq_courses_cover_key` UNIQUE(`cover_key`),
	CONSTRAINT `ck_courses_kind` CHECK(`courses`.`kind` IN ('video','document')),
	CONSTRAINT `ck_courses_status` CHECK(`courses`.`status` IN ('published','unpublished','archived')),
	CONSTRAINT `ck_courses_brand_scope` CHECK(`courses`.`brand_scope` IN ('specified','all')),
	CONSTRAINT `ck_courses_audience` CHECK(`courses`.`audience_level` IN ('all','branch_and_above','hq_and_above')),
	CONSTRAINT `ck_courses_vod_status` CHECK(`courses`.`vod_video_status` IS NULL OR `courses`.`vod_video_status` IN ('uploading','transcoding','normal','failed')),
	CONSTRAINT `ck_courses_file_mime` CHECK(`courses`.`file_mime` IS NULL OR `courses`.`file_mime` IN ('application/pdf','image/jpeg','image/png')),
	CONSTRAINT `ck_courses_file_size` CHECK(`courses`.`file_size` IS NULL OR `courses`.`file_size` > 0),
	CONSTRAINT `ck_courses_duration` CHECK(`courses`.`duration_sec` IS NULL OR `courses`.`duration_sec` >= 0),
	CONSTRAINT `ck_courses_kind_fields` CHECK((`courses`.`kind` = 'video' AND `courses`.`vod_video_id` IS NOT NULL AND `courses`.`vod_video_status` IS NOT NULL AND `courses`.`cover_key` IS NOT NULL
            AND `courses`.`file_key` IS NULL AND `courses`.`file_mime` IS NULL AND `courses`.`file_size` IS NULL)
        OR (`courses`.`kind` = 'document' AND `courses`.`file_key` IS NOT NULL AND `courses`.`file_mime` IS NOT NULL AND `courses`.`file_size` IS NOT NULL
            AND `courses`.`vod_video_id` IS NULL AND `courses`.`vod_video_status` IS NULL))
);
--> statement-breakpoint
CREATE TABLE `learning_progress` (
	`progress_id` bigint AUTO_INCREMENT NOT NULL,
	`user_id` bigint NOT NULL,
	`course_id` bigint NOT NULL,
	`position_sec` int NOT NULL DEFAULT 0,
	`watched_sec` bigint NOT NULL DEFAULT 0,
	`play_count` int NOT NULL DEFAULT 0,
	`first_learned_at` datetime(6) NOT NULL,
	`last_learned_at` datetime(6) NOT NULL,
	CONSTRAINT `learning_progress_progress_id` PRIMARY KEY(`progress_id`),
	CONSTRAINT `uq_learning_progress_user_course` UNIQUE(`user_id`,`course_id`),
	CONSTRAINT `ck_learning_progress_nonneg` CHECK(`learning_progress`.`position_sec` >= 0 AND `learning_progress`.`watched_sec` >= 0 AND `learning_progress`.`play_count` >= 0)
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`tag_id` bigint AUTO_INCREMENT NOT NULL,
	`name` varchar(32) NOT NULL,
	`created_at` datetime(6) NOT NULL,
	CONSTRAINT `tags_tag_id` PRIMARY KEY(`tag_id`),
	CONSTRAINT `uq_tags_name` UNIQUE(`name`)
);
--> statement-breakpoint
ALTER TABLE `course_brand_scopes` ADD CONSTRAINT `fk_course_brand_scopes_course` FOREIGN KEY (`course_id`) REFERENCES `courses`(`course_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `course_brand_scopes` ADD CONSTRAINT `fk_course_brand_scopes_brand` FOREIGN KEY (`brand_id`) REFERENCES `brands`(`brand_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `course_tags` ADD CONSTRAINT `fk_course_tags_course` FOREIGN KEY (`course_id`) REFERENCES `courses`(`course_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `course_tags` ADD CONSTRAINT `fk_course_tags_tag` FOREIGN KEY (`tag_id`) REFERENCES `tags`(`tag_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `courses` ADD CONSTRAINT `fk_courses_created_by` FOREIGN KEY (`created_by`) REFERENCES `access_users`(`user_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `learning_progress` ADD CONSTRAINT `fk_learning_progress_user` FOREIGN KEY (`user_id`) REFERENCES `access_users`(`user_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `learning_progress` ADD CONSTRAINT `fk_learning_progress_course` FOREIGN KEY (`course_id`) REFERENCES `courses`(`course_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_course_brand_scopes_brand` ON `course_brand_scopes` (`brand_id`,`course_id`);--> statement-breakpoint
CREATE INDEX `idx_course_tags_tag` ON `course_tags` (`tag_id`);--> statement-breakpoint
CREATE INDEX `idx_courses_status_updated` ON `courses` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_learning_progress_user_last` ON `learning_progress` (`user_id`,`last_learned_at`);