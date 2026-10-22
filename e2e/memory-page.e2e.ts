/**
 * The Memory page end to end on the fake binary (`e2e/fixture/fake-ai-memory.ts`, a stateful stand-in for the server)
 * in a private HOME (`e2e/fixture/ai-memory-rig.ts`): open it from the command palette, read the overview, search all
 * projects and open a hit, edit and save a page (the write reaches the server and the reader shows it), delete it and
 * restore it from Deleted, then read a handoff and cancel it (the MCP tool call reaches the server and the open list
 * loses it). Never clicked: "Open web console" and "Copy password" (they would open the developer's browser and
 * replace the clipboard).
 */
import * as fs from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { type Launched, launch, makeRig, phaseIs } from "./fixture/ai-memory-rig";
import { exitApp, pressShortcutUntilVisible } from "./harness";

async function openMemory(page: Page) {
	const search = page.getByRole("dialog").getByRole("searchbox");
	await pressShortcutUntilVisible(page, "ControlOrMeta+k", search);
	await search.fill("memory");
	// Once opened, the command also heads the palette's Recent group: either row opens the page.
	await page
		.getByRole("dialog")
		.locator("button[data-palette-index]", { hasText: "Open the Memory page" })
		.first()
		.click();
	const section = page.locator("[data-settings-page] #settings-memory");
	await expect(section).toBeVisible();
	return section;
}

