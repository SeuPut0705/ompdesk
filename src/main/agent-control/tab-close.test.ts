import { describe, expect, it } from "vitest";
import type { FileEdits } from "../web/file-edit-reports";
import { tabCloseStep } from "./tab-close";

describe("tabCloseStep", () => {
	const people = [{}, { looked: true }, { userTouched: true }, { looked: true, userTouched: true }];

	it("asks a desktop window to close its own tab, whatever the person does (its renderer guards it)", () => {
		for (const person of people) expect(tabCloseStep(person)).toEqual({ action: "ask-window" });
	});

	it("keeps a paired page's tab its live page reported dirty, before anything else", () => {
		for (const person of people)
			expect(tabCloseStep({ webEdits: "dirty", ...person })).toEqual({ action: "keep", reason: "dirty" });
	});

	it("releases a paired page's clean or unreported tab in main unless the person is at it", () => {
		for (const webEdits of ["clean", "unreported"] as FileEdits[]) {
			expect(tabCloseStep({ webEdits })).toEqual({ action: "release" });
			for (const person of people.slice(1))
				expect(tabCloseStep({ webEdits, ...person })).toEqual({ action: "keep", reason: "in-use" });
		}
	});
});
