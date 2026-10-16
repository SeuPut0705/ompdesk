/**
 * Dependency-free user-profile contracts shared by main, the renderer and the
 * packaged bridge: how the agent addresses the user and how much development
 * background it assumes (Settings › General › Profile, prefs `userProfile`).
 * Stock omp has no such setting; modes/user-profile.ts appends the section
 * built here through `before_agent_start`, like the reply language.
 */

/** prefs key (electron-store `prefs`). */
export const USER_PROFILE_PREF = "userProfile";

/** Development experience, least to most; the order Settings lists them in. */
export const EXPERIENCE_LEVELS = ["beginner", "vibe-coder", "junior", "expert"] as const;
export type ExperienceLevel = (typeof EXPERIENCE_LEVELS)[number];

export interface UserProfile {
	/** How the agent addresses the user; empty = not set. */
	name: string;
	experience: ExperienceLevel | null;
}

export const EMPTY_USER_PROFILE: UserProfile = { name: "", experience: null };

/** A name longer than this, or with control characters, is not a form of address. */
export const USER_PROFILE_NAME_MAX = 64;

function isName(value: unknown): value is string {
	return typeof value === "string" && value.trim().length <= USER_PROFILE_NAME_MAX && !/\p{Cc}/u.test(value);
}

function isExperience(value: unknown): value is ExperienceLevel {
	return (EXPERIENCE_LEVELS as readonly unknown[]).includes(value);
}

/** A well-formed profile, exactly as prefs stores it and `user_profile_set` takes it. */
export function isUserProfile(value: unknown): value is UserProfile {
	if (typeof value !== "object" || value === null) return false;
	const { name, experience } = value as Record<string, unknown>;
	return isName(name) && (experience === null || isExperience(experience));
}

/** Untrusted JSON (a stored pref, an env value) → a profile; anything malformed reads as not set. */
export function normalizeUserProfile(raw: unknown): UserProfile {
	if (typeof raw !== "object" || raw === null) return { ...EMPTY_USER_PROFILE };
	const { name, experience } = raw as Record<string, unknown>;
	return {
		name: isName(name) ? name.trim() : "",
		experience: isExperience(experience) ? experience : null,
	};
}

/** What each level changes: vocabulary and assumed background, never answer length. */
const EXPERIENCE_GUIDANCE: Record<ExperienceLevel, { label: string; guidance: string }> = {
	beginner: {
		label: "Beginner",
		guidance:
			"Assume no development background: explain, in a sentence or two, each term or prerequisite the answer depends on.",
	},
	"vibe-coder": {
		label: "Vibe coder",
		guidance:
			"Start with what the result does and how to use it; explain implementation jargon only where understanding needs it.",
	},
	junior: {
		label: "Junior developer",
		guidance:
			"Assume basic programming knowledge; spell out connections an experienced developer would take for granted.",
	},
	expert: {
		label: "Expert",
		guidance:
			"Skip familiar basics and use standard technical terms freely, but keep the reasoning needed to judge the result.",
	},
};

/** The system-prompt section for `profile`; undefined when nothing is set. */
export function userProfileInstruction(profile: UserProfile): string | undefined {
	const lines: string[] = [];
	if (profile.name) {
		lines.push(
			`Address the user as ${JSON.stringify(profile.name)} when you speak to them directly; leave the name out of routine progress updates.`,
		);
	}
	if (profile.experience) {
		const { label, guidance } = EXPERIENCE_GUIDANCE[profile.experience];
		lines.push(
			`The user's development experience: ${label}. ${guidance} This sets vocabulary and assumed background, not the length of your answers.`,
		);
	}
	return lines.length ? ["<user-profile>", ...lines, "</user-profile>"].join("\n") : undefined;
}
