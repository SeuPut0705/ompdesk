/**
 * What a model-role row says (Settings › Model roles): when the role is used and, while it is empty, what it falls
 * back to. OMPdesk's own sentence wins when the locale has one (`modelRoles.use.<id>`, `modelRoles.fallback.<id>`);
 * a role no locale knows (a newer omp's, or one OMPdesk adds) gets a generic sentence from what stock reports: its
 * name, the model kinds it takes and, for the fallback, how stock really resolved it (`effective.source`/`via`) and
 * whether it has a built-in list (`defaults`). A raw locale key never reaches the row.
 */

import type { ModelRoleEntry } from "../../../shared/rpc-types";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** The locale's text for `key`, or undefined when it has none (`t` answers a missing key with the key itself). */
function localized(t: Translate, key: string): string | undefined {
	const text = t(key);
	return text === key ? undefined : text;
}

/** When the role is used; `name` is its display name. */
export function rolePurpose(entry: ModelRoleEntry, name: string, t: Translate, lang: string): string {
	const own = localized(t, `modelRoles.use.${entry.id}`);
	if (own) return own;
	const kinds = (entry.accepts ?? []).map(kind => localized(t, `modelRoles.kind.${kind}`) ?? kind);
	if (kinds.length > 0) {
		return t("modelRoles.generic.use", {
			name,
			kinds: new Intl.ListFormat(lang, { type: "unit", style: "short" }).format(kinds),
		});
	}
	return t(entry.section === "kind" ? "modelRoles.generic.useKind" : "modelRoles.generic.useChat", { name });
}

/** What an empty role falls back to; undefined while the role holds a value. */
export function roleFallback(
	entry: ModelRoleEntry,
	t: Translate,
	roleName: (id: string) => string,
): string | undefined {
	if (entry.model !== undefined) return undefined;
	const own = localized(t, `modelRoles.fallback.${entry.id}`);
	if (own) return own;
	const effective = entry.effective;
	if (effective?.via) return t("modelRoles.generic.fallback.via", { role: roleName(effective.via) });
	if (effective?.source === "session") return t("modelRoles.generic.fallback.session");
	if (effective?.source === "none") return t("modelRoles.generic.fallback.none");
	return t(entry.defaults?.length ? "modelRoles.generic.fallback.builtin" : "modelRoles.generic.fallback.pool");
}
