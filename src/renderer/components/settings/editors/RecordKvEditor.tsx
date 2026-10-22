/**
 * Key-value row editor for flat `record` settings (string → string|number|
 * boolean), e.g. tools.approval (tool → policy). Replaces the raw-JSON
 * textarea: rows of {key, value} + add/remove. When the value domain is a
 * known small enum (passed via valueOptions), the value cell is a dropdown
 * instead of free text. Commits the whole record on every change.
 */

import { Plus, X } from "lucide-react";
import { Fragment, useState } from "react";
import { useT } from "../../../lib/i18n";
import { Button, IconButton, Input, Select } from "../../common";
import { ModelValueSelect } from "../ModelValueSelect";

type Primitive = string | number | boolean;

export interface RecordKvEditorProps {
	value: Record<string, unknown>;
	onCommit: (value: Record<string, unknown>) => void;
	disabled?: boolean;
	/** When set, the value cell renders a dropdown of these options. */
	valueOptions?: { value: string; label: string }[];
	/** When "model", the value cell renders a searchable model dropdown. */
	valueKind?: "model";
	keyPlaceholder?: string;
	valuePlaceholder?: string;
	/** Render free-text value cells as password inputs (secret env vars / headers). */
	maskValues?: boolean;
}

function toPrimitive(input: string): Primitive {
	if (input === "true") return true;
	if (input === "false") return false;
	const n = Number(input);
	if (input.trim() !== "" && Number.isFinite(n)) return n;
	return input;
}

export function RecordKvEditor({
	value,
	onCommit,
	disabled,
	valueOptions,
	valueKind,
	keyPlaceholder,
	valuePlaceholder,
	maskValues,
}: RecordKvEditorProps) {
	const t = useT();
	const entries = Object.entries(value);
	/** Row whose last rename collided, plus the name that collides with it. */
	const [collision, setCollision] = useState<{ row: string; typed: string } | null>(null);

	const setEntry = (index: number, key: string, val: Primitive) => {
		const next: Record<string, unknown> = {};
		entries.forEach(([k, v], i) => {
			next[i === index ? key : k] = i === index ? val : v;
		});
		onCommit(next);
	};

	const removeEntry = (index: number) => {
		setCollision(null);
		const next: Record<string, unknown> = {};
		entries.forEach(([k, v], i) => {
			if (i !== index) next[k] = v;
		});
		onCommit(next);
	};

	const addEntry = () => {
		// Find a free placeholder key so we never clobber an existing entry.
		let n = entries.length + 1;
		while (`key${n}` in value) n += 1;
		setCollision(null);
		onCommit({ ...value, [`key${n}`]: valueOptions ? valueOptions[0].value : "" });
	};

	return (
		<div className="flex w-full flex-col gap-1">
			{entries.map(([k, v], index) => (
				// Key by the record key (stable), not the index: rows use
				// uncontrolled inputs, so index keys would keep stale DOM values
				// attached to the wrong record entry after a row deletion.
				<Fragment key={k}>
					<div className="flex items-center gap-2">
						<div className="w-[45%] shrink-0">
							<Input
								aria-label={keyPlaceholder ?? t("settings.editors.kvKey")}
								controlSize="sm"
								disabled={disabled}
								onBlur={e => {
									const nk = e.target.value.trim();
									if (!nk || nk === k) return;
									if (entries.some(([other], i) => i !== index && other === nk)) {
										// Writing it would replace that entry's value with
										// this row's — a silent loss, so refuse instead.
										setCollision({ row: k, typed: nk });
										return;
									}
									setCollision(null);
									setEntry(index, nk, v as Primitive);
								}}
								onChange={() => {}}
								defaultValue={k}
								placeholder={keyPlaceholder ?? t("settings.editors.kvKey")}
								aria-invalid={collision?.row === k || undefined}
								className={collision?.row === k ? "border-(--sc-danger) focus:border-(--sc-danger)" : undefined}
								mono
								spellCheck={false}
							/>
						</div>
						{valueKind === "model" ? (
							<div className="min-w-0 flex-1">
								<ModelValueSelect
									disabled={disabled}
									kind="model"
									onCommit={next => setEntry(index, k, next)}
									value={typeof v === "string" ? v : ""}
								/>
							</div>
						) : valueOptions ? (
							<div className="min-w-0 flex-1">
								<Select
									aria-label={valuePlaceholder ?? t("settings.editors.kvValue")}
									controlSize="sm"
									disabled={disabled}
									onChange={e => setEntry(index, k, e.target.value)}
									options={valueOptions}
									value={typeof v === "string" ? v : String(v)}
								/>
							</div>
						) : (
							<div className="min-w-0 flex-1">
								<Input
									aria-label={valuePlaceholder ?? t("settings.editors.kvValue")}
									controlSize="sm"
									defaultValue={typeof v === "string" ? v : String(v)}
									disabled={disabled}
									onBlur={e => {
										const nv = toPrimitive(e.target.value);
										if (nv !== v) setEntry(index, k, nv);
									}}
									onChange={() => {}}
									placeholder={valuePlaceholder ?? t("settings.editors.kvValue")}
									spellCheck={false}
									type={maskValues ? "password" : "text"}
								/>
							</div>
						)}
						{!disabled && (
							<IconButton
								className="shrink-0"
								icon={<X />}
								label={k ? t("settings.editors.kvRemoveFor", { key: k }) : t("settings.editors.kvRemove")}
								onClick={() => removeEntry(index)}
								size="sm"
							/>
						)}
					</div>
					{collision?.row === k && (
						<span className="pl-1 text-sc-xs text-(--sc-danger)" role="alert">
							{t("settings.editors.kvDuplicateKey", { key: collision.typed })}
						</span>
					)}
				</Fragment>
			))}
			{!disabled && (
				<Button className="w-fit" icon={<Plus />} onClick={addEntry} size="sm" variant="ghost">
					{t("settings.editors.kvAdd")}
				</Button>
			)}
		</div>
	);
}
