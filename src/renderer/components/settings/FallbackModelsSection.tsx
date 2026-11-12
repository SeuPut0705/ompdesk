/**
 * Settings › Models & accounts › Fallback models: per model (or group of models) the ordered models stock tries when
 * it cannot be used, and when it switches. Stock's settings are the one store (`fallback-chains.ts`):
 * `retry.fallbackChains` is a row per key, `retry.fallbackOn` the "when" choice, `retry.modelFallback` the switch in
 * the header (off: one notice offering to turn it on, no rows). Every key stock accepts is shown: a model by its
 * name, `provider/*` as every model of that service, a role by its name, `default` as any other model, anything else
 * verbatim; an entry or key this editor does not understand is moved or removed, never rewritten. Writes replace the
 * global layer only, so a key a project config or a launch config sets shows read-only with where it comes from.
 * Models are picked from the signed-in accounts' models with the role rows' picker (`ModelValueSelect`), the roles'
 * own models first; an entry that is signed out or not among them is marked, never dropped. Each row says which of
 * the roles' models it applies to now and which follow a more specific row (`chainKeyFor`, a copy of stock's order).
 */

import { ArrowDown, ArrowUp, Shuffle, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { HIDDEN_ROLE_IDS, ROLE_ORDER } from "../../../../resources/gui-bridge/model-role-contracts";
import type { ModelRoleEntry, ModelRolesResult, SettingProvenance } from "../../../shared/rpc-types";
import { useLang, useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { useModelStore } from "../../stores/model";
import { toast, toastError } from "../../stores/toast";
import { Badge, Button, ChoiceCards, EmptyState, IconButton, InlineNotice, Switch } from "../common";
import {
	asChainRecord,
	type ChainContext,
	type ChainRecord,
	chainKeyFor,
	chainRows,
	FALLBACK_CHAINS_PATH,
	FALLBACK_ON_PATH,
	FALLBACK_REVERT_PATH,
	FALLBACK_TRIGGERS,
	type FallbackTrigger,
	isFallbackTrigger,
	keyCovers,
	MODEL_FALLBACK_PATH,
	moveEntry,
	RETRY_ENABLED_PATH,
	removeEntry,
	sameJson,
	selectorKind,
	serializeChains,
	withChain,
	withoutChain,
} from "./fallback-chains";
import { type ModelValueGroup, ModelValueSelect, modelValueGroups } from "./ModelValueSelect";
import { ProviderMark } from "./providers/ProviderMark";
import { shortProviderName } from "./providers/provider-groups";
import { compactModelLabel, compactModelLabels, compactModelText, modelRefOf } from "./providers/provider-marks";
import { SettingsRow, SettingsSection } from "./SettingsLayout";
import { modelRoleName } from "./schema-i18n";
import { useSettingsData } from "./settings-data";

/** set_setting's answer: the effective value after the write and where it now comes from. */
const setResultSchema = z.object({
	value: z.unknown(),
	provenance: z
		.object({
			layers: z.array(z.enum(["global", "project", "overlay", "runtime"])),
			globalValue: z.unknown(),
			globalPath: z.string().optional(),
		})
		.optional(),
});

/** A model some chat role runs on, with those roles in OMPdesk's order. */
interface UsedModel {
	selector: string;
	roles: string[];
}

function rank(role: string): number {
	const index = ROLE_ORDER.indexOf(role);
	return index >= 0 ? index : ROLE_ORDER.length;
}

export function FallbackModelsSection() {
	const t = useT();
	const { lang } = useLang();
	const tabRpc = useTabRpc();
	const { schema, values, sidecarReady, onCommitted } = useSettingsData();
	const providers = useModelStore(state => state.providers);
	const models = useModelStore(state => state.availableModels);
	const chainsEntry = schema?.entries.find(entry => entry.path === FALLBACK_CHAINS_PATH);
	const onEntry = schema?.entries.find(entry => entry.path === FALLBACK_ON_PATH);
	const switchEntry = schema?.entries.find(entry => entry.path === MODEL_FALLBACK_PATH);
	const retryEntry = schema?.entries.find(entry => entry.path === RETRY_ENABLED_PATH);
	const shown = chainsEntry !== undefined;
	const [roles, setRoles] = useState<ModelRoleEntry[]>([]);
	const [saved, setSaved] = useState<Record<string, SettingProvenance>>({});
	const [saving, setSaving] = useState(false);
	const [draft, setDraft] = useState<string | null>(null);

	useEffect(() => {
		if (!sidecarReady || !shown) return;
		let live = true;
		const load = () =>
			tabRpc
				.getModelRoles()
				.then(res => {
					if (live && res.success) setRoles((res.data as ModelRolesResult).roles);
				})
				.catch(() => undefined);
		void load();
		const off = window.omp.events.onConfigUpdate(() => void load());
		return () => {
			live = false;
			off();
		};
	}, [sidecarReady, shown, tabRpc]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: fresh schema provenance (config_update) replaces what the last save returned.
	useEffect(() => {
		setSaved({});
	}, [chainsEntry?.provenance, onEntry?.provenance]);

	const labels = useMemo(() => compactModelLabels(models), [models]);
	const used = useMemo(() => {
		const bySelector = new Map<string, UsedModel>();
		for (const role of [...roles].sort((a, b) => rank(a.id) - rank(b.id))) {
			const selector = role.effective?.model;
			if (!selector || role.section !== "chat" || role.hidden || HIDDEN_ROLE_IDS.includes(role.id)) continue;
			const known = bySelector.get(selector);
			if (known) known.roles.push(role.id);
			else bySelector.set(selector, { selector, roles: [role.id] });
		}
		return [...bySelector.values()];
	}, [roles]);

	if (!chainsEntry) return null;

	const valueAt = (path: string, fallback: unknown) => (Object.hasOwn(values, path) ? values[path] : fallback);
	const chains = asChainRecord(valueAt(FALLBACK_CHAINS_PATH, chainsEntry.value));
	const provenance = saved[FALLBACK_CHAINS_PATH] ?? chainsEntry.provenance;
	// The global layer alone is what a write replaces; a project or launch config's keys must never be copied into it.
	// A bridge too old to say (no provenance) wrote the global layer only.
	const globalLayer: ChainRecord = provenance
		? provenance.layers.includes("global")
			? asChainRecord(provenance.globalValue)
			: {}
		: chains;
	const otherLayer = (layers: SettingProvenance["layers"] | undefined) => layers?.find(layer => layer !== "global");
	const enabled = valueAt(MODEL_FALLBACK_PATH, switchEntry?.value) !== false;
	// Stock walks a chain on a failed request only while retries are on (`isHardErrorFallbackEligible`, the retry
	// handler); a model with no credential at all still switches (`applyMissingCredentialFallback`), so the rows stay.
	const retriesOff = retryEntry !== undefined && valueAt(RETRY_ENABLED_PATH, retryEntry.value) === false;
	const triggerValue = valueAt(FALLBACK_ON_PATH, onEntry?.value ?? onEntry?.default);
	const trigger: FallbackTrigger | null = isFallbackTrigger(triggerValue) ? triggerValue : null;
	const triggerSource = otherLayer((saved[FALLBACK_ON_PATH] ?? onEntry?.provenance)?.layers);
	const revertNever = valueAt(FALLBACK_REVERT_PATH, undefined) === "never";
	const busy = saving || !sidecarReady;

	const roleName = (id: string) => {
		const entry = roles.find(role => role.id === id);
		return entry ? modelRoleName(lang, entry.name) : id;
	};
	const modelName = (selector: string) =>
		compactModelText(labels.get(selector) ?? compactModelLabel(modelRefOf(selector)));
	const providerName = (id: string) =>
		shortProviderName(providers.find(provider => provider.id === id) ?? { id, name: id });
	const keyText = (key: string): string => {
		const kind = selectorKind(key);
		switch (kind.kind) {
			case "model":
				return modelName(key);
			case "provider":
				return t("fallback.key.provider", { provider: providerName(kind.provider) });
			case "default":
				return t("fallback.key.default");
			case "role":
				return roles.some(role => role.id === kind.role)
					? t("fallback.key.role", { role: roleName(kind.role) })
					: key;
			case "verbatim":
				return key;
		}
	};
	const entryText = (entry: string): string => {
		const kind = selectorKind(entry);
		if (kind.kind === "model") return modelName(entry);
		if (kind.kind === "provider") return t("fallback.entry.sameModel", { provider: providerName(kind.provider) });
		return entry;
	};
	const providerOf = (selector: string) => {
		const kind = selectorKind(selector);
		return kind.kind === "model" || kind.kind === "provider" ? kind.provider : undefined;
	};
	/** What is wrong with an entry, judged against the catalog this window last read (nothing until it has one). */
	const entryProblem = (entry: string): string | null => {
		const kind = selectorKind(entry);
		if (providers.length === 0 || (kind.kind !== "model" && kind.kind !== "provider")) return null;
		const provider = providers.find(candidate => candidate.id === kind.provider);
		if (!provider) return t("fallback.entry.missing");
		if (provider.disabled) return t("modelRoles.account.off");
		if (!provider.authenticated) return t("modelRoles.account.signedOut");
		if (kind.kind === "model" && !models.some(model => model.provider === kind.provider && model.id === kind.id)) {
			return t("fallback.entry.missing");
		}
		return null;
	};

	const context: ChainContext = {
		chains,
		roleModels: Object.fromEntries(
			roles.flatMap(role => (role.model && role.effective?.model ? [[role.id, role.effective.model]] : [])),
		),
		kindRoles: new Set(roles.filter(role => role.section === "kind").map(role => role.id)),
		isProvider: id => providers.some(provider => provider.id === id),
	};
	const winners = new Map(used.map(model => [model.selector, chainKeyFor(context, model.selector, model.roles[0])]));
	const usedText = (model: UsedModel) => `${modelName(model.selector)} (${model.roles.map(roleName).join(", ")})`;

	/** Writes `value` to `path`; false (and a warning) when a higher layer keeps another value in force. */
	const commit = async (
		path: string,
		value: unknown,
		landed: (effective: unknown) => boolean,
		what: string,
	): Promise<boolean> => {
		setSaving(true);
		try {
			const res = await tabRpc.setSetting(path, value);
			if (!res.success) {
				toastError({ title: t("settings.saveFailed"), error: res });
				return false;
			}
			const data = setResultSchema.safeParse(res.data);
			if (!data.success) throw new Error(t("settings.savedUnverified"));
			onCommitted(path, data.data.value);
			const next = data.data.provenance;
			if (next) setSaved(previous => ({ ...previous, [path]: next }));
			if (!landed(data.data.value)) {
				toast({ variant: "warning", message: t("fallback.overridden", { row: what }) });
				return false;
			}
			return true;
		} catch (error) {
			toastError({ title: t("settings.saveFailed"), error });
			return false;
		} finally {
			setSaving(false);
		}
	};
	const writeChains = (next: Record<string, unknown>, key: string) =>
		commit(
			FALLBACK_CHAINS_PATH,
			serializeChains(next),
			effective => sameJson(asChainRecord(effective)[key], next[key]),
			keyText(key),
		);
	const setChain = async (key: string, chain: readonly string[]) => {
		if (await writeChains(withChain(globalLayer, key, chain), key))
			setDraft(pending => (pending === key ? null : pending));
	};
	const removeRow = (key: string) => {
		if (!Object.hasOwn(chains, key)) setDraft(null);
		else void writeChains(withoutChain(globalLayer, key), key);
	};

	const rows = chainRows(chains);
	if (draft && !Object.hasOwn(chains, draft)) rows.push({ key: draft, chain: [] });
	const rowKeys = new Set(rows.map(row => row.key));

	/** The roles' models first (named by their roles), then every service group not yet a row (`services`), then the signed-in catalog. */
	const pickerGroups = (exclude: ReadonlySet<string>, services: boolean): ModelValueGroup[] => {
		const roleOptions = used
			.filter(model => !exclude.has(model.selector))
			.map(model => ({
				value: model.selector,
				label: modelName(model.selector),
				provider: providerOf(model.selector),
				fullName: models.find(candidate => `${candidate.provider}/${candidate.id}` === model.selector)?.name,
				suffix: model.roles.map(roleName).join(" · "),
			}));
		const serviceOptions = services
			? providers
					.filter(provider => provider.authenticated && !provider.disabled && !exclude.has(`${provider.id}/*`))
					.map(provider => ({
						value: `${provider.id}/*`,
						label: t("fallback.key.provider", { provider: shortProviderName(provider) }),
						provider: provider.id,
					}))
			: [];
		const listed = new Set([...exclude, ...used.map(model => model.selector)]);
		return [
			...(roleOptions.length > 0 ? [{ label: t("fallback.add.roles"), options: roleOptions }] : []),
			...(serviceOptions.length > 0 ? [{ label: t("fallback.add.services"), options: serviceOptions }] : []),
			...modelValueGroups(models, providers, labels)
				.map(group => ({ ...group, options: group.options.filter(option => !listed.has(option.value)) }))
				.filter(group => group.options.length > 0),
		];
	};

	const triggerCards = FALLBACK_TRIGGERS.map(value => ({
		value,
		title: t(`fallback.trigger.${value}`),
		hint: t(`fallback.trigger.${value}.hint`),
	}));

	return (
		<SettingsSection
			actions={
				switchEntry ? (
					<Switch
						checked={enabled}
						data-fallback-switch=""
						disabled={busy}
						label={t("fallback.switch")}
						onCheckedChange={next =>
							void commit(MODEL_FALLBACK_PATH, next, effective => effective === next, t("fallback.switch"))
						}
					/>
				) : undefined
			}
			description={`${t("fallback.desc")} ${t(revertNever ? "fallback.revert.never" : "fallback.revert.cooldown")}`}
			id="settings-models-fallback"
			title={t("fallback.title")}
		>
			{!enabled ? (
				<InlineNotice
					action={
						<Button
							data-fallback-turn-on=""
							disabled={busy}
							onClick={() =>
								void commit(MODEL_FALLBACK_PATH, true, effective => effective === true, t("fallback.switch"))
							}
							size="sm"
							variant="secondary"
						>
							{t("fallback.turnOn")}
						</Button>
					}
					title={t("fallback.off")}
					tone="info"
				/>
			) : (
				<>
					{retriesOff && (
						<InlineNotice
							action={
								<Button
									data-fallback-retry-on=""
									disabled={busy}
									onClick={() =>
										void commit(
											RETRY_ENABLED_PATH,
											true,
											effective => effective === true,
											t("fallback.retryOn"),
										)
									}
									size="sm"
									variant="secondary"
								>
									{t("fallback.retryOn")}
								</Button>
							}
							title={t("fallback.retryOff")}
							tone="warning"
						/>
					)}
					{onEntry && (
						<SettingsRow id="fallback-trigger" label={t("fallback.trigger")}>
							<ChoiceCards
								aria-label={t("fallback.trigger")}
								className="grid-cols-1 @2xl:grid-cols-3"
								disabled={busy}
								onChange={next =>
									void commit(FALLBACK_ON_PATH, next, effective => effective === next, t("fallback.trigger"))
								}
								optionAttr="data-fallback-trigger"
								options={triggerCards}
								value={trigger}
							/>
							<p className="mt-1 text-sc-xs break-keep text-(--sc-text-muted)">
								{t("fallback.trigger.noCredential")}
								{triggerSource &&
									` ${t("fallback.otherLayer", { source: t(`settings.source.${triggerSource}`) })}`}
							</p>
						</SettingsRow>
					)}
					<div className="divide-y divide-(--sc-divider)" data-fallback-rows="">
						{rows.map(({ key, chain }) => {
							const kind = selectorKind(key);
							const isDraft = !Object.hasOwn(chains, key);
							const editable =
								isDraft || (Object.hasOwn(globalLayer, key) && sameJson(globalLayer[key], chains[key]));
							const source = editable ? undefined : (otherLayer(provenance?.layers) ?? "project");
							const label = keyText(key);
							const applies = used.filter(model => winners.get(model.selector) === key);
							const follows =
								kind.kind === "provider" || kind.kind === "role"
									? used.filter(model => {
											const winner = winners.get(model.selector);
											return (
												winner && winner !== key && keyCovers(context, key, model.selector, model.roles[0])
											);
										})
									: [];
							const provider = providerOf(key);
							const own = new Set([key, ...(chain ?? [])]);
							return (
								<div data-fallback-row={key} key={key}>
									<SettingsRow
										compactControl
										control={
											(editable || chain === null) && (
												<IconButton
													disabled={busy}
													icon={<Trash2 />}
													label={t("fallback.removeRow", { row: label })}
													onClick={() => removeRow(key)}
													size="sm"
												/>
											)
										}
										description={kind.kind === "default" ? t("fallback.key.default.tip") : undefined}
										icon={
											provider ? <ProviderMark provider={{ id: provider, name: provider }} /> : <Shuffle />
										}
										id={`fallback-row-${key}`}
										label={
											kind.kind === "verbatim" ? (
												<span className="font-mono text-sc-sm" title={key}>
													{key}
												</span>
											) : (
												<span title={key}>{label}</span>
											)
										}
									>
										{chain === null ? (
											<p className="text-sc-xs text-(--sc-danger)">{t("fallback.unreadable")}</p>
										) : (
											<>
												{chain.length > 0 && (
													<ol
														aria-label={t("fallback.chain", { row: label })}
														className="flex flex-col gap-0.5"
														data-fallback-chain=""
													>
														{chain.map((entry, index) => {
															const text = entryText(entry);
															const problem = entryProblem(entry);
															const entryProvider = providerOf(entry);
															return (
																<li
																	className="flex min-h-(--sc-control-sm) min-w-0 items-center gap-2"
																	data-fallback-entry={entry}
																	key={`${index}:${entry}`}
																>
																	<span
																		aria-label={t("fallback.position", { n: index + 1 })}
																		className="w-4 shrink-0 text-right text-sc-xs tabular-nums text-(--sc-text-muted)"
																	>
																		{index + 1}
																	</span>
																	{entryProvider && (
																		<ProviderMark
																			className="size-4 shrink-0"
																			provider={{ id: entryProvider, name: entryProvider }}
																		/>
																	)}
																	<span
																		className={
																			selectorKind(entry).kind === "verbatim"
																				? "min-w-0 truncate font-mono text-sc-sm"
																				: "min-w-0 truncate text-sc-sm text-(--sc-text)"
																		}
																		title={entry}
																	>
																		{text}
																	</span>
																	{problem && (
																		<Badge data-fallback-problem="" dot size="xs" variant="warning">
																			{problem}
																		</Badge>
																	)}
																	{editable && (
																		<span
																			className="ml-auto flex shrink-0 items-center gap-1"
																			data-fallback-actions=""
																		>
																			<IconButton
																				disabled={busy || index === 0}
																				icon={<ArrowUp />}
																				label={t("fallback.moveUp", { model: text })}
																				onClick={() =>
																					void setChain(key, moveEntry(chain, index, -1))
																				}
																				size="sm"
																			/>
																			<IconButton
																				disabled={busy || index === chain.length - 1}
																				icon={<ArrowDown />}
																				label={t("fallback.moveDown", { model: text })}
																				onClick={() =>
																					void setChain(key, moveEntry(chain, index, 1))
																				}
																				size="sm"
																			/>
																			<IconButton
																				disabled={busy}
																				icon={<X />}
																				label={t("fallback.removeEntry", { model: text })}
																				onClick={() =>
																					void setChain(key, removeEntry(chain, index))
																				}
																				size="sm"
																			/>
																		</span>
																	)}
																</li>
															);
														})}
													</ol>
												)}
												{chain.length === 0 && (
													<p className="text-sc-xs text-(--sc-text-muted)">
														{t(isDraft ? "fallback.draft" : "fallback.noEntries")}
													</p>
												)}
												{editable && (
													<div className="mt-1 w-full max-w-xs" data-fallback-add-entry="">
														<ModelValueSelect
															ariaLabel={t("fallback.addEntryFor", { row: label })}
															clearable={false}
															disabled={busy}
															groups={pickerGroups(own, false)}
															onCommit={next => {
																if (next) void setChain(key, [...chain, next]);
															}}
															placeholder={t("fallback.addEntry")}
															value=""
														/>
													</div>
												)}
											</>
										)}
										{(applies.length > 0 || follows.length > 0 || source) && (
											<div className="mt-1 space-y-0.5 text-sc-xs break-keep text-(--sc-text-muted)">
												{applies.length > 0 && (
													<p data-fallback-applies="">
														{t("fallback.appliesTo", { models: applies.map(usedText).join(", ") })}
													</p>
												)}
												{follows.map(model => {
													const winner = winners.get(model.selector) ?? "";
													return (
														<p data-fallback-follows={model.selector} key={model.selector}>
															{winner === model.selector
																? t("fallback.followsOwn", { model: modelName(model.selector) })
																: t("fallback.follows", {
																		model: modelName(model.selector),
																		row: keyText(winner),
																	})}
														</p>
													);
												})}
												{source && (
													<p data-fallback-source={source}>
														{t("fallback.otherLayer", { source: t(`settings.source.${source}`) })}
													</p>
												)}
											</div>
										)}
									</SettingsRow>
								</div>
							);
						})}
						{rows.length === 0 && <EmptyState icon={<Shuffle />} size="row" title={t("fallback.empty")} />}
					</div>
					<SettingsRow
						control={
							<ModelValueSelect
								ariaLabel={t("fallback.addRow")}
								clearable={false}
								disabled={busy}
								groups={pickerGroups(rowKeys, true)}
								onCommit={next => {
									if (next) setDraft(next);
								}}
								placeholder={t("fallback.addRowPlaceholder")}
								value=""
							/>
						}
						id="fallback-add-row"
						label={t("fallback.addRow")}
					/>
				</>
			)}
		</SettingsSection>
	);
}
