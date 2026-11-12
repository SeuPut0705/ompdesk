/**
 * A project the memory server cannot read by name: its name is also another project's canonical or legacy key (the
 * server refuses the name as "ambiguous"). Seen on 21 Oct 2026: a paired computer's sync made a plain
 * `seuput0705-ompdesk` here, then this computer's own capture of that repository made `ompdesk` with the canonical
 * key `seuput0705-ompdesk`, and every read of the first (pages, sessions, the sync's own listing) failed.
 *
 * The repair is the core's (`native/ompdesk/crates/core/src/upkeep/names.rs`): a rename by id of a project no
 * checkout ever captured into, to `<name>-unclaimed` (`-2`, … when taken). This file is its client.
 */
import type { AiMemoryProject, AiMemoryProjectRef } from "../../shared/ai-memory";
import { core } from "../core/process";
import { answerAsks, coreSide, serviceName } from "./core-asks";

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

/** Each rename is one request to the server; a project it refuses is tried under up to five names. */
const CORE_TIMEOUT_MS = 120_000;

export async function renameAmbiguousProjects(client: AmbiguousNameClient): Promise<NameRepair> {
	const service = serviceName();
	const side = coreSide(client);
	const stop = answerAsks(service, side.handlers);
	try {
		const answer = await core().call<NameRepair>(
			"upkeep.renameAmbiguous",
			{ service, ...side.wire() },
			{ timeoutMs: CORE_TIMEOUT_MS },
		);
		return answer.result;
	} finally {
		stop();
	}
}
