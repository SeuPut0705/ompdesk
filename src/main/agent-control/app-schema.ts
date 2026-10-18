/**
 * The argument schemas of `ompdesk_app` actions: a small strict JSON Schema subset (the same objects the model is
 * shown through `ompdesk_app_list`), validated in main. Flat objects of strings, enums, numbers, booleans and string
 * arrays; anything else, and every unknown key, is refused.
 */

export type PropSchema =
	| { type: "string"; description?: string; enum?: readonly string[]; minLength?: number; maxLength?: number }
	| { type: "boolean"; description?: string }
	| { type: "integer" | "number"; description?: string; minimum?: number; maximum?: number }
	| {
			type: "array";
			description?: string;
			items: { type: "string"; maxLength?: number; enum?: readonly string[] };
			maxItems?: number;
	  };

export interface ArgsSchema {
	type: "object";
	properties: Record<string, PropSchema>;
	required?: readonly string[];
	additionalProperties: false;
}

export const NO_ARGS: ArgsSchema = { type: "object", properties: {}, additionalProperties: false };

export function objectSchema(properties: Record<string, PropSchema>, required: readonly string[] = []): ArgsSchema {
	return { type: "object", properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false };
}

export type Validated = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

function problem(name: string, schema: PropSchema, value: unknown): string | null {
	switch (schema.type) {
		case "string": {
			if (typeof value !== "string") return `${name} must be a string`;
			if (schema.enum && !schema.enum.includes(value)) return `${name} must be one of: ${schema.enum.join(", ")}`;
			if (value.length < (schema.minLength ?? 0)) return `${name} is too short`;
			if (value.length > (schema.maxLength ?? 2000)) return `${name} is too long`;
			return null;
		}
		case "boolean":
			return typeof value === "boolean" ? null : `${name} must be true or false`;
		case "integer":
		case "number": {
			if (typeof value !== "number" || !Number.isFinite(value)) return `${name} must be a number`;
			if (schema.type === "integer" && !Number.isInteger(value)) return `${name} must be a whole number`;
			if (schema.minimum !== undefined && value < schema.minimum)
				return `${name} must be at least ${schema.minimum}`;
			if (schema.maximum !== undefined && value > schema.maximum) return `${name} must be at most ${schema.maximum}`;
			return null;
		}
		case "array": {
			if (!Array.isArray(value)) return `${name} must be a list`;
			if (value.length > (schema.maxItems ?? 20)) return `${name} has too many items`;
			return value.every(
				item =>
					typeof item === "string" &&
					item.length <= (schema.items.maxLength ?? 500) &&
					(!schema.items.enum || schema.items.enum.includes(item)),
			)
				? null
				: `${name} must be a list of short strings`;
		}
	}
}

export function validateArgs(schema: ArgsSchema, raw: unknown): Validated {
	const args = raw ?? {};
	if (typeof args !== "object" || Array.isArray(args)) return { ok: false, error: "args must be an object" };
	const record = args as Record<string, unknown>;
	for (const key of Object.keys(record))
		if (!Object.hasOwn(schema.properties, key)) return { ok: false, error: `unknown argument "${key}"` };
	for (const key of schema.required ?? [])
		if (record[key] === undefined) return { ok: false, error: `${key} is required` };
	for (const [key, value] of Object.entries(record)) {
		const found = problem(key, schema.properties[key] as PropSchema, value);
		if (found) return { ok: false, error: found };
	}
	return { ok: true, value: record };
}
