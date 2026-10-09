import { app } from "electron";
import Store from "electron-store";
import { isUiLanguage, type UiLanguage, uiLanguageFromLocale } from "../shared/ui-language";
import type { OmpFailure } from "./omp-runtime";

export type MainLanguage = UiLanguage;

export type MainTextKey =
	| "dialog.openProject"
	| "menu.about"
	| "menu.checkUpdates"
	| "menu.services"
	| "menu.hide"
	| "menu.hideOthers"
	| "menu.showAll"
	| "menu.quit"
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
	| "remote.offline"
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
	| "updates.releaseInvalid"
	| "updates.unsupportedArchitecture";

const TEXT: Record<MainTextKey, Record<MainLanguage, string>> = {
	"dialog.openProject": { en: "Open project", ko: "프로젝트 열기" },
	"menu.about": { en: "About OMPdesk", ko: "OMPdesk 정보" },
	"menu.checkUpdates": { en: "Check for Updates…", ko: "업데이트 확인…" },
	"menu.services": { en: "Services", ko: "서비스" },
	"menu.hide": { en: "Hide OMPdesk", ko: "OMPdesk 가리기" },
	"menu.hideOthers": { en: "Hide Others", ko: "기타 가리기" },
	"menu.showAll": { en: "Show All", ko: "모두 보기" },
	"menu.quit": { en: "Quit OMPdesk", ko: "OMPdesk 종료" },
	"menu.addToDictionary": { en: "Add to dictionary", ko: "사전에 추가" },
	"menu.closeTab": { en: "Close Tab", ko: "탭 닫기" },
	"menu.closeWindow": { en: "Close Window", ko: "창 닫기" },
	"menu.commandCenter": { en: "Command Palette", ko: "명령 팔레트" },
	"menu.capabilities": { en: "Features", ko: "기능" },
	"menu.importSession": { en: "Import Session", ko: "세션 가져오기" },
	"menu.branchPicker": { en: "Branch from Message", ko: "메시지에서 분기" },
	"menu.sessionTree": { en: "Session Tree", ko: "세션 트리" },
	"menu.modelPicker": { en: "Select Model", ko: "모델 선택" },
	"menu.usage": { en: "Usage", ko: "사용량" },
	"menu.workspaceChanges": { en: "Git Changes", ko: "Git 변경 사항" },
	"menu.restartCore": { en: "Restart omp", ko: "omp 재시작" },
	"menu.contextReport": { en: "Context Report", ko: "컨텍스트 보고서" },
	"menu.debugConsole": { en: "Debug Console", ko: "디버그 콘솔" },
	"menu.documentation": { en: "Documentation", ko: "문서" },
	"menu.edit": { en: "Edit", ko: "편집" },
	"menu.exportHtml": { en: "Export HTML", ko: "HTML 내보내기" },
	"menu.file": { en: "File", ko: "파일" },
	"menu.handoff": { en: "Handoff", ko: "핸드오프" },
	"menu.help": { en: "Help", ko: "도움말" },
	"menu.hotkeys": { en: "Keyboard Shortcuts", ko: "키보드 단축키" },
	"menu.jobs": { en: "Background Jobs", ko: "백그라운드 실행" },
	"menu.agentHub": { en: "Agent Definitions", ko: "에이전트 정의" },
	"menu.extensions": { en: "Extensions", ko: "확장" },
	"menu.inventory": { en: "Plugins & Resources", ko: "플러그인 및 리소스" },
	"menu.modes": { en: "Modes", ko: "모드" },
	"menu.modelRoles": { en: "Model Roles", ko: "모델 역할" },
	"crash.body": {
		en: "This window's renderer has crashed repeatedly and cannot recover on its own. The failure was written to the runtime log ({logPath}) — restarting may help, and reporting the log via Help → Report an Issue helps us fix it.",
		ko: "이 창의 렌더러가 반복해서 충돌해 스스로 복구할 수 없어요. 실패 내용은 런타임 로그({logPath})에 기록했어요. 재시작하면 해결될 수 있고, 도움말 → 문제 신고로 로그를 보내 주시면 수정에 도움이 돼요.",
	},
	"crash.close": { en: "Close", ko: "닫기" },
	"crash.title": { en: "OMPdesk window crashed", ko: "OMPdesk 창이 충돌했어요" },
	"menu.newChatTab": { en: "New Chat Tab", ko: "새 채팅 탭" },
	"menu.newSession": { en: "New Session", ko: "새 세션" },
	"menu.newTab": { en: "New Tab", ko: "새 탭" },
	"menu.newWindow": { en: "New Window", ko: "새 창" },
	"menu.openProject": { en: "Open Project…", ko: "프로젝트 열기…" },
	"menu.prCenter": { en: "Pull Requests", ko: "풀 리퀘스트" },
	"menu.providers": { en: "Models & Providers", ko: "모델 및 프로바이더" },
	"menu.reportIssue": { en: "Report an Issue…", ko: "문제 신고…" },
	"menu.session": { en: "Session", ko: "세션" },
	"menu.sessionInfo": { en: "Session Info", ko: "세션 정보" },
	"menu.shareSession": { en: "Share Session", ko: "세션 공유" },
	"menu.settings": { en: "Settings…", ko: "설정…" },
	"menu.stats": { en: "Stats (All Sessions)", ko: "통계 (모든 세션)" },
	"menu.togglePanel": { en: "Toggle Side Panel", ko: "사이드 패널 표시/숨기기" },
	"menu.toggleSidebar": { en: "Toggle Sidebar", ko: "사이드바 표시/숨기기" },
	"menu.tools": { en: "Tools", ko: "도구" },
	"menu.view": { en: "View", ko: "보기" },
	"menu.window": { en: "Window", ko: "창" },
	"menu.workspaceDirs": { en: "Project Folders", ko: "프로젝트 폴더" },
	"omp.cannotRun": {
		en: "omp at {bin} could not run ({detail}). Reinstall it with `bun install -g @oh-my-pi/pi-coding-agent`, then press Restart.",
		ko: "{bin}의 omp를 실행할 수 없어요 ({detail}). `bun install -g @oh-my-pi/pi-coding-agent`로 다시 설치한 뒤 다시 시작을 눌러 주세요.",
	},
	"omp.notFound": {
		en: "omp is not installed. Install it in a terminal with `bun install -g @oh-my-pi/pi-coding-agent`, then press Restart.",
		ko: "omp가 설치되어 있지 않아요. 터미널에서 `bun install -g @oh-my-pi/pi-coding-agent`로 설치한 뒤 다시 시작을 눌러 주세요.",
	},
	"omp.overrideMissing": {
		en: "OMP_GUI_OMP points at a missing file ({path}). Fix or unset it, then press Restart.",
		ko: "OMP_GUI_OMP가 가리키는 파일이 없어요 ({path}). 값을 고치거나 지운 뒤 다시 시작을 눌러 주세요.",
	},
	"omp.tooOld": {
		en: "omp {version} is too old; this app needs {minimum} or newer. Run `omp update` in a terminal, then press Restart.",
		ko: "omp {version}은 너무 오래된 버전이에요. 이 앱은 {minimum} 이상이 필요해요. 터미널에서 `omp update`를 실행한 뒤 다시 시작을 눌러 주세요.",
	},
	"quit.keepWorking": { en: "Keep working", ko: "계속 사용" },
	"quit.quitAnyway": { en: "Quit anyway", ko: "그래도 종료" },
	"quit.workingBody": {
		en: "{working} of {total} sessions are still working in {windows} window(s). Quitting stops them and their agents.",
		ko: "{windows}개 창에서 세션 {total}개 중 {working}개가 아직 실행 중이에요. 종료하면 세션과 에이전트가 모두 중단돼요.",
	},
	"quit.workingTitle": { en: "Sessions are still running", ko: "아직 실행 중인 세션이 있어요" },
	"restart.body": {
		en: "OMPdesk's installed files were replaced while it was running, so this window can no longer load them reliably. {working} of {total} sessions are still working.",
		ko: "OMPdesk 실행 중에 설치 파일이 교체되어 이 창에서 더 이상 안정적으로 불러올 수 없어요. 세션 {total}개 중 {working}개가 아직 실행 중이에요.",
	},
	"restart.later": { en: "Later", ko: "나중에" },
	"restart.now": { en: "Restart now", ko: "지금 재시작" },
	"restart.title": { en: "Restart to finish updating", ko: "업데이트를 마치려면 재시작하세요" },
	// Status of a tab whose omp runs on a paired device that is unreachable.
	"remote.offline": {
		en: "The device running this session is offline. Reconnecting…",
		ko: "이 세션을 실행하는 기기가 오프라인이에요. 다시 연결하는 중이에요…",
	},
	// Stats bridge failures that reach the renderer (toasts, the stats page).
	"stats.notReady": {
		en: "The stats server is still starting. Try again in a moment.",
		ko: "통계 서버가 아직 시작 중이에요. 잠시 후 다시 시도하세요.",
	},
	"stats.notRunning": {
		en: "The stats server isn't running. Restart OMPdesk to bring it back.",
		ko: "통계 서버가 실행되고 있지 않아요. OMPdesk를 다시 시작하면 복구돼요.",
	},
	"updates.checkFailed": {
		en: "Couldn't check for updates. Check your connection and try again.",
		ko: "업데이트를 확인하지 못했어요. 연결을 확인하고 다시 시도하세요.",
	},
	"updates.downloadFailed": {
		en: "The installer download failed. Check your connection and try again.",
		ko: "설치 프로그램을 다운로드하지 못했어요. 연결을 확인하고 다시 시도하세요.",
	},
	"updates.hashMismatch": {
		en: "The downloaded installer failed SHA-512 verification and was removed. Try the update again.",
		ko: "다운로드한 설치 프로그램이 SHA-512 검증에 실패해 삭제했어요. 업데이트를 다시 시도하세요.",
	},
	"updates.installerMissing": {
		en: "This release does not include an installer for this computer.",
		ko: "이 릴리스에는 이 컴퓨터에 맞는 설치 프로그램이 없어요.",
	},
	"updates.failed": {
		en: "Couldn't finish the update. Try again later.",
		ko: "업데이트를 마치지 못했어요. 잠시 후 다시 시도하세요.",
	},
	"updates.noResult": {
		en: "Couldn't finish the update check. Try again later.",
		ko: "업데이트 확인을 마치지 못했어요. 잠시 후 다시 시도하세요.",
	},
	"updates.openInstallerFailed": {
		en: "The installer was downloaded, but macOS could not open it.",
		ko: "설치 프로그램을 다운로드했지만 macOS에서 열 수 없어요.",
	},
	"updates.releaseInvalid": {
		en: "The latest release has no valid update information, so OMPdesk can't update from it.",
		ko: "최신 릴리스에 올바른 업데이트 정보가 없어서 OMPdesk를 업데이트할 수 없어요.",
	},
	"updates.unsupportedArchitecture": {
		en: "This Mac architecture does not have a supported installer.",
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
