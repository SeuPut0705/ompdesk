import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";

const omp = path.join(os.homedir(), ".bun", "bin", "omp");

/** Runs inside stock omp, so imports use its bundled singleton resolver. */
function stockCheckExtension(reportPath: string): string {
	return `
import assert from "node:assert/strict";
import { methods as skills } from "./extensions/skills";
import { methods as plugins } from "./extensions/plugins";
import { methods as agents } from "./extensions/agents";
import { methods as mcp } from "./extensions/mcp";
import { methods as extras } from "./session-extras";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { formatModelString } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { createAgentsHubDeps } from "@oh-my-pi/pi-coding-agent/modes/agents-hub-deps";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { cfgMcpEnableProjectConfig } from "@oh-my-pi/pi-coding-agent/mcp/settings";
import { MCPCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import { buildMcpArgumentCompletions } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-completions";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";

export default function(pi) {
 pi.on("session_start", async (_event, ctx) => {
  const report = {};
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
   assert.ok(session, "live stock AgentSession");
   const env = { pi, session: () => session, context: () => ctx, emit: () => {} };
   const cwd = session.sessionManager.getCwd();
   const manager = MCPManager.instance();
   const overrides = lookup("task.agentModelOverrides");
   overrides.override(session.settings,{...overrides.get(session.settings),"stock-agent-probe":["openai/gpt-4o:high","@slow"]});
   lookup("task.disabledAgents").setMember(session.settings,"stock-agent-probe",{member:true});
   lookup("task.agentAdvisor").setEntry(session.settings,"stock-agent-probe","@advisor");
   assert.ok(manager, "live stock MCPManager");
   const snapshot = async () => {
    const [skillList, pluginList, agentList, mcpList] = await Promise.all([
     skills.get_skills({}, env), plugins.get_plugins({}, env), agents.get_agent_definitions({}, env), mcp.get_mcp_servers({}, env),
    ]);
    const stockSkills = await loadCapability("skills", {cwd, agentDir: session.settings.getAgentDir(), includeDisabled:true, extensionRoots:session.effectiveExtensionRoots, disabledExtensions:lookup("disabledExtensions").get(session.settings)});
    assert.deepEqual(skillList.skills.map(s => s.name), stockSkills.items.map(s => s.name));
    assert.deepEqual(skillList.skills.map(s => s.enabled), stockSkills.items.map(s => session.skills.some(live => live.name === s.name)));
    const stockPlugins = await new PluginManager(cwd).list();
    assert.deepEqual(pluginList.plugins.filter(p => p.marketplace === "npm"), stockPlugins.map(p => ({name:p.name,marketplace:"npm",enabled:p.enabled,version:p.version})));
    const hub = createAgentsHubDeps(cwd, session.settings, session.modelRegistry, () => session.effectiveExtensionRoots, session.model ? formatModelString(session.model) : undefined, session.settings.getModelRole("default"));
    const stockAgents = await hub.loadAgents();
    assert.deepEqual(agentList.agents.map(a => a.name), stockAgents.map(a => a.name));
    for (const agent of agentList.agents) {
     const stock = stockAgents.find(a => a.name === agent.name);
     assert.deepEqual(agent.effectivePatterns, hub.effectiveModelPatterns(stock));
     assert.equal(agent.effectiveResolved, hub.resolvePatterns(hub.effectiveModelPatterns(stock)));
     assert.equal(agent.prewalkPattern, hub.effectivePrewalkPattern(stock));
     assert.equal(agent.advisorPattern, hub.effectiveAdvisorPattern(stock));
     assert.equal(agent.disabled, stock.disabled);
    }
    const active = await loadAllMCPConfigs(cwd, {enableProjectConfig:cfgMcpEnableProjectConfig.get(session.settings),filterExa:false,extensionRoots:session.effectiveExtensionRoots});
    for (const server of mcpList.servers) assert.equal(server.enabled, Object.hasOwn(active.configs,server.name));
    // Evidence excludes connection URLs/commands, which may contain credentials.
    return { skills:skillList.skills.map(({name,enabled,provider,managed,hidden})=>({name,enabled,provider,managed,hidden})), plugins:pluginList.plugins, agents:agentList.agents, mcp:mcpList.servers.map(({name,transport,status,toolCount,enabled,scope,authState})=>({name,transport,status,toolCount,enabled,scope,authState})) };
   };
   report.before = await snapshot();
   assert.equal(report.before.mcp.find(s=>s.name==="ompdesk-force-probe")?.enabled,cfgMcpEnableProjectConfig.get(session.settings));
   const skillName = "ompdesk-duplication-probe";
   assert.equal(report.before.skills.find(s => s.name === skillName)?.enabled,true);
   report.skillDisabled = await skills.set_skill_enabled({name:skillName,enabled:false},env);
   assert.equal(report.skillDisabled.enabled,false);
   assert.ok(lookup("disabledExtensions").get(session.settings).includes("skill:"+skillName));
   report.skillEnabled = await skills.set_skill_enabled({name:skillName,enabled:true},env);
   assert.equal(report.skillEnabled.enabled,true);
   report.mcpEnabled = await mcp.mcp_action({name:"ompdesk-probe",action:"enable"},env);
   assert.equal((await mcp.get_mcp_servers({},env)).servers.find(s=>s.name==="ompdesk-probe").enabled,true);
   // Add/remove use the same public reload path; direct stock reload is also
   // exercised here before comparing its connection state with the GUI path.
   await new MCPCommandController({session,settings:session.settings,mcpManager:manager,presentCommandOutput:output=>{throw new Error(output.render(120).join("\\n"));}}).reloadServers();
   report.stockReloadStatus = manager.getConnectionStatus("ompdesk-probe");
   report.guiReload = await mcp.mcp_add({name:"ompdesk-reload-probe",scope:"user",config:{transport:"stdio",command:process.execPath,args:[process.env.OMPDESK_MCP_PROBE]}},env);
   assert.equal(report.guiReload.added,true);
   assert.equal(manager.getConnectionStatus("ompdesk-probe"),report.stockReloadStatus);
   report.mcpDisabled = await mcp.mcp_action({name:"ompdesk-probe",action:"disable"},env);
   assert.equal((await mcp.get_mcp_servers({},env)).servers.find(s=>s.name==="ompdesk-probe").enabled,false);
   const spec = BUILTIN_SLASH_COMMANDS_INTERNAL.find(s=>s.name==="mcp");
   report.completions = {};
   for (const prefix of ["", "enable ", "disable ", "test ", "remove ", "reauth ", "unauth "]) {
    const gui = await extras["sessions.arg_completions"]({cwd,command:"mcp",prefix},env);
    const stock = await buildMcpArgumentCompletions(spec.subcommands,{ctx:{mcpManager:manager}})(prefix);
    assert.deepEqual(gui.items,stock ?? []);
    report.completions[prefix] = gui.items;
   }
   const valid = "---\\nname: preview-probe\\ndescription: Preview\\ntools: [search, READ, read, task]\\nmodel: ['@slow', '@default']\\nblocking: 'true'\\n---\\nInstructions";
   const parsed = await agents.validate_agent_definition({content:valid,source:"probe.md"},env);
   const stockParsed = parseAgent("probe.md",valid,"user");
   const {systemPrompt,source,filePath,...stockFields} = stockParsed;
   assert.deepEqual(parsed,{fields:stockFields,body:systemPrompt});
   report.preview = parsed;
   const invalid = "---\\nname: invalid-probe\\ndescription: [not, a, string]\\n---\\nInstructions";
   let stockError;
   try { parseAgent("invalid.md",invalid,"user"); } catch(error) { stockError = error.message; }
   assert.ok(stockError);
   try { await agents.validate_agent_definition({content:invalid,source:"invalid.md"},env); assert.fail("invalid definition accepted"); }
   catch(error) { assert.equal(error.message,stockError); report.invalidFieldError = error.message; }
   // A project layer must remain authoritative when the global member is removed.
   const setting = lookup("disabledExtensions");
   await Bun.write(cwd+"/.omp/config.yml", "disabledExtensions:\\n  - skill:"+skillName+"\\n");
   await session.settings.reloadFromDisk();
   await session.refreshSkills();
   report.projectDisabled = await skills.set_skill_enabled({name:skillName,enabled:true},env);
   assert.equal(report.projectDisabled.enabled,false);
   assert.equal(report.projectDisabled.provenance,"project");
   report.after = await snapshot();
  } catch(error) { report.error = error.stack ?? String(error); }
  await Bun.write(${JSON.stringify(reportPath)},JSON.stringify(report,null,2));
 });
}
`;
}

