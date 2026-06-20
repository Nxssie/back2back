CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`created_at` integer
);
--> statement-breakpoint
CREATE TABLE `songs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`room_id` text NOT NULL,
	`video_id` text NOT NULL,
	`url` text NOT NULL,
	`title` text,
	`added_by` text DEFAULT 'Anonymous',
	`votes` integer DEFAULT 0,
	`played` integer DEFAULT false,
	`created_at` integer,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action
);
