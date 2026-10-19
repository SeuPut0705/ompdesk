-- Session conclusions copied from another computer of the same person.
--
-- A conclusion is the final answer of one turn, captured as a `Stop`
-- observation with a body. OMPdesk shares those between a person's paired
-- computers so `memory_query {conclusions:true}` on one of them answers what
-- was concluded on the other. Raw observations never cross, so the copies get
-- their own table instead of rows in `observations`: nothing here feeds
-- consolidation, session summaries, session counts or the raw-hit fallback.
--
-- Immutable: a copy is written once (`origin_id` is the id the observation has
-- on the computer it came from) and a repeat of the same origin id changes
-- nothing. `id` is AUTOINCREMENT so a deleted row's number is never reused;
-- a puller holding `id` as a cursor would otherwise miss a later row that took
-- the number of a pruned one.
--
-- `session_id` names a session of the OTHER computer, so it carries no foreign
-- key. Retention (`prune_consolidated_observations`) and `purge_session` clear
-- the rows by `created_at` and `session_id`.
CREATE TABLE synced_conclusions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id  BLOB    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_id    BLOB    NOT NULL REFERENCES projects(id)   ON DELETE CASCADE,
    origin_device TEXT    NOT NULL,
    origin_id     TEXT    NOT NULL,
    session_id    BLOB    NOT NULL,
    title         TEXT    NOT NULL,
    body          TEXT    NOT NULL,
    created_at    INTEGER NOT NULL,
    received_at   INTEGER NOT NULL,
    UNIQUE (workspace_id, project_id, origin_id)
);

CREATE INDEX idx_synced_conclusions_session ON synced_conclusions(session_id);
CREATE INDEX idx_synced_conclusions_created
    ON synced_conclusions(workspace_id, project_id, created_at);

-- Same invariant as V18: the denormalised workspace must be the project's own.
CREATE TRIGGER synced_conclusions_ws_proj_pairing_ai
BEFORE INSERT ON synced_conclusions
FOR EACH ROW
WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM projects WHERE id = NEW.project_id)
BEGIN
    SELECT RAISE(ABORT, 'synced_conclusions.workspace_id does not match the project''s workspace');
END;

-- Same tokenizer and options as `observations_fts` (V12), so a query matches a
-- synced conclusion exactly the way it matches a local one.
CREATE VIRTUAL TABLE synced_conclusions_fts USING fts5(
    title, body,
    content='synced_conclusions',
    content_rowid='id',
    tokenize="unicode61 remove_diacritics 2 tokenchars '/_-'"
);

CREATE TRIGGER synced_conclusions_fts_ai AFTER INSERT ON synced_conclusions BEGIN
    INSERT INTO synced_conclusions_fts(rowid, title, body)
        VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER synced_conclusions_fts_ad AFTER DELETE ON synced_conclusions BEGIN
    INSERT INTO synced_conclusions_fts(synced_conclusions_fts, rowid, title, body)
        VALUES ('delete', old.id, old.title, old.body);
END;