const mcpProbe = `
const readline = require("node:readline");
readline.createInterface({input:process.stdin}).on("line",line=>{
 const request = JSON.parse(line);
 if(request.id === undefined) return;
 const result = request.method === "initialize" ? {protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"ompdesk-probe",version:"1"}} : request.method === "tools/list" ? {tools:[]} : {};
 process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result})+"\\n");
});
`;

test("extension inventories, mutations, completions and agent validation match stock omp", async () => {
	test.setTimeout(180_000);
	test.skip(!(await fs.stat(omp).catch(() => null)), "stock omp is not installed");
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-stock-extensions-"));
	const agentDir = path.join(profile, "agent");
	const project = path.join(profile, "project");
	const reportPath = path.join(profile, "report.json");
	const bridge = path.join(profile, "bridge");
	const extension = path.join(bridge, "verify.ts");
	const server = path.join(profile, "mcp-probe.cjs");
	await fs.chmod(profile, 0o700);
	await fs.mkdir(agentDir, { mode: 0o700 });
	await fs.mkdir(path.join(project, ".omp"), { recursive: true });
	const sourceDir = path.join(os.homedir(), ".omp", "agent");
	await fs.copyFile(path.join(sourceDir, "config.yml"), path.join(agentDir, "config.yml")).catch(error => {
		if (error.code !== "ENOENT") throw error;
	});
	if (await fs.stat(path.join(sourceDir, "agent.db")).catch(() => null)) {
		execFileSync("sqlite3", [
			"-readonly",
			path.join(sourceDir, "agent.db"),
			`VACUUM INTO '${path.join(agentDir, "agent.db").replaceAll("'", "''")}'`,
		]);
	}
	await fs.mkdir(path.join(agentDir, "skills", "ompdesk-duplication-probe"), { recursive: true });
	await fs.writeFile(
		path.join(agentDir, "skills", "ompdesk-duplication-probe", "SKILL.md"),
		"---\nname: ompdesk-duplication-probe\ndescription: Isolated inventory probe\n---\nTest knowledge.\n",
	);
	await fs.mkdir(path.join(agentDir, "agents"), { recursive: true });
	await fs.writeFile(
		path.join(agentDir, "agents", "stock-agent-probe.md"),
		'---\nname: stock-agent-probe\ndescription: Isolated agent inventory probe\nmodel: ["@slow", "@default"]\ntools: [read]\nprewalk: true\nadvisor: true\n---\nInstructions.\n',
	);
	await fs.writeFile(server, mcpProbe);
	await fs.writeFile(
		path.join(agentDir, "mcp.json"),
		JSON.stringify({
			mcpServers: { "ompdesk-probe": { type: "stdio", command: process.execPath, args: [server], enabled: false } },
			enabledServers: ["ompdesk-force-probe"],
		}),
	);
	await fs.writeFile(
		path.join(project, ".mcp.json"),
		JSON.stringify({
			mcpServers: {
				"ompdesk-force-probe": { type: "stdio", command: process.execPath, args: [server], enabled: false },
			},
		}),
	);
	await fs.cp(path.resolve("resources/gui-bridge"), bridge, { recursive: true });
	await fs.writeFile(extension, stockCheckExtension(reportPath));
	const child = spawn(
		omp,
		["--mode", "rpc-ui", "--no-extensions", "--no-rules", "--model", "openai/gpt-4o", "-e", extension],
		{
			cwd: project,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: agentDir,
				PI_CONFIG_DIR: path.relative(os.homedir(), profile),
				OMP_PROFILE: "",
				PI_PROFILE: "",
				OMPDESK_MCP_PROBE: server,
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	let stderr = "";
	child.stderr.on("data", chunk => {
		stderr += String(chunk);
	});
	let output = "";
	child.stdout.on("data", chunk => {
		output += String(chunk);
	});
	try {
		await expect
			.poll(
				async () => {
					if (child.exitCode !== null) throw new Error(`Stock omp exited: ${stderr}\n${output}`);
					if (stderr.includes("Failed to load extension")) throw new Error(stderr);
					return fs
						.stat(reportPath)
						.then(() => true)
						.catch(() => false);
				},
				{ timeout: 120_000, message: "stock extension report" },
			)
			.toBe(true);
		const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
		expect(report.error, stderr).toBeUndefined();
		await test
			.info()
			.attach("stock-before-after", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
		console.log(
			JSON.stringify(
				{
					before: report.before,
					skillDisabled: report.skillDisabled,
					skillEnabled: report.skillEnabled,
					mcpEnabled: report.mcpEnabled,
					mcpDisabled: report.mcpDisabled,
					stockReloadStatus: report.stockReloadStatus,
					guiReload: report.guiReload,
					completions: report.completions,
					preview: report.preview,
					projectDisabled: report.projectDisabled,
					after: report.after,
					invalidFieldError: report.invalidFieldError,
				},
				null,
				2,
			),
		);
	} finally {
		await test.info().attach("stock-startup-output", {
			body: `${stderr}\n${output}`,
			contentType: "text/plain",
		});
		child.stdin.end();
		child.kill("SIGTERM");
		await new Promise<void>(resolve => {
			if (child.exitCode !== null || child.signalCode !== null) resolve();
			else child.once("exit", () => resolve());
		});
		await fs.rm(profile, { recursive: true, force: true });
	}
});
