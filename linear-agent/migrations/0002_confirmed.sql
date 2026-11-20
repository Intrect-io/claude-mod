-- confirmed = 1 once a delivery of this event was answered 200. A write that committed after its
-- delivery was answered 503 (timeout) stays 0, so Linear's retry takes it over instead of being
-- treated as a duplicate.
ALTER TABLE events ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0;
