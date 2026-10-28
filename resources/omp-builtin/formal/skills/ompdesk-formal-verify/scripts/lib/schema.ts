import { isRecord } from "./json";

/** The JSON Schema keywords assets/findings.schema.json uses: type, enum, required, properties, items, additionalProperties. */
export function validate(value: unknown, schema: unknown, where = "$"): string[] {
	if (!isRecord(schema)) return [];
	const errors: string[] = [];
	const type = schema.type;
	if (typeof type === "string") {
		const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
		const ok =
			type === "integer"
				? typeof value === "number" && Number.isInteger(value)
				: type === "number"
					? typeof value === "number"
					: actual === type;
		if (!ok) return [`${where}: expected ${type}, got ${actual}`];
	}
	if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
		errors.push(`${where}: must be one of ${schema.enum.map(item => JSON.stringify(item)).join(", ")}`);
	}
	if (isRecord(value)) {
		if (Array.isArray(schema.required)) {
			for (const key of schema.required)
				if (typeof key === "string" && !(key in value)) errors.push(`${where}: missing "${key}"`);
		}
		const properties = isRecord(schema.properties) ? schema.properties : {};
		for (const [key, item] of Object.entries(value)) {
			if (key in properties) errors.push(...validate(item, properties[key], `${where}.${key}`));
			else if (isRecord(schema.additionalProperties))
				errors.push(...validate(item, schema.additionalProperties, `${where}.${key}`));
		}
	}
	if (Array.isArray(value) && schema.items !== undefined) {
		for (const [index, item] of value.entries()) errors.push(...validate(item, schema.items, `${where}[${index}]`));
	}
	return errors;
}
