CREATE TABLE `tag_categories` (
	`category_id` bigint AUTO_INCREMENT NOT NULL,
	`name` varchar(32) NOT NULL,
	`created_at` datetime(6) NOT NULL,
	CONSTRAINT `tag_categories_category_id` PRIMARY KEY(`category_id`),
	CONSTRAINT `uq_tag_categories_name` UNIQUE(`name`)
);
--> statement-breakpoint
-- g-learning-tags-v2：标签从扁平变成「一级标签 + 二级标签」。本迁移只扩展（加表、加列、回填、加约束），保留 tag_id 与 course_tags。
-- 旧标签按第一个 '-' 拆成「一级-二级」（如 平台-抖音）；没有前缀的归入「未分类」。
-- 保留 uq_tags_name：标签名暂时全局唯一，下一版再收缩；拆分后若与别的标签重名，下面的 UPDATE 会因唯一键失败——有意如此，先人工处理，不静默合并。
ALTER TABLE `tags` ADD `category_id` bigint NULL;--> statement-breakpoint
INSERT INTO `tag_categories` (`name`, `created_at`)
SELECT p.`prefix`, UTC_TIMESTAMP(6) FROM (
	SELECT TRIM(SUBSTRING_INDEX(`name`, '-', 1)) AS `prefix`, MIN(`tag_id`) AS `first_id`
	FROM `tags`
	WHERE LOCATE('-', `name`) > 1 AND TRIM(SUBSTRING_INDEX(`name`, '-', 1)) <> '' AND TRIM(SUBSTRING(`name`, LOCATE('-', `name`) + 1)) <> ''
	GROUP BY `prefix`
) p ORDER BY p.`first_id`;--> statement-breakpoint
INSERT IGNORE INTO `tag_categories` (`name`, `created_at`)
SELECT '未分类', UTC_TIMESTAMP(6) FROM DUAL
WHERE EXISTS (SELECT 1 FROM `tags` WHERE NOT (LOCATE('-', `name`) > 1 AND TRIM(SUBSTRING_INDEX(`name`, '-', 1)) <> '' AND TRIM(SUBSTRING(`name`, LOCATE('-', `name`) + 1)) <> ''));--> statement-breakpoint
UPDATE `tags` t JOIN `tag_categories` c ON c.`name` = TRIM(SUBSTRING_INDEX(t.`name`, '-', 1))
SET t.`category_id` = c.`category_id`, t.`name` = TRIM(SUBSTRING(t.`name`, LOCATE('-', t.`name`) + 1))
WHERE LOCATE('-', t.`name`) > 1 AND TRIM(SUBSTRING_INDEX(t.`name`, '-', 1)) <> '' AND TRIM(SUBSTRING(t.`name`, LOCATE('-', t.`name`) + 1)) <> '';--> statement-breakpoint
UPDATE `tags` SET `category_id` = (SELECT `category_id` FROM `tag_categories` WHERE `name` = '未分类') WHERE `category_id` IS NULL;--> statement-breakpoint
ALTER TABLE `tags` MODIFY `category_id` bigint NOT NULL;--> statement-breakpoint
ALTER TABLE `tags` ADD CONSTRAINT `uq_tags_category_name` UNIQUE(`category_id`,`name`);--> statement-breakpoint
ALTER TABLE `tags` ADD CONSTRAINT `fk_tags_category` FOREIGN KEY (`category_id`) REFERENCES `tag_categories`(`category_id`) ON DELETE no action ON UPDATE no action;
