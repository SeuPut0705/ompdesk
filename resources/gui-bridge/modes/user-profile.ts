/**
 * User profile: Settings › General › Profile (how the agent addresses the
 * user, their development experience; contracts in ../user-profile-contracts.ts).
 * Main passes the stored profile as JSON in `OMP_GUI_USER_PROFILE` at spawn,
 * then `user_profile_set` whenever it changes, so open sessions follow from
 * their next turn. Stock omp has no such setting, so the public
 * `before_agent_start` hook appends one section, exactly like
 * modes/reply-language.ts (same reasons: no `--append-system-prompt`, an empty
 * profile leaves the prompt byte-identical to stock, subagents rebinding this
 * extension share the module state).
 *
 * No omp imports (not even types): the GUI's vitest installs it on a fake `pi`
 * (src/main/bridge-user-profile.test.ts).
 */
import { type PromptSectionHost, registerPromptSection } from "../prompt-sections";
import {
	isUserProfile,
	normalizeUserProfile,
	type UserProfile,
	userProfileInstruction,
} from "../user-profile-contracts";

/** The slice of omp's ExtensionAPI this module needs. */
export type UserProfileHost = PromptSectionHost;

function fromEnv(raw: string | undefined): UserProfile {
	if (!raw) return normalizeUserProfile(undefined);
	try {
		return normalizeUserProfile(JSON.parse(raw));
	} catch {
		return normalizeUserProfile(undefined);
	}
}

/** The section every hooked prompt gets; undefined = none. */
let instruction = userProfileInstruction(fromEnv(process.env.OMP_GUI_USER_PROFILE));

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: UserProfileHost): void {
	registerPromptSection(pi, "user-profile", () => instruction);
}

/** `{name, experience}` as prefs stores it; anything else is refused and the current profile stays. */
export function setUserProfile(params: unknown): UserProfile {
	if (!isUserProfile(params))
		throw new Error("user_profile_set needs {name: string, experience: ExperienceLevel | null}");
	const profile = normalizeUserProfile(params);
	instruction = userProfileInstruction(profile);
	return profile;
}

export const methods = {
	/** Main sends this to every live local sidecar when the profile changes, and on bridge connect. */
	user_profile_set: async (params: unknown) => setUserProfile(params),
};
