/**
 * Settings › SSH hosts: saved remote targets (user + project scope) in a
 * master-detail — host list on the left, edit form + connection test on the
 * right. Deleting a hand-typed host is confirmed first.
 */
import { FileKey2, FolderOpen, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RpcSshHostInfo, RpcSshHostInput, RpcSshHostsResult, RpcSshTestResult } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { useFocusedTabDevice } from "../../stores/remote";
import { useSessionStore } from "../../stores/session";
import {
	Badge,
	type BadgeVariant,
	Banner,
	Button,
	ConfirmDialog,
	EmptyState,
	ErrorDetail,
	IconButton,
	Input,
	ListRow,
	Select,
	Spinner,
	SwitchField,
	TextArea,
} from "../common";
import { SettingsSection } from "./SettingsLayout";

interface HostDraft extends RpcSshHostInput {
	name: string;
	scope: "user" | "project";
}

const EMPTY_DRAFT: HostDraft = { name: "", host: "", port: 22, scope: "project", compat: false };

type Health = "healthy" | "failed" | "unknown";

const HEALTH_BADGE: Record<Health, BadgeVariant> = { healthy: "success", failed: "error", unknown: "muted" };

/**
 * One health rule for the list row, the detail header and the reachable count.
 * A host nobody has probed is "unknown", never "healthy" — a freshly added host
 * must not look reachable before it has ever been tested.
 */
function hostHealth(host: RpcSshHostInfo | undefined, result: RpcSshTestResult | undefined): Health {
	if (result?.ok === false) return "failed";
	if (result?.ok === true || host?.os !== undefined) return "healthy";
	return "unknown";
}

function toDraft(host: RpcSshHostInfo): HostDraft {
	return {
		name: host.name,
		host: host.host,
		username: host.username ?? "",
		port: host.port ?? 22,
		keyPath: host.keyPath ?? "",
		description: host.description ?? "",
		compat: host.compat ?? false,
		scope: host.scope === "user" ? "user" : "project",
	};
}

