CREATE TABLE `square_brand_policies` (
	`brand_id` bigint NOT NULL,
	`view_mode` varchar(8) NOT NULL,
	`updated_by_actor` varchar(128) NOT NULL,
	`created_at` datetime(6) NOT NULL,
	`updated_at` datetime(6) NOT NULL,
	CONSTRAINT `square_brand_policies_brand_id` PRIMARY KEY(`brand_id`),
	CONSTRAINT `ck_square_policies_mode` CHECK(`square_brand_policies`.`view_mode` IN ('all','own'))
);
--> statement-breakpoint
ALTER TABLE `square_brand_policies` ADD CONSTRAINT `fk_square_policies_brand` FOREIGN KEY (`brand_id`) REFERENCES `brands`(`brand_id`) ON DELETE no action ON UPDATE no action;