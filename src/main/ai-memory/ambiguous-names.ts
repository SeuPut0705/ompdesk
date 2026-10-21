/**
 * A project the memory server cannot read by name: its name is also another project's canonical or legacy key (the
 * server refuses the name as "ambiguous"). Seen on 21 Oct 2026: a paired computer's sync made a plain
 * `seuput0705-ompdesk` here, then this computer's own capture of that repository made `ompdesk` with the canonical
 * key `seuput0705-ompdesk`, and every read of the first (pages, sessions, the sync's own listing) failed.
 *
 * The server's own remedy is a rename by id. Only a project no checkout ever captured into is renamed: the listing
 * skips one a repository claimed, and the server's `/admin/rename-unclaimed-project` refuses (409) one with a folder or
 * a session, checked in the rename itself; an older server without that route answers 404 and nothing is renamed. The
 * new name is `<name>-unclaimed` (`-2`, `-3`, … when taken): names only, no file moves, reversible by renaming back.
 * Afterwards the old name resolves to the repository's project through its canonical key.
 */
import type { AiMemoryProject, AiMemoryProjectRef } from "../../shared/ai-memory";

export interface AmbiguousNameClient {
	projects(): Promise<AiMemoryProject[]>;
	nameStatus(ref: AiMemoryProjectRef): Promise<string>;
	renameUnclaimedProject(workspace: string, projectId: string, to: string): Promise<void>;
}

export interface RenamedProject {
	workspace: string;
	from: string;
	to: string;
}

/** An ambiguous name no rename took: the server's last answer, so it is said rather than left unreadable unseen. */
export interface RefusedRename {
	workspace: string;
	project: string;
	detail: string;
}

export interface NameRepair {
	renamed: RenamedProject[];
	refused: RefusedRename[];
}

/** Tries before giving up on one project: names may be taken as names or as keys the listing does not show. */
const NAME_TRIES = 5;

export async function renameAmbiguousProjects(client: AmbiguousNameClient): Promise<NameRepair> {
	const listed = await client.projects();
	const taken = new Set(listed.map(project => `${project.workspace}\u0000${project.project}`));
	const renamed: RenamedProject[] = [];
	const refused: RefusedRename[] = [];
	for (const project of listed) {
		// `_global` and the like are reserved scopes; a project a repository claimed keeps its name.
		if (project.identity || !project.id || project.project.startsWith("_")) continue;
		if ((await client.nameStatus(project)) !== "ambiguous") continue;
		let detail = "no free name";
		let done = false;
		for (let n = 1; n <= NAME_TRIES && !done; n++) {
			const to = `${project.project}-unclaimed${n === 1 ? "" : `-${n}`}`;
			if (taken.has(`${project.workspace}\u0000${to}`)) continue;
			try {
				await client.renameUnclaimedProject(project.workspace, project.id, to);
			} catch (error) {
				detail = error instanceof Error ? error.message : String(error);
				continue;
			}
			taken.add(`${project.workspace}\u0000${to}`);
			renamed.push({ workspace: project.workspace, from: project.project, to });
			done = true;
		}
		if (!done) refused.push({ workspace: project.workspace, project: project.project, detail });
	}
	return { renamed, refused };
}
