/**
 * The security dashboard over the live session: stock `SecurityStore` scans and
 * the `SecurityCoordinator` operations. Ported from the fork's rpc-operations.ts.
 * Wire shapes match `src/shared/rpc-types.ts`.
 */
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import type { SecurityFinding, SecurityScanBundle } from "@oh-my-pi/pi-coding-agent/security/contracts";
import { getSecurityCoordinator, type SecurityOperationSnapshot } from "@oh-my-pi/pi-coding-agent/security/coordinator";
import type { SecurityTargetRequest } from "@oh-my-pi/pi-coding-agent/security/preflight";
import { SecurityStore } from "@oh-my-pi/pi-coding-agent/security/store";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { prompt } from "@oh-my-pi/pi-utils";
import { guard } from "./health";
import { ompPrompt } from "./modes/shared";
import { asRecord, requiredString } from "./params";
import type { BridgeMethods } from "./types";

function securityCoordinator(session: AgentSession) {
	return getSecurityCoordinator({
		cwd: session.sessionManager.getCwd(),
		settings: session.settings,
		authStorage: session.modelRegistry.authStorage,
		modelRegistry: session.modelRegistry,
		activeModel: session.model,
		sessionId: session.sessionId,
		agentId: session.getAgentId(),
		asyncJobManager: session.asyncJobManager,
	});
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
		securityCoordinator(session).listOperations(),
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
	security_start: async (params, env) => {
		const coordinator = securityCoordinator(env.session());
		const plan = await coordinator.preflight({ target: asRecord(params).target as SecurityTargetRequest });
		return projectOperation(await coordinator.start({ planId: plan.id }));
	},
	security_cancel: async (params, env) => ({
		cancelled: await securityCoordinator(env.session()).cancel(requiredString(params, "operationId")),
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
