-- 手写迁移（drizzle-kit generate --custom）。drizzle-kit 不能表达的两类东西放在这里：
--   1) 平台与供应商参考数据（v2 §6.1 初始化 douyin / xiaohongshu / wechat_channels / kuaishou；供应商 aimaster）；
--   2) 触发器：MySQL 的 CHECK 不能引用自增列（错误 3818），所以 v2 §9.5「reconciled_by 不等于自身 ID」改由触发器保证。
-- 没有种入 sync_settings：list_safety_page_limit 等取值 v2 未定，不由迁移默认值静默冻结，由运维显式配置。
INSERT INTO `platforms` (`platform_code`, `platform_name`, `status`, `created_at`, `updated_at`) VALUES
  ('douyin', '抖音', 'active', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)),
  ('xiaohongshu', '小红书', 'active', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)),
  ('wechat_channels', '视频号', 'active', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)),
  ('kuaishou', '快手', 'active', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6));
--> statement-breakpoint
INSERT INTO `data_providers` (`provider_code`, `provider_name`, `base_endpoint`, `status`, `created_at`, `updated_at`) VALUES
  ('aimaster', 'AI Master', 'https://openapi.fieldshortcut.com', 'active', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6));
--> statement-breakpoint
CREATE TRIGGER `trg_calls_reconciled_not_self` BEFORE UPDATE ON `ods_provider_calls`
FOR EACH ROW
BEGIN
  IF NEW.reconciled_by_provider_call_id IS NOT NULL AND NEW.reconciled_by_provider_call_id = NEW.provider_call_id THEN
    SIGNAL SQLSTATE '23000' SET MESSAGE_TEXT = 'trg_calls_reconciled_not_self: reconciled_by_provider_call_id must not equal provider_call_id';
  END IF;
END;
