/** A one-field dialog that asks for a name (new branch, renamed branch, tag, stash message). */
import { useEffect, useId, useRef, useState } from "react";
import { useT } from "../../../lib/i18n";
import { Button, Input, Modal } from "../../common";

export interface NameRequest {
	title: string;
	label: string;
	submitLabel: string;
	initial?: string;
	/** An empty value is allowed (an optional stash message). */
	optional?: boolean;
	onSubmit: (value: string) => void;
}

export function NameDialog({ request, onClose }: { request: NameRequest | null; onClose: () => void }) {
	const t = useT();
	const formId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const [value, setValue] = useState("");
	useEffect(() => {
		if (!request) return;
		setValue(request.initial ?? "");
		requestAnimationFrame(() => {
			inputRef.current?.focus();
			inputRef.current?.select();
		});
	}, [request]);
	const trimmed = value.trim();
	return (
		<Modal
			footer={
				<>
					<Button onClick={onClose} type="button" variant="secondary">
						{t("common.cancel")}
					</Button>
					<Button disabled={!request?.optional && !trimmed} form={formId} type="submit" variant="primary">
						{request?.submitLabel}
					</Button>
				</>
			}
			onClose={onClose}
			open={request !== null}
			size="sm"
			title={request?.title}
		>
			<form
				id={formId}
				onSubmit={event => {
					event.preventDefault();
					if (!request || (!request.optional && !trimmed)) return;
					onClose();
					request.onSubmit(trimmed);
				}}
			>
				<Input
					aria-label={request?.label}
					label={request?.label}
					onChange={event => setValue(event.target.value)}
					ref={inputRef}
					spellCheck={false}
					value={value}
				/>
			</form>
		</Modal>
	);
}
