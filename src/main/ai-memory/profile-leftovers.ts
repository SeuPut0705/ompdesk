/**
 * The cross-project profile is on (ai-memory's `[profile] enabled` default, `auto`), so an agent can store the owner's
 * standing preferences for every project with `memory_write_page {scope: "profile"}` and every session start shows
 * them. The server's own harvest stays off (`[profile] harvest = false` in our build), because before it was turned off
 * (19 Oct 2026) it filed agents' task briefs as the owner's usual choices ("Tests: host-services unit tests …").
 * Those entries are still in `_global/profile/` on the computers that ran it, and paired computers' sync copied them;
 * with the profile on again they would lead every session start. The repair retires them (expired, restorable through
 * the page's checkpoints, synced as retired), once per launch and idempotently: a retired page leaves the page list.
 *
 * What marks one is the body the harvest renders: its evidence section `## In your words` (`ai-memory-consolidate`
 * profile.rs `entry_body`). The `generated_by: profile-harvest` stamp would be plainer, but a sync copy keeps the body
 * and not that frontmatter key, so the body is what every copy has.
 */
import type { AiMemoryClient } from "./client";
import { GLOBAL_PROJECT } from "./distill";

const HARVEST_EVIDENCE = /^## In your words[ \t]*$/m;
const PROFILE_FOLDER = "profile/";
const REASON = "written by the old profile harvest from an agent's task text, not stated by the owner";

export type ProfileLeftoverClient = Pick<AiMemoryClient, "projects" | "pages" | "page" | "retirePage">;

export interface ProfileLeftoverReport {
	retired: string[];
	/** Pinned, or edited after it was read: left as it is. */
	kept: string[];
}

/** Retires every harvest-written entry of the `_global` profile. Rejects when the server cannot be read. */
export async function retireHarvestedProfile(client: ProfileLeftoverClient, at: Date): Promise<ProfileLeftoverReport> {
	const report: ProfileLeftoverReport = { retired: [], kept: [] };
	const projects = await client.projects();
	// `_global` exists once something wrote it.
	if (!projects.some(p => p.workspace === GLOBAL_PROJECT.workspace && p.project === GLOBAL_PROJECT.project)) {
		return report;
	}
	for (const ref of await client.pages(GLOBAL_PROJECT)) {
		if (!ref.path.startsWith(PROFILE_FOLDER)) continue;
		const page = await client.page({ ...GLOBAL_PROJECT, path: ref.path });
		if (!HARVEST_EVIDENCE.test(page.markdown)) continue;
		const outcome = await client.retirePage({
			...GLOBAL_PROJECT,
			path: ref.path,
			at,
			expectedPageId: page.id,
			reason: REASON,
		});
		(outcome === "retired" ? report.retired : report.kept).push(ref.path);
	}
	return report;
}
