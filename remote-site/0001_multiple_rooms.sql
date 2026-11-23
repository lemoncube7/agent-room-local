ALTER TABLE remote_events ADD COLUMN room TEXT;
--> statement-breakpoint
ALTER TABLE remote_commands ADD COLUMN room TEXT;
--> statement-breakpoint
CREATE TABLE remote_rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL);
--> statement-breakpoint
CREATE INDEX remote_room_events ON remote_events(room,seq);
--> statement-breakpoint
CREATE INDEX remote_room_commands ON remote_commands(room,delivered,created);
