/**
 * The bot's tool reference: for each `ompdesk_*` tool it uses most, one line saying what it is for and its argument names
 * with types, in its prompt (`resources/gui-bridge/agent-control.ts` `botSection`). Measured 5 Nov 2026 over 8 of its
 * conversations: it read `xd://ompdesk_*` docs 49 times (2 to 9 per conversation, about 19 minutes of model time), because
 * every conversation starts without them. Generated from the tools' own JSON schemas (`tools.ts`), so it cannot drift from
 * them; the docs stay available for the rest of a tool's text.
 */
import { AGENT_CONTROL_TOOLS as T } from "../../shared/agent-control";
import { AGENT_CONTROL_DEFINITIONS } from "./tools";

/** The tools the bot uses most, in the order its reference lists them. */
export const BOT_REFERENCE_TOOLS: readonly string[] = [
	T.list,
	T.open,
	T.send,
	T.result,
	T.read,
	T.stop,
	T.schedule,
	T.bot,
	T.notify,
];

/** The slice of a tool's JSON schema the reference prints. */
interface Schema {
	type?: string;
	enum?: readonly unknown[];
	items?: Schema;
	properties?: Record<string, Schema>;
	required?: readonly string[];
	anyOf?: readonly Schema[];
	description?: string;
}

/** An object with more fields than this prints as `object`: its own description (the docs) says what it holds. */
const INLINE_OBJECT_FIELDS = 4;

function typeOf(schema: Schema): string {
	if (schema.enum) return schema.enum.map(String).join("|");
	if (schema.anyOf) return schema.anyOf.map(typeOf).join("|");
	if (schema.type === "array") {
		const item = typeOf(schema.items ?? {});
		return item.includes("|") ? `(${item})[]` : `${item}[]`;
	}
	if (schema.type === "object") {
		const count = Object.keys(schema.properties ?? {}).length;
		return count > 0 && count <= INLINE_OBJECT_FIELDS ? `{${fields(schema)}}` : "object";
	}
	if (schema.type === "integer") return "int";
	return schema.type === "boolean" ? "bool" : (schema.type ?? "any");
}

/**
 * The actions a field's description names up front ("decide: what the owner is asked", "create, update: a short name"),
 * when the tool has an `action` argument: the reference prints them after the field, so the bot sees which action takes it.
 */
function actionsOf(description: string | undefined, actions: ReadonlySet<string>): string[] {
	const named = /^([a-z_]+(?:, [a-z_]+)*)[:,] /.exec(description ?? "")?.[1]?.split(", ") ?? [];
	return named.every(action => actions.has(action)) ? named : [];
}

function fields(schema: Schema): string {
	const properties = Object.entries(schema.properties ?? {});
	const actions = new Set((schema.properties?.action?.enum ?? []).map(String));
	return properties
		.map(([name, property]) => {
			const optional = schema.required?.includes(name) ? "" : "?";
			const only = actions.size > 0 ? actionsOf(property.description, actions) : [];
			return `${name}${optional}: ${typeOf(property)}${only.length > 0 ? ` [${only.join(", ")}]` : ""}`;
		})
		.join(", ");
}

/**
 * One line per tool in `names`: `- <name> — <what it is for> | <argument>: <type>, …`. `?` marks an optional argument; a
 * `[action, …]` after an argument names the actions that take it. A name that is no defined tool is a bug in the caller.
 */
export function botToolReference(names: readonly string[] = BOT_REFERENCE_TOOLS): string {
	return names
		.map(name => {
			const tool = AGENT_CONTROL_DEFINITIONS.find(definition => definition.name === name);
			if (!tool) throw new Error(`The bot tool reference names ${name}, which is no control tool.`);
			const summary = tool.description.split("\n")[0]?.trim().replace(/\.$/, "") ?? "";
			return `- ${name} — ${summary} | ${fields(tool.parameters as Schema)}`;
		})
		.join("\n");
}

/** What every bot tab's prompt carries (`BotRoleDesk.tools`). */
export const BOT_TOOL_REFERENCE = botToolReference();