function targetText(host: RpcSshHostInfo): string {
	const user = host.username ? `${host.username}@` : "";
	return `${user}${host.host}:${host.port ?? 22}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function SshSection() {
	const tabRpc = useTabRpc();
	const t = useT();
	const sidecarReady = useSessionStore(state => state.status) === "ready";
	// The native file panel sees this device only; a paired host's key path is typed.
	const remote = useFocusedTabDevice() !== undefined;
	const [data, setData] = useState<RpcSshHostsResult>();
	const [selected, setSelected] = useState<RpcSshHostInfo>();
	const selectionRef = useRef<{ name: string; scope: RpcSshHostInfo["scope"] } | undefined>(undefined);
	const [draft, setDraft] = useState<HostDraft>(EMPTY_DRAFT);
	const [creating, setCreating] = useState(false);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [testing, setTesting] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [error, setError] = useState<string>();
	// A failed read is not the same claim as a form-validation refusal: only the
	// first hides the empty state and offers a retry.
	const [loadError, setLoadError] = useState<string>();
	const [tests, setTests] = useState<Record<string, RpcSshTestResult>>({});

	const load = useCallback(
		async (preferred?: { name: string; scope: RpcSshHostInfo["scope"] }) => {
			if (!sidecarReady) {
				setData(undefined);
				setError(undefined);
				setLoadError(t("common.notConnected"));
				setLoading(false);
				return;
			}
			setLoading(true);
			try {
				const response = await tabRpc.getSshHosts();
				if (!response.success) {
					setLoadError(response.error);
					return;
				}
				const next = response.data as RpcSshHostsResult;
				setData(next);
				const wanted = preferred ?? selectionRef.current;
				const match = wanted
					? next.hosts.find(host => host.name === wanted.name && host.scope === wanted.scope)
					: undefined;
				const fallback = match ?? next.hosts[0];
				selectionRef.current = fallback ? { name: fallback.name, scope: fallback.scope } : undefined;
				setSelected(fallback);
				if (fallback) setDraft(toDraft(fallback));
				setError(undefined);
				setLoadError(undefined);
			} catch (cause) {
				setLoadError(errorMessage(cause));
			} finally {
				setLoading(false);
			}
		},
		[sidecarReady, t, tabRpc.getSshHosts],
	);

	useEffect(() => {
		void load();
	}, [load]);

	const reachable = useMemo(
		() => data?.hosts.filter(host => hostHealth(host, tests[host.name]) === "healthy").length ?? 0,
		[data?.hosts, tests],
	);

	const chooseHost = (host: RpcSshHostInfo) => {
		selectionRef.current = { name: host.name, scope: host.scope };
		setSelected(host);
		setDraft(toDraft(host));
		setCreating(false);
		setError(undefined);
	};

	const addHost = () => {
		selectionRef.current = undefined;
		setCreating(true);
		setSelected(undefined);
		setDraft({ ...EMPTY_DRAFT });
		setError(undefined);
	};

	const chooseKey = async () => {
		const paths = await window.omp.system.showOpenDialog([], { directory: false }).catch(() => null);
		if (paths?.[0]) setDraft(current => ({ ...current, keyPath: paths[0] }));
	};

	const save = async () => {
		if (!sidecarReady) return;
		if (!draft.name.trim() || !draft.host.trim()) {
			setError(t("ssh.validation.required"));
			return;
		}
		setSaving(true);
		setError(undefined);
		const host: RpcSshHostInput = {
			host: draft.host.trim(),
			...(draft.username?.trim() ? { username: draft.username.trim() } : {}),
			...(draft.port ? { port: draft.port } : {}),
			...(draft.keyPath?.trim() ? { keyPath: draft.keyPath.trim() } : {}),
			...(draft.description?.trim() ? { description: draft.description.trim() } : {}),
			...(draft.compat ? { compat: true } : {}),
		};
		try {
			const response = await tabRpc.sshManage({
				action: creating ? "create" : "update",
				scope: draft.scope,
				name: draft.name.trim(),
				...(selected ? { previousName: selected.name } : {}),
				...(selected && selected.scope !== "native" ? { previousScope: selected.scope } : {}),
				host,
			});
			if (!response.success) setError(response.error);
			else {
				setCreating(false);
				await load({ name: draft.name.trim(), scope: draft.scope });
			}
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setSaving(false);
		}
	};

	const test = async () => {
		if (!sidecarReady) return;
		if (!draft.name.trim() || !draft.host.trim()) {
			setError(t("ssh.validation.required"));
			return;
		}
		setTesting(true);
		setError(undefined);
		try {
			const response = await tabRpc.sshTest({
				name: draft.name.trim(),
				host: draft.host.trim(),
				...(draft.username?.trim() ? { username: draft.username.trim() } : {}),
				...(draft.port ? { port: draft.port } : {}),
				...(draft.keyPath?.trim() ? { keyPath: draft.keyPath.trim() } : {}),
				...(draft.compat ? { compat: true } : {}),
			});
			if (!response.success) setError(response.error);
			else {
				const result = response.data as RpcSshTestResult;
				setTests(current => ({ ...current, [result.name]: result }));
			}
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setTesting(false);
		}
	};

	const remove = async () => {
		setConfirmDelete(false);
		if (!sidecarReady || !selected?.editable) return;
		setDeleting(true);
		try {
			const response = await tabRpc.sshManage({
				action: "delete",
				scope: selected.scope === "user" ? "user" : "project",
				name: selected.name,
			});
			if (!response.success) setError(response.error);
			else {
				selectionRef.current = undefined;
				setSelected(undefined);
				setCreating(false);
				setDraft({ ...EMPTY_DRAFT });
				await load();
			}
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setDeleting(false);
		}
	};

	const notConnectedTitle = !sidecarReady ? t("common.notConnected") : undefined;
	const detailHealth = hostHealth(selected, tests[draft.name]);
	const testResult = tests[draft.name];
	const hostCount = data?.hosts.length ?? 0;
	// The editor is for a host being added or the selected one; with no hosts the empty state is the
	// whole section and carries the only Add action.
	const editing = creating || selected !== undefined;
	const empty = !loading && !loadError && hostCount === 0;
	const addButton = (
		<Button disabled={!sidecarReady} icon={<Plus />} onClick={addHost} size="sm" title={notConnectedTitle}>
			{t("ssh.add")}
		</Button>
	);
	const emptyState = empty && (
		<EmptyState
			actions={creating ? undefined : addButton}
			description={t("ssh.empty.description")}
			icon={<Server />}
			title={t("ssh.empty.title")}
		/>
	);

	return (
		<SettingsSection actions={empty && !creating ? undefined : addButton}>
			{loading && !data && !loadError ? (
				<div className="flex justify-center py-16">
					<Spinner />
				</div>
			) : (
				<div className="flex flex-col gap-3 py-3">
					{data && (
						// Refresh sits with the status it re-reads, not alone on a row of its own.
						<div className="flex flex-wrap items-center gap-2">
							<Badge dot variant={data.openSshAvailable ? "success" : "error"}>
								{data.openSshAvailable ? t("ssh.ready.available") : t("ssh.ready.missing")}
							</Badge>
							{hostCount > 0 && <Badge>{t("ssh.ready.hosts", { count: hostCount })}</Badge>}
							{hostCount > 0 && <Badge>{t("ssh.ready.reachable", { count: reachable })}</Badge>}
							<IconButton
								className="ms-auto"
								disabled={!sidecarReady || loading}
								icon={<RefreshCw />}
								label={t("common.refresh")}
								onClick={() => void load()}
								size="sm"
							/>
						</div>
					)}

					{loadError && (
						<Banner
							actions={
								<Button
									disabled={!sidecarReady}
									onClick={() => void load()}
									size="sm"
									title={notConnectedTitle}
								>
									{t("common.retry")}
								</Button>
							}
							live
							title={t("ssh.loadFailed")}
							variant="danger"
						>
							<ErrorDetail error={loadError} />
						</Banner>
					)}
					{error && (
						<Banner live title={t("ssh.actionFailed")} variant="danger">
							<ErrorDetail error={error} />
						</Banner>
					)}

					{!editing ? (
						emptyState
					) : (
						<div className="ssh-master-detail overflow-hidden rounded-(--sc-radius-lg) border border-(--sc-border-subtle)">
							<section aria-label={t("ssh.title")} className="ssh-list-pane min-w-0 overflow-y-auto p-1.5">
								{data?.hosts.map(host => {
									const health = hostHealth(host, tests[host.name]);
									return (
										<ListRow
											description={[targetText(host), host.scope, host.os, host.shell]
												.filter(value => value && value !== "unknown")
												.join(" · ")}
											key={`${host.scope}:${host.name}:${host.source}`}
											leading={<Server />}
											meta={
												<Badge dot variant={HEALTH_BADGE[health]}>
													{t(`ssh.health.${health}`)}
												</Badge>
											}
											onClick={() => chooseHost(host)}
											selected={selected?.name === host.name && selected.scope === host.scope}
											title={host.name}
											titleText={host.name}
										/>
									);
								})}
								{emptyState}
							</section>

							<aside className="ssh-detail-pane min-w-0 overflow-y-auto p-4">
								<div className="mb-4 flex items-start gap-2 border-b border-(--sc-divider) pb-3">
									<div className="min-w-0 flex-1">
										<h3 className="truncate text-sc-md font-semibold text-(--sc-text)">
											{creating ? t("ssh.newHost") : draft.name || t("ssh.selectHost")}
										</h3>
										{!creating && selected && (
											<p className="mt-0.5 truncate font-mono text-sc-xs text-(--sc-text-muted)">
												{targetText(selected)}
											</p>
										)}
									</div>
									<Badge dot variant={HEALTH_BADGE[detailHealth]}>
										{testResult?.ok === true ? t("ssh.connected") : t(`ssh.health.${detailHealth}`)}
									</Badge>
								</div>

								<div className="flex flex-col gap-3">
									<Input
										label={t("ssh.form.alias")}
										onChange={event => setDraft(current => ({ ...current, name: event.target.value }))}
										value={draft.name}
									/>
									<Input
										label={t("ssh.form.host")}
										mono
										onChange={event => setDraft(current => ({ ...current, host: event.target.value }))}
										placeholder="build.example.com"
										value={draft.host}
									/>
									<div className="grid grid-cols-[1fr_6rem] gap-2">
										<Input
											label={t("ssh.form.user")}
											onChange={event => setDraft(current => ({ ...current, username: event.target.value }))}
											value={draft.username ?? ""}
										/>
										<Input
											label={t("ssh.form.port")}
											max={65535}
											min={1}
											onChange={event =>
												setDraft(current => ({ ...current, port: Number(event.target.value) || undefined }))
											}
											type="number"
											value={draft.port ?? ""}
										/>
									</div>
									<Select
										label={t("ssh.form.scope")}
										onChange={event =>
											setDraft(current => ({ ...current, scope: event.target.value as "user" | "project" }))
										}
										options={[
											{ value: "project", label: t("ssh.scope.project") },
											{ value: "user", label: t("ssh.scope.user") },
										]}
										value={draft.scope}
									/>
									<Input
										label={t("ssh.form.key")}
										mono
										onChange={event => setDraft(current => ({ ...current, keyPath: event.target.value }))}
										placeholder="~/.ssh/id_ed25519"
										trailing={
											remote ? undefined : (
												<IconButton
													disabled={!sidecarReady}
													icon={<FolderOpen />}
													label={t("ssh.chooseKey")}
													onClick={() => void chooseKey()}
													size="sm"
												/>
											)
										}
										value={draft.keyPath ?? ""}
									/>
									<TextArea
										label={t("ssh.form.description")}
										onChange={event => setDraft(current => ({ ...current, description: event.target.value }))}
										rows={2}
										value={draft.description ?? ""}
									/>
									<SwitchField
										checked={draft.compat === true}
										description={t("ssh.form.compatDesc")}
										label={t("ssh.form.compat")}
										onCheckedChange={compat => setDraft(current => ({ ...current, compat }))}
									/>
								</div>

								<div className="mt-4 flex items-center justify-end gap-2 border-t border-(--sc-divider) pt-3">
									{selected?.editable && !creating && (
										<IconButton
											disabled={!sidecarReady || saving || testing || loading || deleting}
											icon={<Trash2 />}
											label={t("ssh.delete")}
											onClick={() => setConfirmDelete(true)}
											size="sm"
										/>
									)}
									<Button
										disabled={!sidecarReady || saving || deleting || loading}
										icon={<FileKey2 />}
										loading={testing}
										onClick={() => void test()}
										size="sm"
									>
										{t("ssh.test")}
									</Button>
									<Button
										disabled={!sidecarReady || testing || deleting || loading}
										loading={saving}
										onClick={() => void save()}
										size="sm"
										variant="primary"
									>
										{t("ssh.save")}
									</Button>
								</div>

								{testResult && (
									<Banner
										className="mt-3"
										live
										title={testResult.ok ? t("ssh.test.success") : t("ssh.test.failed")}
										variant={testResult.ok ? "success" : "danger"}
									>
										{testResult.ok
											? [testResult.os, testResult.shell, testResult.transferShell]
													.filter(Boolean)
													.join(" · ")
											: testResult.error}
									</Banner>
								)}
							</aside>
						</div>
					)}
				</div>
			)}

			<ConfirmDialog
				busy={deleting}
				message={t("ssh.deleteBody", {
					name: selected?.name ?? "",
					target: selected ? targetText(selected) : "",
				})}
				onCancel={() => setConfirmDelete(false)}
				onConfirm={() => void remove()}
				open={confirmDelete}
				title={t("ssh.deleteTitle", { name: selected?.name ?? "" })}
				warning={t("ssh.deleteWarning")}
			/>
		</SettingsSection>
	);
}
