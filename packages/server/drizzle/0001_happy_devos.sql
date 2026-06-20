CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`avatar` text,
	`access_token` text,
	`refresh_token` text,
	`created_at` integer
);
--> statement-breakpoint
CREATE TABLE `votes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`song_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `votes_song_id_user_id_unique` ON `votes` (`song_id`,`user_id`);--> statement-breakpoint
DROP INDEX "votes_song_id_user_id_unique";--> statement-breakpoint
ALTER TABLE `songs` ALTER COLUMN "added_by" TO "added_by" text;--> statement-breakpoint
ALTER TABLE `songs` ADD `added_by_user_id` text;