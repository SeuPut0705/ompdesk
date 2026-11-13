import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	CHECKS_ENUMS,
	CHECKS_LIMITS,
	CHECKS_OPS,
	CHECKS_SCHEMAS,
	CHECKS_TOOL,
	CHECKS_WIRE,
	emptySnapshot,
	SnapshotSchema,
} from "./checks-contract";
import { sampleAnswer, sampleSnapshot } from "./checks-fixture";

/** What the Rust types write (`contract.rs` `samples::all`): every shape with every optional field, every variant, every word. */
const samples = JSON.parse(
	readFileSync(join(__dirname, "../../native/ompdesk/crates/core/src/checks/contract-samples.json"), "utf8"),
) as {
	tool: string;
	ops: string[];
	limits: Record<string, number>;
	wire: Record<string, string>;
	enums: Record<string, string[]>;
	types: Record<string, unknown[]>;
};

/** The unions with an entry of their own (`Where`, `Origin`, `FakeOp`): each variant is held there, not at every use. */
const NAMED_UNIONS = new Set<z.ZodTypeAny>(
	Object.values(CHECKS_SCHEMAS).filter(schema => schema instanceof z.ZodDiscriminatedUnion),
);

/**
 * Every field and variant `schema` names that no value of `values` holds, by path. A strict parse finds what Rust
 * writes and the schema lacks; this finds the reverse.
 */
function unseen(schema: z.ZodTypeAny, values: unknown[], path: string): string[] {
	if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
		return unseen(
			schema.unwrap(),
			values.filter(value => value !== null && value !== undefined),
			path,
		);
	}
	if (schema instanceof z.ZodArray) {
		return unseen(
			schema.element,
			values.flatMap(value => (Array.isArray(value) ? value : [])),
			`${path}[]`,
		);
	}
	if (schema instanceof z.ZodDiscriminatedUnion) {
		const tag = schema.discriminator as string;
		return (schema.options as z.ZodObject<z.ZodRawShape>[]).flatMap(option => {
			const word = (option.shape[tag] as z.ZodLiteral<string>).value;
			const of = values.filter(value => (value as Record<string, unknown> | null)?.[tag] === word);
			// Inside another shape a named union needs no variant again: its own entry (a path without a field) has all.
			if (of.length === 0) return NAMED_UNIONS.has(schema) && /[.[]/.test(path) ? [] : [`${path}<${word}>`];
			return unseen(option, of, `${path}<${word}>`);
		});
	}
	if (schema instanceof z.ZodObject) {
		const objects = values.filter(
			(value): value is Record<string, unknown> => typeof value === "object" && value !== null,
		);
		return Object.entries(schema.shape as z.ZodRawShape).flatMap(([key, field]) => {
			const held = objects.filter(object => key in object).map(object => object[key]);
			return held.length === 0 ? [`${path}.${key}`] : unseen(field, held, `${path}.${key}`);
		});
	}
	return [];
}

describe("the checks contract's TypeScript mirror", () => {
	it("names the tool, its operations, the limits and the wire as the core does", () => {
		expect(samples.tool).toBe(CHECKS_TOOL);
		expect(samples.ops).toEqual([...CHECKS_OPS]);
		expect(samples.limits).toEqual(CHECKS_LIMITS);
		expect(samples.wire).toEqual(CHECKS_WIRE);
	});

	it("lists every enum with the core's words, in its order", () => {
		expect(samples.enums).toEqual(JSON.parse(JSON.stringify(CHECKS_ENUMS)));
	});

	it("has one schema per shape the core writes", () => {
		expect(Object.keys(CHECKS_SCHEMAS).sort()).toEqual(Object.keys(samples.types).sort());
	});

	it.each(Object.entries(CHECKS_SCHEMAS))("reads %s as the core writes it, field for field", (name, schema) => {
		const values = samples.types[name] ?? [];
		for (const value of values) expect(schema.parse(value)).toEqual(value);
		expect(unseen(schema, values, name)).toEqual([]);
	});
});

describe("the fixture's made-up data", () => {
	it("is a snapshot and an answer of the contract", () => {
		expect(SnapshotSchema.parse(sampleSnapshot())).toEqual(sampleSnapshot());
		expect(CHECKS_SCHEMAS.Answer.parse(sampleAnswer())).toEqual(sampleAnswer());
		expect(SnapshotSchema.parse(emptySnapshot(1))).toEqual(emptySnapshot(1));
	});
});
