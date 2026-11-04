CREATE TABLE `account_profile_snapshots` (
	`profile_snapshot_id` bigint AUTO_INCREMENT NOT NULL,
	`batch_id` bigint NOT NULL,
	`account_id` bigint NOT NULL,
	`assignment_id` bigint NOT NULL,
	`provider_id` bigint NOT NULL,
	`source_provider_call_id` bigint,
	`nickname` varchar(512),
	`signature` longtext,
	`location` varchar(256),
	`follower_value` bigint,
	`following_value` bigint,
	`like_value` bigint,
	`post_value` bigint,
	`follower_state` varchar(32) NOT NULL,
	`following_state` varchar(32) NOT NULL,
	`like_state` varchar(32) NOT NULL,
	`post_state` varchar(32) NOT NULL,
	`provider_updated_at` datetime(6),
	`response_received_at` datetime(6) NOT NULL,
	`adapter_version` varchar(64) NOT NULL,
	`created_at` datetime(6) NOT NULL,
	CONSTRAINT `account_profile_snapshots_profile_snapshot_id` PRIMARY KEY(`profile_snapshot_id`),
	CONSTRAINT `uq_profile_snapshots_batch_account` UNIQUE(`batch_id`,`account_id`),
	CONSTRAINT `uq_profile_snapshots_account_id` UNIQUE(`account_id`,`profile_snapshot_id`),
	CONSTRAINT `ck_profile_follower` CHECK((`account_profile_snapshots`.`follower_state` = 'value' AND `account_profile_snapshots`.`follower_value` IS NOT NULL AND `account_profile_snapshots`.`follower_value` >= 0) OR (`account_profile_snapshots`.`follower_state` IN ('missing','explicit_null','invalid','unsupported') AND `account_profile_snapshots`.`follower_value` IS NULL)),
	CONSTRAINT `ck_profile_following` CHECK((`account_profile_snapshots`.`following_state` = 'value' AND `account_profile_snapshots`.`following_value` IS NOT NULL AND `account_profile_snapshots`.`following_value` >= 0) OR (`account_profile_snapshots`.`following_state` IN ('missing','explicit_null','invalid','unsupported') AND `account_profile_snapshots`.`following_value` IS NULL)),
	CONSTRAINT `ck_profile_like` CHECK((`account_profile_snapshots`.`like_state` = 'value' AND `account_profile_snapshots`.`like_value` IS NOT NULL AND `account_profile_snapshots`.`like_value` >= 0) OR (`account_profile_snapshots`.`like_state` IN ('missing','explicit_null','invalid','unsupported') AND `account_profile_snapshots`.`like_value` IS NULL)),
	CONSTRAINT `ck_profile_post` CHECK((`account_profile_snapshots`.`post_state` = 'value' AND `account_profile_snapshots`.`post_value` IS NOT NULL AND `account_profile_snapshots`.`post_value` >= 0) OR (`account_profile_snapshots`.`post_state` IN ('missing','explicit_null','invalid','unsupported') AND `account_profile_snapshots`.`post_value` IS NULL))
);
--> statement-breakpoint
CREATE TABLE `external_account_identifiers` (
	`account_identifier_id` bigint AUTO_INCREMENT NOT NULL,
	`account_id` bigint NOT NULL,
	`namespace_code` varchar(128) NOT NULL,
	`identifier_value` varchar(2048) character set utf8mb4 collate utf8mb4_bin NOT NULL,
	`identifier_sha256` binary(32) NOT NULL,
	`binding_method` varchar(32) NOT NULL,
	`confidence` varchar(16) NOT NULL,
	`binding_policy_version` varchar(64),
	`binding_evidence` json,
	`binding_evidence_sha256` binary(32),
	`evidence_batch_id` bigint,
	`first_seen_at` datetime(6) NOT NULL,
	`last_seen_at` datetime(6) NOT NULL,
	`created_at` datetime(6) NOT NULL,
	CONSTRAINT `external_account_identifiers_account_identifier_id` PRIMARY KEY(`account_identifier_id`),
	CONSTRAINT `uq_identifiers_namespace_sha` UNIQUE(`namespace_code`,`identifier_sha256`),
	CONSTRAINT `ck_identifiers_namespace` CHECK(`external_account_identifiers`.`namespace_code` IN ('douyin.user_id','douyin.sec_uid','xiaohongshu.profile.user_id','xiaohongshu.content.user_id','kuaishou.user_id')),
	CONSTRAINT `ck_identifiers_method` CHECK(`external_account_identifiers`.`binding_method` IN ('same_payload','dominant_list_author','provider_mapping','manual')),
	CONSTRAINT `ck_identifiers_confidence` CHECK(`external_account_identifiers`.`confidence` IN ('observed','verified')),
	CONSTRAINT `ck_identifiers_evidence_all_or_none` CHECK((`external_account_identifiers`.`binding_policy_version` IS NULL AND `external_account_identifiers`.`binding_evidence` IS NULL AND `external_account_identifiers`.`binding_evidence_sha256` IS NULL AND `external_account_identifiers`.`evidence_batch_id` IS NULL) OR (`external_account_identifiers`.`binding_policy_version` IS NOT NULL AND `external_account_identifiers`.`binding_evidence` IS NOT NULL AND `external_account_identifiers`.`binding_evidence_sha256` IS NOT NULL AND `external_account_identifiers`.`evidence_batch_id` IS NOT NULL)),
	CONSTRAINT `ck_identifiers_dominant_has_evidence` CHECK(`external_account_identifiers`.`binding_method` <> 'dominant_list_author' OR (`external_account_identifiers`.`binding_policy_version` IS NOT NULL AND `external_account_identifiers`.`binding_evidence` IS NOT NULL AND `external_account_identifiers`.`binding_evidence_sha256` IS NOT NULL AND `external_account_identifiers`.`evidence_batch_id` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `external_accounts` (
	`account_id` bigint AUTO_INCREMENT NOT NULL,
	`platform_id` bigint NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'active',
	`status_reason` varchar(256),
	`status_changed_at` datetime(6),
	`current_profile_snapshot_id` bigint,
	`current_profile_selected_at` datetime(6),
	`first_seen_at` datetime(6) NOT NULL,
	`last_seen_at` datetime(6) NOT NULL,
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `external_accounts_account_id` PRIMARY KEY(`account_id`),
	CONSTRAINT `uq_accounts_id_platform` UNIQUE(`account_id`,`platform_id`),
	CONSTRAINT `ck_accounts_status` CHECK(`external_accounts`.`status` IN ('active','unavailable','deleted'))
);
--> statement-breakpoint
CREATE TABLE `staff_account_assignments` (
	`assignment_id` bigint AUTO_INCREMENT NOT NULL,
	`watch_type` varchar(16) NOT NULL DEFAULT 'staff',
	`staff_id` bigint,
	`account_id` bigint NOT NULL,
	`platform_id` bigint NOT NULL,
	`monitoring_enabled` boolean NOT NULL DEFAULT true,
	`current_home_locator` longtext NOT NULL,
	`current_home_locator_sha256` binary(32) NOT NULL,
	`previous_home_locator` longtext,
	`previous_home_locator_sha256` binary(32),
	`resolved_home_url` longtext NOT NULL,
	`resolved_home_url_sha256` binary(32) NOT NULL,
	`intake_status` varchar(32) NOT NULL,
	`monitoring_closed_reason` varchar(32),
	`slot_released_at` datetime(6),
	`active_staff_platform` bigint GENERATED ALWAYS AS ((CASE WHEN watch_type = 'staff' AND slot_released_at IS NULL THEN staff_id END)) STORED,
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `staff_account_assignments_assignment_id` PRIMARY KEY(`assignment_id`),
	CONSTRAINT `uq_assignments_account` UNIQUE(`account_id`),
	CONSTRAINT `uq_assignments_staff_platform_slot` UNIQUE(`active_staff_platform`,`platform_id`),
	CONSTRAINT `ck_assignments_watch_type` CHECK(`staff_account_assignments`.`watch_type` IN ('staff','external')),
	CONSTRAINT `ck_assignments_staff_by_type` CHECK((`staff_account_assignments`.`watch_type` = 'staff' AND `staff_account_assignments`.`staff_id` IS NOT NULL) OR (`staff_account_assignments`.`watch_type` = 'external' AND `staff_account_assignments`.`staff_id` IS NULL)),
	CONSTRAINT `ck_assignments_intake_status` CHECK(`staff_account_assignments`.`intake_status` IN ('normal','suspected_empty')),
	CONSTRAINT `ck_assignments_previous_locator_pair` CHECK((`staff_account_assignments`.`previous_home_locator` IS NULL) = (`staff_account_assignments`.`previous_home_locator_sha256` IS NULL)),
	CONSTRAINT `ck_assignments_closed_reason` CHECK(`staff_account_assignments`.`monitoring_enabled` OR `staff_account_assignments`.`monitoring_closed_reason` IS NOT NULL),
	CONSTRAINT `ck_assignments_closed_reason_values` CHECK(`staff_account_assignments`.`monitoring_closed_reason` IS NULL OR `staff_account_assignments`.`monitoring_closed_reason` IN ('manual','unreferenced_15d'))
);
--> statement-breakpoint
CREATE TABLE `content_discoveries` (
	`discovery_id` bigint AUTO_INCREMENT NOT NULL,
	`batch_id` bigint NOT NULL,
	`assignment_id` bigint NOT NULL,
	`content_id` bigint NOT NULL,
	`page_no` int NOT NULL,
	`position_in_page` int NOT NULL,
	`absolute_position` int NOT NULL,
	`is_potentially_pinned` boolean NOT NULL,
	`discovered_at` datetime(6) NOT NULL,
	`source_provider_call_id` bigint,
	`created_at` datetime(6) NOT NULL,
	CONSTRAINT `content_discoveries_discovery_id` PRIMARY KEY(`discovery_id`),
	CONSTRAINT `uq_discoveries_batch_assignment_content` UNIQUE(`batch_id`,`assignment_id`,`content_id`),
	CONSTRAINT `ck_discoveries_positions` CHECK(`content_discoveries`.`page_no` >= 0 AND `content_discoveries`.`position_in_page` >= 0 AND `content_discoveries`.`absolute_position` >= 0)
);
--> statement-breakpoint
CREATE TABLE `content_snapshots` (
	`content_snapshot_id` bigint AUTO_INCREMENT NOT NULL,
	`batch_id` bigint NOT NULL,
	`content_id` bigint NOT NULL,
	`snapshot_status` varchar(16) NOT NULL,
	`returned_author_namespace_code` varchar(128),
	`returned_author_identifier` varchar(2048) character set utf8mb4 collate utf8mb4_bin,
	`returned_author_name` varchar(512),
	`published_at` datetime(6),
	`title` longtext,
	`body` longtext,
	`tag_text` longtext,
	`publish_location` varchar(512),
	`related_search_terms` json,
	`share_url` longtext,
	`share_url_sha256` binary(32),
	`duration_value` decimal(20,6),
	`duration_state` varchar(32) NOT NULL,
	`duration_unit` varchar(32) NOT NULL DEFAULT 'unknown',
	`play_value` bigint,
	`like_value` bigint,
	`comment_value` bigint,
	`collect_value` bigint,
	`share_value` bigint,
	`forward_value` bigint,
	`play_state` varchar(32) NOT NULL,
	`like_state` varchar(32) NOT NULL,
	`comment_state` varchar(32) NOT NULL,
	`collect_state` varchar(32) NOT NULL,
	`share_state` varchar(32) NOT NULL,
	`forward_state` varchar(32) NOT NULL,
	`list_observed` boolean NOT NULL DEFAULT false,
	`detail_observed` boolean NOT NULL DEFAULT false,
	`last_list_provider_call_id` bigint,
	`last_detail_provider_call_id` bigint,
	`list_response_received_at` datetime(6),
	`detail_response_received_at` datetime(6),
	`snapshot_at` datetime(6) NOT NULL,
	`merge_policy_version` varchar(64) NOT NULL,
	`list_adapter_version` varchar(64),
	`detail_adapter_version` varchar(64),
	`finalized_at` datetime(6),
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `content_snapshots_content_snapshot_id` PRIMARY KEY(`content_snapshot_id`),
	CONSTRAINT `uq_content_snapshots_batch_content` UNIQUE(`batch_id`,`content_id`),
	CONSTRAINT `uq_content_snapshots_content_id` UNIQUE(`content_id`,`content_snapshot_id`),
	CONSTRAINT `ck_content_snapshots_status` CHECK(`content_snapshots`.`snapshot_status` IN ('building','finalized')),
	CONSTRAINT `ck_content_snapshots_finalized` CHECK((`content_snapshots`.`snapshot_status` = 'building' AND `content_snapshots`.`finalized_at` IS NULL) OR (`content_snapshots`.`snapshot_status` = 'finalized' AND `content_snapshots`.`finalized_at` IS NOT NULL)),
	CONSTRAINT `ck_content_snapshots_play` CHECK((`content_snapshots`.`play_state` = 'value' AND `content_snapshots`.`play_value` IS NOT NULL AND `content_snapshots`.`play_value` >= 0) OR (`content_snapshots`.`play_state` IN ('missing','explicit_null','invalid','unsupported') AND `content_snapshots`.`play_value` IS NULL)),
	CONSTRAINT `ck_content_snapshots_like` CHECK((`content_snapshots`.`like_state` = 'value' AND `content_snapshots`.`like_value` IS NOT NULL AND `content_snapshots`.`like_value` >= 0) OR (`content_snapshots`.`like_state` IN ('missing','explicit_null','invalid','unsupported') AND `content_snapshots`.`like_value` IS NULL)),
	CONSTRAINT `ck_content_snapshots_comment` CHECK((`content_snapshots`.`comment_state` = 'value' AND `content_snapshots`.`comment_value` IS NOT NULL AND `content_snapshots`.`comment_value` >= 0) OR (`content_snapshots`.`comment_state` IN ('missing','explicit_null','invalid','unsupported') AND `content_snapshots`.`comment_value` IS NULL)),
	CONSTRAINT `ck_content_snapshots_collect` CHECK((`content_snapshots`.`collect_state` = 'value' AND `content_snapshots`.`collect_value` IS NOT NULL AND `content_snapshots`.`collect_value` >= 0) OR (`content_snapshots`.`collect_state` IN ('missing','explicit_null','invalid','unsupported') AND `content_snapshots`.`collect_value` IS NULL)),
	CONSTRAINT `ck_content_snapshots_share` CHECK((`content_snapshots`.`share_state` = 'value' AND `content_snapshots`.`share_value` IS NOT NULL AND `content_snapshots`.`share_value` >= 0) OR (`content_snapshots`.`share_state` IN ('missing','explicit_null','invalid','unsupported') AND `content_snapshots`.`share_value` IS NULL)),
	CONSTRAINT `ck_content_snapshots_forward` CHECK((`content_snapshots`.`forward_state` = 'value' AND `content_snapshots`.`forward_value` IS NOT NULL AND `content_snapshots`.`forward_value` >= 0) OR (`content_snapshots`.`forward_state` IN ('missing','explicit_null','invalid','unsupported') AND `content_snapshots`.`forward_value` IS NULL)),
	CONSTRAINT `ck_content_snapshots_duration` CHECK((`content_snapshots`.`duration_state` = 'value' AND `content_snapshots`.`duration_value` IS NOT NULL AND `content_snapshots`.`duration_value` >= 0) OR (`content_snapshots`.`duration_state` IN ('missing','explicit_null','invalid','unsupported') AND `content_snapshots`.`duration_value` IS NULL)),
	CONSTRAINT `ck_content_snapshots_share_url` CHECK((`content_snapshots`.`share_url` IS NULL) = (`content_snapshots`.`share_url_sha256` IS NULL)),
	CONSTRAINT `ck_content_snapshots_author_pair` CHECK((`content_snapshots`.`returned_author_namespace_code` IS NULL) = (`content_snapshots`.`returned_author_identifier` IS NULL))
);
--> statement-breakpoint
CREATE TABLE `contents` (
	`content_id` bigint AUTO_INCREMENT NOT NULL,
	`platform_id` bigint NOT NULL,
	`account_id` bigint NOT NULL,
	`platform_content_id` varchar(2048) character set utf8mb4 collate utf8mb4_bin NOT NULL,
	`platform_content_id_sha256` binary(32) NOT NULL,
	`content_kind` varchar(32) NOT NULL DEFAULT 'unknown',
	`status` varchar(32) NOT NULL DEFAULT 'active',
	`status_reason` varchar(256),
	`status_changed_at` datetime(6),
	`current_snapshot_id` bigint,
	`current_snapshot_selected_at` datetime(6),
	`first_seen_at` datetime(6) NOT NULL,
	`last_seen_at` datetime(6) NOT NULL,
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `contents_content_id` PRIMARY KEY(`content_id`),
	CONSTRAINT `uq_contents_account_content` UNIQUE(`platform_id`,`account_id`,`platform_content_id_sha256`),
	CONSTRAINT `ck_contents_kind` CHECK(`contents`.`content_kind` IN ('unknown','video','image','text')),
	CONSTRAINT `ck_contents_status` CHECK(`contents`.`status` IN ('active','unavailable','deleted'))
);
--> statement-breakpoint
CREATE TABLE `media_assets` (
	`media_asset_id` bigint AUTO_INCREMENT NOT NULL,
	`sha256` binary(32) NOT NULL,
	`byte_length` bigint NOT NULL,
	`media_kind` varchar(32) NOT NULL,
	`mime_type` varchar(255) NOT NULL,
	`width` int,
	`height` int,
	`duration_ms` bigint,
	`oss_object_id` bigint NOT NULL,
	`object_category` varchar(32) NOT NULL DEFAULT 'media',
	`verification_status` varchar(32) NOT NULL,
	`verified_at` datetime(6) NOT NULL,
	`created_at` datetime(6) NOT NULL,
	CONSTRAINT `media_assets_media_asset_id` PRIMARY KEY(`media_asset_id`),
	CONSTRAINT `uq_media_assets_sha` UNIQUE(`sha256`),
	CONSTRAINT `uq_media_assets_oss_object` UNIQUE(`oss_object_id`),
	CONSTRAINT `ck_media_assets_category` CHECK(`media_assets`.`object_category` = 'media'),
	CONSTRAINT `ck_media_assets_kind` CHECK(`media_assets`.`media_kind` IN ('image','video','audio','unknown')),
	CONSTRAINT `ck_media_assets_verification` CHECK(`media_assets`.`verification_status` IN ('verified','quarantined')),
	CONSTRAINT `ck_media_assets_nonneg` CHECK(`media_assets`.`byte_length` >= 0 AND (`media_assets`.`width` IS NULL OR `media_assets`.`width` >= 0) AND (`media_assets`.`height` IS NULL OR `media_assets`.`height` >= 0) AND (`media_assets`.`duration_ms` IS NULL OR `media_assets`.`duration_ms` >= 0))
);
--> statement-breakpoint
CREATE TABLE `media_references` (
	`media_reference_id` bigint AUTO_INCREMENT NOT NULL,
	`profile_snapshot_id` bigint,
	`content_snapshot_id` bigint,
	`role` varchar(32) NOT NULL,
	`slot_index` int NOT NULL DEFAULT 0,
	`source_locator` longtext,
	`source_locator_sha256` binary(32),
	`source_json_path` varchar(1024),
	`observed_at` datetime(6) NOT NULL,
	`media_asset_id` bigint,
	`archive_status` varchar(32) NOT NULL,
	`is_carried_forward` boolean NOT NULL DEFAULT false,
	`last_error_code` varchar(128),
	`source_provider_call_id` bigint,
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `media_references_media_reference_id` PRIMARY KEY(`media_reference_id`),
	CONSTRAINT `uq_media_refs_profile_slot` UNIQUE(`profile_snapshot_id`,`role`,`slot_index`),
	CONSTRAINT `uq_media_refs_content_slot` UNIQUE(`content_snapshot_id`,`role`,`slot_index`),
	CONSTRAINT `ck_media_refs_role` CHECK(`media_references`.`role` IN ('avatar','background','avatar_normalized','background_normalized','cover','cover_normalized','gallery_image','video','audio')),
	CONSTRAINT `ck_media_refs_one_snapshot` CHECK((`media_references`.`profile_snapshot_id` IS NULL) <> (`media_references`.`content_snapshot_id` IS NULL)),
	CONSTRAINT `ck_media_refs_slot` CHECK(`media_references`.`slot_index` >= 0),
	CONSTRAINT `ck_media_refs_locator_pair` CHECK((`media_references`.`source_locator` IS NULL) = (`media_references`.`source_locator_sha256` IS NULL)),
	CONSTRAINT `ck_media_refs_archive_status` CHECK(`media_references`.`archive_status` IN ('pending','archived','carried_forward','failed')),
	CONSTRAINT `ck_media_refs_state_shape` CHECK((`media_references`.`archive_status` = 'pending' AND `media_references`.`media_asset_id` IS NULL AND `media_references`.`last_error_code` IS NULL AND NOT `media_references`.`is_carried_forward`)
        OR (`media_references`.`archive_status` = 'archived' AND `media_references`.`media_asset_id` IS NOT NULL AND `media_references`.`last_error_code` IS NULL AND NOT `media_references`.`is_carried_forward`)
        OR (`media_references`.`archive_status` = 'carried_forward' AND `media_references`.`media_asset_id` IS NOT NULL AND `media_references`.`last_error_code` IS NOT NULL AND `media_references`.`is_carried_forward`)
        OR (`media_references`.`archive_status` = 'failed' AND `media_references`.`media_asset_id` IS NULL AND `media_references`.`last_error_code` IS NOT NULL AND NOT `media_references`.`is_carried_forward`))
);
--> statement-breakpoint
CREATE TABLE `oss_objects` (
	`oss_object_id` bigint AUTO_INCREMENT NOT NULL,
	`object_category` varchar(32) NOT NULL,
	`provider_code` varchar(32) character set ascii collate ascii_bin NOT NULL,
	`region` varchar(64) character set ascii collate ascii_bin NOT NULL,
	`bucket` varchar(255) character set ascii collate ascii_bin NOT NULL,
	`object_key` varchar(1024) character set ascii collate ascii_bin NOT NULL,
	`object_version` varchar(512) character set ascii collate ascii_bin NOT NULL DEFAULT '',
	`etag` varchar(256),
	`byte_length` bigint,
	`sha256` binary(32),
	`content_type` varchar(255),
	`storage_class` varchar(32) NOT NULL,
	`encryption_mode` varchar(32) NOT NULL,
	`status` varchar(32) NOT NULL,
	`expires_at` datetime(6),
	`verified_at` datetime(6),
	`deleted_at` datetime(6),
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `oss_objects_oss_object_id` PRIMARY KEY(`oss_object_id`),
	CONSTRAINT `uq_oss_objects_location` UNIQUE(`provider_code`,`region`,`bucket`,`object_key`,`object_version`),
	CONSTRAINT `uq_oss_objects_id_category` UNIQUE(`oss_object_id`,`object_category`),
	CONSTRAINT `ck_oss_objects_category` CHECK(`oss_objects`.`object_category` IN ('ods','media','temp')),
	CONSTRAINT `ck_oss_objects_status` CHECK(`oss_objects`.`status` IN ('pending','available','deleting','deleted','quarantined')),
	CONSTRAINT `ck_oss_objects_available` CHECK(`oss_objects`.`status` <> 'available' OR (`oss_objects`.`byte_length` IS NOT NULL AND `oss_objects`.`sha256` IS NOT NULL AND `oss_objects`.`verified_at` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `branches` (
	`branch_id` bigint AUTO_INCREMENT NOT NULL,
	`region_id` bigint NOT NULL,
	`branch_code` varchar(64) character set utf8mb4 collate utf8mb4_bin NOT NULL,
	`branch_name` varchar(128) NOT NULL,
	`status` varchar(32) NOT NULL,
	`monitoring_enabled` boolean NOT NULL DEFAULT true,
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `branches_branch_id` PRIMARY KEY(`branch_id`),
	CONSTRAINT `uq_branches_code` UNIQUE(`branch_code`),
	CONSTRAINT `uq_branches_region_name` UNIQUE(`region_id`,`branch_name`),
	CONSTRAINT `ck_branches_status` CHECK(`branches`.`status` IN ('active','inactive'))
);
--> statement-breakpoint
CREATE TABLE `brands` (
	`brand_id` bigint AUTO_INCREMENT NOT NULL,
	`brand_code` varchar(64) character set utf8mb4 collate utf8mb4_bin NOT NULL,
	`brand_name` varchar(128) NOT NULL,
	`status` varchar(32) NOT NULL,
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `brands_brand_id` PRIMARY KEY(`brand_id`),
	CONSTRAINT `uq_brands_code` UNIQUE(`brand_code`),
	CONSTRAINT `uq_brands_name` UNIQUE(`brand_name`),
	CONSTRAINT `ck_brands_status` CHECK(`brands`.`status` IN ('active','inactive'))
);
--> statement-breakpoint
CREATE TABLE `dealers` (
	`dealer_id` bigint AUTO_INCREMENT NOT NULL,
	`dealer_code` varchar(64) character set utf8mb4 collate utf8mb4_bin,
	`dealer_name` varchar(200) NOT NULL,
	`status` varchar(32) NOT NULL,
	`monitoring_enabled` boolean NOT NULL DEFAULT true,
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `dealers_dealer_id` PRIMARY KEY(`dealer_id`),
	CONSTRAINT `uq_dealers_code` UNIQUE(`dealer_code`),
	CONSTRAINT `ck_dealers_status` CHECK(`dealers`.`status` IN ('active','inactive'))
);
--> statement-breakpoint
CREATE TABLE `media_staff` (
	`staff_id` bigint AUTO_INCREMENT NOT NULL,
	`store_id` bigint NOT NULL,
	`staff_name` varchar(100) NOT NULL,
	`phone` varchar(32) NOT NULL,
	`status` varchar(32) NOT NULL,
	`monitoring_enabled` boolean NOT NULL DEFAULT true,
	`active_phone` varchar(32) GENERATED ALWAYS AS ((CASE WHEN status = 'active' THEN phone END)) STORED,
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `media_staff_staff_id` PRIMARY KEY(`staff_id`),
	CONSTRAINT `uq_media_staff_active_phone` UNIQUE(`active_phone`),
	CONSTRAINT `ck_media_staff_status` CHECK(`media_staff`.`status` IN ('active','inactive'))
);
--> statement-breakpoint
CREATE TABLE `regions` (
	`region_id` bigint AUTO_INCREMENT NOT NULL,
	`region_code` varchar(64) character set utf8mb4 collate utf8mb4_bin NOT NULL,
	`region_name` varchar(128) NOT NULL,
	`status` varchar(32) NOT NULL,
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `regions_region_id` PRIMARY KEY(`region_id`),
	CONSTRAINT `uq_regions_code` UNIQUE(`region_code`),
	CONSTRAINT `ck_regions_status` CHECK(`regions`.`status` IN ('active','inactive'))
);
--> statement-breakpoint
CREATE TABLE `sectors` (
	`sector_id` bigint AUTO_INCREMENT NOT NULL,
	`branch_id` bigint NOT NULL,
	`sector_code` varchar(64) character set utf8mb4 collate utf8mb4_bin NOT NULL,
	`sector_name` varchar(128) NOT NULL,
	`status` varchar(32) NOT NULL,
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `sectors_sector_id` PRIMARY KEY(`sector_id`),
	CONSTRAINT `uq_sectors_code` UNIQUE(`sector_code`),
	CONSTRAINT `uq_sectors_branch_name` UNIQUE(`branch_id`,`sector_name`),
	CONSTRAINT `ck_sectors_status` CHECK(`sectors`.`status` IN ('active','inactive'))
);
--> statement-breakpoint
CREATE TABLE `stores` (
	`store_id` bigint AUTO_INCREMENT NOT NULL,
	`store_code` varchar(64) character set utf8mb4 collate utf8mb4_bin NOT NULL,
	`store_name` varchar(200) NOT NULL,
	`dealer_id` bigint NOT NULL,
	`brand_id` bigint NOT NULL,
	`sector_id` bigint NOT NULL,
	`store_tier` varchar(64),
	`status` varchar(32) NOT NULL,
	`monitoring_enabled` boolean NOT NULL DEFAULT true,
	`source_batch_id` bigint,
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `stores_store_id` PRIMARY KEY(`store_id`),
	CONSTRAINT `uq_stores_brand_code` UNIQUE(`brand_id`,`store_code`),
	CONSTRAINT `ck_stores_status` CHECK(`stores`.`status` IN ('active','closed'))
);
--> statement-breakpoint
CREATE TABLE `data_providers` (
	`provider_id` bigint AUTO_INCREMENT NOT NULL,
	`provider_code` varchar(64) character set utf8mb4 collate utf8mb4_bin NOT NULL,
	`provider_name` varchar(128) NOT NULL,
	`base_endpoint` varchar(512),
	`status` varchar(32) NOT NULL,
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `data_providers_provider_id` PRIMARY KEY(`provider_id`),
	CONSTRAINT `uq_data_providers_code` UNIQUE(`provider_code`),
	CONSTRAINT `ck_data_providers_status` CHECK(`data_providers`.`status` IN ('active','inactive'))
);
--> statement-breakpoint
CREATE TABLE `platforms` (
	`platform_id` bigint AUTO_INCREMENT NOT NULL,
	`platform_code` varchar(64) character set utf8mb4 collate utf8mb4_bin NOT NULL,
	`platform_name` varchar(128) NOT NULL,
	`status` varchar(32) NOT NULL,
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `platforms_platform_id` PRIMARY KEY(`platform_id`),
	CONSTRAINT `uq_platforms_code` UNIQUE(`platform_code`),
	CONSTRAINT `ck_platforms_status` CHECK(`platforms`.`status` IN ('active','inactive'))
);
--> statement-breakpoint
CREATE TABLE `data_quality_issues` (
	`issue_id` bigint AUTO_INCREMENT NOT NULL,
	`issue_fingerprint` binary(32) NOT NULL,
	`issue_code` varchar(128) NOT NULL,
	`severity` varchar(16) NOT NULL,
	`status` varchar(16) NOT NULL,
	`entity_type` varchar(32),
	`entity_id` bigint,
	`batch_id` bigint,
	`account_id` bigint,
	`content_id` bigint,
	`assignment_id` bigint,
	`provider_call_id` bigint,
	`json_path` varchar(1024),
	`detail` json NOT NULL,
	`occurrence_count` bigint NOT NULL DEFAULT 1,
	`first_seen_at` datetime(6) NOT NULL,
	`last_seen_at` datetime(6) NOT NULL,
	`resolved_at` datetime(6),
	`resolution_note` varchar(1024),
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `data_quality_issues_issue_id` PRIMARY KEY(`issue_id`),
	CONSTRAINT `uq_issues_fingerprint` UNIQUE(`issue_fingerprint`),
	CONSTRAINT `ck_issues_severity` CHECK(`data_quality_issues`.`severity` IN ('info','warning','error','critical')),
	CONSTRAINT `ck_issues_status` CHECK(`data_quality_issues`.`status` IN ('open','acknowledged','resolved','ignored')),
	CONSTRAINT `ck_issues_occurrence` CHECK(`data_quality_issues`.`occurrence_count` >= 1)
);
--> statement-breakpoint
CREATE TABLE `ods_payloads` (
	`payload_id` bigint AUTO_INCREMENT NOT NULL,
	`provider_call_id` bigint NOT NULL,
	`payload_role` varchar(32) NOT NULL,
	`content_type` varchar(255),
	`content_encoding` varchar(64),
	`oss_object_id` bigint NOT NULL,
	`object_category` varchar(32) NOT NULL DEFAULT 'ods',
	`byte_length` bigint NOT NULL,
	`sha256` binary(32) NOT NULL,
	`parse_status` varchar(32) NOT NULL,
	`adapter_version` varchar(64),
	`parse_error` varchar(2048),
	`captured_at` datetime(6) NOT NULL,
	`expires_at` datetime(6) NOT NULL,
	CONSTRAINT `ods_payloads_payload_id` PRIMARY KEY(`payload_id`),
	CONSTRAINT `uq_payloads_call_role` UNIQUE(`provider_call_id`,`payload_role`),
	CONSTRAINT `uq_payloads_oss_object` UNIQUE(`oss_object_id`),
	CONSTRAINT `ck_payloads_category` CHECK(`ods_payloads`.`object_category` = 'ods'),
	CONSTRAINT `ck_payloads_role` CHECK(`ods_payloads`.`payload_role` IN ('request_body','response_body','transport_error')),
	CONSTRAINT `ck_payloads_parse_status` CHECK(`ods_payloads`.`parse_status` IN ('not_attempted','parsed','invalid')),
	CONSTRAINT `ck_payloads_adapter_version` CHECK((`ods_payloads`.`parse_status` = 'not_attempted' AND `ods_payloads`.`adapter_version` IS NULL) OR (`ods_payloads`.`parse_status` IN ('parsed','invalid') AND `ods_payloads`.`adapter_version` IS NOT NULL)),
	CONSTRAINT `ck_payloads_length` CHECK(`ods_payloads`.`byte_length` >= 0)
);
--> statement-breakpoint
CREATE TABLE `ods_provider_calls` (
	`provider_call_id` bigint AUTO_INCREMENT NOT NULL,
	`sync_task_id` bigint NOT NULL,
	`provider_id` bigint NOT NULL,
	`platform_id` bigint,
	`attempt_no` int NOT NULL,
	`call_sequence` int NOT NULL,
	`requested_action` varchar(64) NOT NULL,
	`expected_response_action` varchar(64) NOT NULL,
	`response_action` varchar(64),
	`endpoint` varchar(1024) NOT NULL,
	`request_method` varchar(16),
	`http_status` smallint,
	`provider_code` varchar(128),
	`provider_task_id` varchar(512),
	`provider_request_id` varchar(512),
	`provider_task_status` varchar(64),
	`call_status` varchar(32) NOT NULL,
	`outcome` varchar(32),
	`transport_error` json,
	`prepared_at` datetime(6) NOT NULL,
	`request_captured_at` datetime(6) NOT NULL,
	`send_started_at` datetime(6),
	`response_received_at` datetime(6),
	`finished_at` datetime(6),
	`elapsed_seconds` decimal(20,6),
	`terminal_captured_at` datetime(6),
	`ambiguous_at` datetime(6),
	`reconciled_at` datetime(6),
	`reconciliation_method` varchar(64),
	`reconciled_by_provider_call_id` bigint,
	`expires_at` datetime(6) NOT NULL,
	CONSTRAINT `ods_provider_calls_provider_call_id` PRIMARY KEY(`provider_call_id`),
	CONSTRAINT `uq_calls_task_attempt_seq` UNIQUE(`sync_task_id`,`attempt_no`,`call_sequence`),
	CONSTRAINT `ck_calls_status` CHECK(`ods_provider_calls`.`call_status` IN ('prepared','in_flight','terminal','ambiguous')),
	CONSTRAINT `ck_calls_outcome` CHECK(`ods_provider_calls`.`outcome` IS NULL OR `ods_provider_calls`.`outcome` IN ('not_sent','succeeded','http_error','provider_error','invalid_response','transport_error','ambiguous','reconciled_succeeded','reconciled_failed')),
	CONSTRAINT `ck_calls_prepared` CHECK(`ods_provider_calls`.`call_status` <> 'prepared' OR (`ods_provider_calls`.`outcome` IS NULL AND `ods_provider_calls`.`send_started_at` IS NULL AND `ods_provider_calls`.`response_received_at` IS NULL AND `ods_provider_calls`.`finished_at` IS NULL AND `ods_provider_calls`.`elapsed_seconds` IS NULL AND `ods_provider_calls`.`terminal_captured_at` IS NULL AND `ods_provider_calls`.`ambiguous_at` IS NULL AND `ods_provider_calls`.`reconciled_at` IS NULL AND `ods_provider_calls`.`reconciliation_method` IS NULL AND `ods_provider_calls`.`reconciled_by_provider_call_id` IS NULL AND `ods_provider_calls`.`transport_error` IS NULL)),
	CONSTRAINT `ck_calls_in_flight` CHECK(`ods_provider_calls`.`call_status` <> 'in_flight' OR (`ods_provider_calls`.`outcome` IS NULL AND `ods_provider_calls`.`send_started_at` IS NOT NULL AND `ods_provider_calls`.`response_received_at` IS NULL AND `ods_provider_calls`.`finished_at` IS NULL AND `ods_provider_calls`.`elapsed_seconds` IS NULL AND `ods_provider_calls`.`terminal_captured_at` IS NULL AND `ods_provider_calls`.`ambiguous_at` IS NULL AND `ods_provider_calls`.`reconciled_at` IS NULL AND `ods_provider_calls`.`reconciliation_method` IS NULL AND `ods_provider_calls`.`reconciled_by_provider_call_id` IS NULL AND `ods_provider_calls`.`transport_error` IS NULL)),
	CONSTRAINT `ck_calls_not_sent` CHECK(`ods_provider_calls`.`outcome` IS NULL OR `ods_provider_calls`.`outcome` <> 'not_sent' OR (`ods_provider_calls`.`call_status` = 'terminal' AND `ods_provider_calls`.`finished_at` IS NOT NULL AND `ods_provider_calls`.`terminal_captured_at` IS NOT NULL AND `ods_provider_calls`.`send_started_at` IS NULL AND `ods_provider_calls`.`response_received_at` IS NULL AND `ods_provider_calls`.`elapsed_seconds` IS NULL AND `ods_provider_calls`.`ambiguous_at` IS NULL AND `ods_provider_calls`.`reconciled_at` IS NULL AND `ods_provider_calls`.`reconciliation_method` IS NULL AND `ods_provider_calls`.`reconciled_by_provider_call_id` IS NULL AND `ods_provider_calls`.`transport_error` IS NULL)),
	CONSTRAINT `ck_calls_complete_response` CHECK(`ods_provider_calls`.`outcome` IS NULL OR `ods_provider_calls`.`outcome` NOT IN ('succeeded','http_error','provider_error','invalid_response') OR (`ods_provider_calls`.`call_status` = 'terminal' AND `ods_provider_calls`.`send_started_at` IS NOT NULL AND `ods_provider_calls`.`response_received_at` IS NOT NULL AND `ods_provider_calls`.`finished_at` IS NOT NULL AND `ods_provider_calls`.`elapsed_seconds` IS NOT NULL AND `ods_provider_calls`.`terminal_captured_at` IS NOT NULL AND `ods_provider_calls`.`http_status` IS NOT NULL AND `ods_provider_calls`.`ambiguous_at` IS NULL AND `ods_provider_calls`.`reconciled_at` IS NULL AND `ods_provider_calls`.`reconciliation_method` IS NULL AND `ods_provider_calls`.`reconciled_by_provider_call_id` IS NULL AND `ods_provider_calls`.`transport_error` IS NULL)),
	CONSTRAINT `ck_calls_transport_error` CHECK(`ods_provider_calls`.`outcome` IS NULL OR `ods_provider_calls`.`outcome` <> 'transport_error' OR (`ods_provider_calls`.`call_status` = 'terminal' AND `ods_provider_calls`.`send_started_at` IS NOT NULL AND `ods_provider_calls`.`finished_at` IS NOT NULL AND `ods_provider_calls`.`elapsed_seconds` IS NOT NULL AND `ods_provider_calls`.`terminal_captured_at` IS NOT NULL AND `ods_provider_calls`.`transport_error` IS NOT NULL AND `ods_provider_calls`.`response_received_at` IS NULL AND `ods_provider_calls`.`ambiguous_at` IS NULL AND `ods_provider_calls`.`reconciled_at` IS NULL AND `ods_provider_calls`.`reconciliation_method` IS NULL AND `ods_provider_calls`.`reconciled_by_provider_call_id` IS NULL)),
	CONSTRAINT `ck_calls_ambiguous` CHECK(`ods_provider_calls`.`call_status` <> 'ambiguous' OR (`ods_provider_calls`.`outcome` = 'ambiguous' AND `ods_provider_calls`.`send_started_at` IS NOT NULL AND `ods_provider_calls`.`ambiguous_at` IS NOT NULL AND `ods_provider_calls`.`response_received_at` IS NULL AND `ods_provider_calls`.`finished_at` IS NULL AND `ods_provider_calls`.`elapsed_seconds` IS NULL AND `ods_provider_calls`.`terminal_captured_at` IS NULL AND `ods_provider_calls`.`reconciled_at` IS NULL AND `ods_provider_calls`.`reconciliation_method` IS NULL AND `ods_provider_calls`.`reconciled_by_provider_call_id` IS NULL)),
	CONSTRAINT `ck_calls_reconciled` CHECK(`ods_provider_calls`.`outcome` IS NULL OR `ods_provider_calls`.`outcome` NOT IN ('reconciled_succeeded','reconciled_failed') OR (`ods_provider_calls`.`call_status` = 'terminal' AND `ods_provider_calls`.`send_started_at` IS NOT NULL AND `ods_provider_calls`.`finished_at` IS NOT NULL AND `ods_provider_calls`.`terminal_captured_at` IS NOT NULL AND `ods_provider_calls`.`ambiguous_at` IS NOT NULL AND `ods_provider_calls`.`reconciled_at` IS NOT NULL AND `ods_provider_calls`.`reconciliation_method` IS NOT NULL AND `ods_provider_calls`.`reconciled_by_provider_call_id` IS NOT NULL AND `ods_provider_calls`.`response_received_at` IS NULL AND `ods_provider_calls`.`elapsed_seconds` IS NULL)),
	CONSTRAINT `ck_calls_terminal_has_outcome` CHECK(`ods_provider_calls`.`call_status` <> 'terminal' OR `ods_provider_calls`.`outcome` IS NOT NULL),
	CONSTRAINT `ck_calls_times` CHECK((`ods_provider_calls`.`send_started_at` IS NULL OR `ods_provider_calls`.`send_started_at` >= `ods_provider_calls`.`prepared_at`)
          AND (`ods_provider_calls`.`response_received_at` IS NULL OR `ods_provider_calls`.`response_received_at` >= `ods_provider_calls`.`send_started_at`)
          AND (`ods_provider_calls`.`ambiguous_at` IS NULL OR `ods_provider_calls`.`ambiguous_at` >= `ods_provider_calls`.`send_started_at`)
          AND (`ods_provider_calls`.`terminal_captured_at` IS NULL OR `ods_provider_calls`.`terminal_captured_at` >= `ods_provider_calls`.`finished_at`)
          AND (`ods_provider_calls`.`reconciled_at` IS NULL OR (`ods_provider_calls`.`reconciled_at` >= `ods_provider_calls`.`ambiguous_at` AND `ods_provider_calls`.`finished_at` >= `ods_provider_calls`.`reconciled_at`))
          AND (`ods_provider_calls`.`outcome` IS NULL OR `ods_provider_calls`.`outcome` IN ('not_sent','reconciled_succeeded','reconciled_failed','ambiguous') OR `ods_provider_calls`.`finished_at` >= `ods_provider_calls`.`send_started_at`)
          AND (`ods_provider_calls`.`elapsed_seconds` IS NULL OR `ods_provider_calls`.`elapsed_seconds` >= 0))
);
--> statement-breakpoint
CREATE TABLE `sync_batches` (
	`batch_id` bigint AUTO_INCREMENT NOT NULL,
	`batch_key` binary(32) NOT NULL,
	`trigger_type` varchar(32) NOT NULL,
	`logical_at` datetime(6) NOT NULL,
	`status` varchar(32) NOT NULL,
	`settings_version` bigint NOT NULL,
	`settings_snapshot` json NOT NULL,
	`detail_rule_version` varchar(128),
	`comment_rule_version` varchar(128),
	`planned_task_count` bigint NOT NULL DEFAULT 0,
	`succeeded_task_count` bigint NOT NULL DEFAULT 0,
	`failed_task_count` bigint NOT NULL DEFAULT 0,
	`skipped_task_count` bigint NOT NULL DEFAULT 0,
	`gap_task_count` bigint NOT NULL DEFAULT 0,
	`skip_reason` varchar(128),
	`started_at` datetime(6),
	`finished_at` datetime(6),
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `sync_batches_batch_id` PRIMARY KEY(`batch_id`),
	CONSTRAINT `uq_sync_batches_key` UNIQUE(`batch_key`),
	CONSTRAINT `ck_sync_batches_trigger` CHECK(`sync_batches`.`trigger_type` IN ('scheduled','manual')),
	CONSTRAINT `ck_sync_batches_status` CHECK(`sync_batches`.`status` IN ('planned','queued','running','succeeded','partial_succeeded','failed','cancelled','skipped','expired')),
	CONSTRAINT `ck_sync_batches_counts` CHECK(`sync_batches`.`planned_task_count` >= 0 AND `sync_batches`.`succeeded_task_count` >= 0 AND `sync_batches`.`failed_task_count` >= 0 AND `sync_batches`.`skipped_task_count` >= 0 AND `sync_batches`.`gap_task_count` >= 0)
);
--> statement-breakpoint
CREATE TABLE `sync_checkpoints` (
	`checkpoint_id` bigint AUTO_INCREMENT NOT NULL,
	`account_id` bigint NOT NULL,
	`provider_id` bigint NOT NULL,
	`action` varchar(64) NOT NULL DEFAULT 'fetch_content_list',
	`checkpoint_scope` varchar(64) NOT NULL DEFAULT 'default',
	`anchor_mode` varchar(16) NOT NULL,
	`high_watermark_published_at` datetime(6),
	`high_watermark_content_ids` json,
	`cursor_envelope` json,
	`cursor_sha256` binary(32),
	`cursor_task_id` bigint,
	`last_successful_batch_id` bigint,
	`last_successful_task_id` bigint,
	`continuity_status` varchar(32) NOT NULL,
	`last_gap_at` datetime(6),
	`version` bigint NOT NULL DEFAULT 0,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `sync_checkpoints_checkpoint_id` PRIMARY KEY(`checkpoint_id`),
	CONSTRAINT `uq_checkpoints_scope` UNIQUE(`account_id`,`provider_id`,`action`,`checkpoint_scope`),
	CONSTRAINT `ck_checkpoints_anchor_mode` CHECK(`sync_checkpoints`.`anchor_mode` IN ('time','id_window','empty')),
	CONSTRAINT `ck_checkpoints_continuity` CHECK(`sync_checkpoints`.`continuity_status` IN ('ready','in_progress','rebased_after_gap','blocked')),
	CONSTRAINT `ck_checkpoints_cursor_pair` CHECK((`sync_checkpoints`.`cursor_envelope` IS NULL) = (`sync_checkpoints`.`cursor_sha256` IS NULL)),
	CONSTRAINT `ck_checkpoints_ids_array` CHECK(`sync_checkpoints`.`high_watermark_content_ids` IS NULL OR JSON_TYPE(`sync_checkpoints`.`high_watermark_content_ids`) = 'ARRAY'),
	CONSTRAINT `ck_checkpoints_anchor_shape` CHECK((`sync_checkpoints`.`anchor_mode` = 'time' AND `sync_checkpoints`.`high_watermark_published_at` IS NOT NULL)
        OR (`sync_checkpoints`.`anchor_mode` = 'id_window' AND `sync_checkpoints`.`high_watermark_published_at` IS NULL AND `sync_checkpoints`.`high_watermark_content_ids` IS NOT NULL AND JSON_LENGTH(`sync_checkpoints`.`high_watermark_content_ids`) > 0)
        OR (`sync_checkpoints`.`anchor_mode` = 'empty' AND `sync_checkpoints`.`high_watermark_published_at` IS NULL AND (`sync_checkpoints`.`high_watermark_content_ids` IS NULL OR JSON_LENGTH(`sync_checkpoints`.`high_watermark_content_ids`) = 0))),
	CONSTRAINT `ck_checkpoints_version` CHECK(`sync_checkpoints`.`version` >= 0)
);
--> statement-breakpoint
CREATE TABLE `sync_settings` (
	`settings_id` tinyint NOT NULL DEFAULT 1,
	`timezone` varchar(64) NOT NULL DEFAULT 'Asia/Shanghai',
	`schedule_slots` json NOT NULL,
	`initial_content_limit` int NOT NULL DEFAULT 20,
	`list_safety_page_limit` int NOT NULL,
	`comment_page_limit` int,
	`comment_item_limit` int,
	`account_resolve_max_attempts` int NOT NULL DEFAULT 3,
	`task_max_attempts` int NOT NULL,
	`config_version` bigint NOT NULL,
	`updated_by_actor` varchar(128),
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `sync_settings_settings_id` PRIMARY KEY(`settings_id`),
	CONSTRAINT `ck_sync_settings_singleton` CHECK(`sync_settings`.`settings_id` = 1),
	CONSTRAINT `ck_sync_settings_slots` CHECK(JSON_LENGTH(`sync_settings`.`schedule_slots`) BETWEEN 1 AND 2),
	CONSTRAINT `ck_sync_settings_initial_limit` CHECK(`sync_settings`.`initial_content_limit` BETWEEN 1 AND 20),
	CONSTRAINT `ck_sync_settings_positive` CHECK(`sync_settings`.`list_safety_page_limit` > 0 AND `sync_settings`.`task_max_attempts` > 0 AND `sync_settings`.`account_resolve_max_attempts` > 0),
	CONSTRAINT `ck_sync_settings_comment_limits` CHECK((`sync_settings`.`comment_page_limit` IS NOT NULL OR `sync_settings`.`comment_item_limit` IS NOT NULL) AND (`sync_settings`.`comment_page_limit` IS NULL OR `sync_settings`.`comment_page_limit` > 0) AND (`sync_settings`.`comment_item_limit` IS NULL OR `sync_settings`.`comment_item_limit` > 0))
);
--> statement-breakpoint
CREATE TABLE `sync_tasks` (
	`task_id` bigint AUTO_INCREMENT NOT NULL,
	`batch_id` bigint NOT NULL,
	`parent_task_id` bigint,
	`provider_id` bigint NOT NULL,
	`platform_id` bigint NOT NULL,
	`assignment_id` bigint,
	`account_id` bigint,
	`content_id` bigint,
	`requested_action` varchar(64) NOT NULL,
	`subject_type` varchar(32) NOT NULL,
	`subject_id` bigint,
	`subject_key` varchar(2048),
	`subject_key_sha256` binary(32),
	`task_parameters` json NOT NULL,
	`rule_decision_id` varchar(256),
	`rule_version` varchar(128),
	`source_content_snapshot_id` bigint,
	`idempotency_key` binary(32) NOT NULL,
	`submitted_by_actor` varchar(128),
	`caller_idempotency_key_sha256` binary(32),
	`canonical_command_sha256` binary(32),
	`status` varchar(32) NOT NULL,
	`priority` int NOT NULL DEFAULT 0,
	`attempt_count` int NOT NULL,
	`max_attempts` int NOT NULL,
	`next_attempt_at` datetime(6),
	`lease_owner` varchar(128),
	`lease_expires_at` datetime(6),
	`fencing_token` bigint NOT NULL DEFAULT 0,
	`page_count` bigint NOT NULL DEFAULT 0,
	`fetched_item_count` bigint NOT NULL DEFAULT 0,
	`oldest_published_at` datetime(6),
	`newest_published_at` datetime(6),
	`has_more_at_stop` boolean,
	`continuity_gap_detected` boolean NOT NULL DEFAULT false,
	`window_overflow_detected` boolean NOT NULL DEFAULT false,
	`stop_reason` varchar(64),
	`result_summary` json,
	`last_error_code` varchar(128),
	`last_error_detail` json,
	`started_at` datetime(6),
	`finished_at` datetime(6),
	`expires_at` datetime(6) NOT NULL,
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `sync_tasks_task_id` PRIMARY KEY(`task_id`),
	CONSTRAINT `uq_sync_tasks_idempotency` UNIQUE(`idempotency_key`),
	CONSTRAINT `uq_sync_tasks_caller_key` UNIQUE(`submitted_by_actor`,`caller_idempotency_key_sha256`),
	CONSTRAINT `ck_sync_tasks_status` CHECK(`sync_tasks`.`status` IN ('pending','leased','running','retry_wait','succeeded','succeeded_with_gap','failed','dead','cancelled')),
	CONSTRAINT `ck_sync_tasks_action` CHECK(`sync_tasks`.`requested_action` IN ('resolve_account','fetch_profile','fetch_content_list','fetch_content_detail','fetch_comments','download_media')),
	CONSTRAINT `ck_sync_tasks_command_triple` CHECK(((`sync_tasks`.`submitted_by_actor` IS NULL) = (`sync_tasks`.`caller_idempotency_key_sha256` IS NULL)) AND ((`sync_tasks`.`caller_idempotency_key_sha256` IS NULL) = (`sync_tasks`.`canonical_command_sha256` IS NULL))),
	CONSTRAINT `ck_sync_tasks_attempts` CHECK(`sync_tasks`.`attempt_count` >= 0 AND `sync_tasks`.`attempt_count` <= `sync_tasks`.`max_attempts`),
	CONSTRAINT `ck_sync_tasks_lease` CHECK(`sync_tasks`.`status` NOT IN ('leased','running') OR (`sync_tasks`.`lease_owner` IS NOT NULL AND `sync_tasks`.`lease_expires_at` IS NOT NULL)),
	CONSTRAINT `ck_sync_tasks_overflow` CHECK(NOT `sync_tasks`.`window_overflow_detected` OR `sync_tasks`.`continuity_gap_detected`),
	CONSTRAINT `ck_sync_tasks_gap` CHECK(`sync_tasks`.`status` <> 'succeeded_with_gap' OR (`sync_tasks`.`continuity_gap_detected` AND `sync_tasks`.`stop_reason` IS NOT NULL)),
	CONSTRAINT `ck_sync_tasks_counts` CHECK(`sync_tasks`.`page_count` >= 0 AND `sync_tasks`.`fetched_item_count` >= 0 AND `sync_tasks`.`fencing_token` >= 0),
	CONSTRAINT `ck_sync_tasks_subject_key` CHECK((`sync_tasks`.`subject_key` IS NULL) = (`sync_tasks`.`subject_key_sha256` IS NULL))
);
--> statement-breakpoint
ALTER TABLE `account_profile_snapshots` ADD CONSTRAINT `account_profile_snapshots_batch_id_sync_batches_batch_id_fk` FOREIGN KEY (`batch_id`) REFERENCES `sync_batches`(`batch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `account_profile_snapshots` ADD CONSTRAINT `fk_profile_snap_account` FOREIGN KEY (`account_id`) REFERENCES `external_accounts`(`account_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `account_profile_snapshots` ADD CONSTRAINT `fk_profile_snap_assignment` FOREIGN KEY (`assignment_id`) REFERENCES `staff_account_assignments`(`assignment_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `account_profile_snapshots` ADD CONSTRAINT `fk_profile_snap_provider` FOREIGN KEY (`provider_id`) REFERENCES `data_providers`(`provider_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `account_profile_snapshots` ADD CONSTRAINT `fk_profile_snap_call` FOREIGN KEY (`source_provider_call_id`) REFERENCES `ods_provider_calls`(`provider_call_id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `external_account_identifiers` ADD CONSTRAINT `fk_identifiers_account` FOREIGN KEY (`account_id`) REFERENCES `external_accounts`(`account_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `external_account_identifiers` ADD CONSTRAINT `fk_identifiers_evidence_batch` FOREIGN KEY (`evidence_batch_id`) REFERENCES `sync_batches`(`batch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `external_accounts` ADD CONSTRAINT `external_accounts_platform_id_platforms_platform_id_fk` FOREIGN KEY (`platform_id`) REFERENCES `platforms`(`platform_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `external_accounts` ADD CONSTRAINT `fk_accounts_current_profile` FOREIGN KEY (`account_id`,`current_profile_snapshot_id`) REFERENCES `account_profile_snapshots`(`account_id`,`profile_snapshot_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `staff_account_assignments` ADD CONSTRAINT `staff_account_assignments_staff_id_media_staff_staff_id_fk` FOREIGN KEY (`staff_id`) REFERENCES `media_staff`(`staff_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `staff_account_assignments` ADD CONSTRAINT `fk_assignments_account_platform` FOREIGN KEY (`account_id`,`platform_id`) REFERENCES `external_accounts`(`account_id`,`platform_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `content_discoveries` ADD CONSTRAINT `content_discoveries_batch_id_sync_batches_batch_id_fk` FOREIGN KEY (`batch_id`) REFERENCES `sync_batches`(`batch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `content_discoveries` ADD CONSTRAINT `content_discoveries_content_id_contents_content_id_fk` FOREIGN KEY (`content_id`) REFERENCES `contents`(`content_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `content_discoveries` ADD CONSTRAINT `fk_discoveries_assignment` FOREIGN KEY (`assignment_id`) REFERENCES `staff_account_assignments`(`assignment_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `content_discoveries` ADD CONSTRAINT `fk_discoveries_call` FOREIGN KEY (`source_provider_call_id`) REFERENCES `ods_provider_calls`(`provider_call_id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `content_snapshots` ADD CONSTRAINT `content_snapshots_batch_id_sync_batches_batch_id_fk` FOREIGN KEY (`batch_id`) REFERENCES `sync_batches`(`batch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `content_snapshots` ADD CONSTRAINT `content_snapshots_content_id_contents_content_id_fk` FOREIGN KEY (`content_id`) REFERENCES `contents`(`content_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `content_snapshots` ADD CONSTRAINT `fk_content_snap_list_call` FOREIGN KEY (`last_list_provider_call_id`) REFERENCES `ods_provider_calls`(`provider_call_id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `content_snapshots` ADD CONSTRAINT `fk_content_snap_detail_call` FOREIGN KEY (`last_detail_provider_call_id`) REFERENCES `ods_provider_calls`(`provider_call_id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contents` ADD CONSTRAINT `contents_platform_id_platforms_platform_id_fk` FOREIGN KEY (`platform_id`) REFERENCES `platforms`(`platform_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contents` ADD CONSTRAINT `contents_account_id_external_accounts_account_id_fk` FOREIGN KEY (`account_id`) REFERENCES `external_accounts`(`account_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contents` ADD CONSTRAINT `fk_contents_current_snapshot` FOREIGN KEY (`content_id`,`current_snapshot_id`) REFERENCES `content_snapshots`(`content_id`,`content_snapshot_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_assets` ADD CONSTRAINT `fk_media_assets_oss_object` FOREIGN KEY (`oss_object_id`,`object_category`) REFERENCES `oss_objects`(`oss_object_id`,`object_category`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_references` ADD CONSTRAINT `media_references_media_asset_id_media_assets_media_asset_id_fk` FOREIGN KEY (`media_asset_id`) REFERENCES `media_assets`(`media_asset_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_references` ADD CONSTRAINT `fk_media_refs_profile_snap` FOREIGN KEY (`profile_snapshot_id`) REFERENCES `account_profile_snapshots`(`profile_snapshot_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_references` ADD CONSTRAINT `fk_media_refs_content_snap` FOREIGN KEY (`content_snapshot_id`) REFERENCES `content_snapshots`(`content_snapshot_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_references` ADD CONSTRAINT `fk_media_refs_call` FOREIGN KEY (`source_provider_call_id`) REFERENCES `ods_provider_calls`(`provider_call_id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `branches` ADD CONSTRAINT `branches_region_id_regions_region_id_fk` FOREIGN KEY (`region_id`) REFERENCES `regions`(`region_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_staff` ADD CONSTRAINT `media_staff_store_id_stores_store_id_fk` FOREIGN KEY (`store_id`) REFERENCES `stores`(`store_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sectors` ADD CONSTRAINT `sectors_branch_id_branches_branch_id_fk` FOREIGN KEY (`branch_id`) REFERENCES `branches`(`branch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stores` ADD CONSTRAINT `stores_dealer_id_dealers_dealer_id_fk` FOREIGN KEY (`dealer_id`) REFERENCES `dealers`(`dealer_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stores` ADD CONSTRAINT `stores_brand_id_brands_brand_id_fk` FOREIGN KEY (`brand_id`) REFERENCES `brands`(`brand_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stores` ADD CONSTRAINT `stores_sector_id_sectors_sector_id_fk` FOREIGN KEY (`sector_id`) REFERENCES `sectors`(`sector_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `data_quality_issues` ADD CONSTRAINT `data_quality_issues_batch_id_sync_batches_batch_id_fk` FOREIGN KEY (`batch_id`) REFERENCES `sync_batches`(`batch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `data_quality_issues` ADD CONSTRAINT `data_quality_issues_account_id_external_accounts_account_id_fk` FOREIGN KEY (`account_id`) REFERENCES `external_accounts`(`account_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `data_quality_issues` ADD CONSTRAINT `data_quality_issues_content_id_contents_content_id_fk` FOREIGN KEY (`content_id`) REFERENCES `contents`(`content_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `data_quality_issues` ADD CONSTRAINT `fk_issues_assignment` FOREIGN KEY (`assignment_id`) REFERENCES `staff_account_assignments`(`assignment_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `data_quality_issues` ADD CONSTRAINT `fk_issues_call` FOREIGN KEY (`provider_call_id`) REFERENCES `ods_provider_calls`(`provider_call_id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ods_payloads` ADD CONSTRAINT `fk_payloads_call` FOREIGN KEY (`provider_call_id`) REFERENCES `ods_provider_calls`(`provider_call_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ods_payloads` ADD CONSTRAINT `fk_payloads_oss_object` FOREIGN KEY (`oss_object_id`,`object_category`) REFERENCES `oss_objects`(`oss_object_id`,`object_category`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ods_provider_calls` ADD CONSTRAINT `ods_provider_calls_sync_task_id_sync_tasks_task_id_fk` FOREIGN KEY (`sync_task_id`) REFERENCES `sync_tasks`(`task_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ods_provider_calls` ADD CONSTRAINT `ods_provider_calls_provider_id_data_providers_provider_id_fk` FOREIGN KEY (`provider_id`) REFERENCES `data_providers`(`provider_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ods_provider_calls` ADD CONSTRAINT `ods_provider_calls_platform_id_platforms_platform_id_fk` FOREIGN KEY (`platform_id`) REFERENCES `platforms`(`platform_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ods_provider_calls` ADD CONSTRAINT `fk_calls_reconciled_by` FOREIGN KEY (`reconciled_by_provider_call_id`) REFERENCES `ods_provider_calls`(`provider_call_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sync_checkpoints` ADD CONSTRAINT `sync_checkpoints_account_id_external_accounts_account_id_fk` FOREIGN KEY (`account_id`) REFERENCES `external_accounts`(`account_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sync_checkpoints` ADD CONSTRAINT `sync_checkpoints_provider_id_data_providers_provider_id_fk` FOREIGN KEY (`provider_id`) REFERENCES `data_providers`(`provider_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sync_checkpoints` ADD CONSTRAINT `sync_checkpoints_cursor_task_id_sync_tasks_task_id_fk` FOREIGN KEY (`cursor_task_id`) REFERENCES `sync_tasks`(`task_id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sync_checkpoints` ADD CONSTRAINT `sync_checkpoints_last_successful_task_id_sync_tasks_task_id_fk` FOREIGN KEY (`last_successful_task_id`) REFERENCES `sync_tasks`(`task_id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sync_checkpoints` ADD CONSTRAINT `fk_checkpoints_batch` FOREIGN KEY (`last_successful_batch_id`) REFERENCES `sync_batches`(`batch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sync_tasks` ADD CONSTRAINT `sync_tasks_batch_id_sync_batches_batch_id_fk` FOREIGN KEY (`batch_id`) REFERENCES `sync_batches`(`batch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sync_tasks` ADD CONSTRAINT `sync_tasks_provider_id_data_providers_provider_id_fk` FOREIGN KEY (`provider_id`) REFERENCES `data_providers`(`provider_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sync_tasks` ADD CONSTRAINT `sync_tasks_platform_id_platforms_platform_id_fk` FOREIGN KEY (`platform_id`) REFERENCES `platforms`(`platform_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sync_tasks` ADD CONSTRAINT `sync_tasks_account_id_external_accounts_account_id_fk` FOREIGN KEY (`account_id`) REFERENCES `external_accounts`(`account_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sync_tasks` ADD CONSTRAINT `sync_tasks_content_id_contents_content_id_fk` FOREIGN KEY (`content_id`) REFERENCES `contents`(`content_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sync_tasks` ADD CONSTRAINT `fk_sync_tasks_assignment` FOREIGN KEY (`assignment_id`) REFERENCES `staff_account_assignments`(`assignment_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sync_tasks` ADD CONSTRAINT `fk_sync_tasks_parent` FOREIGN KEY (`parent_task_id`) REFERENCES `sync_tasks`(`task_id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_profile_snapshots_account_batch` ON `account_profile_snapshots` (`account_id`,`batch_id`);--> statement-breakpoint
CREATE INDEX `idx_profile_snapshots_assignment_batch` ON `account_profile_snapshots` (`assignment_id`,`batch_id`);--> statement-breakpoint
CREATE INDEX `idx_identifiers_account_ns` ON `external_account_identifiers` (`account_id`,`namespace_code`);--> statement-breakpoint
CREATE INDEX `idx_identifiers_evidence_batch` ON `external_account_identifiers` (`evidence_batch_id`);--> statement-breakpoint
CREATE INDEX `idx_accounts_platform_status` ON `external_accounts` (`platform_id`,`status`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `idx_accounts_current_profile` ON `external_accounts` (`current_profile_snapshot_id`);--> statement-breakpoint
CREATE INDEX `idx_assignments_staff_platform` ON `staff_account_assignments` (`staff_id`,`platform_id`);--> statement-breakpoint
CREATE INDEX `idx_assignments_watch_monitoring` ON `staff_account_assignments` (`watch_type`,`monitoring_enabled`);--> statement-breakpoint
CREATE INDEX `idx_discoveries_assignment_batch_pos` ON `content_discoveries` (`assignment_id`,`batch_id`,`absolute_position`);--> statement-breakpoint
CREATE INDEX `idx_discoveries_content_batch` ON `content_discoveries` (`content_id`,`batch_id`);--> statement-breakpoint
CREATE INDEX `idx_discoveries_batch_pinned` ON `content_discoveries` (`batch_id`,`is_potentially_pinned`);--> statement-breakpoint
CREATE INDEX `idx_content_snapshots_content_batch` ON `content_snapshots` (`content_id`,`batch_id`);--> statement-breakpoint
CREATE INDEX `idx_content_snapshots_batch_published` ON `content_snapshots` (`batch_id`,`published_at`);--> statement-breakpoint
CREATE INDEX `idx_content_snapshots_published` ON `content_snapshots` (`published_at`,`content_id`);--> statement-breakpoint
CREATE INDEX `idx_contents_platform_content` ON `contents` (`platform_id`,`platform_content_id_sha256`);--> statement-breakpoint
CREATE INDEX `idx_contents_platform_status` ON `contents` (`platform_id`,`status`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `idx_contents_current_snapshot` ON `contents` (`current_snapshot_id`);--> statement-breakpoint
CREATE INDEX `idx_media_assets_kind_created` ON `media_assets` (`media_kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_media_refs_asset` ON `media_references` (`media_asset_id`);--> statement-breakpoint
CREATE INDEX `idx_media_refs_status_updated` ON `media_references` (`archive_status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_oss_objects_status_expires` ON `oss_objects` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_oss_objects_sha` ON `oss_objects` (`sha256`);--> statement-breakpoint
CREATE INDEX `idx_branches_region_status` ON `branches` (`region_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_dealers_name` ON `dealers` (`dealer_name`);--> statement-breakpoint
CREATE INDEX `idx_dealers_status_monitoring` ON `dealers` (`status`,`monitoring_enabled`);--> statement-breakpoint
CREATE INDEX `idx_media_staff_phone` ON `media_staff` (`phone`);--> statement-breakpoint
CREATE INDEX `idx_media_staff_store` ON `media_staff` (`store_id`,`status`,`monitoring_enabled`);--> statement-breakpoint
CREATE INDEX `idx_sectors_branch_status` ON `sectors` (`branch_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_stores_dealer_status` ON `stores` (`dealer_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_stores_brand_status` ON `stores` (`brand_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_stores_sector_status` ON `stores` (`sector_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_stores_source_batch` ON `stores` (`source_batch_id`);--> statement-breakpoint
CREATE INDEX `idx_issues_status_severity` ON `data_quality_issues` (`status`,`severity`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `idx_issues_code` ON `data_quality_issues` (`issue_code`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `idx_issues_batch` ON `data_quality_issues` (`batch_id`);--> statement-breakpoint
CREATE INDEX `idx_issues_account` ON `data_quality_issues` (`account_id`);--> statement-breakpoint
CREATE INDEX `idx_issues_content` ON `data_quality_issues` (`content_id`);--> statement-breakpoint
CREATE INDEX `idx_issues_assignment` ON `data_quality_issues` (`assignment_id`);--> statement-breakpoint
CREATE INDEX `idx_issues_call` ON `data_quality_issues` (`provider_call_id`);--> statement-breakpoint
CREATE INDEX `idx_payloads_expires` ON `ods_payloads` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_payloads_sha` ON `ods_payloads` (`sha256`);--> statement-breakpoint
CREATE INDEX `idx_calls_provider_task` ON `ods_provider_calls` (`provider_task_id`);--> statement-breakpoint
CREATE INDEX `idx_calls_provider_request` ON `ods_provider_calls` (`provider_request_id`);--> statement-breakpoint
CREATE INDEX `idx_calls_reconciled_by` ON `ods_provider_calls` (`reconciled_by_provider_call_id`);--> statement-breakpoint
CREATE INDEX `idx_calls_prepared` ON `ods_provider_calls` (`prepared_at`,`provider_call_id`);--> statement-breakpoint
CREATE INDEX `idx_calls_status_prepared` ON `ods_provider_calls` (`call_status`,`prepared_at`);--> statement-breakpoint
CREATE INDEX `idx_calls_outcome_finished` ON `ods_provider_calls` (`outcome`,`finished_at`);--> statement-breakpoint
CREATE INDEX `idx_calls_expires` ON `ods_provider_calls` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_sync_batches_status_logical` ON `sync_batches` (`status`,`logical_at`);--> statement-breakpoint
CREATE INDEX `idx_checkpoints_batch` ON `sync_checkpoints` (`last_successful_batch_id`);--> statement-breakpoint
CREATE INDEX `idx_sync_tasks_claim` ON `sync_tasks` (`status`,`next_attempt_at`,`priority`,`task_id`);--> statement-breakpoint
CREATE INDEX `idx_sync_tasks_batch_status` ON `sync_tasks` (`batch_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_sync_tasks_account_action` ON `sync_tasks` (`account_id`,`requested_action`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_sync_tasks_content_action` ON `sync_tasks` (`content_id`,`requested_action`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_sync_tasks_parent` ON `sync_tasks` (`parent_task_id`);--> statement-breakpoint
CREATE INDEX `idx_sync_tasks_canonical_command` ON `sync_tasks` (`canonical_command_sha256`);--> statement-breakpoint
CREATE INDEX `idx_sync_tasks_expires` ON `sync_tasks` (`expires_at`);