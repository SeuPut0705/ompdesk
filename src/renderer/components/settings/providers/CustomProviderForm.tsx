/**
 * Add or edit an OpenAI/Anthropic-compatible endpoint stored in the agent's
 * models.yml (window.omp.models IPC). Inline — it replaces the provider list
 * in Settings › Models & providers and the connect step of the first-run
 * setup; it never opens over another overlay. The essentials come first;
 * auth mode, discovery, transport, extra body and headers sit behind
 * "Advanced".
 */

import { ChevronDown, ChevronRight, Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import type {
	CustomProviderApi,
	CustomProviderDiscoveryType,
	CustomProviderInput,
	CustomProviderView,
} from "../../../../shared/ipc-types";
import { CUSTOM_PROVIDER_APIS } from "../../../../shared/ipc-types";
import { errorDetail, type InlineFailure, inlineFailure } from "../../../lib/error-detail";
import { useT } from "../../../lib/i18n";
import { useModelStore } from "../../../stores/model";
import { useFocusedTabDevice } from "../../../stores/remote";
import { toast } from "../../../stores/toast";
import { Banner, Button, ErrorDetail, IconButton, Input, Select, TextArea } from "../../common";
import { FieldError, FieldLabel } from "./FormFields";
import { ModelEditor, type ModelRow } from "./ModelEditor";

/** New providers only contact a model-list endpoint when the user opts in. */
export function defaultProviderDiscovery(): undefined {
	return undefined;
}

/** Manual model rows are optional when the provider can discover them upstream. */
export function providerRequiresManualModels(discoveryType: CustomProviderDiscoveryType | undefined): boolean {
	return discoveryType === undefined;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const DISCOVERY_TYPES: readonly CustomProviderDiscoveryType[] = [
	"ollama",
	"llama.cpp",
	"lm-studio",
	"openai-models-list",
	"proxy",
	"litellm",
];

interface HeaderRow {
	key: number;
	name: string;
	value: string;
}

function dropKey(errors: Record<string, string>, key: string): Record<string, string> {
	if (!(key in errors)) return errors;
	const next = { ...errors };
	delete next[key];
	return next;
}

function isValidHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

const CHECKBOX_CLASS = "size-4 shrink-0 accent-(--sc-accent) disabled:cursor-not-allowed";

export interface CustomProviderFormProps {
	/** null = adding a new provider. */
	editing: CustomProviderView | null;
	/** Already-configured providers (id collision check when adding). */
	existing: readonly CustomProviderView[];
	onSaved: (providerId: string) => void;
	onCancel: () => void;
}

export function CustomProviderForm({ editing, existing, onSaved, onCancel }: CustomProviderFormProps) {
	const t = useT();
	const device = useFocusedTabDevice();
	const refreshProviders = useModelStore(state => state.refreshProviders);
	const nextKey = useRef(1);
	const readonly = editing?.builtin ?? false;

	const [id, setId] = useState(editing?.id ?? "");
	const [api, setApi] = useState<CustomProviderApi>(
		(editing?.api as CustomProviderApi | undefined) ?? CUSTOM_PROVIDER_APIS[0],
	);
	const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? "");
	const [apiKey, setApiKey] = useState("");
	const [clearKey, setClearKey] = useState(false);
	const [showKey, setShowKey] = useState(false);
	const [auth, setAuth] = useState<"apiKey" | "none" | "oauth" | undefined>(editing?.auth);
	const [authHeader, setAuthHeader] = useState(editing?.authHeader ?? false);
	const [discoveryType, setDiscoveryType] = useState<CustomProviderDiscoveryType | undefined>(() =>
		editing ? editing.discovery?.type : defaultProviderDiscovery(),
	);
	const [discoveryTimeout, setDiscoveryTimeout] = useState<number | undefined>(editing?.discovery?.timeoutMs);
	const [disableStrictTools, setDisableStrictTools] = useState(editing?.disableStrictTools ?? false);
	const [transport, setTransport] = useState<"pi-native" | undefined>(editing?.transport);
	const [extraBody, setExtraBody] = useState(() =>
		editing?.extraBody ? JSON.stringify(editing.extraBody, null, 2) : "",
	);
	const [models, setModels] = useState<ModelRow[]>(() =>
		editing?.models.length
			? editing.models.map(model => ({ key: nextKey.current++, ...model }))
			: [{ key: nextKey.current++, id: "", name: "" }],
	);
	const [headers, setHeaders] = useState<HeaderRow[]>(() =>
		Object.entries(editing?.headers ?? {}).map(([name, value]) => ({
			key: nextKey.current++,
			name,
			value: String(value),
		})),
	);
	const [advancedOpen, setAdvancedOpen] = useState(
		() =>
			Object.keys(editing?.headers ?? {}).length > 0 ||
			editing?.auth !== undefined ||
			editing?.authHeader === true ||
			editing?.discovery !== undefined ||
			editing?.disableStrictTools === true ||
			editing?.transport !== undefined ||
			editing?.extraBody !== undefined,
	);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [submitError, setSubmitError] = useState<InlineFailure | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const locked = readonly || submitting;

	const updateModel = (key: number, patch: Partial<Omit<ModelRow, "key">>) => {
		setModels(prev => prev.map(row => (row.key === key ? { ...row, ...patch } : row)));
		setErrors(prev => dropKey(prev, "models"));
	};
	const removeModel = (key: number) =>
		setModels(prev => (prev.length > 1 ? prev.filter(row => row.key !== key) : prev));
	const updateHeader = (key: number, patch: Partial<Omit<HeaderRow, "key">>) => {
		setHeaders(prev => prev.map(row => (row.key === key ? { ...row, ...patch } : row)));
		setErrors(prev => dropKey(prev, "headers"));
	};

	const validate = (): Record<string, string> => {
		const errs: Record<string, string> = {};
		if (!editing) {
			const candidate = id.trim();
			if (!candidate) errs.id = t("providerCfg.form.idRequired");
			else if (!ID_PATTERN.test(candidate)) errs.id = t("providerCfg.form.idSlug");
			else if (existing.some(provider => provider.id === candidate)) errs.id = t("providerCfg.form.idExists");
		}
		const url = baseUrl.trim();
		if (!url) errs.baseUrl = t("providerCfg.form.baseUrlRequired");
		else if (!isValidHttpUrl(url)) errs.baseUrl = t("providerCfg.form.baseUrlInvalid");

		const filled = models.filter(row => row.id.trim().length > 0);
		if (filled.length === 0 && providerRequiresManualModels(discoveryType)) {
			errs.models = t("providerCfg.form.modelsRequired");
		} else if (models.some(row => row.id.trim().length === 0 && (row.name?.trim().length ?? 0) > 0)) {
			errs.models = t("providerCfg.form.modelIdRequired");
		} else {
			const seen = new Set<string>();
			for (const row of filled) {
				const modelId = row.id.trim();
				if (seen.has(modelId)) {
					errs.models = t("providerCfg.form.modelDuplicate", { id: modelId });
					break;
				}
				seen.add(modelId);
			}
		}

		// Cost: if any field is filled, all four are required and finite ≥ 0.
		for (const row of filled) {
			const cost = row.cost;
			if (!cost) continue;
			const fields = [cost.input, cost.output, cost.cacheRead, cost.cacheWrite];
			if (
				fields.some(value => value !== undefined) &&
				!fields.every(value => value !== undefined && Number.isFinite(value) && value >= 0)
			) {
				errs.models = t("providerCfg.form.costAllRequired");
				break;
			}
		}

		const headerSeen = new Set<string>();
		for (const row of headers) {
			const name = row.name.trim();
			if (!name) continue;
			if (headerSeen.has(name)) {
				errs.headers = t("providerCfg.form.headerDuplicate", { name });
				setAdvancedOpen(true);
				break;
			}
			headerSeen.add(name);
		}
		return errs;
	};

	const handleSubmit = async () => {
		const errs = validate();
		setErrors(errs);
		if (Object.keys(errs).length > 0) return;

		let parsedExtraBody: Record<string, unknown> | undefined;
		if (extraBody.trim().length > 0) {
			try {
				parsedExtraBody = JSON.parse(extraBody);
			} catch {
				setErrors({ extraBody: t("providerCfg.form.extraBodyInvalid") });
				setAdvancedOpen(true);
				return;
			}
		}

		const headerEntries = headers.filter(row => row.name.trim().length > 0);
		const input: CustomProviderInput = {
			id: editing ? editing.id : id.trim(),
			api,
			baseUrl: baseUrl.trim(),
			...(apiKey.trim().length > 0 ? { apiKey: apiKey.trim() } : {}),
			...(clearKey ? { clearApiKey: true } : {}),
			...(auth ? { auth } : {}),
			...(authHeader ? { authHeader: true } : {}),
			...(headerEntries.length > 0
				? { headers: Object.fromEntries(headerEntries.map(row => [row.name.trim(), row.value])) }
				: {}),
			...(discoveryType
				? { discovery: { type: discoveryType, ...(discoveryTimeout ? { timeoutMs: discoveryTimeout } : {}) } }
				: {}),
			...(disableStrictTools ? { disableStrictTools: true } : {}),
			...(transport ? { transport } : {}),
			...(parsedExtraBody ? { extraBody: parsedExtraBody } : {}),
			models: models
				.filter(row => row.id.trim().length > 0)
				.map(row => {
					const { key: _key, ...modelInput } = row;
					return {
						...modelInput,
						id: modelInput.id.trim(),
						...(modelInput.name && modelInput.name.trim().length > 0 ? { name: modelInput.name.trim() } : {}),
					};
				}),
		};

		setSubmitting(true);
		setSubmitError(null);
		try {
			await window.omp.models.upsertProvider(input, device);
			try {
				const catalog = await refreshProviders(true);
				const discoveryError = catalog.discoveryStates.find(
					state => state.provider === input.id && state.status === "unavailable",
				);
				if (discoveryError) {
					toast({
						variant: "warning",
						message: t("providerCfg.toast.refreshFailed"),
						detail: errorDetail(discoveryError.error),
					});
				}
			} catch (cause) {
				toast({ variant: "warning", message: t("providerCfg.toast.refreshFailed"), detail: errorDetail(cause) });
			}
			toast({ variant: "success", message: t("providerCfg.toast.saved", { id: input.id }) });
			onSaved(input.id);
		} catch (cause) {
			setSubmitError(inlineFailure(cause, t("providerCfg.toast.saveFailed")));
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<form
			aria-label={editing ? t("providerCfg.title.edit", { id: editing.id }) : t("providerCfg.title.add")}
			className="flex flex-col gap-4"
			noValidate
			onSubmit={event => {
				event.preventDefault();
				void handleSubmit();
			}}
		>
			<div>
				<h3 className="text-sc-xl font-semibold text-(--sc-text)">
					{editing ? t("providerCfg.title.edit", { id: editing.id }) : t("providerCfg.title.add")}
				</h3>
				<p className="mt-1 text-sc-sm text-(--sc-text-muted)">{t("providerCfg.subtitle")}</p>
			</div>

			{readonly && <Banner variant="info">{t("providerCfg.form.builtinReadonly")}</Banner>}

			<div className="grid gap-4 sm:grid-cols-2">
				<Input
					autoFocus={!editing}
					disabled={editing !== null || submitting}
					error={errors.id}
					hint={editing ? undefined : t("providerCfg.form.idHint")}
					label={t("providerCfg.form.id")}
					mono
					onChange={event => {
						setId(event.target.value);
						setErrors(prev => dropKey(prev, "id"));
					}}
					placeholder={t("providerCfg.form.idPlaceholder")}
					value={id}
				/>
				<Select
					disabled={locked}
					hint={t("providerCfg.form.apiHint")}
					label={t("providerCfg.form.api")}
					onChange={event => setApi(event.target.value as CustomProviderApi)}
					options={CUSTOM_PROVIDER_APIS.map(protocol => ({
						value: protocol,
						label: t(`providerCfg.protocol.${protocol}`),
					}))}
					value={api}
				/>
			</div>

			<Input
				disabled={locked}
				error={errors.baseUrl}
				label={t("providerCfg.form.baseUrl")}
				mono
				onChange={event => {
					setBaseUrl(event.target.value);
					setErrors(prev => dropKey(prev, "baseUrl"));
				}}
				placeholder={t("providerCfg.form.baseUrlPlaceholder")}
				value={baseUrl}
			/>

			<div>
				<Input
					autoComplete="off"
					disabled={locked || clearKey}
					hint={
						clearKey
							? t("providerCfg.form.apiKeyRemovingHint")
							: editing?.hasApiKey
								? t("providerCfg.form.apiKeyKeep")
								: t("providerCfg.form.apiKeyOptional")
					}
					label={t("providerCfg.form.apiKey")}
					mono
					onChange={event => {
						setApiKey(event.target.value);
						setClearKey(false);
					}}
					placeholder={
						clearKey
							? t("providerCfg.form.apiKeyRemoving")
							: (editing?.apiKeyPreview ?? t("providerCfg.form.apiKeyPlaceholder"))
					}
					spellCheck={false}
					trailing={
						<IconButton
							disabled={locked || clearKey}
							icon={showKey ? <EyeOff /> : <Eye />}
							label={showKey ? t("providerCfg.form.apiKeyHide") : t("providerCfg.form.apiKeyShow")}
							onClick={() => setShowKey(prev => !prev)}
							size="sm"
						/>
					}
					type={showKey ? "text" : "password"}
					value={apiKey}
				/>
				{/* The field is masked, so a blank submit cannot mean "delete": without
				this the only way to revoke a key is deleting the whole provider. */}
				{editing?.hasApiKey && !readonly && (
					<Button
						className="mt-1"
						disabled={submitting}
						onClick={() => setClearKey(prev => !prev)}
						size="sm"
						variant="ghost"
					>
						{clearKey ? t("providerCfg.form.apiKeyKeepIt") : t("providerCfg.form.apiKeyRemove")}
					</Button>
				)}
			</div>

			<div>
				<FieldLabel>{t("providerCfg.form.models")}</FieldLabel>
				<div className="flex flex-col gap-2">
					{models.map(row => (
						<ModelEditor
							canRemove={models.length > 1}
							disabled={submitting}
							key={row.key}
							model={row}
							onRemove={removeModel}
							onUpdate={updateModel}
							readonly={readonly}
						/>
					))}
				</div>
				{!readonly && (
					<Button
						className="mt-2"
						disabled={submitting}
						icon={<Plus />}
						onClick={() => setModels(prev => [...prev, { key: nextKey.current++, id: "", name: "" }])}
						size="sm"
						variant="ghost"
					>
						{t("providerCfg.form.modelAdd")}
					</Button>
				)}
				<FieldError message={errors.models} />
				{discoveryType && (
					<span className="mt-1.5 block text-sc-sm text-(--sc-text-muted)">
						{t("providerCfg.form.modelsDiscoveryOptional")}
					</span>
				)}
			</div>

			<div className="border-t border-(--sc-divider) pt-3">
				<Button
					aria-expanded={advancedOpen}
					icon={advancedOpen ? <ChevronDown /> : <ChevronRight />}
					onClick={() => setAdvancedOpen(prev => !prev)}
					size="sm"
					variant="ghost"
				>
					{t("providerCfg.form.advanced")}
				</Button>
				{advancedOpen && (
					<div className="mt-3 flex flex-col gap-4">
						<Select
							disabled={locked}
							hint={t("providerCfg.form.authHint")}
							label={t("providerCfg.form.auth")}
							onChange={event =>
								setAuth((event.target.value || undefined) as "apiKey" | "none" | "oauth" | undefined)
							}
							options={[
								{ value: "", label: t("providerCfg.form.authApiKeyDefault") },
								{ value: "apiKey", label: t("providerCfg.form.authApiKey") },
								{ value: "none", label: t("common.none") },
								{ value: "oauth", label: "OAuth" },
							]}
							value={auth ?? ""}
						/>

						<label className="flex items-start gap-2.5">
							<input
								checked={authHeader}
								className={`${CHECKBOX_CLASS} mt-0.5`}
								disabled={locked}
								onChange={event => setAuthHeader(event.target.checked)}
								type="checkbox"
							/>
							<span>
								<span className="block text-sc-md text-(--sc-text)">{t("providerCfg.form.authHeader")}</span>
								<span className="block text-sc-sm text-(--sc-text-muted)">
									{t("providerCfg.form.authHeaderHint")}
								</span>
							</span>
						</label>

						<div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
							<Select
								disabled={locked}
								hint={t("providerCfg.form.discoveryHint")}
								label={t("providerCfg.form.discovery")}
								onChange={event =>
									setDiscoveryType(
										(event.target.value || undefined) as CustomProviderDiscoveryType | undefined,
									)
								}
								options={[
									{ value: "", label: t("providerCfg.form.discoveryNone") },
									...DISCOVERY_TYPES.map(type => ({
										value: type,
										label: t(`providerCfg.discovery.${type}`),
									})),
								]}
								value={discoveryType ?? ""}
							/>
							<Input
								disabled={locked || !discoveryType}
								label={t("providerCfg.form.discoveryTimeout")}
								min={0}
								onChange={event =>
									setDiscoveryTimeout(event.target.value ? Number.parseInt(event.target.value, 10) : undefined)
								}
								type="number"
								value={discoveryTimeout ?? ""}
							/>
						</div>

						<label className="flex items-start gap-2.5">
							<input
								checked={disableStrictTools}
								className={`${CHECKBOX_CLASS} mt-0.5`}
								disabled={locked}
								onChange={event => setDisableStrictTools(event.target.checked)}
								type="checkbox"
							/>
							<span>
								<span className="block text-sc-md text-(--sc-text)">
									{t("providerCfg.form.disableStrictTools")}
								</span>
								<span className="block text-sc-sm text-(--sc-text-muted)">
									{t("providerCfg.form.disableStrictToolsHint")}
								</span>
							</span>
						</label>

						<Select
							disabled={locked}
							hint={t("providerCfg.form.transportHint")}
							label={t("providerCfg.form.transport")}
							onChange={event => setTransport((event.target.value || undefined) as "pi-native" | undefined)}
							options={[
								{ value: "", label: t("common.defaultParenthesized") },
								{ value: "pi-native", label: "pi-native" },
							]}
							value={transport ?? ""}
						/>

						<TextArea
							disabled={locked}
							error={errors.extraBody}
							hint={t("providerCfg.form.extraBodyHint")}
							label={t("providerCfg.form.extraBody")}
							mono
							onChange={event => {
								setExtraBody(event.target.value);
								setErrors(prev => dropKey(prev, "extraBody"));
							}}
							placeholder={t("providerCfg.form.extraBodyPlaceholder")}
							rows={3}
							value={extraBody}
						/>

						<div>
							<FieldLabel>{t("providerCfg.form.headers")}</FieldLabel>
							<div className="flex flex-col gap-2">
								{headers.map(row => (
									<div className="flex items-center gap-2" key={row.key}>
										<div className="min-w-0 flex-1">
											<Input
												aria-label={t("providerCfg.form.headerName")}
												disabled={locked}
												mono
												onChange={event => updateHeader(row.key, { name: event.target.value })}
												placeholder={t("providerCfg.form.headerName")}
												value={row.name}
											/>
										</div>
										<div className="min-w-0 flex-1">
											<Input
												aria-label={t("providerCfg.form.headerValue")}
												disabled={locked}
												mono
												onChange={event => updateHeader(row.key, { value: event.target.value })}
												placeholder={t("providerCfg.form.headerValue")}
												value={row.value}
											/>
										</div>
										<IconButton
											disabled={locked}
											icon={<Trash2 />}
											label={t("providerCfg.form.headerRemove")}
											onClick={() => setHeaders(prev => prev.filter(item => item.key !== row.key))}
											size="sm"
										/>
									</div>
								))}
							</div>
							{!readonly && (
								<Button
									className="mt-2"
									disabled={submitting}
									icon={<Plus />}
									onClick={() =>
										setHeaders(prev => [...prev, { key: nextKey.current++, name: "", value: "" }])
									}
									size="sm"
									variant="ghost"
								>
									{t("providerCfg.form.headerAdd")}
								</Button>
							)}
							<FieldError message={errors.headers} />
						</div>
					</div>
				)}
			</div>

			{submitError && (
				<Banner live title={submitError.message} variant="danger">
					<ErrorDetail error={submitError.cause} />
				</Banner>
			)}

			<div className="flex items-center justify-end gap-2 border-t border-(--sc-divider) pt-4">
				<Button disabled={submitting} onClick={onCancel} variant="ghost">
					{t("providerCfg.form.cancel")}
				</Button>
				{!readonly && (
					<Button loading={submitting} type="submit" variant="primary">
						{editing ? t("providerCfg.form.save") : t("providerCfg.form.add")}
					</Button>
				)}
			</div>
		</form>
	);
}
