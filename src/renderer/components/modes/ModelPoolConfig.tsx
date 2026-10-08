/**
 * The composer Modes popover's "Model pool" tab: pick several models (through
 * the model picker, purpose "pool"), give each a role hint, and switch the pool
 * on for this session. While it is on, the main agent splits each request into
 * subtasks and runs them across the pool in parallel (gui-bridge modes/pool.ts).
 * The pool is stored in the session journal, so it follows the session across
 * tab switches and restarts; presets (prefs) save a set of models for reuse.
 * Each member gets one tiny test request (stores/model-pool-checks.ts) so a
 * model the account can't serve is flagged before a subtask fails on it.
 */
import { AlertTriangle, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { RpcModelPoolMember, RpcModelPoolState } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import {
	EMPTY_MODEL_POOL,
	isPresetRole,
	MAX_POOL_MEMBERS,
	POOL_ROLES,
	removePoolMember,
	setPoolMemberRole,
} from "../../lib/model-pool";
import { useTabRpc } from "../../lib/tab-rpc";
import { type PoolModelCheck, poolCheckKey, useModelPoolChecks } from "../../stores/model-pool-checks";
import { useModelPoolPresets } from "../../stores/model-pool-presets";
import { useFocusedTabDevice } from "../../stores/remote";
import { type SessionStore, useSessionStore } from "../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../stores/session-runtime-context";
import { toastError } from "../../stores/toast";
import { Button, ErrorDetail, IconButton, Input, ListRow, Select, SwitchField } from "../common";

const CUSTOM_ROLE = "custom";

function MemberRow({
	member,
	check,
	disabled,
	onRole,
	onRemove,
	onRecheck,
}: {
	member: RpcModelPoolMember;
	check: PoolModelCheck | undefined;
	disabled: boolean;
	onRole: (role: string) => void;
	onRemove: () => void;
	onRecheck: () => void;
}) {
	const t = useT();
	const preset = isPresetRole(member.role);
	// "Custom" with nothing typed yet is a local state: the bridge stores no empty role.
	const [customDraft, setCustomDraft] = useState<string | null>(preset ? null : member.role);
	const custom = customDraft !== null;
	const commitCustom = () => {
		const role = customDraft?.trim() ?? "";
		if (role && role !== member.role) onRole(role);
	};

	return (
		<li className="flex flex-col gap-1.5 py-2" data-pool-check={check?.status} data-pool-member={member.selector}>
			<div className="flex min-w-0 items-center gap-2">
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="truncate text-sc-md text-(--sc-text)" title={member.name}>
						{member.name}
					</span>
					<span className="truncate font-mono text-sc-xs text-(--sc-text-muted)" title={member.selector}>
						{member.selector}
					</span>
				</span>
				<IconButton
					disabled={disabled}
					icon={<X />}
					label={t("modelPool.remove", { name: member.name })}
					onClick={onRemove}
					size="sm"
				/>
			</div>
			<Select
				aria-label={t("modelPool.roleLabel", { name: member.name })}
				controlSize="sm"
				disabled={disabled}
				onChange={event => {
					const value = event.target.value;
					if (value === CUSTOM_ROLE) {
						setCustomDraft("");
						return;
					}
					setCustomDraft(null);
					onRole(value);
				}}
				options={[
					...POOL_ROLES.map(role => ({ value: role, label: t(`modelPool.role.${role}`) })),
					{ value: CUSTOM_ROLE, label: t("modelPool.role.custom") },
				]}
				value={custom ? CUSTOM_ROLE : member.role}
			/>
			{custom && (
				<Input
					aria-label={t("modelPool.customRoleLabel", { name: member.name })}
					controlSize="sm"
					disabled={disabled}
					maxLength={120}
					onBlur={commitCustom}
					onChange={event => setCustomDraft(event.target.value)}
					onKeyDown={event => {
						if (event.key === "Enter" && !isImeKeyEvent(event)) commitCustom();
					}}
					placeholder={t("modelPool.customRolePlaceholder")}
					value={customDraft ?? ""}
				/>
			)}
			{check?.status === "checking" && (
				<p aria-live="polite" className="text-sc-xs text-(--sc-text-muted)">
					{t("modelPool.check.checking")}
				</p>
			)}
			{check?.status === "failed" && (
				<div className="flex flex-col items-start gap-1">
					<p className="flex items-start gap-1.5 text-sc-xs text-(--sc-warning)">
						<AlertTriangle aria-hidden className="mt-px shrink-0" size={12} />
						<span>{t("modelPool.check.failed")}</span>
					</p>
					<span
						className="line-clamp-2 font-mono text-sc-2xs break-all text-(--sc-text-muted)"
						title={check.error}
					>
						{check.error}
					</span>
					<Button disabled={disabled} onClick={onRecheck} size="sm" variant="ghost">
						{t("modelPool.check.retry")}
					</Button>
				</div>
			)}
		</li>
	);
}

function Presets({
	members,
	disabled,
	onApply,
}: {
	members: RpcModelPoolMember[];
	disabled: boolean;
	onApply: (members: RpcModelPoolMember[]) => void;
}) {
	const t = useT();
	const presets = useModelPoolPresets(s => s.presets);
	const hydrate = useModelPoolPresets(s => s.hydrate);
	const savePreset = useModelPoolPresets(s => s.savePreset);
	const deletePreset = useModelPoolPresets(s => s.deletePreset);
	const [name, setName] = useState("");

	useEffect(() => {
		void hydrate();
	}, [hydrate]);

	const save = () => {
		if (!name.trim() || members.length === 0) return;
		void savePreset(name, members).then(() => setName(""));
	};

	return (
		<section aria-label={t("modelPool.presets")} className="flex flex-col gap-1.5">
			<span className="text-sc-xs font-medium text-(--sc-text-muted)">{t("modelPool.presets")}</span>
			{presets.length > 0 && (
				<div className="-mx-2 flex flex-col">
					{presets.map(preset => (
						<ListRow
							actions={
								<IconButton
									icon={<Trash2 />}
									label={t("modelPool.deletePreset", { name: preset.name })}
									onClick={() => void deletePreset(preset.id)}
									size="sm"
								/>
							}
							description={preset.members.map(member => member.name).join(" · ")}
							disabled={disabled}
							key={preset.id}
							onClick={() => onApply(preset.members)}
							title={preset.name}
							titleText={t("modelPool.applyPreset", { name: preset.name })}
						/>
					))}
				</div>
			)}
			<div className="flex items-center gap-2">
				<Input
					aria-label={t("modelPool.presetName")}
					className="min-w-0 flex-1"
					controlSize="sm"
					maxLength={60}
					onChange={event => setName(event.target.value)}
					onKeyDown={event => {
						if (event.key === "Enter" && !isImeKeyEvent(event)) save();
					}}
					placeholder={t("modelPool.presetNamePlaceholder")}
					value={name}
				/>
				<Button
					disabled={!name.trim() || members.length === 0}
					onClick={save}
					size="sm"
					title={members.length === 0 ? t("modelPool.saveNeedsModels") : undefined}
					variant="secondary"
				>
					{t("modelPool.savePreset")}
				</Button>
			</div>
		</section>
	);
}

export function ModelPoolConfig({ onAddModel }: { onAddModel: () => void }) {
	const t = useT();
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const ready = useSessionStore(s => s.status) === "ready";
	const stored = useSessionStore(s => s.modelPool);
	const pool = stored ?? EMPTY_MODEL_POOL;
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Hydration normally fills the pool; a session opened before the bridge knew pools reads it here.
	useEffect(() => {
		if (!ready || stored !== null) return;
		const session = sessionRuntimeStore<SessionStore>(tabId, "session") ?? useSessionStore;
		let live = true;
		void rpc.getModelPool().then(response => {
			if (live && response.success) session.setState({ modelPool: response.data as RpcModelPoolState });
		});
		return () => {
			live = false;
		};
	}, [ready, stored, rpc, tabId]);

	const checks = useModelPoolChecks(s => s.checks);
	// The check runs where this tab's omp does (a paired host's accounts are its own).
	const device = useFocusedTabDevice();
	const selectorsKey = pool.members.map(member => member.selector).join("\n");
	// A model joining the pool gets its quick check (cached per selector and machine for this app run).
	useEffect(() => {
		if (selectorsKey) useModelPoolChecks.getState().ensure(selectorsKey.split("\n"), device);
	}, [selectorsKey, device]);

	const update = async (next: RpcModelPoolState) => {
		if (pending || !ready) return;
		const session = sessionRuntimeStore<SessionStore>(tabId, "session") ?? useSessionStore;
		const originSession = session.getState().sessionId;
		setPending(true);
		setError(null);
		try {
			const response = await rpc.setModelPool(next);
			if (!response.success) throw new Error(response.error);
			if (session.getState().sessionId === originSession) {
				session.setState({ modelPool: response.data as RpcModelPoolState });
			}
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			setError(message);
			toastError({ title: t("modelPool.updateFailed"), error: message });
		} finally {
			setPending(false);
		}
	};

	const disabled = pending || !ready;
	const notConnected = !ready ? t("modesPanel.notConnected") : undefined;
	const full = pool.members.length >= MAX_POOL_MEMBERS;

	return (
		<div className="flex flex-col gap-3" data-model-pool>
			<SwitchField
				checked={pool.enabled}
				className="-mx-2"
				description={pool.members.length < 2 ? t("modelPool.needsTwo") : t("modelPool.toggleDesc")}
				disabled={disabled || (!pool.enabled && pool.members.length < 2)}
				label={t("modelPool.toggleLabel")}
				onCheckedChange={enabled => void update({ ...pool, enabled })}
				title={notConnected}
			/>
			<section aria-label={t("modelPool.models")} className="flex flex-col">
				<span className="text-sc-xs font-medium text-(--sc-text-muted)">{t("modelPool.models")}</span>
				{pool.members.length === 0 ? (
					<p className="py-2 text-sc-sm text-(--sc-text-muted)">{t("modelPool.empty")}</p>
				) : (
					<ul className="divide-y divide-(--sc-divider)">
						{pool.members.map(member => (
							<MemberRow
								check={checks[poolCheckKey(member.selector, device)]}
								disabled={disabled}
								key={member.selector}
								member={member}
								onRecheck={() => useModelPoolChecks.getState().recheck(member.selector, device)}
								onRemove={() => void update(removePoolMember(pool, member.selector))}
								onRole={role => void update(setPoolMemberRole(pool, member.selector, role))}
							/>
						))}
					</ul>
				)}
				<Button
					className="self-start"
					disabled={disabled || full}
					icon={<Plus />}
					onClick={onAddModel}
					size="sm"
					title={notConnected ?? (full ? t("modelPool.full", { max: MAX_POOL_MEMBERS }) : undefined)}
					variant="secondary"
				>
					{t("modelPool.addModel")}
				</Button>
			</section>
			<Presets
				disabled={disabled}
				members={pool.members}
				onApply={members => void update({ enabled: pool.enabled && members.length >= 2, members })}
			/>
			{error && (
				<div className="text-sc-xs" role="alert">
					<p className="text-(--sc-danger)">{t("modelPool.updateFailed")}</p>
					<ErrorDetail error={error} />
				</div>
			)}
		</div>
	);
}
