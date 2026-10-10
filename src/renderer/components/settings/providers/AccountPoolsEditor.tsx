/**
 * Settings › Models & providers › Account pools: which signed-in accounts each
 * agent may use (`task.agentAccountPools`, omp 18.8.1+; rules in
 * account-pools.ts). Agents are the focused tab's agent definitions plus any
 * name the setting already holds; accounts are the connected subscription
 * providers' accounts the Providers section already read, keyed by the
 * identity key the bridge reports. Shown only when the omp has both the
 * setting and the identity keys, so an older omp shows nothing. Edits target
 * the global layer (config.yml); a project or `--config` value that overrides
 * it is called out. Keys of accounts not signed in here stay listed, checked,
 * until unchecked. Everything goes through the tab's RPC, so a paired host's
 * tab edits the host's pools with the host's accounts.
 */

import { ChevronDown, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import type { ProviderAccountsResult, ProviderInfo } from "../../../../shared/rpc-types";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { toastError } from "../../../stores/toast";
import { Badge, Button, ListRow } from "../../common";
import { InlineNotice } from "../InlineNotice";
import { SettingsSection } from "../SettingsLayout";
import {
	AGENT_ACCOUNT_POOLS_PATH,
	type AgentAccountPools,
	clearAgentPool,
	parseAgentAccountPools,
	poolFor,
	poolIncludes,
	restrictedProviders,
	serializeAgentAccountPools,
	togglePoolAccount,
} from "./account-pools";

const CHECKBOX_CLASS = "size-4 shrink-0 accent-(--sc-accent) disabled:cursor-not-allowed";

/** A connected subscription provider and its account read (null until it answered). */
export interface PoolProvider {
	provider: ProviderInfo;
	result: ProviderAccountsResult | null;
}

const settingsData = z.object({
	values: z.record(z.string(), z.unknown()),
	provenance: z
		.record(z.string(), z.object({ layers: z.array(z.string()), globalValue: z.unknown().optional() }))
		.optional(),
});
const definitionsData = z.object({ agents: z.array(z.object({ name: z.string().min(1) })) });

interface Loaded {
	/** The global layer's map; null when it is not one this editor can edit. */
	pools: AgentAccountPools | null;
	/** A project or overlay layer sets the value too, and wins. */
	overridden: boolean;
	agents: string[];
}

/** One provider block of an agent: the accounts that can join a pool, plus saved keys no account here has. */
interface ProviderBlock {
	id: string;
	name: string;
	accounts: { key: string | null; label: string; credentialId: number }[];
	orphanKeys: string[];
}

function providerBlocks(providers: readonly PoolProvider[], pools: AgentAccountPools, agent: string): ProviderBlock[] {
	const blocks: ProviderBlock[] = [];
	const seen = new Set<string>();
	for (const { provider, result } of providers) {
		const id = result?.credentialProvider;
		if (!result || id === undefined || seen.has(id)) continue;
		seen.add(id);
		const accounts = result.accounts
			.filter(account => account.identityKey !== undefined)
			.map(account => ({
				key: account.identityKey ?? null,
				label: account.label,
				credentialId: account.credentialId,
			}));
		const known = new Set(accounts.map(account => account.key));
		const orphanKeys = (poolFor(pools, agent, id) ?? []).filter(key => !known.has(key));
		blocks.push({ id, name: provider.name, accounts, orphanKeys });
	}
	for (const id of restrictedProviders(pools, agent)) {
		if (seen.has(id)) continue;
		blocks.push({ id, name: id, accounts: [], orphanKeys: [...(poolFor(pools, agent, id) ?? [])] });
	}
	return blocks;
}

function AgentPool({
	agent,
	missing,
	pools,
	providers,
	disabled,
	expanded,
	onToggleExpanded,
	onChange,
}: {
	agent: string;
	/** Named by the setting but not among this workspace's agent definitions. */
	missing: boolean;
	pools: AgentAccountPools;
	providers: readonly PoolProvider[];
	disabled: boolean;
	expanded: boolean;
	onToggleExpanded: () => void;
	onChange: (next: AgentAccountPools) => void;
}) {
	const t = useT();
	const regionId = useId();
	const restricted = restrictedProviders(pools, agent);
	const keyCount = restricted.reduce((sum, provider) => sum + (poolFor(pools, agent, provider)?.length ?? 0), 0);
	const summary =
		restricted.length === 0
			? t("accountPools.unrestricted")
			: keyCount === 1
				? t("accountPools.restrictedOne")
				: t("accountPools.restricted", { count: keyCount });
	const checkbox = (provider: string, key: string, label: string, title?: string) => (
		<label className="flex min-h-7 min-w-0 items-center gap-2 text-sc-sm text-(--sc-text)" key={key} title={title}>
			<input
				checked={poolIncludes(pools, agent, provider, key)}
				className={CHECKBOX_CLASS}
				disabled={disabled}
				onChange={event => onChange(togglePoolAccount(pools, agent, provider, key, event.target.checked))}
				type="checkbox"
			/>
			<span className="min-w-0 truncate">{label}</span>
		</label>
	);
	return (
		<li>
			<ListRow
				buttonProps={{ "aria-expanded": expanded, "aria-controls": regionId }}
				meta={summary}
				onClick={onToggleExpanded}
				title={
					<span className="flex min-w-0 items-center gap-1.5">
						<span className="min-w-0 truncate">{agent}</span>
						{missing && <Badge variant="warning">{t("accountPools.agentMissing")}</Badge>}
					</span>
				}
				titleText={agent}
				trailing={
					<ChevronDown
						aria-hidden
						className={cx(
							"size-(--sc-icon-sm) text-(--sc-text-muted) transition-transform duration-(--sc-duration-fast) motion-reduce:transition-none",
							expanded && "rotate-180",
						)}
					/>
				}
			/>
			{expanded && (
				<div className="flex flex-col gap-2 pr-2.5 pb-2 pl-9" id={regionId}>
					{providerBlocks(providers, pools, agent).map(block => (
						<fieldset className="min-w-0" key={block.id}>
							<legend className="pb-0.5 text-sc-xs font-medium text-(--sc-text-muted)">{block.name}</legend>
							{block.accounts.map(account =>
								account.key === null ? (
									<label
										className="flex min-h-7 min-w-0 items-center gap-2 text-sc-sm text-(--sc-text-muted)"
										key={`none-${account.credentialId}`}
									>
										<input checked={false} className={CHECKBOX_CLASS} disabled readOnly type="checkbox" />
										<span className="min-w-0 truncate">
											{t("accountPools.noIdentity", { account: account.label })}
										</span>
									</label>
								) : (
									checkbox(block.id, account.key, account.label, account.key)
								),
							)}
							{block.orphanKeys.map(key => checkbox(block.id, key, t("accountPools.signedOut", { key }), key))}
						</fieldset>
					))}
					{restricted.length > 0 && (
						<Button
							className="-ml-2 self-start"
							disabled={disabled}
							onClick={() => onChange(clearAgentPool(pools, agent))}
							size="sm"
							variant="ghost"
						>
							{t("accountPools.allowAll")}
						</Button>
					)}
				</div>
			)}
		</li>
	);
}

export function AccountPoolsEditor({
	providers,
	sidecarReady,
}: {
	providers: readonly PoolProvider[];
	sidecarReady: boolean;
}) {
	const t = useT();
	const tabRpc = useTabRpc();
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [expanded, setExpanded] = useState<string | null>(null);
	const requestVersion = useRef(0);

	const load = useCallback(async () => {
		const version = ++requestVersion.current;
		setLoading(true);
		try {
			const [settings, definitions] = await Promise.all([
				tabRpc.getSettings([AGENT_ACCOUNT_POOLS_PATH]),
				tabRpc.getAgentDefinitions(),
			]);
			if (version !== requestVersion.current) return;
			if (!settings.success) throw new Error(settings.error);
			if (!definitions.success) throw new Error(definitions.error);
			const data = settingsData.parse(settings.data);
			const provenance = data.provenance?.[AGENT_ACCOUNT_POOLS_PATH];
			const agents = definitionsData.parse(definitions.data).agents.map(agent => agent.name);
			setLoaded({
				pools: parseAgentAccountPools(provenance ? provenance.globalValue : data.values[AGENT_ACCOUNT_POOLS_PATH]),
				overridden: provenance?.layers.some(layer => layer === "project" || layer === "overlay") === true,
				agents: [...new Set(agents)],
			});
			setError(null);
		} catch (cause) {
			if (version === requestVersion.current) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (version === requestVersion.current) setLoading(false);
		}
	}, [tabRpc]);

	useEffect(() => {
		if (sidecarReady) void load();
	}, [sidecarReady, load]);

	const write = async (next: AgentAccountPools) => {
		if (!loaded) return;
		const previous = loaded;
		setLoaded({ ...loaded, pools: next });
		setSaving(true);
		try {
			const response = await tabRpc.setSetting(AGENT_ACCOUNT_POOLS_PATH, serializeAgentAccountPools(next));
			if (!response.success) {
				setLoaded(previous);
				toastError({ title: t("accountPools.saveFailed"), error: response });
			}
		} catch (cause) {
			setLoaded(previous);
			toastError({ title: t("accountPools.saveFailed"), error: cause });
		} finally {
			setSaving(false);
		}
	};

	const pools = loaded?.pools;
	const agents = loaded ? [...loaded.agents] : [];
	for (const name of pools ? Object.keys(pools) : []) if (!agents.includes(name)) agents.push(name);
	if (loaded && pools && agents.length === 0 && !error) return null;

	return (
		<SettingsSection
			description={t("accountPools.desc")}
			id="settings-models-account-pools"
			title={t("accountPools.title")}
		>
			{error && (
				<InlineNotice
					action={
						<Button
							disabled={!sidecarReady || loading}
							icon={<RefreshCw />}
							onClick={() => void load()}
							size="sm"
							variant="ghost"
						>
							{t("common.retry")}
						</Button>
					}
					detail={error}
					title={t("accountPools.loadFailed")}
					tone="danger"
				/>
			)}
			{loaded?.overridden && <InlineNotice title={t("accountPools.overridden")} tone="info" />}
			{loaded && pools === null && (
				<InlineNotice
					title={t("accountPools.unreadable")}
					tone="warning"
					action={
						<Button
							disabled={saving || !sidecarReady}
							onClick={() => void write({})}
							size="sm"
							variant="secondary"
						>
							{t("common.reset")}
						</Button>
					}
				/>
			)}
			{loaded && pools && (
				<ul aria-label={t("accountPools.title")} className="flex flex-col divide-y divide-(--sc-divider)">
					{agents.map(agent => (
						<AgentPool
							agent={agent}
							disabled={!sidecarReady || saving}
							expanded={expanded === agent}
							key={agent}
							missing={!loaded.agents.includes(agent)}
							onChange={next => void write(next)}
							onToggleExpanded={() => setExpanded(open => (open === agent ? null : agent))}
							pools={pools}
							providers={providers}
						/>
					))}
				</ul>
			)}
		</SettingsSection>
	);
}
