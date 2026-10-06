/**
 * The same tool result reaches renderers in two wire shapes:
 * - live `tool_execution_end` events: `{ content, details }` (AgentToolResult),
 * - hydrated history (tools store): the same `{ content, details }` envelope.
 * These helpers unwrap both without the renderers caring which arrived. They
 * are the canonical accessors (re-exported from lib/format) — every renderer
 * should use them instead of ad-hoc `JSON.stringify` fallbacks.
 */

export { resultBodyText, resultDetails } from "../../lib/format";
