import { Monitor } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WebModelsText } from "../../../shared/web-host";
import { Button } from "../../components/common/Button";
import { Sheet } from "../../components/common/Sheet";
import { Spinner } from "../../components/common/Spinner";
import { TextEditor } from "../../components/common/TextEditor";
import { useT } from "../../lib/i18n";
import { toast } from "../../stores/toast";
import { hostActionError } from "./errors";
import type { HostPrompt } from "./host-ui-store";

type ModelsPrompt = Extract<HostPrompt, { kind: "models" }>;

/**
 * Settings › "Edit config" on a phone: models.yml as text in an in-app editor. The host checks the text with
 * its models.yml parser and the agent's schema and writes it only when valid (the reason shows under the
 * editor); a file that changed on the computer meanwhile asks for a reload. "Edit on computer" calls the
 * desktop handler that opens the file in the computer's editor.
 */
export function ModelsConfigSheet({ prompt, onSettled }: { prompt: ModelsPrompt; onSettled: () => void }) {
	const t = useT();
	const [file, setFile] = useState<WebModelsText | null>(null);
	const [revision, setRevision] = useState(0);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [changed, setChanged] = useState(false);
	const text = useRef("");
	const stamp = useRef("");
	const path = useRef("");

	// `revision` re-reads the file after "Reload".
	// biome-ignore lint/correctness/useExhaustiveDependencies: revision is the reload trigger.
	useEffect(() => {
		let current = true;
		setFile(null);
		prompt.host
			.modelsConfigRead()
			.then(next => {
				if (!current) return;
				text.current = next.text;
				stamp.current = next.stamp;
				path.current = next.path;
				setFile(next);
				setChanged(false);
				setError(null);
			})
			.catch((cause: unknown) => {
				if (current) setLoadError(hostActionError(cause));
			});
		return () => {
			current = false;
		};
	}, [prompt.host, revision]);

	const close = useCallback(() => {
		prompt.resolve({ path: path.current, opened: false });
		onSettled();
	}, [prompt, onSettled]);

	const save = async () => {
		setSaving(true);
		setError(null);
		try {
			const result = await prompt.host.modelsConfigWrite({ text: text.current, stamp: stamp.current });
			if (result.ok) {
				stamp.current = result.stamp;
				toast({ variant: "success", message: t("hostUi.models.saved") });
				prompt.resolve({ path: path.current, opened: true });
				onSettled();
				return;
			}
			if (/changed on disk/.test(result.error)) setChanged(true);
			setError(result.error);
		} catch (cause) {
			setError(hostActionError(cause));
		}
		setSaving(false);
	};

	const onComputer = async () => {
		try {
			const opened = await prompt.host.openModelsConfigOnComputer();
			prompt.resolve(opened);
			onSettled();
		} catch (cause) {
			setError(hostActionError(cause));
		}
	};

	return (
		<Sheet
			bodyClassName="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3"
			description={t("hostUi.models.description")}
			footer={
				<>
					<Button icon={<Monitor />} onClick={() => void onComputer()} variant="secondary">
						{t("hostUi.models.onComputer")}
					</Button>
					<Button disabled={!file || changed} loading={saving} onClick={() => void save()} variant="primary">
						{t("hostUi.models.save")}
					</Button>
				</>
			}
			onClose={close}
			open
			placement="full"
			title={t("hostUi.models.title")}
		>
			<div className="flex min-h-0 flex-1 flex-col gap-2" data-host-sheet="models">
				{loadError ? (
					<p className="text-sc-sm text-(--sc-danger)" data-host-sheet-error="" role="alert">
						{t("hostUi.models.readFailed", { error: loadError })}
					</p>
				) : !file ? (
					<div className="flex items-center gap-2 text-sc-sm text-(--sc-text-muted)">
						<Spinner size="sm" /> {t("hostUi.models.loading")}
					</div>
				) : (
					<>
						<p className="font-mono text-sc-xs text-(--sc-text-muted)">{file.path}</p>
						{!file.exists && <p className="text-sc-xs text-(--sc-text-muted)">{t("hostUi.models.missing")}</p>}
						<TextEditor
							ariaLabel={t("hostUi.models.label")}
							autoFocus
							className="min-h-0 flex-1"
							key={`${revision}:${file.stamp}`}
							language="text"
							lineNumbers
							onChange={value => {
								text.current = value;
							}}
							onSave={() => void save()}
							value={file.text}
						/>
					</>
				)}
				{error && (
					<p className="text-sc-sm text-(--sc-danger)" data-host-sheet-error="" role="alert">
						{error}
					</p>
				)}
				{changed && (
					<Button onClick={() => setRevision(value => value + 1)} size="sm">
						{t("hostUi.models.reload")}
					</Button>
				)}
			</div>
		</Sheet>
	);
}
