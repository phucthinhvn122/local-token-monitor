CREATE TABLE `public_quota_snapshots` (
	`id` integer PRIMARY KEY NOT NULL,
	`token_limit` integer NOT NULL,
	`token_used` integer NOT NULL,
	`token_remaining` integer NOT NULL,
	`observed_at` text NOT NULL,
	`published_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
