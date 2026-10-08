/**
 * Per-workspace launch profiles in GUI prefs (`launchProfiles.<cwd>`). The
 * machine that spawns omp reads them (sidecar.ts loadLaunchProfileFlags), so
 * a paired host serves its own through these same helpers.
 */
import { isAbsolute } from "node:path";
import { codedError } from "../shared/ipc-error-codes";
import { type LaunchProfile, parseLaunchProfile } from "../shared/launch-profile";

/** The slice of the prefs store the profiles need. */
export interface LaunchProfilePrefs {
	get(key: "launchProfiles"): unknown;
	set(key: "launchProfiles", value: Record<string, unknown>): void;
}

function profileMap(prefs: LaunchProfilePrefs): Record<string, unknown> {
	const raw = prefs.get("launchProfiles");
	return raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
}

export function readLaunchProfile(prefs: LaunchProfilePrefs, cwd: unknown): LaunchProfile {
	if (typeof cwd !== "string" || !isAbsolute(cwd)) throw codedError("invalid_launch_profile", "Invalid workspace");
	return parseLaunchProfile(profileMap(prefs)[cwd]);
}

/**
 * Merge `patch` into the workspace's profile and persist it; an emptied
 * profile is removed. The read/merge/write is synchronous, so concurrent
 * callers changing different fields or workspaces never replace each other.
 */
export function updateLaunchProfile(prefs: LaunchProfilePrefs, cwd: unknown, patch: unknown): LaunchProfile {
	if (typeof cwd !== "string" || !isAbsolute(cwd) || !patch || typeof patch !== "object" || Array.isArray(patch))
		throw codedError("invalid_launch_profile", "Invalid launch profile update");
	const profiles = profileMap(prefs);
	const profile = parseLaunchProfile({ ...parseLaunchProfile(profiles[cwd]), ...patch });
	if (Object.keys(profile).length) profiles[cwd] = profile;
	else delete profiles[cwd];
	prefs.set("launchProfiles", profiles);
	return profile;
}
