CREATE INDEX `songs_room_votes_created_idx` ON `songs` (`room_id`,"votes" desc,`created_at`);--> statement-breakpoint
CREATE INDEX `songs_room_played_idx` ON `songs` (`room_id`,`played`);--> statement-breakpoint
CREATE INDEX `votes_user_id_idx` ON `votes` (`user_id`);