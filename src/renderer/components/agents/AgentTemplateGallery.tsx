/**
 * Agents › Definitions › template gallery (Sheet md): the curated specialist
 * agents bundled with ompdesk (`shared/agent-templates.ts`). "Customize"
 * opens one prefilled in the agent editor; "Add all" writes every template
 * whose file does not exist yet into the chosen scope — existing files are
 * never replaced.
 */

import { useState } from "react";
import { AGENT_TEMPLATES, type AgentTemplate } from "../../../shared/agent-templates";
import type { AgentFileScope, RpcAgentDefinitionInfo, RpcAgentTemplatesInstallResult } from "../../../shared/rpc-types";
import { useLang, useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { toast, toastError } from "../../stores/toast";
import { Badge, Button, Select, Sheet } from "../common";
import { agentSourceLabel } from "./agent-settings";

export interface AgentTemplateGalleryProps {
	open: boolean;
	definitions: readonly RpcAgentDefinitionInfo[];
	onClose: () => void;
	onCustomize: (template: AgentTemplate, scope: AgentFileScope) => void;
	/** After "Add all" wrote files: refresh discovery. */
	onInstalled: () => void;
}

export function AgentTemplateGallery({
	open,
	definitions,
	onClose,
	onCustomize,
	onInstalled,
}: AgentTemplateGalleryProps) {
	const t = useT();
	const { lang } = useLang();
	const rpc = useTabRpc();
	const [scope, setScope] = useState<AgentFileScope>("user");
	const [installing, setInstalling] = useState(false);
	const byName = new Map(definitions.map(definition => [definition.name, definition]));

	const addAll = async () => {
		setInstalling(true);
		try {
			const response = await rpc.installAgentTemplates(scope);
			if (!response.success) {
				toastError({ title: t("agentStudio.gallery.addFailed"), error: response });
				return;
			}
			const result = response.data as RpcAgentTemplatesInstallResult;
			toast({
				variant: result.installed.length > 0 ? "success" : "info",
				title: t("agentStudio.gallery.added", { count: result.installed.length }),
				message:
					result.skipped.length > 0
						? t("agentStudio.gallery.skipped", { names: result.skipped.join(", ") })
						: result.dir,
			});
			onInstalled();
			onClose();
		} catch (cause) {
			toastError({ title: t("agentStudio.gallery.addFailed"), error: cause });
		} finally {
			setInstalling(false);
		}
	};

	return (
		<Sheet
			description={t("agentStudio.gallery.description")}
			footer={
				<>
					<div className="mr-auto w-44">
						<Select
							aria-label={t("agentStudio.scope.label")}
							onChange={event => setScope(event.target.value as AgentFileScope)}
							options={[
								{ value: "user", label: t("agentStudio.scope.user") },
								{ value: "project", label: t("agentStudio.scope.project") },
							]}
							value={scope}
						/>
					</div>
					<Button loading={installing} onClick={() => void addAll()} variant="primary">
						{t("agentStudio.gallery.addAll", { count: AGENT_TEMPLATES.length })}
					</Button>
				</>
			}
			onClose={onClose}
			open={open}
			size="md"
			title={t("agentStudio.gallery.title")}
		>
			<ul className="-my-1 divide-y divide-(--sc-divider)">
				{AGENT_TEMPLATES.map(template => {
					const existing = byName.get(template.name);
					return (
						<li className="flex items-start gap-3 py-3.5" key={template.name}>
							<div className="min-w-0 flex-1">
								<div className="flex flex-wrap items-center gap-2">
									<h3 className="text-sc-md font-medium text-(--sc-text)">{template.title[lang]}</h3>
									{existing && (
										<Badge variant="success">
											{t("agentStudio.gallery.exists", { source: agentSourceLabel(t, existing.source) })}
										</Badge>
									)}
								</div>
								<p className="mt-0.5 text-sc-sm text-(--sc-text-muted)">{template.summary[lang]}</p>
								<p className="mt-1 text-sc-xs text-(--sc-text-subtle)">
									<span className="font-mono">{template.name}</span>
									{" · "}
									{template.model.join(" → ")}
									{" · "}
									{t(`input.thinking.name.${template.thinkingLevel}`)}
									{" · "}
									{t("agentStudio.gallery.toolCount", { count: template.tools.length })}
								</p>
							</div>
							<Button onClick={() => onCustomize(template, scope)} size="sm" variant="secondary">
								{t("agentStudio.gallery.customize")}
							</Button>
						</li>
					);
				})}
			</ul>
		</Sheet>
	);
}
