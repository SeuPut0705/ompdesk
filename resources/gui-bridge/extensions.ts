/**
 * Extensions domain: skills, hooks, prompt templates, MCP, plugins,
 * marketplaces, agent definitions, subagent revive, memory report, themes.
 * Method names match the GUI RPC command each one answers.
 */
import { methods as agents } from "./extensions/agents";
import { methods as mcp } from "./extensions/mcp";
import { methods as plugins } from "./extensions/plugins";
import { methods as skills } from "./extensions/skills";
import type { BridgeMethods } from "./types";

export const methods: BridgeMethods = { ...skills, ...mcp, ...plugins, ...agents };
