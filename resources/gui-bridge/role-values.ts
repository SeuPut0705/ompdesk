/**
 * How OMPdesk writes and shows model-role values (pure: no omp imports, tested
 * by src/main/bridge-role-values.test.ts).
 *
 * Stock runs an advisor role without a `:level` suffix at a fixed `medium`
 * (`session/session-advisors.ts`), while `:auto` follows the primary agent's
 * per-turn level. OMPdesk writes the advisor role with `:auto` when the pick
 * carries no level, and reports it without that suffix so the role pickers
 * still match the model.
 */

const ADVISOR_ROLE = "advisor";
const AUTO_SUFFIX = ":auto";
const LEVEL_SUFFIX = /:(?:off|minimal|low|medium|high|xhigh|max|auto|inherit)$/;

/** The value to store for `role` when the user picks `modelId` (undefined clears the role). */
export function storedRoleValue(role: string, modelId: string | undefined): string | undefined {
	if (role !== ADVISOR_ROLE || !modelId || LEVEL_SUFFIX.test(modelId)) return modelId;
	return `${modelId}${AUTO_SUFFIX}`;
}

/** The value to show for `role`: the advisor's OMPdesk-added `:auto` is hidden. */
export function shownRoleValue(role: string, value: string | undefined): string | undefined {
	return role === ADVISOR_ROLE && value?.endsWith(AUTO_SUFFIX) ? value.slice(0, -AUTO_SUFFIX.length) : value;
}
