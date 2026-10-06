import { describe, expect, it } from "vitest";
import { GuiBridgeClient } from "../bridge-client";
import { localHandlerFor, mergeHandlers, runLocalCommand } from "./index";
import { type LocalCommandContext, LocalCommandError } from "./types";

const ctx: LocalCommandContext = {
	cwd: "/tmp",
	omp: { bin: "omp", version: "18.6.1", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
	bridge: new GuiBridgeClient(""),
	emit: () => {},
	send: async () => {
		throw new Error("not used");
	},
};

describe("local command table", () => {
	it("refuses a command claimed by two areas", () => {
		const handler = async () => null;
		expect(() => mergeHandlers({ a: { same: handler }, b: { same: handler } })).toThrow(
			/"same" is defined twice \(b\)/,
		);
	});

	it("answers GUI-side commands and forwards everything else", () => {
		expect(localHandlerFor("get_transcript")).toBeTypeOf("function");
		expect(localHandlerFor("get_messages")).toBeUndefined();
		expect(localHandlerFor("constructor")).toBeUndefined();
	});

	it("shapes handler outcomes as the response frame the renderer expects", async () => {
		await expect(runLocalCommand(async () => ({ ok: 1 }), { type: "x", id: "gui-1" }, ctx)).resolves.toEqual({
			id: "gui-1",
			type: "response",
			command: "x",
			success: true,
			data: { ok: 1 },
		});
		await expect(
			runLocalCommand(
				async () => {
					throw new LocalCommandError("nope", "some_code");
				},
				{ type: "x", id: "gui-2" },
				ctx,
			),
		).resolves.toEqual({
			id: "gui-2",
			type: "response",
			command: "x",
			success: false,
			error: "nope",
			code: "some_code",
		});
	});
});
