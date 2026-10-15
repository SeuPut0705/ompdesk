import { Bell, CheckCheck, ExternalLink, MailOpen, RefreshCw } from "lucide-react";
import { useState } from "react";
import { cx, formatTimeAgo } from "../../../lib/format";
import { github, useGithubLoad } from "../../../lib/github";
import { useT } from "../../../lib/i18n";
import { AsyncSection, Badge, Button, IconButton, Tabs } from "../../common";
import { type GithubSectionProps, GithubToolbar, useGithubMutation } from "./shared";

/** The signed-in account's notifications on the chosen host (no repository needed). */
export function GithubNotifications({ target, targetKey }: Pick<GithubSectionProps, "target" | "targetKey">) {
	const t = useT();
	const [all, setAll] = useState(false);
	const { busy, run } = useGithubMutation();
	const host = target.host ? { host: target.host } : {};
	const list = useGithubLoad({ ...host, op: "notification_list", all }, `${targetKey}|${all}`);
	const rows = list.data ?? [];
	const unread = rows.filter(row => row.unread).length;
	return (
		<>
			<GithubToolbar>
				<Tabs
					activeId={all ? "all" : "unread"}
					ariaLabel={t("github.notifications.filter")}
					onChange={id => setAll(id === "all")}
					tabs={[
						{ id: "unread", label: t("github.notifications.unread") },
						{ id: "all", label: t("github.notifications.all") },
					]}
					variant="segmented"
				/>
				<Button
					disabled={unread === 0}
					icon={<CheckCheck />}
					loading={busy === "all"}
					onClick={() =>
						void run(
							"all",
							() => github({ ...host, op: "notification_read_all" }),
							t("github.actionFailed"),
							t("github.notifications.allRead"),
						).then(done => done && list.reload())
					}
					size="sm"
					variant="secondary"
				>
					{t("github.notifications.markAllRead")}
				</Button>
				<IconButton
					className="ml-auto"
					icon={<RefreshCw />}
					label={t("common.refresh")}
					loading={list.loading}
					onClick={list.reload}
				/>
			</GithubToolbar>
			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-2 min-[1280px]:px-8">
				<AsyncSection
					emptyLabel={t(all ? "github.notifications.emptyAll" : "github.notifications.empty")}
					empty={rows.length === 0}
					error={list.error}
					hasData={rows.length > 0}
					loading={list.loading && !list.data}
					onRetry={list.reload}
				>
					<ul aria-label={t("github.notifications.list")} className="flex flex-col">
						{rows.map(row => (
							<li
								className="flex items-center gap-3 border-b border-(--sc-divider) px-2 py-2"
								data-github-notification={row.id}
								key={row.id}
							>
								<Bell
									aria-hidden
									className={cx(
										"size-(--sc-icon-sm) shrink-0",
										row.unread ? "text-(--sc-accent)" : "text-(--sc-text-subtle)",
									)}
								/>
								<span className="sr-only">
									{t(row.unread ? "github.notifications.unreadMark" : "github.notifications.readMark")}
								</span>
								<div className="min-w-0 flex-1">
									<div
										className={cx(
											"truncate text-sc-md",
											row.unread ? "text-(--sc-text)" : "text-(--sc-text-muted)",
										)}
									>
										{row.title}
									</div>
									<div className="flex flex-wrap items-center gap-2 text-sc-xs text-(--sc-text-muted)">
										<span className="font-mono">{row.repo}</span>
										<Badge variant="muted">{row.type}</Badge>
										<span>{row.reason.replaceAll("_", " ")}</span>
										<span>{formatTimeAgo(row.updatedAt)}</span>
									</div>
								</div>
								{row.url && (
									<IconButton
										icon={<ExternalLink />}
										label={t("github.openOnGithub")}
										onClick={() => void window.omp.system.openExternal(row.url)}
										size="sm"
									/>
								)}
								{row.unread && (
									<IconButton
										icon={<MailOpen />}
										label={t("github.notifications.markRead")}
										loading={busy === row.id}
										onClick={() =>
											void run(
												row.id,
												() => github({ ...host, op: "notification_read", id: row.id }),
												t("github.actionFailed"),
											).then(done => done && list.reload())
										}
										size="sm"
									/>
								)}
							</li>
						))}
					</ul>
				</AsyncSection>
			</div>
		</>
	);
}
