/**
 * How an omp reaches OMPdesk's MCP hub (./mcp-hub.ts, started by src/main/mcp-hub.ts): main puts these variables into
 * every omp it spawns, and the built-in MCP entries name them, so stock expands them when it reads the `.mcp.json`
 * (`expandEnvVarsDeep` in its plugin discovery) and the files stay the same across launches.
 */

/** `http://127.0.0.1:<port>` of this launch's hub. */
export const MCP_HUB_ENV = "OMP_GUI_MCP_HUB";
/** `Bearer <secret>`: the per-launch secret the hub requires on every request. */
export const MCP_AUTH_ENV = "OMP_GUI_MCP_AUTH";
/** The omp's folder, URL-encoded: where that omp's REA runs (it ran as omp's grandchild before the hub). */
export const MCP_CWD_ENV = "OMP_GUI_MCP_CWD";

/** The `ompdesk-memory` entry of memory's extension root (src/main/ai-memory/root.ts). */
export const MEMORY_HUB_ENTRY = {
	type: "http",
	url: `\${${MCP_HUB_ENV}}/memory`,
	headers: { Authorization: `\${${MCP_AUTH_ENV}}` },
} as const;

/** The `rea` entry of `resources/omp-builtin/rea/.mcp.json` (pinned against this by packaging-config.test.ts). */
export const REA_HUB_ENTRY = {
	type: "http",
	url: `\${${MCP_HUB_ENV}}/rea?cwd=\${${MCP_CWD_ENV}}`,
	headers: { Authorization: `\${${MCP_AUTH_ENV}}` },
} as const;
