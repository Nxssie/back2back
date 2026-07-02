CREATE TABLE `guilds` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`approved` integer DEFAULT false NOT NULL,
	`requested_by` text,
	`requested_by_username` text,
	`requested_at` integer,
	`approved_at` integer
);
