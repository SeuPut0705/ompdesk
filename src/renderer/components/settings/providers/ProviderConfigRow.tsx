/**
 * Provider configuration row component: displays a single provider entry
 * in the provider list with edit and delete actions.
 */

import { Globe, Pencil, Trash2 } from "lucide-react";
import type { CustomProviderView } from "../../../../shared/ipc-types";
import { Badge, Button } from "../../common";

type TFn = (key: string, params?: Record<string, string | number>) => string;

export function ProviderConfigRow({
	provider,
	onEdit,
	onDelete,
	t,
}: {
	provider: CustomProviderView;
	onEdit?: (provider: CustomProviderView) => void;
	onDelete?: (provider: CustomProviderView) => void;
	t: TFn;
}) {
	return (
		<div className="flex items-center gap-3 rounded-lg border border-(--omp-border-muted) bg-transparent px-3 py-2.5">
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="flex items-center gap-2">
					<span className="truncate text-omp-lg font-medium text-(--omp-text)">{provider.id}</span>
					<Badge variant="info">{provider.api}</Badge>
					{provider.builtin && <Badge variant="muted">{t("providerCfg.list.builtin")}</Badge>}
				</div>
				<div className="flex items-center gap-3 text-omp-sm text-(--omp-dim)">
					{provider.baseUrl && (
						<span className="flex min-w-0 items-center gap-1">
							<Globe size={10} className="shrink-0" />
							<span className="truncate">{provider.baseUrl}</span>
						</span>
					)}
					<span className="shrink-0">{t("providerCfg.list.models", { count: provider.models.length })}</span>
					{provider.hasApiKey && provider.apiKeyPreview ? (
						<span className="shrink-0 font-mono">{provider.apiKeyPreview}</span>
					) : (
						<span className="shrink-0">{t("providerCfg.list.noKey")}</span>
					)}
				</div>
			</div>
			{(onEdit || onDelete) && (
				<div className="flex shrink-0 items-center gap-1.5">
					{onEdit && (
						<Button size="sm" variant="ghost" icon={<Pencil size={12} />} onClick={() => onEdit(provider)}>
							{t("providerCfg.list.edit")}
						</Button>
					)}
					{onDelete && (
						<Button
							size="sm"
							variant="ghost"
							icon={<Trash2 size={12} />}
							aria-label={t("providerCfg.list.delete")}
							onClick={() => onDelete(provider)}
						/>
					)}
				</div>
			)}
		</div>
	);
}
