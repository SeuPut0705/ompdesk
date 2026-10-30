import { describe, expect, it } from "vitest";
import type { IpcSessionsChanged, SessionInfo } from "../../shared/ipc-types";
import { HostSessionList } from "./host-session-list";

const row = (path: string, title: string | null = null, modified = "2026-10-30T00:00:00.000Z"): SessionInfo => ({
	path,
	id: path,
	title,
	cwd: "/work",
	created: "2026-10-01T00:00:00.000Z",
	modified,
	messageCount: 1,
	size: 1,
	status: "complete",
	firstMessage: "hi",
});

/** A device's copy of host "studio", whose reads of the host wait until the test answers them. */
function rig() {
	const asked: Array<(reply: unknown) => void> = [];
	const told: IpcSessionsChanged[] = [];
	const list = new HostSessionList("studio", {
		read: () => {
			const { promise, resolve } = Promise.withResolvers<unknown>();
			asked.push(resolve);
			return promise;
		},
		broadcast: change => told.push(change),
	});
	const answer = async (reply: unknown) => {
		const next = asked.shift();
		if (!next) throw new Error("nothing asked the host");
		next(reply);
		await new Promise(resolve => setImmediate(resolve));
	};
	return { list, asked, told, answer };
}

describe("HostSessionList", () => {
	it("reads the host once for every window that asks, and tags the rows with the host", async () => {
		const { list, asked, answer } = rig();
		const first = list.current();
		const second = list.current();
		expect(asked).toHaveLength(1);
		await answer({ version: "h.1", sessions: [row("/b"), row("/a")] });
		const [a, b] = await Promise.all([first, second]);
		expect(a).toBe(b);
		expect(a.sessions.map(entry => [entry.path, entry.device])).toEqual([
			["/a", "studio"],
			["/b", "studio"],
		]);
		// Asked again with nothing changed: the copy answers.
		expect(await list.current()).toBe(a);
		expect(asked).toHaveLength(0);
	});

	it("applies a host change of the version it holds and hands its windows what changed, reading nothing", async () => {
		const { list, asked, told, answer } = rig();
		const reading = list.current();
		await answer({ version: "h.1", sessions: [row("/a"), row("/b")] });
		const before = await reading;

		list.hostChanged({ base: "h.1", version: "h.2", set: [row("/b", "Renamed")], remove: ["/a"] });
		expect(asked).toHaveLength(0);
		expect(told).toHaveLength(1);
		const change = told[0];
		expect(change?.device).toBe("studio");
		expect(change?.list).toMatchObject({ base: before.version, remove: ["/a"] });
		expect(change?.list?.set).toEqual([{ ...row("/b", "Renamed"), device: "studio" }]);
		const after = await list.current();
		expect(after.version).toBe(change?.list?.version);
		expect(after.sessions.map(entry => entry.title)).toEqual(["Renamed"]);
		// The same change again (it crossed twice, or a read already held it) is nothing.
		list.hostChanged({ base: "h.1", version: "h.2", set: [], remove: ["/b"] });
		expect(told).toHaveLength(1);
		expect(asked).toHaveLength(0);
	});

	it("reads the host once more after a change it cannot apply, and tells its windows to ask", async () => {
		const { list, asked, told, answer } = rig();
		const reading = list.current();
		await answer({ version: "h.1", sessions: [row("/a")] });
		await reading;

		// h.2 never arrived (the link dropped): h.3 does not apply to h.1.
		list.hostChanged({ base: "h.2", version: "h.3", set: [row("/c")], remove: [] });
		expect(told).toEqual([{ device: "studio" }]);
		expect(asked).toHaveLength(0);
		const windows = [list.current(), list.current()];
		expect(asked).toHaveLength(1);
		await answer({ version: "h.3", sessions: [row("/a"), row("/c")] });
		const [one, two] = await Promise.all(windows);
		expect(one).toBe(two);
		expect(one.sessions.map(entry => entry.path)).toEqual(["/a", "/c"]);
		// From h.3 on the host's changes apply again.
		list.hostChanged({ base: "h.3", version: "h.4", set: [], remove: ["/a"] });
		expect(asked).toHaveLength(0);
		expect((await list.current()).sessions.map(entry => entry.path)).toEqual(["/c"]);
	});

	it("reads an older host's list on each of its bare events, in this computer's order", async () => {
		const { list, asked, told, answer } = rig();
		const reading = list.current();
		// An older host numbers nothing and answers the rows in its own order.
		await answer([row("/old", null, "2026-10-01T00:00:00.000Z"), row("/new", null, "2026-10-30T00:00:00.000Z")]);
		expect((await reading).sessions.map(entry => entry.path)).toEqual(["/new", "/old"]);

		list.hostChanged(null);
		expect(told).toEqual([{ device: "studio" }]);
		const again = list.current();
		expect(asked).toHaveLength(1);
		await answer([row("/new", null, "2026-10-30T00:00:00.000Z")]);
		expect((await again).sessions.map(entry => entry.path)).toEqual(["/new"]);
		// What changed goes to the windows here, numbered by this computer.
		expect(told.at(-1)?.list?.remove).toEqual(["/old"]);
	});

	it("reads again when a change named a later version than the read under way answered", async () => {
		const { list, asked, told, answer } = rig();
		const reading = list.current();
		// The host published h.2 between taking the list for this read (h.1) and sending it.
		list.hostChanged({ base: "h.1", version: "h.2", set: [row("/b")], remove: [] });
		expect(told).toHaveLength(0);
		await answer({ version: "h.1", sessions: [row("/a")] });
		await reading;
		expect(told).toEqual([{ device: "studio" }]);
		const next = list.current();
		expect(asked).toHaveLength(1);
		await answer({ version: "h.2", sessions: [row("/a"), row("/b")] });
		expect((await next).sessions.map(entry => entry.path)).toEqual(["/a", "/b"]);
	});

	it("reads the host again after a request through it changed its sessions or the link came back", async () => {
		const { list, asked, told, answer } = rig();
		const reading = list.current();
		await answer({ version: "h.1", sessions: [row("/a")] });
		await reading;

		list.stale();
		expect(told).toEqual([{ device: "studio" }]);
		const next = list.current();
		expect(asked).toHaveLength(1);
		await answer({ version: "h.2", sessions: [row("/a", "Renamed")] });
		expect((await next).sessions[0]?.title).toBe("Renamed");
	});

	it("still reads the host for the ask after a request through it, when another change of the version it holds applies first", async () => {
		const { list, asked, answer } = rig();
		const reading = list.current();
		await answer({ version: "h.1", sessions: [row("/a"), row("/b")] });
		await reading;

		// The device deleted /a through the host: its copy is stale, and the host has not published that change yet.
		list.stale();
		// Another change (a turn wrote to /b) comes first and applies to the version held.
		list.hostChanged({ base: "h.1", version: "h.2", set: [row("/b", "Renamed")], remove: [] });
		// The window asks now: the copy still lists /a, which the host deleted, so the host answers, not the copy.
		const next = list.current();
		expect(asked).toHaveLength(1);
		await answer({ version: "h.3", sessions: [row("/b", "Renamed")] });
		expect((await next).sessions.map(entry => entry.path)).toEqual(["/b"]);
	});

	it("keeps a change that applied right behind the answer of a read under way, though the answer is older", async () => {
		const { list, asked, told, answer } = rig();
		const first = list.current();
		await answer({ version: "h.1", sessions: [row("/a"), row("/b")] });
		await first;

		list.stale();
		const reading = list.current();
		expect(asked).toHaveLength(1);
		// The link delivered both frames in one drain: the read's answer (taken at h.1) resolves its promise, and the
		// host's change of h.1 runs before the read's continuation does.
		asked.shift()?.({ version: "h.1", sessions: [row("/a"), row("/b")] });
		list.hostChanged({ base: "h.1", version: "h.2", set: [], remove: ["/a"] });
		expect((await reading).sessions.map(entry => entry.path)).toEqual(["/b"]);
		// Nothing later brings /a back: the copy holds h.2, and the host's next change applies to it.
		await new Promise(resolve => setImmediate(resolve));
		expect((await list.current()).sessions.map(entry => entry.path)).toEqual(["/b"]);
		expect(asked).toHaveLength(0);
		list.hostChanged({ base: "h.2", version: "h.3", set: [row("/c")], remove: [] });
		expect((await list.current()).sessions.map(entry => entry.path)).toEqual(["/b", "/c"]);
		expect(asked).toHaveLength(0);
		// The windows were told each change once, as what changed, and never a change that put /a back.
		expect(told.flatMap(change => (change.list ? [change.list.remove] : []))).toEqual([["/a"], []]);
	});

	it("takes an answer that names the version a change just brought, and one newer than it", async () => {
		const { list, asked } = rig();
		const first = list.current();
		asked.shift()?.({ version: "h.1", sessions: [row("/a"), row("/b")] });
		await first;

		list.stale();
		const same = list.current();
		asked.shift()?.({ version: "h.2", sessions: [row("/b")] });
		list.hostChanged({ base: "h.1", version: "h.2", set: [], remove: ["/a"] });
		expect((await same).sessions.map(entry => entry.path)).toEqual(["/b"]);

		list.stale();
		const newer = list.current();
		asked.shift()?.({ version: "h.4", sessions: [row("/b"), row("/d")] });
		list.hostChanged({ base: "h.2", version: "h.3", set: [row("/c")], remove: [] });
		expect((await newer).sessions.map(entry => entry.path)).toEqual(["/b", "/d"]);
	});
});
