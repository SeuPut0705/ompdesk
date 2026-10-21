import { describe, expect, it } from "vitest";
import type { AiMemoryProject } from "../../shared/ai-memory";
import { type AmbiguousNameClient, renameAmbiguousProjects } from "./ambiguous-names";

function fake(
	projects: AiMemoryProject[],
	ambiguous: string[],
	refuse: (to: string) => string | null = () => null,
): AmbiguousNameClient & { renames: string[] } {
	const renames: string[] = [];
	return {
		renames,
		projects: async () => projects,
		nameStatus: async ref => (ambiguous.includes(ref.project) ? "ambiguous" : "resolved"),
		renameUnclaimedProject: async (_workspace, id, to) => {
			const reason = refuse(to);
			if (reason) throw new Error(reason);
			renames.push(`${id}->${to}`);
		},
	};
}

const project = (name: string, extra: Partial<AiMemoryProject> = {}): AiMemoryProject => ({
	workspace: "default",
	project: name,
	pages: 1,
	lastUpdated: null,
	id: `id-${name}`,
	...extra,
});

describe("renameAmbiguousProjects", () => {
	it("renames only the plain project whose name the server calls ambiguous, never the repository's", async () => {
		const client = fake(
			[
				project("seuput0705-ompdesk"),
				project("ompdesk", { identity: "github.com/seuput0705/ompdesk" }),
				project("notes"),
				project("_global"),
			],
			["seuput0705-ompdesk", "ompdesk", "_global"],
		);
		expect((await renameAmbiguousProjects(client)).renamed).toEqual([
			{ workspace: "default", from: "seuput0705-ompdesk", to: "seuput0705-ompdesk-unclaimed" },
		]);
		expect(client.renames).toEqual(["id-seuput0705-ompdesk->seuput0705-ompdesk-unclaimed"]);
	});

	it("takes the next free name when one is taken, listed or refused", async () => {
		const client = fake([project("acme-api"), project("acme-api-unclaimed")], ["acme-api"], to =>
			to === "acme-api-unclaimed-2" ? "project name 'acme-api-unclaimed-2' already exists" : null,
		);
		expect((await renameAmbiguousProjects(client)).renamed).toEqual([
			{ workspace: "default", from: "acme-api", to: "acme-api-unclaimed-3" },
		]);
	});

	it("renames nothing the server refuses: a captured project, or a server without the guarded route", async () => {
		const client = fake([project("folder")], ["folder"], () => "Memory answered 409");
		expect(await renameAmbiguousProjects(client)).toEqual({
			renamed: [],
			// Said, not swallowed: a repair that renamed nothing for an ambiguous name left a project unreadable unnoticed.
			refused: [{ workspace: "default", project: "folder", detail: "Memory answered 409" }],
		});
		expect(client.renames).toEqual([]);
	});
});
