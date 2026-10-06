/**
 * Tests for the extensions window: closed-state rendering plus the pure
 * filtering, path-shortening, hook-grouping, and status-variant contracts
 * that drive the Hooks/MCP/Commands tabs. (Open-state SSR assertions are not
 * viable: react-dom/server renders createPortal children as empty in this
 * repo's test environment.)
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AvailableCommand, RpcHookInfo, RpcSkillInfo } from "../../../shared/rpc-types";
import { shortenPath } from "../../lib/format";
import { I18nProvider } from "../../lib/i18n";
import {
	ExtensionsPanel,
	filterList,
	groupCommandsBySource,
	groupHooksByTool,
	hookPhase,
	hookTool,
	isCustomCommand,
} from "./ExtensionsPanel";
import { MCP_STATUS_VARIANT } from "./mcp/McpServerCard";

function skill(partial: Partial<RpcSkillInfo> & { name: string }): RpcSkillInfo {
	return {
		description: "",
		source: "native:project",
		enabled: true,
		location: "/tmp/x",
		provider: "native",
		providerName: "OMP",
		level: "project",
		managed: false,
		hidden: false,
		...partial,
	};
}

function hook(partial: Partial<RpcHookInfo> & { id: string; event: string }): RpcHookInfo {
	return { name: partial.id, enabled: true, source: "claude", path: "/tmp/hook.sh", ...partial };
}

function command(partial: Partial<AvailableCommand> & { name: string }): AvailableCommand {
	return { description: "", ...partial };
}

describe("ExtensionsPanel closed state", () => {
	it("renders nothing while closed", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<ExtensionsPanel onClose={() => {}} open={false} />
			</I18nProvider>,
		);
		expect(html).toBe("");
	});
});

describe("filterList", () => {
	const skills = [
		skill({ name: "agent-reach", description: "Research the internet", source: "native:project" }),
		skill({ name: "hatch-pet", description: "Create pixel pets", source: "claude:user" }),
	];

	it("returns the input untouched for blank queries", () => {
		expect(filterList(skills, "  ", s => [s.name])).toBe(skills);
	});

	it("matches case-insensitively across any of the row's fields", () => {
		expect(filterList(skills, "REACH", s => [s.name]).map(s => s.name)).toEqual(["agent-reach"]);
		expect(filterList(skills, "pixel", s => [s.name, s.description]).map(s => s.name)).toEqual(["hatch-pet"]);
		expect(filterList(skills, "claude:", s => [s.name, s.source]).map(s => s.name)).toEqual(["hatch-pet"]);
	});

	it("drops every row when nothing matches", () => {
		expect(filterList(skills, "zzz", s => [s.name, s.description, s.source])).toEqual([]);
	});

	it("treats null data as no rows", () => {
		expect(filterList(null, "x", (s: RpcSkillInfo) => [s.name])).toEqual([]);
	});
});

describe("shortenPath", () => {
	it("collapses macOS and Linux home prefixes to ~", () => {
		expect(shortenPath("/Users/zach/.omp/skills/foo/SKILL.md")).toBe("~/.omp/skills/foo/SKILL.md");
		expect(shortenPath("/home/zach/.config/hook.sh")).toBe("~/.config/hook.sh");
	});

	it("leaves non-home paths untouched", () => {
		expect(shortenPath("/tmp/hook.sh")).toBe("/tmp/hook.sh");
	});

	it("middle-truncates very long paths", () => {
		const long = `/Users/zach/${"deep/".repeat(20)}SKILL.md`;
		const out = shortenPath(long);
		expect(out.length).toBeLessThanOrEqual(56);
		expect(out).toContain("…");
		expect(out.startsWith("~/deep/")).toBe(true);
		expect(out.endsWith("SKILL.md")).toBe(true);
	});
});

describe("hook event parsing", () => {
	it("splits phase and tool on the first colon", () => {
		expect(hookPhase("pre:bash")).toBe("pre");
		expect(hookTool("pre:bash")).toBe("bash");
		expect(hookPhase("post:*")).toBe("post");
		expect(hookTool("post:*")).toBe("*");
	});

	it("handles events with no separator", () => {
		expect(hookPhase("sessionStart")).toBe("sessionStart");
		expect(hookTool("sessionStart")).toBe("");
	});
});

describe("groupHooksByTool", () => {
	it("buckets by event tool, sorts groups A–Z, and preserves row order within a group", () => {
		const groups = groupHooksByTool([
			hook({ id: "h1", event: "pre:bash" }),
			hook({ id: "h2", event: "post:read" }),
			hook({ id: "h3", event: "post:bash" }),
			hook({ id: "h4", event: "pre:*" }),
		]);
		expect(groups.map(([tool]) => tool)).toEqual(["*", "bash", "read"]);
		const bash = groups.find(([tool]) => tool === "bash");
		expect(bash?.[1].map(h => h.id)).toEqual(["h1", "h3"]);
	});

	it("falls back to the * bucket for events with no tool part", () => {
		const groups = groupHooksByTool([hook({ id: "h1", event: "sessionStart" })]);
		expect(groups.map(([tool]) => tool)).toEqual(["*"]);
	});
});

describe("MCP_STATUS_VARIANT", () => {
	it("maps every connection status to the spec'd badge color", () => {
		expect(MCP_STATUS_VARIANT.connected).toBe("success");
		expect(MCP_STATUS_VARIANT.connecting).toBe("info");
		expect(MCP_STATUS_VARIANT.disconnected).toBe("muted");
	});
});

describe("isCustomCommand", () => {
	it("excludes only builtin commands", () => {
		expect(isCustomCommand(command({ name: "mcp", source: "builtin" }))).toBe(false);
		expect(isCustomCommand(command({ name: "review", source: "file" }))).toBe(true);
		expect(isCustomCommand(command({ name: "deploy", source: "custom" }))).toBe(true);
		expect(isCustomCommand(command({ name: "mcp:docs", source: "mcp_prompt" }))).toBe(true);
	});

	it("treats a missing source as custom (the sidecar always sets it; unknowns stay visible)", () => {
		expect(isCustomCommand(command({ name: "mystery" }))).toBe(true);
	});
});

describe("groupCommandsBySource", () => {
	it("buckets by source, sorts groups A–Z, and preserves row order within a group", () => {
		const groups = groupCommandsBySource([
			command({ name: "review", source: "file" }),
			command({ name: "deploy", source: "custom" }),
			command({ name: "lint", source: "file" }),
			command({ name: "skill:test", source: "skill" }),
		]);
		expect(groups.map(([source]) => source)).toEqual(["custom", "file", "skill"]);
		const file = groups.find(([source]) => source === "file");
		expect(file?.[1].map(c => c.name)).toEqual(["review", "lint"]);
	});

	it("falls back to the other bucket when the source is missing", () => {
		const groups = groupCommandsBySource([command({ name: "mystery" })]);
		expect(groups.map(([source]) => source)).toEqual(["other"]);
	});
});
