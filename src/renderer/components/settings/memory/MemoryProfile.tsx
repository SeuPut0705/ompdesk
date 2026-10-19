/**
 * Memory › Profile: the cross-project profile (how you usually work) that every session starts with, read-only.
 * Editing an entry opens its page in Pages.
 */
import { useMemo } from "react";
import type { AiMemoryProfile, AiMemoryProfileEntry } from "../../../../shared/ai-memory";
import { formatBytes } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useMemoryPageStore } from "../../../stores/memory-page";
import { Badge, Button, SkeletonRows } from "../../common";
import { SettingsRow } from "../SettingsLayout";
import { MutedLine, ReadError } from "./memory-ui";
import { useMemoryRead } from "./use-memory-read";

export function MemoryProfile() {
	const t = useT();
	const read = useMemoryRead<AiMemoryProfile>("profile", () => window.omp.aiMemory.profile());
	const profile = read.data;
	const groups = useMemo(() => {
		const out = new Map<string, AiMemoryProfileEntry[]>();
		for (const entry of profile?.entries ?? []) out.set(entry.category, [...(out.get(entry.category) ?? []), entry]);
		return [...out];
	}, [profile]);

	return (
		<div className="flex flex-col" data-memory-profile>
			<ReadError error={read.error} onRetry={read.refresh} />
			{!profile && !read.error && <SkeletonRows label={t("common.loading")} widths={[70, 55, 62]} />}
			{profile && (
				<SettingsRow
					tipOnly
					description={t("memory.profile.info")}
					id="setting-memory-profile"
					label={t("memory.profile.status")}
				>
					<span className="block text-sc-sm text-(--sc-text-secondary)" data-memory-profile-status>
						{t(profile.enabled && profile.injected ? "memory.profile.on" : "memory.profile.off", {
							count: profile.entries.length,
							size: formatBytes(profile.digestBytes),
						})}
					</span>
				</SettingsRow>
			)}
			{profile && profile.entries.length === 0 && (
				<MutedLine data-memory-empty>{t("memory.profile.empty")}</MutedLine>
			)}
			{groups.map(([category, entries]) => (
				<section data-memory-profile-group={category} key={category}>
					<h4 className="px-1 pt-3 pb-1 text-sc-xs font-semibold text-(--sc-text-muted) uppercase">
						{category || t("memory.profile.general")}
					</h4>
					{entries.map(entry => (
						<div
							className="flex min-w-0 items-center gap-2 border-b border-(--sc-divider) px-1 py-1.5 text-sc-sm"
							data-memory-profile-entry={entry.path}
							key={entry.path}
						>
							<span className="min-w-0 flex-1 truncate" title={entry.statement}>
								{entry.statement}
							</span>
							{entry.appliesTo.map(tag => (
								<Badge key={tag} variant="muted">
									{tag}
								</Badge>
							))}
							{profile?.scope && (
								<Button
									onClick={() => {
										if (profile.scope)
											useMemoryPageStore.getState().openPage({ ...profile.scope, path: entry.path });
									}}
									size="sm"
									variant="ghost"
								>
									{t("memory.profile.edit")}
								</Button>
							)}
						</div>
					))}
				</section>
			))}
		</div>
	);
}