test("the Memory page: search, read, edit, delete, restore and cancel a handoff on the fake server", async () => {
	test.setTimeout(240_000);
	const rig = await makeRig();
	let current: Launched | null = null;
	try {
		current = await launch(rig);
		const { page } = current;
		await phaseIs(page, "ready");
		const section = await openMemory(page);

		await test.step("the overview shows the project's counts and no upstream name", async () => {
			await expect(page.locator("[data-settings-page]")).toContainText("Memory");
			await expect(section.locator("[data-memory-status]")).toContainText("Running");
			await expect(section.locator("[data-memory-scope]")).toContainText("alpha");
			await expect(section.locator("[data-memory-counts]")).toHaveText("4 pages · 2 sessions · 17 observations");
			await expect(section.locator("[data-memory-last]")).not.toHaveText("");
			await expect(section.getByRole("button", { name: "Open web console", exact: true })).toBeEnabled();
			// The data folder's own path and the exclusion file's name are data, not branding.
			const shown = (await section.innerText())
				.replace(await section.locator("[data-memory-dir]").innerText(), "")
				.replaceAll(".ai-memory.toml", "");
			expect(shown).not.toMatch(/ai-memory/i);
		});

		await test.step("search across all projects and open the hit in Pages", async () => {
			await section.getByRole("tab", { name: "Search" }).click();
			await section.getByRole("tab", { name: "All projects", exact: true }).click();
			const box = section.getByRole("searchbox");
			await box.fill("sqlite");
			await box.press("Enter");
			const hits = section.locator("[data-memory-results]");
			await expect(hits.locator("[data-memory-hit]")).toHaveCount(2);
			const hit = hits.locator('[data-memory-hit="decisions/0007-db.md"]');
			await expect(hit).toContainText("Use SQLite for the cache");
			await expect(hit).toContainText("Decision");
			await expect(hit).toContainText("Semantic");
			await expect(hit.locator("mark")).toHaveCount(0);
			await hit.click();
			await expect(section.locator('[data-memory-tab="pages"]')).toBeVisible();
			await expect(section.locator("[data-memory-body]")).toContainText("it ships with Bun");
		});

		await test.step("edit and save: the write reaches the server and the reader shows the new text", async () => {
			await section.locator("[data-memory-edit]").click();
			const editor = section.locator("[data-memory-editor]");
			await editor.fill("# Use SQLite for the cache\n\nWe chose SQLite, and measured it.");
			await section.locator("[data-memory-save]").click();
			await expect(section.locator("[data-memory-body]")).toContainText("and measured it.");
			const writes = (await rig.memory.requests()).filter(request => request.path === "/admin/write-page");
			expect(writes).toHaveLength(1);
			expect(writes[0]?.body).toMatchObject({
				workspace: "fixture",
				project: "alpha",
				path: "decisions/0007-db.md",
				body: "# Use SQLite for the cache\n\nWe chose SQLite, and measured it.",
				kind: "decision",
				tier: "semantic",
			});
		});

		await test.step("delete asks first, lists the page under Deleted, and Restore brings it back", async () => {
			await section.locator("[data-memory-delete]").click();
			const dialog = page.getByRole("dialog");
			await expect(dialog).toContainText("Delete this page?");
			await dialog.getByRole("button", { name: "Delete", exact: true }).click();
			await expect(section.locator('[data-memory-page="decisions/0007-db.md"]')).toHaveCount(0);
			const deleted = section.locator('[data-memory-deleted="decisions/0007-db.md"]');
			await expect(deleted).toContainText("Use SQLite for the cache");
			await deleted.getByRole("button", { name: "Restore", exact: true }).click();
			await expect(section.locator('[data-memory-page="decisions/0007-db.md"]')).toBeVisible();
			await expect(section.locator('[data-memory-deleted="decisions/0007-db.md"]')).toHaveCount(0);
			const restores = (await rig.memory.requests()).filter(request => request.path === "/admin/restore-page");
			expect(restores).toHaveLength(1);
			expect(restores[0]?.body).toMatchObject({
				path: "decisions/0007-db.md",
				rev: expect.stringMatching(/^rev-pre-/),
			});
			// The restored page is the edited one.
			await section.locator('[data-memory-page="decisions/0007-db.md"]').click();
			await expect(section.locator("[data-memory-body]")).toContainText("and measured it.");
		});

		await test.step("a handoff is read without claiming it, then cancelled", async () => {
			await section.getByRole("tab", { name: "Handoffs" }).click();
			const row = section.locator('[data-memory-handoff="h-1"]');
			await expect(row).toContainText("Cache fix half done");
			await row.click();
			const detail = section.locator('[data-memory-handoff-detail="h-1"]');
			await expect(detail).toContainText("Which eviction policy?");
			await expect(detail).toContainText("Add the eviction test");
			await section.locator("[data-memory-handoff-cancel]").click();
			await page.getByRole("dialog").getByRole("button", { name: "Cancel handoff", exact: true }).click();
			await expect(section.locator('[data-memory-handoff-detail="h-1"]')).toHaveCount(0);
			await expect(section.locator('[data-memory-handoff="h-1"]')).toContainText("Expired");
			const calls = (await rig.memory.requests()).filter(request => request.tool === "memory_handoff_cancel");
			expect(calls).toHaveLength(1);
			expect(calls[0]?.body).toMatchObject({
				params: { arguments: { workspace: "fixture", project: "alpha", handoff_id: "h-1" } },
			});
		});

		await test.step("sessions open their raw observations a page at a time", async () => {
			await section.getByRole("tab", { name: "Sessions" }).click();
			await section.locator('[data-memory-session="s-big"]').click();
			await expect(section.locator("[data-memory-observation]")).toHaveCount(50);
			await section.getByRole("button", { name: "Next", exact: true }).click();
			await expect(section.locator("[data-memory-observation]")).toHaveCount(10);
		});

		await test.step("closing Settings and reopening the Memory page from the palette lists the pages again", async () => {
			await page.keyboard.press("Escape");
			await expect(page.locator("[data-settings-page]")).toHaveCount(0);
			const reopened = await openMemory(page);
			await reopened.getByRole("tab", { name: "Pages" }).click();
			await expect(reopened.locator('[data-memory-page="decisions/0007-db.md"]')).toBeVisible();
		});

		expect(current.errors).toEqual([]);
	} finally {
		if (current) await exitApp(current.app);
		// The fake server is detached on purpose (like the real service): stop it with the test.
		const pid = Number(await fs.readFile(`${rig.home}/.fake-ai-memory/server.pid`, "utf8").catch(() => ""));
		if (pid) {
			try {
				process.kill(pid);
			} catch {
				// already gone
			}
		}
		await fs.rm(rig.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
