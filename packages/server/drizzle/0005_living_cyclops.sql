ALTER TABLE `songs` ADD `uploader` text;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `access_token`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `refresh_token`;