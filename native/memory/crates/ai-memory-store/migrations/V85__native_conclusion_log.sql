-- A cursor-safe log of this computer's own conclusions, and the identity of
-- this store.
--
-- `GET /admin/conclusions?source=native` paged by `observations.rowid`. That
-- rowid is implicit (the primary key is a BLOB), and SQLite hands out
-- max(rowid) + 1 for the next insert, so after the newest rows are deleted
-- (`purge-session` on the newest session) the numbers come round again and a
-- puller holding cursor N silently skips conclusions captured afterwards.
-- AUTOINCREMENT never reuses a number, so the log below is the cursor space.
--
-- A row is added when an observation becomes a conclusion (a `Stop` with a
-- non-blank body), at insert or by a later update, and leaves with its
-- observation through the foreign key (the runtime connections enforce it, and
-- every delete path removes observations by DELETE or by a cascade from their
-- session/project/workspace).
CREATE TABLE native_conclusions (
    seq            INTEGER PRIMARY KEY AUTOINCREMENT,
    observation_id BLOB NOT NULL UNIQUE REFERENCES observations(id) ON DELETE CASCADE
);

INSERT INTO native_conclusions (observation_id)
    SELECT id FROM observations
    WHERE kind = 'stop' AND trim(body) <> ''
    ORDER BY rowid;

CREATE TRIGGER native_conclusions_ai AFTER INSERT ON observations
WHEN NEW.kind = 'stop' AND trim(NEW.body) <> ''
BEGIN
    INSERT OR IGNORE INTO native_conclusions (observation_id) VALUES (NEW.id);
END;

CREATE TRIGGER native_conclusions_au AFTER UPDATE OF body, kind ON observations
WHEN NEW.kind = 'stop' AND trim(NEW.body) <> ''
BEGIN
    INSERT OR IGNORE INTO native_conclusions (observation_id) VALUES (NEW.id);
END;

-- One row: who this database is. A puller keeps it beside its cursors; when it
-- changes (a "delete all memory" made a fresh database whose sequence numbers
-- restart), the cursors no longer mean anything and it starts over.
CREATE TABLE store_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    id        TEXT NOT NULL
);

INSERT INTO store_identity (singleton, id) VALUES (1, lower(hex(randomblob(16))));
