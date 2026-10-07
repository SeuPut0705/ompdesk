import { app } from "electron";
import Store from "electron-store";
import { isUiLanguage, type UiLanguage, uiLanguageFromLocale } from "../shared/ui-language";
import type { OmpFailure } from "./omp-runtime";

export type MainLanguage = UiLanguage;

export type MainTextKey =
	| "dialog.openProject"
	| "menu.about"
	| "menu.addToDictionary"
	| "menu.closeTab"
	| "menu.closeWindow"
	| "menu.commandCenter"
	| "menu.capabilities"
	| "menu.importSession"
	| "menu.branchPicker"
	| "menu.sessionTree"
	| "menu.modelPicker"
	| "menu.usage"
	| "menu.workspaceChanges"
	| "menu.restartCore"
	| "menu.contextReport"
	| "menu.debugConsole"
	| "crash.body"
	| "crash.close"
	| "crash.title"
	| "menu.documentation"
	| "menu.edit"
	| "menu.exportHtml"
	| "menu.file"
	| "menu.handoff"
	| "menu.help"
	| "menu.hotkeys"
	| "menu.jobs"
	| "menu.agentHub"
	| "menu.extensions"
	| "menu.inventory"
	| "menu.modes"
	| "menu.modelRoles"
	| "menu.newChatTab"
	| "menu.newSession"
	| "menu.newTab"
	| "menu.newWindow"
	| "menu.openProject"
	| "menu.prCenter"
	| "menu.providers"
	| "menu.reportIssue"
	| "menu.session"
	| "menu.sessionInfo"
	| "menu.shareSession"
	| "menu.settings"
	| "menu.stats"
	| "menu.togglePanel"
	| "menu.toggleSidebar"
	| "menu.tools"
	| "menu.view"
	| "menu.window"
	| "menu.workspaceDirs"
	| "omp.cannotRun"
	| "omp.notFound"
	| "omp.overrideMissing"
	| "omp.tooOld"
	| "quit.keepWorking"
	| "quit.quitAnyway"
	| "quit.workingBody"
	| "quit.workingTitle"
	| "restart.body"
	| "restart.later"
	| "restart.now"
	| "restart.title"
	| "stats.notReady"
	| "stats.notRunning"
	| "updates.checkFailed"
	| "updates.downloadFailed"
	| "updates.failed"
	| "updates.hashMismatch"
	| "updates.installerMissing"
	| "updates.noResult"
	| "updates.openInstallerFailed"
	| "updates.unsupportedArchitecture";

