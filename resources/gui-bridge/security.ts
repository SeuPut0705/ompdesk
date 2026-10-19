/**
 * The security dashboard over the live session: stock `SecurityStore` scans and
 * the `SecurityCoordinator` operations. Ported from the fork's rpc-operations.ts.
 * Wire shapes match `src/shared/rpc-types.ts`.
 *
 * Operations go through stock's `security_scan` tool, never `security/coordinator`: omp's bundle does not export
 * that subpath, so a bridge import of it loads a second copy whose setting handles (`security.enabled`, the task
 * agent overrides) read other settings' slots, and whose operations live apart from the session's own.
 */
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import type { SecurityFinding, SecurityScanBundle } from "@oh-my-pi/pi-coding-agent/security/contracts";
import type { SecurityOperationSnapshot } from "@oh-my-pi/pi-coding-agent/security/coordinator";
import type { SecurityTargetRequest } from "@oh-my-pi/pi-coding-agent/security/preflight";
import { SecurityStore } from "@oh-my-pi/pi-coding-agent/security/store";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { SecurityScanTool } from "@oh-my-pi/pi-coding-agent/tools/security-scan";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { prompt } from "@oh-my-pi/pi-utils";
import { guard } from "./health";
import { ompPrompt } from "./modes/shared";
import { asRecord, requiredString } from "./params";
import type { BridgeMethods } from "./types";

type SecurityScanParams = Parameters<SecurityScanTool["execute"]>[1];

interface ToolDetails {
	plan?: { id: string };
	operation?: SecurityOperationSnapshot;
	cancelled?: boolean;
}

/** Operations this bridge started, per stock coordinator key (cwd + session): the tool has no listing. */
const startedOperations = new Map<string, string[]>();

function coordinatorKey(session: AgentSession): string {
	return `${session.sessionManager.getCwd()}\u0000${session.sessionId}`;
}

/** Stock's `security_scan` tool over this session; it reaches stock's own coordinator for the session. */
async function runSecurityTool(session: AgentSession, params: SecurityScanParams): Promise<ToolDetails> {
	// The members the tool reads (tools/security-scan.ts `coordinatorForSession`), as stock's ToolSession has them.
	const toolSession = {
		cwd: session.sessionManager.getCwd(),
		settings: session.settings,
		modelRegistry: session.modelRegistry,
		authStorage: session.modelRegistry.authStorage,
		getActiveModel: () => session.model,
		getSessionId: () => session.sessionId,
		getAgentId: () => session.getAgentId(),
		asyncJobManager: session.asyncJobManager,
	} satisfies Partial<ToolSession>;
	const result = await new SecurityScanTool(toolSession as ToolSession).execute("ompdesk-security", params);
	return (result.details ?? {}) as ToolDetails;
}

function toolTarget(target: SecurityTargetRequest): SecurityScanParams {
	return {
		target_kind: target.kind,
		...("includePaths" in target && target.includePaths ? { include_paths: target.includePaths } : {}),
		...("excludePaths" in target && target.excludePaths ? { exclude_paths: target.excludePaths } : {}),
		...("baseRevision" in target ? { base_revision: target.baseRevision } : {}),
		...("headRevision" in target ? { head_revision: target.headRevision } : {}),
	} as SecurityScanParams;
}

async function listOperations(session: AgentSession): Promise<SecurityOperationSnapshot[]> {
	const ids = startedOperations.get(coordinatorKey(session)) ?? [];
	const snapshots = await Promise.all(
		ids.map(id =>
			runSecurityTool(session, { action: "status", operation_id: id }).then(
				details => details.operation,
				() => undefined,
			),
		),
	);
	return snapshots.filter((operation): operation is SecurityOperationSnapshot => operation !== undefined);
}

async function startOperation(session: AgentSession, target: SecurityTargetRequest) {
	const { plan } = await runSecurityTool(session, { action: "preflight", ...toolTarget(target) });
	if (!plan) throw new Error("Security preflight returned no plan");
	const { operation } = await runSecurityTool(session, { action: "start", plan_id: plan.id });
	if (!operation) throw new Error("Security scan did not start");
	const key = coordinatorKey(session);
	startedOperations.set(key, [...(startedOperations.get(key) ?? []), operation.operationId]);
	return operation;
}

function projectFinding(finding: SecurityFinding) {
	const location = finding.occurrences[0]?.locations[0] ?? finding.evidence.find(item => item.location)?.location;
	return {
		id: finding.id,
		scanId: finding.scanId,
		title: finding.title,
		summary: finding.summary,
		severity: finding.severity.level,
		confidence: finding.confidence.level,
		...(location ? { path: location.path, line: location.startLine } : {}),
		disposition: finding.disposition.status,
		validation: finding.validation.status,
		...(finding.remediation ? { remediation: finding.remediation } : {}),
		evidence: finding.evidence.map(item => ({
			label: item.label,
			explanation: item.explanation,
			...(item.excerpt ? { excerpt: item.excerpt } : {}),
			...(item.location ? { path: item.location.path, line: item.location.startLine } : {}),
		})),
	};
}

