CREATE TABLE `comment_features` (
	`comment_id` bigint NOT NULL,
	`text_material_sha256` binary(32) NOT NULL,
	`text_normalized` longtext,
	`signals` json NOT NULL,
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `comment_features_comment_id` PRIMARY KEY(`comment_id`),
	CONSTRAINT `ck_comment_features_signals` CHECK(JSON_TYPE(`comment_features`.`signals`) = 'OBJECT'),
	CONSTRAINT `ck_comment_features_text` CHECK((`comment_features`.`text_normalized` IS NOT NULL) = (JSON_UNQUOTE(JSON_EXTRACT(`comment_features`.`signals`, '$."comment.text_normalized".state')) <=> 'valid')),
	CONSTRAINT `ck_comment_features_states` CHECK(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(`comment_features`.`signals`, '$."comment.text_normalized".state')), 'valid') IN ('valid','failed'))
);
--> statement-breakpoint
CREATE TABLE `content_features` (
	`content_id` bigint NOT NULL,
	`content_snapshot_id` bigint NOT NULL,
	`text_material_sha256` binary(32) NOT NULL,
	`title_normalized` longtext,
	`body_normalized` longtext,
	`hashtags` json,
	`signals` json NOT NULL,
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `content_features_content_id` PRIMARY KEY(`content_id`),
	CONSTRAINT `ck_content_features_signals` CHECK(JSON_TYPE(`content_features`.`signals`) = 'OBJECT'),
	CONSTRAINT `ck_content_features_hashtags` CHECK(`content_features`.`hashtags` IS NULL OR JSON_TYPE(`content_features`.`hashtags`) = 'ARRAY'),
	CONSTRAINT `ck_content_features_title` CHECK((`content_features`.`title_normalized` IS NOT NULL) = (JSON_UNQUOTE(JSON_EXTRACT(`content_features`.`signals`, '$."text.title_normalized".state')) <=> 'valid')),
	CONSTRAINT `ck_content_features_body` CHECK((`content_features`.`body_normalized` IS NOT NULL) = (JSON_UNQUOTE(JSON_EXTRACT(`content_features`.`signals`, '$."text.body_normalized".state')) <=> 'valid')),
	CONSTRAINT `ck_content_features_tags` CHECK((`content_features`.`hashtags` IS NOT NULL) = (JSON_UNQUOTE(JSON_EXTRACT(`content_features`.`signals`, '$."text.hashtags".state')) <=> 'valid')),
	CONSTRAINT `ck_content_features_states` CHECK(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(`content_features`.`signals`, '$."text.title_normalized".state')), 'valid') IN ('valid','failed') AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(`content_features`.`signals`, '$."text.body_normalized".state')), 'valid') IN ('valid','failed') AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(`content_features`.`signals`, '$."text.hashtags".state')), 'valid') IN ('valid','failed'))
);
--> statement-breakpoint
CREATE TABLE `monitoring_segments` (
	`plan_id` bigint NOT NULL,
	`version` int NOT NULL,
	`platform_code` varchar(32) NOT NULL,
	`status` varchar(16) NOT NULL,
	`items` json NOT NULL,
	`created_by_actor` varchar(128) NOT NULL,
	`published_at` datetime(6),
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `pk_monitoring_segments` PRIMARY KEY(`plan_id`,`version`),
	CONSTRAINT `ck_segments_status` CHECK(`monitoring_segments`.`status` IN ('draft','published')),
	CONSTRAINT `ck_segments_platform` CHECK(`monitoring_segments`.`platform_code` IN ('douyin','xiaohongshu','kuaishou')),
	CONSTRAINT `ck_segments_published` CHECK((`monitoring_segments`.`status` = 'published') = (`monitoring_segments`.`published_at` IS NOT NULL)),
	CONSTRAINT `ck_segments_items` CHECK(JSON_TYPE(`monitoring_segments`.`items`) = 'ARRAY'),
	CONSTRAINT `ck_segments_version` CHECK(`monitoring_segments`.`version` > 0)
);
--> statement-breakpoint
CREATE TABLE `segment_images` (
	`image_id` bigint AUTO_INCREMENT NOT NULL,
	`plan_id` bigint NOT NULL,
	`version` int NOT NULL,
	`kind` varchar(16) NOT NULL,
	`target` varchar(16) NOT NULL,
	`element_key` varchar(64) NOT NULL DEFAULT '',
	`sha256` binary(32) NOT NULL,
	`byte_length` bigint NOT NULL,
	`width` int NOT NULL,
	`height` int NOT NULL,
	`mime` varchar(64) NOT NULL,
	`bucket` varchar(128) NOT NULL,
	`object_key` varchar(512) character set ascii collate ascii_bin NOT NULL,
	`created_by_actor` varchar(128) NOT NULL,
	`created_at` datetime(6) NOT NULL,
	CONSTRAINT `segment_images_image_id` PRIMARY KEY(`image_id`),
	CONSTRAINT `uq_segment_images_slot` UNIQUE(`plan_id`,`version`,`kind`,`target`,`element_key`),
	CONSTRAINT `ck_segment_images_kind` CHECK(`segment_images`.`kind` IN ('template','element')),
	CONSTRAINT `ck_segment_images_target` CHECK(`segment_images`.`target` IN ('cover','background','avatar')),
	CONSTRAINT `ck_segment_images_element` CHECK((`segment_images`.`kind` = 'template') = (`segment_images`.`element_key` = '')),
	CONSTRAINT `ck_segment_images_size` CHECK(`segment_images`.`byte_length` > 0 AND `segment_images`.`width` > 0 AND `segment_images`.`height` > 0)
);
--> statement-breakpoint
CREATE TABLE `signal_cursors` (
	`cursor_name` varchar(64) NOT NULL,
	`watermark_at` datetime(6) NOT NULL,
	`watermark_id` bigint NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `signal_cursors_cursor_name` PRIMARY KEY(`cursor_name`)
);
--> statement-breakpoint
CREATE TABLE `signal_history` (
	`history_id` bigint AUTO_INCREMENT NOT NULL,
	`subject_kind` varchar(16) NOT NULL,
	`subject_id` bigint NOT NULL,
	`subject_snapshot_id` bigint,
	`signal_key` varchar(64) NOT NULL,
	`state` varchar(16) NOT NULL,
	`value` json,
	`capability_id` varchar(64) NOT NULL,
	`capability_version` int NOT NULL,
	`normalizer_version` int,
	`produced_at` datetime(6) NOT NULL,
	`superseded_at` datetime(6) NOT NULL,
	`superseded_reason` varchar(32) NOT NULL,
	`expires_at` datetime(6) NOT NULL,
	CONSTRAINT `signal_history_history_id` PRIMARY KEY(`history_id`),
	CONSTRAINT `ck_signal_history_kind` CHECK(`signal_history`.`subject_kind` IN ('content','comment')),
	CONSTRAINT `ck_signal_history_state` CHECK(`signal_history`.`state` IN ('valid','failed')),
	CONSTRAINT `ck_signal_history_reason` CHECK(`signal_history`.`superseded_reason` IN ('material_changed','capability_upgraded')),
	CONSTRAINT `ck_signal_history_version` CHECK(`signal_history`.`capability_version` > 0)
);
--> statement-breakpoint
CREATE TABLE `signal_recompute_runs` (
	`run_id` bigint AUTO_INCREMENT NOT NULL,
	`requested_by_actor` varchar(128) NOT NULL,
	`signal_key` varchar(64) NOT NULL,
	`scope` json NOT NULL,
	`scope_sha256` binary(32) NOT NULL,
	`scope_count` int NOT NULL,
	`from_version` int,
	`to_version` int NOT NULL,
	`status` varchar(16) NOT NULL,
	`active_key` binary(32),
	`cursor_id` bigint NOT NULL DEFAULT 0,
	`processed_count` int NOT NULL DEFAULT 0,
	`started_at` datetime(6) NOT NULL,
	`finished_at` datetime(6),
	`created_at` datetime(6) NOT NULL,
	CONSTRAINT `signal_recompute_runs_run_id` PRIMARY KEY(`run_id`),
	CONSTRAINT `uq_recompute_active` UNIQUE(`active_key`),
	CONSTRAINT `ck_recompute_status` CHECK(`signal_recompute_runs`.`status` IN ('running','completed','failed','cancelled')),
	CONSTRAINT `ck_recompute_versions` CHECK(`signal_recompute_runs`.`to_version` > 0 AND (`signal_recompute_runs`.`from_version` IS NULL OR (`signal_recompute_runs`.`from_version` > 0 AND `signal_recompute_runs`.`from_version` <= `signal_recompute_runs`.`to_version`))),
	CONSTRAINT `ck_recompute_counts` CHECK(`signal_recompute_runs`.`scope_count` >= 0 AND `signal_recompute_runs`.`processed_count` >= 0 AND `signal_recompute_runs`.`cursor_id` >= 0),
	CONSTRAINT `ck_recompute_active` CHECK((`signal_recompute_runs`.`status` IN ('running','failed')) = (`signal_recompute_runs`.`active_key` IS NOT NULL)),
	CONSTRAINT `ck_recompute_finished` CHECK((`signal_recompute_runs`.`status` = 'running') = (`signal_recompute_runs`.`finished_at` IS NULL))
);
--> statement-breakpoint
CREATE TABLE `signal_results` (
	`result_id` bigint AUTO_INCREMENT NOT NULL,
	`signal_key` varchar(64) NOT NULL,
	`material_sha256` binary(32) NOT NULL,
	`param_sha256` binary(32) NOT NULL,
	`capability_id` varchar(64) NOT NULL,
	`capability_version` int NOT NULL,
	`state` varchar(16) NOT NULL,
	`score` decimal(4,2),
	`value` json,
	`evidence` json NOT NULL,
	`failure_code` varchar(64),
	`lineage` json,
	`produced_at` datetime(6) NOT NULL,
	`expires_at` datetime(6) NOT NULL,
	`created_at` datetime(6) NOT NULL,
	CONSTRAINT `signal_results_result_id` PRIMARY KEY(`result_id`),
	CONSTRAINT `uq_signal_results_key` UNIQUE(`signal_key`,`capability_id`,`material_sha256`,`param_sha256`,`capability_version`),
	CONSTRAINT `ck_signal_results_state` CHECK(`signal_results`.`state` IN ('valid','failed')),
	CONSTRAINT `ck_signal_results_version` CHECK(`signal_results`.`capability_version` > 0),
	CONSTRAINT `ck_signal_results_score` CHECK(`signal_results`.`score` IS NULL OR (`signal_results`.`score` >= 0 AND `signal_results`.`score` <= 10)),
	CONSTRAINT `ck_signal_results_shape` CHECK((`signal_results`.`state` = 'valid' AND `signal_results`.`failure_code` IS NULL AND ((`signal_results`.`score` IS NOT NULL) <> (`signal_results`.`value` IS NOT NULL)))
        OR (`signal_results`.`state` = 'failed' AND `signal_results`.`failure_code` IS NOT NULL AND `signal_results`.`score` IS NULL AND `signal_results`.`value` IS NULL))
);
--> statement-breakpoint
CREATE TABLE `signal_tasks` (
	`task_id` bigint AUTO_INCREMENT NOT NULL,
	`kind` varchar(32) NOT NULL,
	`idempotency_key` binary(32) NOT NULL,
	`params` json NOT NULL,
	`status` varchar(16) NOT NULL,
	`priority` int NOT NULL DEFAULT 0,
	`attempt_count` int NOT NULL DEFAULT 0,
	`max_attempts` int NOT NULL,
	`defer_count` int NOT NULL DEFAULT 0,
	`next_attempt_at` datetime(6),
	`lease_owner` varchar(128),
	`lease_expires_at` datetime(6),
	`fencing_token` bigint NOT NULL DEFAULT 0,
	`run_id` bigint,
	`result_id` bigint,
	`last_error_code` varchar(128),
	`last_error_detail` json,
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	`finished_at` datetime(6),
	`expires_at` datetime(6) NOT NULL,
	CONSTRAINT `signal_tasks_task_id` PRIMARY KEY(`task_id`),
	CONSTRAINT `uq_signal_tasks_idempotency` UNIQUE(`idempotency_key`),
	CONSTRAINT `ck_signal_tasks_kind` CHECK(`signal_tasks`.`kind` IN ('score_template','score_element','asr_text','asr_judgement','recompute_chunk')),
	CONSTRAINT `ck_signal_tasks_status` CHECK(`signal_tasks`.`status` IN ('pending','running','retry_wait','succeeded','dead')),
	CONSTRAINT `ck_signal_tasks_lease` CHECK(`signal_tasks`.`status` <> 'running' OR (`signal_tasks`.`lease_owner` IS NOT NULL AND `signal_tasks`.`lease_expires_at` IS NOT NULL)),
	CONSTRAINT `ck_signal_tasks_attempts` CHECK(`signal_tasks`.`attempt_count` >= 0 AND `signal_tasks`.`attempt_count` <= `signal_tasks`.`max_attempts` AND `signal_tasks`.`defer_count` >= 0 AND `signal_tasks`.`fencing_token` >= 0)
);
--> statement-breakpoint
ALTER TABLE `comment_features` ADD CONSTRAINT `comment_features_comment_id_comments_comment_id_fk` FOREIGN KEY (`comment_id`) REFERENCES `comments`(`comment_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `content_features` ADD CONSTRAINT `content_features_content_id_contents_content_id_fk` FOREIGN KEY (`content_id`) REFERENCES `contents`(`content_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `content_features` ADD CONSTRAINT `fk_content_features_snapshot` FOREIGN KEY (`content_id`,`content_snapshot_id`) REFERENCES `content_snapshots`(`content_id`,`content_snapshot_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `segment_images` ADD CONSTRAINT `fk_segment_images_segment` FOREIGN KEY (`plan_id`,`version`) REFERENCES `monitoring_segments`(`plan_id`,`version`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `signal_tasks` ADD CONSTRAINT `fk_signal_tasks_run` FOREIGN KEY (`run_id`) REFERENCES `signal_recompute_runs`(`run_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `signal_tasks` ADD CONSTRAINT `fk_signal_tasks_result` FOREIGN KEY (`result_id`) REFERENCES `signal_results`(`result_id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_content_features_snapshot` ON `content_features` (`content_snapshot_id`);--> statement-breakpoint
CREATE INDEX `idx_segment_images_sha` ON `segment_images` (`sha256`);--> statement-breakpoint
CREATE INDEX `idx_signal_history_subject` ON `signal_history` (`subject_kind`,`subject_id`,`signal_key`,`superseded_at`);--> statement-breakpoint
CREATE INDEX `idx_signal_history_expires` ON `signal_history` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_recompute_signal` ON `signal_recompute_runs` (`signal_key`,`to_version`,`scope_sha256`);--> statement-breakpoint
CREATE INDEX `idx_signal_results_expires` ON `signal_results` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_signal_tasks_claim` ON `signal_tasks` (`status`,`next_attempt_at`,`priority`,`task_id`);--> statement-breakpoint
CREATE INDEX `idx_signal_tasks_run` ON `signal_tasks` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_signal_tasks_expires` ON `signal_tasks` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_contents_current_selected` ON `contents` (`current_snapshot_selected_at`,`content_id`);