const TEXT: Record<MainTextKey, Record<MainLanguage, string>> = {
	"dialog.openProject": { en: "Open project", zh: "打开项目", ko: "프로젝트 열기" },
	"menu.about": { en: "About ompdesk", zh: "关于 ompdesk", ko: "ompdesk 정보" },
	"menu.addToDictionary": { en: "Add to dictionary", zh: "添加到词典", ko: "사전에 추가" },
	"menu.closeTab": { en: "Close Tab", zh: "关闭标签页", ko: "탭 닫기" },
	"menu.closeWindow": { en: "Close Window", zh: "关闭窗口", ko: "창 닫기" },
	"menu.commandCenter": { en: "Command Palette", zh: "命令面板", ko: "명령 팔레트" },
	"menu.capabilities": { en: "Features", zh: "功能", ko: "기능" },
	"menu.importSession": { en: "Import Session", zh: "导入会话", ko: "세션 가져오기" },
	"menu.branchPicker": { en: "Branch from Message", zh: "从消息分支", ko: "메시지에서 분기" },
	"menu.sessionTree": { en: "Session Tree", zh: "会话树", ko: "세션 트리" },
	"menu.modelPicker": { en: "Select Model", zh: "选择模型", ko: "모델 선택" },
	"menu.usage": { en: "Usage", zh: "用量", ko: "사용량" },
	"menu.workspaceChanges": { en: "Git Changes", zh: "Git 变更", ko: "Git 변경 사항" },
	"menu.restartCore": { en: "Restart omp", zh: "重启 omp", ko: "omp 재시작" },
	"menu.contextReport": { en: "Context Report", zh: "上下文报告", ko: "컨텍스트 보고서" },
	"menu.debugConsole": { en: "Debug Console", zh: "调试控制台", ko: "디버그 콘솔" },
	"menu.documentation": { en: "Documentation", zh: "文档", ko: "문서" },
	"menu.edit": { en: "Edit", zh: "编辑", ko: "편집" },
	"menu.exportHtml": { en: "Export HTML", zh: "导出 HTML", ko: "HTML 내보내기" },
	"menu.file": { en: "File", zh: "文件", ko: "파일" },
	"menu.handoff": { en: "Handoff", zh: "交接", ko: "핸드오프" },
	"menu.help": { en: "Help", zh: "帮助", ko: "도움말" },
	"menu.hotkeys": { en: "Keyboard Shortcuts", zh: "键盘快捷键", ko: "키보드 단축키" },
	"menu.jobs": { en: "Background Jobs", zh: "后台任务", ko: "백그라운드 실행" },
	"menu.agentHub": { en: "Agent Definitions", zh: "代理定义", ko: "에이전트 정의" },
	"menu.extensions": { en: "Extensions", zh: "扩展", ko: "확장" },
	"menu.inventory": { en: "Plugins & Resources", zh: "插件与资源", ko: "플러그인 및 리소스" },
	"menu.modes": { en: "Modes", zh: "模式", ko: "모드" },
	"menu.modelRoles": { en: "Model Roles", zh: "模型角色", ko: "모델 역할" },
	"crash.body": {
		en: "This window's renderer has crashed repeatedly and cannot recover on its own. The failure was written to the runtime log ({logPath}) — restarting may help, and reporting the log via Help → Report an Issue helps us fix it.",
		zh: "窗口渲染进程反复崩溃且无法自行恢复。故障已写入运行日志({logPath})——重启可能有用,也可以通过「帮助 → 反馈问题」把日志提交给我们。",
		ko: "이 창의 렌더러가 반복해서 충돌해 스스로 복구할 수 없어요. 실패 내용은 런타임 로그({logPath})에 기록했어요. 재시작하면 해결될 수 있고, 도움말 → 문제 신고로 로그를 보내 주시면 수정에 도움이 돼요.",
	},
	"crash.close": { en: "Close", zh: "关闭", ko: "닫기" },
	"crash.title": { en: "ompdesk window crashed", zh: "ompdesk 窗口崩溃", ko: "ompdesk 창이 충돌했어요" },
	"menu.newChatTab": { en: "New Chat Tab", zh: "新建聊天标签页", ko: "새 채팅 탭" },
	"menu.newSession": { en: "New Session", zh: "新建会话", ko: "새 세션" },
	"menu.newTab": { en: "New Tab", zh: "新建标签页", ko: "새 탭" },
	"menu.newWindow": { en: "New Window", zh: "新建窗口", ko: "새 창" },
	"menu.openProject": { en: "Open Project…", zh: "打开项目…", ko: "프로젝트 열기…" },
	"menu.prCenter": { en: "Pull Requests", zh: "拉取请求", ko: "풀 리퀘스트" },
	"menu.providers": { en: "Models & Providers", zh: "模型与提供商", ko: "모델 및 프로바이더" },
	"menu.reportIssue": { en: "Report an Issue…", zh: "反馈问题…", ko: "문제 신고…" },
	"menu.session": { en: "Session", zh: "会话", ko: "세션" },
	"menu.sessionInfo": { en: "Session Info", zh: "会话信息", ko: "세션 정보" },
	"menu.shareSession": { en: "Share Session", zh: "分享会话", ko: "세션 공유" },
	"menu.settings": { en: "Settings…", zh: "设置…", ko: "설정…" },
	"menu.stats": { en: "Stats (All Sessions)", zh: "统计（所有会话）", ko: "통계 (모든 세션)" },
	"menu.togglePanel": { en: "Toggle Side Panel", zh: "显示或隐藏侧边面板", ko: "사이드 패널 표시/숨기기" },
	"menu.toggleSidebar": { en: "Toggle Sidebar", zh: "显示或隐藏侧边栏", ko: "사이드바 표시/숨기기" },
	"menu.tools": { en: "Tools", zh: "工具", ko: "도구" },
	"menu.view": { en: "View", zh: "视图", ko: "보기" },
	"menu.window": { en: "Window", zh: "窗口", ko: "창" },
	"menu.workspaceDirs": { en: "Project Folders", zh: "项目文件夹", ko: "프로젝트 폴더" },
	"omp.cannotRun": {
		en: "omp at {bin} could not run ({detail}). Reinstall it with `bun install -g @oh-my-pi/pi-coding-agent`, then press Restart.",
		zh: "无法运行 {bin} 处的 omp（{detail}）。请用 `bun install -g @oh-my-pi/pi-coding-agent` 重新安装，然后点击重新启动。",
		ko: "{bin}의 omp를 실행할 수 없어요 ({detail}). `bun install -g @oh-my-pi/pi-coding-agent`로 다시 설치한 뒤 다시 시작을 눌러 주세요.",
	},
	"omp.notFound": {
		en: "omp is not installed. Install it in a terminal with `bun install -g @oh-my-pi/pi-coding-agent`, then press Restart.",
		zh: "未安装 omp。请在终端运行 `bun install -g @oh-my-pi/pi-coding-agent` 安装，然后点击重新启动。",
		ko: "omp가 설치되어 있지 않아요. 터미널에서 `bun install -g @oh-my-pi/pi-coding-agent`로 설치한 뒤 다시 시작을 눌러 주세요.",
	},
	"omp.overrideMissing": {
		en: "OMP_GUI_OMP points at a missing file ({path}). Fix or unset it, then press Restart.",
		zh: "OMP_GUI_OMP 指向的文件不存在（{path}）。请修正或删除该变量，然后点击重新启动。",
		ko: "OMP_GUI_OMP가 가리키는 파일이 없어요 ({path}). 값을 고치거나 지운 뒤 다시 시작을 눌러 주세요.",
	},
	"omp.tooOld": {
		en: "omp {version} is too old; this app needs {minimum} or newer. Run `omp update` in a terminal, then press Restart.",
		zh: "omp {version} 版本过旧，此应用需要 {minimum} 或更新版本。请在终端运行 `omp update`，然后点击重新启动。",
		ko: "omp {version}은 너무 오래된 버전이에요. 이 앱은 {minimum} 이상이 필요해요. 터미널에서 `omp update`를 실행한 뒤 다시 시작을 눌러 주세요.",
	},
	"quit.keepWorking": { en: "Keep working", zh: "继续工作", ko: "계속 사용" },
	"quit.quitAnyway": { en: "Quit anyway", zh: "仍要退出", ko: "그래도 종료" },
	"quit.workingBody": {
		en: "{working} of {total} sessions are still working in {windows} window(s). Quitting stops them and their agents.",
		zh: "仍有 {working}/{total} 个会话正在 {windows} 个窗口中工作。退出会中止它们及其代理。",
		ko: "{windows}개 창에서 세션 {total}개 중 {working}개가 아직 실행 중이에요. 종료하면 세션과 에이전트가 모두 중단돼요.",
	},
	"quit.workingTitle": { en: "Sessions are still running", zh: "仍有会话在运行", ko: "아직 실행 중인 세션이 있어요" },
	"restart.body": {
		en: "ompdesk's installed files were replaced while it was running, so this window can no longer load them reliably. {working} of {total} sessions are still working.",
		zh: "ompdesk 运行期间安装文件已被替换，窗口无法可靠地加载它们。仍有 {working}/{total} 个会话正在工作。",
		ko: "ompdesk 실행 중에 설치 파일이 교체되어 이 창에서 더 이상 안정적으로 불러올 수 없어요. 세션 {total}개 중 {working}개가 아직 실행 중이에요.",
	},
	"restart.later": { en: "Later", zh: "稍后再说", ko: "나중에" },
	"restart.now": { en: "Restart now", zh: "立即重启", ko: "지금 재시작" },
	"restart.title": { en: "Restart to finish updating", zh: "重启以完成更新", ko: "업데이트를 마치려면 재시작하세요" },
	// Stats bridge failures that reach the renderer (toasts, the stats page).
	"stats.notReady": {
		en: "The stats server is still starting. Try again in a moment.",
		zh: "统计服务仍在启动中，请稍后再试。",
		ko: "통계 서버가 아직 시작 중이에요. 잠시 후 다시 시도하세요.",
	},
	"stats.notRunning": {
		en: "The stats server isn't running. Restart ompdesk to bring it back.",
		zh: "统计服务未运行。请重启 ompdesk 以恢复。",
		ko: "통계 서버가 실행되고 있지 않아요. ompdesk를 다시 시작하면 복구돼요.",
	},
	"updates.checkFailed": {
		en: "Couldn't check for updates. Check your connection and try again.",
		zh: "无法检查更新。请检查网络连接后重试。",
		ko: "업데이트를 확인하지 못했어요. 연결을 확인하고 다시 시도하세요.",
	},
	"updates.downloadFailed": {
		en: "The installer download failed. Check your connection and try again.",
		zh: "安装程序下载失败。请检查网络连接后重试。",
		ko: "설치 프로그램을 다운로드하지 못했어요. 연결을 확인하고 다시 시도하세요.",
	},
	"updates.hashMismatch": {
		en: "The downloaded installer failed SHA-512 verification and was removed. Try the update again.",
		zh: "下载的安装程序未通过 SHA-512 校验，已被删除。请重新尝试更新。",
		ko: "다운로드한 설치 프로그램이 SHA-512 검증에 실패해 삭제했어요. 업데이트를 다시 시도하세요.",
	},
	"updates.installerMissing": {
		en: "This release does not include the required installer for this Mac.",
		zh: "此版本不包含当前 Mac 所需的安装程序。",
		ko: "이 릴리스에는 이 Mac에 필요한 설치 프로그램이 없어요.",
	},
	"updates.failed": {
		en: "Couldn't finish the update. Try again later.",
		zh: "未能完成更新。请稍后重试。",
		ko: "업데이트를 마치지 못했어요. 잠시 후 다시 시도하세요.",
	},
	"updates.noResult": {
		en: "Couldn't finish the update check. Try again later.",
		zh: "未能完成更新检查。请稍后重试。",
		ko: "업데이트 확인을 마치지 못했어요. 잠시 후 다시 시도하세요.",
	},
	"updates.openInstallerFailed": {
		en: "The installer was downloaded, but macOS could not open it.",
		zh: "安装程序已下载，但 macOS 无法打开。",
		ko: "설치 프로그램을 다운로드했지만 macOS에서 열 수 없어요.",
	},
	"updates.unsupportedArchitecture": {
		en: "This Mac architecture does not have a supported installer.",
		zh: "当前 Mac 架构没有受支持的安装程序。",
		ko: "이 Mac 아키텍처를 지원하는 설치 프로그램이 없어요.",
	},
};

const prefs = new Store<{ language?: MainLanguage }>({ name: "prefs" });

export function getMainLanguage(): MainLanguage {
	const stored = prefs.get("language");
	if (isUiLanguage(stored)) return stored;
	return uiLanguageFromLocale(app.getLocale());
}

export function mainT(
	key: MainTextKey,
	language = getMainLanguage(),
	params?: Record<string, string | number>,
): string {
	if (!params) return TEXT[key][language];
	return TEXT[key][language].replace(/\{(\w+)\}/g, (match, name: string) =>
		name in params ? String(params[name]) : match,
	);
}

/** User-facing text for why the system omp is unusable, in the UI language. */
export function ompFailureText(reason: OmpFailure, language = getMainLanguage()): string {
	switch (reason.kind) {
		case "not-found":
			return mainT("omp.notFound", language);
		case "override-missing":
			return mainT("omp.overrideMissing", language, { path: reason.path });
		case "cannot-run":
			return mainT("omp.cannotRun", language, { bin: reason.bin, detail: reason.detail });
		case "too-old":
			return mainT("omp.tooOld", language, { version: reason.version, minimum: reason.minimum });
	}
}