function projectScan(bundle: SecurityScanBundle) {
	const { scan } = bundle;
	return {
		id: scan.id,
		status: scan.status,
		createdAt: scan.createdAt,
		...(scan.completedAt ? { completedAt: scan.completedAt } : {}),
		producer: scan.producer.name,
		findingCount: bundle.findings.length,
		target: {
			kind: scan.target.kind,
			displayName: scan.target.displayName,
			...(scan.target.revision ? { revision: scan.target.revision } : {}),
			...(scan.target.baseRevision ? { baseRevision: scan.target.baseRevision } : {}),
			...(scan.target.headRevision ? { headRevision: scan.target.headRevision } : {}),
		},
	};
}

function projectOperation(operation: SecurityOperationSnapshot) {
	return {
		operationId: operation.operationId,
		planId: operation.planId,
		scanId: operation.scanId,
		phase: operation.phase,
		createdAt: operation.createdAt,
		updatedAt: operation.updatedAt,
		findingCount: operation.findingCount,
		...(operation.error ? { error: operation.error } : {}),
	};
}

async function securityDashboard(session: AgentSession) {
	const cwd = session.sessionManager.getCwd();
	const store = await SecurityStore.openForCwd(cwd);
	const repository = vcs.git(cwd);
	const [summaries, operations, branch, sha] = await Promise.all([
		store.listScans(),
		listOperations(session),
		repository?.currentBranch() ?? null,
		repository?.headSha() ?? null,
	]);
	const bundles = (await Promise.all(summaries.map(summary => store.getBundle(summary.id)))).filter(
		(bundle): bundle is SecurityScanBundle => bundle !== null,
	);
	const revision = [branch, sha?.slice(0, 7)].filter(Boolean).join(" · ");
	const model = session.model;
	return {
		enabled: lookup("security.enabled")?.get(session.settings) === true,
		modelReady: model !== undefined,
		...(model ? { modelLabel: `${model.provider}/${model.id}` } : {}),
		repositoryRoot: store.repositoryRoot,
		...(revision ? { revision } : {}),
		scans: bundles.map(projectScan),
		operations: operations.map(projectOperation),
		...(bundles[0]
			? { latest: { scan: projectScan(bundles[0]), findings: bundles[0].findings.map(projectFinding) } }
			: {}),
	};
}

async function securityScan(session: AgentSession, scanId: string) {
	const bundle = await (await SecurityStore.openForCwd(session.sessionManager.getCwd())).getBundle(scanId);
	if (!bundle) throw new Error(`Unknown security scan: ${scanId}`);
	return { scan: projectScan(bundle), findings: bundle.findings.map(projectFinding) };
}

const DISPOSITIONS: Record<string, true> = {
	open: true,
	false_positive: true,
	accepted_risk: true,
	fixed: true,
	wont_fix: true,
};

async function setDisposition(session: AgentSession, params: unknown) {
	const scanId = requiredString(params, "scanId");
	const findingId = requiredString(params, "findingId");
	const status = requiredString(params, "status");
	if (!DISPOSITIONS[status]) throw new Error(`Unknown disposition: ${status}`);
	const rationale = (asRecord(params).rationale as string | undefined)?.trim();
	if (status !== "open" && !rationale) throw new Error(`${status} requires a rationale`);
	const store = await SecurityStore.openForCwd(session.sessionManager.getCwd());
	const finding = await store.updateDisposition(scanId, findingId, {
		status: status as SecurityFinding["disposition"]["status"],
		...(rationale ? { rationale } : {}),
		updatedAt: new Date().toISOString(),
		actor: "operator",
	});
	return projectFinding(finding);
}

export const methods: BridgeMethods = guard("security", {
	security_dashboard: async (_params, env) => securityDashboard(env.session()),
	security_scan: async (params, env) => securityScan(env.session(), requiredString(params, "scanId")),
	security_start: async (params, env) =>
		projectOperation(await startOperation(env.session(), asRecord(params).target as SecurityTargetRequest)),
	security_cancel: async (params, env) => ({
		cancelled:
			(
				await runSecurityTool(env.session(), {
					action: "cancel",
					operation_id: requiredString(params, "operationId"),
				})
			).cancelled === true,
	}),
	security_set_disposition: async (params, env) => setDisposition(env.session(), params),
	security_validation_prompt: async (params, env) => {
		const scanId = requiredString(params, "scanId");
		const findingId = requiredString(params, "findingId");
		const store = await SecurityStore.openForCwd(env.session().sessionManager.getCwd());
		if (!(await store.getFinding(scanId, findingId))) throw new Error(`Unknown security finding: ${findingId}`);
		return {
			prompt: prompt.render(ompPrompt("security/validate-request.md"), {
				findingUri: `security://scans/${scanId}/findings/${findingId}`,
				scanId,
				findingId,
			}),
		};
	},
});
