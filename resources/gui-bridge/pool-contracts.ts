/** Dependency-free pool contracts shared by the renderer and the packaged bridge. */
/** Preset roles, in menu order; any other non-empty string is a free-form hint. */
export const POOL_ROLE_HINTS = {
	general: "general work",
	explore: "fast, cheap exploration, search and lookups",
	reasoning: "hard reasoning, design and debugging",
	coding: "writing and editing code",
	review: "reviewing and cross-checking other models' work",
} as const;
export type PoolRoleId = keyof typeof POOL_ROLE_HINTS;
export const POOL_ROLES = Object.keys(POOL_ROLE_HINTS) as PoolRoleId[];

export function isPresetRole(role: string): role is PoolRoleId {
	return Object.hasOwn(POOL_ROLE_HINTS, role);
}

/** Upper bound on pool size; more members only dilute the instruction. */
export const MAX_POOL_MEMBERS = 8;
const MAX_ROLE_LENGTH = 120;
const MAX_NAME_LENGTH = 120;

export interface PoolMember {
	/** `provider/model` selector, exactly as the task tool's `model` field takes it. */
	selector: string;
	/** Display name for the GUI. */
	name: string;
	/** Preset role id (`POOL_ROLE_HINTS`) or a free-form hint. */
	role: string;
}

export interface PoolState {
	enabled: boolean;
	members: PoolMember[];
}

export const EMPTY_POOL: PoolState = { enabled: false, members: [] };

const SELECTOR_RE = /^[^\s/]+\/\S+$/;

function oneLine(value: string, max: number): string {
	return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/** Untrusted JSON → a pool: valid members only, first occurrence of a selector wins, capped. */
export function normalizePool(raw: unknown): PoolState {
	if (typeof raw !== "object" || raw === null) return { ...EMPTY_POOL, members: [] };
	const record = raw as Record<string, unknown>;
	const members: PoolMember[] = [];
	const seen = new Set<string>();
	for (const item of Array.isArray(record.members) ? record.members : []) {
		if (typeof item !== "object" || item === null) continue;
		const { selector, name, role } = item as Record<string, unknown>;
		if (typeof selector !== "string") continue;
		const trimmed = selector.trim();
		if (!SELECTOR_RE.test(trimmed) || seen.has(trimmed)) continue;
		seen.add(trimmed);
		members.push({
			selector: trimmed,
			name: typeof name === "string" && name.trim() ? oneLine(name, MAX_NAME_LENGTH) : trimmed,
			role: typeof role === "string" && role.trim() ? oneLine(role, MAX_ROLE_LENGTH) : "general",
		});
		if (members.length === MAX_POOL_MEMBERS) break;
	}
	return { enabled: record.enabled === true && members.length > 0, members };
}

/** A pool only distributes work with two or more models. */
export function poolIsActive(pool: PoolState): boolean {
	return pool.enabled && pool.members.length >= 2;
}
