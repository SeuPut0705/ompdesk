/**
 * Every main-process string (native menu, dialogs, coded failures) in both UI
 * languages. Pure data, apart from `i18n.ts` (which needs electron), so tests
 * can hold it against the renderer's names for the same things.
 */
import type { UiLanguage } from "../shared/ui-language";

export const MAIN_TEXT = {
	"dialog.openProject": { en: "Open project", ko: "프로젝트 열기" },
	"web.unknownDevice.title": { en: "An unknown device tried to connect", ko: "알 수 없는 기기가 접속을 시도했어요" },
	"web.unknownDevice.body": {
		en: "Mobile web refused it (no paired device). Nothing to do unless it was you.",
		ko: "모바일 웹이 거부했어요(페어링된 기기가 아니에요). 직접 시도한 게 아니라면 할 일은 없어요.",
	},
	"menu.about": { en: "About OMPdesk", ko: "OMPdesk 정보" },
	"menu.checkUpdates": { en: "Check for Updates…", ko: "업데이트 확인…" },
	"menu.services": { en: "Services", ko: "서비스" },
	"menu.hide": { en: "Hide OMPdesk", ko: "OMPdesk 가리기" },
	"menu.hideOthers": { en: "Hide Others", ko: "기타 가리기" },
	"menu.showAll": { en: "Show All", ko: "모두 보기" },
	"menu.quit": { en: "Quit OMPdesk", ko: "OMPdesk 종료" },
	"menu.addToDictionary": { en: "Add to dictionary", ko: "사전에 추가" },
	"menu.copyImage": { en: "Copy Image", ko: "이미지 복사" },
	"menu.closeTab": { en: "Close Tab", ko: "탭 닫기" },
	"menu.closeWindow": { en: "Close Window", ko: "창 닫기" },
	"menu.commandCenter": { en: "Command Palette", ko: "명령 팔레트" },
	"menu.capabilities": { en: "Agent Behavior", ko: "에이전트 동작" },
	"menu.importSession": { en: "Import External Session", ko: "외부 세션 가져오기" },
	"menu.branchPicker": { en: "Branch from Message", ko: "메시지에서 분기" },
	"menu.sessionTree": { en: "Session Tree", ko: "세션 트리" },
	"menu.modelPicker": { en: "Select Model", ko: "모델 선택" },
	"menu.usage": { en: "Usage & Quotas", ko: "사용량 및 할당량" },
	"menu.workspaceChanges": { en: "Git Changes", ko: "Git 변경 사항" },
	"menu.restartCore": { en: "Restart omp", ko: "omp 다시 시작" },
	"menu.contextReport": { en: "Context Report", ko: "컨텍스트 보고서" },
	"menu.debugConsole": { en: "Debugger Console", ko: "디버거 콘솔" },
	"menu.documentation": { en: "Documentation", ko: "문서" },
	"menu.edit": { en: "Edit", ko: "편집" },
	"menu.exportHtml": { en: "Export HTML", ko: "HTML 내보내기" },
	"menu.file": { en: "File", ko: "파일" },
	"menu.handoff": { en: "Handoff", ko: "핸드오프" },
	"menu.help": { en: "Help", ko: "도움말" },
	"menu.hotkeys": { en: "Keyboard Shortcuts", ko: "키보드 단축키" },
	"menu.jobs": { en: "Background Tasks", ko: "백그라운드 작업" },
	"menu.agentHub": { en: "Agent Definitions", ko: "에이전트 정의" },
	"menu.extensions": { en: "Extensions", ko: "확장" },
	"menu.inventory": { en: "Plugins", ko: "플러그인" },
	"menu.modes": { en: "Modes", ko: "모드" },
	"menu.modelRoles": { en: "Model Roles", ko: "모델 역할" },
	"crash.body": {
		en: "This window crashed repeatedly and can't recover on its own. The failure is in the runtime log ({logPath}). Restarting may help; send the log via Help → Send Feedback so we can fix it.",
		ko: "이 창이 반복해서 충돌해 스스로 복구할 수 없어요. 실패 내용은 런타임 로그({logPath})에 있어요. 재시작하면 해결될 수 있어요. 도움말 → 피드백 보내기로 로그를 보내 주시면 수정에 도움이 돼요.",
	},
	"crash.close": { en: "Close", ko: "닫기" },
	"crash.title": { en: "OMPdesk window crashed", ko: "OMPdesk 창이 충돌했어요" },
	"menu.newChatTab": { en: "New Chat Tab", ko: "새 채팅 탭" },
	"menu.newSession": { en: "New Session", ko: "새 세션" },
	"menu.newTab": { en: "New Tab", ko: "새 탭" },
	"menu.newWindow": { en: "New Window", ko: "새 창" },
	"menu.openProject": { en: "Open Project…", ko: "프로젝트 열기…" },
	"menu.prCenter": { en: "Pull Requests", ko: "풀 리퀘스트" },
	"menu.providers": { en: "Models & Accounts", ko: "모델 및 계정" },
	"menu.reportIssue": { en: "Send Feedback…", ko: "피드백 보내기…" },
	"menu.session": { en: "Session", ko: "세션" },
	"menu.sessionInfo": { en: "Session Info", ko: "세션 정보" },
	"menu.shareSession": { en: "Share Session", ko: "세션 공유" },
	"menu.settings": { en: "Settings…", ko: "설정…" },
	"menu.stats": { en: "All-Sessions Stats", ko: "전체 통계" },
	"menu.togglePanel": { en: "Toggle Side Panel", ko: "사이드 패널 표시/숨기기" },
	"menu.toggleSidebar": { en: "Toggle Sidebar", ko: "사이드바 표시/숨기기" },
	"menu.tools": { en: "Tools", ko: "도구" },
	"menu.view": { en: "View", ko: "보기" },
	"menu.window": { en: "Window", ko: "창" },
	"menu.workspaceDirs": { en: "Projects & Launch", ko: "프로젝트 및 실행" },
	// Electron names role items in English whatever the language; these replace them.
	"menu.undo": { en: "Undo", ko: "실행 취소" },
	"menu.redo": { en: "Redo", ko: "실행 복귀" },
	"menu.cut": { en: "Cut", ko: "오려두기" },
	"menu.copy": { en: "Copy", ko: "복사하기" },
	"menu.paste": { en: "Paste", ko: "붙여넣기" },
	"tray.keepsRunningTitle": { en: "OMPdesk keeps running in the tray", ko: "OMPdesk는 트레이에서 계속 실행돼요" },
	"tray.keepsRunningBody": {
		en: "Click the tray icon to bring the window back. Quit from the tray menu.",
		ko: "트레이 아이콘을 누르면 창이 돌아와요. 종료는 트레이 메뉴에서 해요.",
	},
	"agentControl.stopTitle": {
		en: "An agent wants to stop a session",
		ko: "에이전트가 세션을 중단하려고 해요",
	},
	"agentControl.stopMessage": {
		en: "The agent in “{caller}” wants to stop the work of “{target}”. Stop it?",
		ko: "“{caller}”의 에이전트가 “{target}” 세션의 작업을 중단하려고 해요. 중단할까요?",
	},
	"agentControl.closeMessage": {
		en: "The agent in “{caller}” wants to stop “{target}” and close its tab (the session stays saved). Continue?",
		ko: "“{caller}”의 에이전트가 “{target}” 세션을 중단하고 탭을 닫으려고 해요(세션은 저장돼 있어요). 계속할까요?",
	},
	"agentControl.deleteMessage": {
		en: "The agent in “{caller}” wants to stop “{target}”, close its tab and DELETE the saved session. This can't be undone. Continue?",
		ko: "“{caller}”의 에이전트가 “{target}” 세션을 중단하고 탭을 닫은 뒤 저장된 세션을 삭제하려고 해요. 되돌릴 수 없어요. 계속할까요?",
	},
	"agentControl.mergeTitle": {
		en: "An agent wants to merge a branch",
		ko: "에이전트가 브랜치를 병합하려고 해요",
	},
	"agentControl.mergeMessage": {
		en: "The agent in “{caller}” wants to merge branch {branch} (from “{target}”) into {base} in {cwd}. Nothing is pushed. Merge?",
		ko: "“{caller}”의 에이전트가 “{target}” 세션의 {branch} 브랜치를 {cwd}의 {base} 브랜치에 병합하려고 해요. 푸시는 하지 않아요. 병합할까요?",
	},
	"agentControl.scheduleTitle": {
		en: "An agent wants to schedule a run",
		ko: "에이전트가 예약 실행을 만들려고 해요",
	},
	"agentControl.scheduleMessage": {
		en: "The agent in “{caller}” wants to run “{name}” {when} in {folder} while OMPdesk is open. It runs without auto-approve. Schedule it?",
		ko: "“{caller}”의 에이전트가 OMPdesk가 켜져 있는 동안 {folder} 폴더에서 “{name}” 작업을 {when} 실행하도록 예약하려고 해요. 자동 승인 없이 실행돼요. 예약할까요?",
	},
	"agentControl.autopilotTitle": {
		en: "An agent wants to start Autopilot",
		ko: "에이전트가 오토파일럿을 시작하려고 해요",
	},
	"agentControl.autopilotMessage": {
		en: "The agent in “{caller}” wants to start Autopilot on {folder}: an unattended loop that keeps changing the repository in its own worktree. Branch: {branch}. Ship level: {ship}. Start it?",
		ko: "“{caller}”의 에이전트가 {folder} 폴더에서 오토파일럿을 시작하려고 해요. 별도 워크트리에서 저장소를 계속 고쳐 가는 자동 반복이에요. 브랜치: {branch}. 반영 수준: {ship}. 시작할까요?",
	},
	"agentControl.autopilotShipCommit": { en: "commits only (nothing is pushed)", ko: "커밋만(푸시는 안 해요)" },
	"agentControl.autopilotShipPush": { en: "pushes every green cycle", ko: "초록 사이클마다 푸시" },
	"agentControl.autopilotShipRelease": {
		en: "pushes and RELEASES (a version is published)",
		ko: "푸시하고 릴리스까지(새 버전이 공개돼요)",
	},
	"agentControl.autopilotBranchNew": { en: "a new autopilot/<date> branch", ko: "새 autopilot/<날짜> 브랜치" },
	"agentControl.autopilotBranchDefault": {
		en: "{name} (the default branch: work and pushes land on it directly)",
		ko: "{name}(기본 브랜치: 작업과 푸시가 바로 여기에 반영돼요)",
	},
	"agentControl.answeredBy": { en: "Answered by an agent ({by})", ko: "에이전트가 답함 ({by})" },
	"agentControl.appTitle": {
		en: "An agent wants to change the app",
		ko: "에이전트가 앱을 조작하려고 해요",
	},
	"agentControl.appMessage": {
		en: "The agent in “{caller}” wants to do this: {what}. Allow it?",
		ko: "“{caller}”의 에이전트가 다음 작업을 하려고 해요: {what}. 허용할까요?",
	},
	"agentControl.appChanged": { en: "Agent changed: {what} → {value}", ko: "에이전트가 바꿈: {what} → {value}" },
	// Autopilot (src/main/autopilot.ts): notifications and the readable failures of a start.
	"autopilot.paused.title": { en: "Autopilot paused", ko: "오토파일럿이 멈췄어요" },
	"autopilot.ended.title": { en: "Autopilot ended", ko: "오토파일럿이 끝났어요" },
	"autopilot.summary": {
		en: "{branch}: {cycles} cycles ({green} green), {commits} commits; {shipped}. Stopped: {reason}",
		ko: "{branch}: 사이클 {cycles}개(초록 {green}개), 커밋 {commits}개. {shipped}. 멈춘 이유: {reason}",
	},
	"autopilot.summary.landed": {
		en: "{landed} of {commits} landed on {target}",
		ko: "{target}에 {commits}개 중 {landed}개 반영",
	},
	"autopilot.summary.pr": {
		en: "{target} is protected: {landed} of {commits} landed, the rest waits in {url}",
		ko: "보호된 브랜치 {target}: {commits}개 중 {landed}개만 반영, 나머지는 {url}에서 기다려요",
	},
	"autopilot.summary.pushed": { en: "pushed to {target}", ko: "{target}에 푸시함" },
	"autopilot.summary.notPushed": { en: "the last commit is not pushed", ko: "마지막 커밋은 푸시 안 됨" },
	"autopilot.summary.local": { en: "kept on this computer", ko: "이 컴퓨터에만 있음" },
	"autopilot.land.prTitle": {
		en: "Autopilot can't push to the default branch",
		ko: "오토파일럿이 기본 브랜치에 푸시할 수 없어요",
	},
	"autopilot.land.prBody": {
		en: "{branch} is protected. Green cycles now go to one pull request instead: {url}",
		ko: "{branch} 브랜치가 보호되어 있어요. 이제 초록 사이클은 풀 리퀘스트 하나로 올라가요: {url}",
	},
	"autopilot.reason.user": { en: "Ended by you.", ko: "직접 끝냈어요." },
	"autopilot.reason.user_pause": { en: "Paused by you.", ko: "직접 일시정지했어요." },
	"autopilot.reason.user_abort": { en: "Stopped by you.", ko: "직접 멈췄어요." },
	"autopilot.reason.tab_closed": { en: "Its tab was closed.", ko: "탭이 닫혔어요." },
	"autopilot.reason.repo_gone": {
		en: "The repository folder is gone ({detail}).",
		ko: "저장소 폴더가 사라졌어요({detail}).",
	},
	"autopilot.reason.ban_violation": {
		en: "Autopilot's safety check saw a git change it did not expect ({detail}) and paused the run. Check it, then Resume to continue.",
		ko: "오토파일럿 안전 점검이 예상하지 못한 git 변경을 보고 멈췄어요({detail}). 확인한 뒤 재개하면 이어서 돌아요.",
	},
	"autopilot.reason.budget": { en: "The token limit was reached.", ko: "토큰 상한에 도달했어요." },
	"autopilot.reason.time": { en: "The time limit was reached.", ko: "시간 상한에 도달했어요." },
	"autopilot.reason.cycles": { en: "The cycle limit was reached.", ko: "사이클 상한에 도달했어요." },
	"autopilot.reason.cost": { en: "The cost limit was reached.", ko: "비용 상한에 도달했어요." },
	"autopilot.reason.app_closed": {
		en: "OMPdesk was closed; press Resume to continue.",
		ko: "OMPdesk가 닫혀 있었어요. 이어서 하려면 재개를 누르세요.",
	},
	"autopilot.reason.agent_done": { en: "The agent declared the work done.", ko: "에이전트가 작업이 끝났다고 했어요." },
	"autopilot.release.ok": { en: "Release {version} succeeded.", ko: "릴리스 {version} 성공." },
	"autopilot.release.failed": { en: "Release {version} failed.", ko: "릴리스 {version} 실패." },
	"autopilot.release.title": { en: "Autopilot release", ko: "오토파일럿 릴리스" },
	"autopilot.denied": {
		en: "Denied a request that breaks a hard limit: {reason}",
		ko: "금지된 요청을 거절했어요: {reason}",
	},
	"autopilot.err.guideTooLarge": {
		en: "The Autopilot guide is too large (limit 256 KB). Shorten it, then start again.",
		ko: "오토파일럿 가이드가 너무 커요(최대 256KB). 줄인 뒤 다시 시작하세요.",
	},
	"autopilot.err.guideCommit": {
		en: "Could not commit AUTOPILOT.md to the new Autopilot branch:",
		ko: "새 오토파일럿 브랜치에 AUTOPILOT.md를 커밋하지 못했어요:",
	},
	"autopilot.err.notRepo": {
		en: "Autopilot needs a git repository with at least one commit.",
		ko: "오토파일럿은 커밋이 하나 이상 있는 git 저장소에서만 시작할 수 있어요.",
	},
	"autopilot.err.detached": {
		en: "Check out a branch first: Autopilot cuts its worktree from the current branch.",
		ko: "먼저 브랜치를 체크아웃하세요. 오토파일럿은 현재 브랜치에서 워크트리를 만들어요.",
	},
	"autopilot.err.branchExists": {
		en: "A branch named {branch} already exists. Pick it from the list, or name the new branch differently.",
		ko: "{branch}라는 브랜치가 이미 있어요. 목록에서 고르거나 새 브랜치 이름을 바꾸세요.",
	},
	"autopilot.err.branchInvalid": {
		en: "{branch} is not a valid git branch name.",
		ko: "git 브랜치 이름으로 쓸 수 없어요: {branch}",
	},
	"autopilot.err.branchMissing": {
		en: "The branch {branch} does not exist (any more). Pick another one.",
		ko: "{branch} 브랜치가 (더 이상) 없어요. 다른 브랜치를 고르세요.",
	},
	"autopilot.err.onBase": {
		en: "This run works on or pushes to the default branch itself: there is nothing to merge or open a pull request for.",
		ko: "이 실행은 기본 브랜치에서 돌거나 기본 브랜치로 푸시해요. 병합하거나 PR을 열 것이 없어요.",
	},
	"autopilot.err.running": {
		en: "This session is already an Autopilot run.",
		ko: "이 세션은 이미 오토파일럿 실행 중이에요.",
	},
	"autopilot.err.device": {
		en: "Autopilot runs only on this computer, not on a paired device.",
		ko: "오토파일럿은 이 컴퓨터에서만 실행돼요(페어링된 기기에서는 안 돼요).",
	},
	"autopilot.err.noRelease": {
		en: "No release procedure was found in this repository's rules files (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, RELEASING.md, docs/release*).",
		ko: "이 저장소의 규칙 파일(AGENTS.md, CLAUDE.md, CONTRIBUTING.md, RELEASING.md, docs/release*)에서 릴리스 절차를 찾지 못했어요.",
	},
	"autopilot.err.noRun": { en: "This session is not an Autopilot run.", ko: "이 세션은 오토파일럿 실행이 아니에요." },
	"autopilot.err.noCommit": { en: "That cycle made no commit to revert.", ko: "되돌릴 커밋이 없는 사이클이에요." },
	"autopilot.err.localOnly": {
		en: "Autopilot is controlled from the OMPdesk window on this computer.",
		ko: "오토파일럿은 이 컴퓨터의 OMPdesk 창에서만 제어해요.",
	},
	"menu.selectAll": { en: "Select All", ko: "전체 선택" },
	"menu.reload": { en: "Reload", ko: "새로고침" },
	"menu.forceReload": { en: "Force Reload", ko: "강제 새로고침" },
	"menu.toggleDevTools": { en: "Toggle Developer Tools", ko: "개발자 도구 표시/숨기기" },
	"menu.actualSize": { en: "Actual Size", ko: "실제 크기" },
	"menu.zoomIn": { en: "Zoom In", ko: "확대" },
	"menu.zoomOut": { en: "Zoom Out", ko: "축소" },
	"menu.toggleFullScreen": { en: "Toggle Full Screen", ko: "전체 화면 표시/숨기기" },
	"menu.minimize": { en: "Minimize", ko: "최소화" },
	"menu.zoom": { en: "Zoom", ko: "확대/축소" },
	"menu.bringAllToFront": { en: "Bring All to Front", ko: "모두 앞으로 가져오기" },
	"omp.bunTooOld": {
		en: "omp at {bin} needs Bun {minimum} or newer, but {bun} is {bunVersion}. OMPdesk is upgrading Bun on its own; this tab starts once it is done.",
		ko: "{bin}의 omp는 Bun {minimum} 이상이 필요한데 {bun}은 {bunVersion}이에요. OMPdesk가 알아서 Bun을 업그레이드하고 있어요. 끝나면 이 탭이 시작돼요.",
	},
	"omp.cannotRun": {
		en: "omp at {bin} could not run ({detail}). OMPdesk is reinstalling it on its own; this tab starts once it is done.",
		ko: "{bin}의 omp를 실행할 수 없어요 ({detail}). OMPdesk가 알아서 다시 설치하고 있어요. 끝나면 이 탭이 시작돼요.",
	},
	"omp.compiled": {
		en: "omp at {bin} is a standalone build, which OMPdesk can't load its features into. OMPdesk is reinstalling it as the package on its own; this tab starts once it is done.",
		ko: "{bin}의 omp는 단독 실행 파일 빌드라서 OMPdesk 기능을 불러올 수 없어요. OMPdesk가 알아서 패키지로 다시 설치하고 있어요. 끝나면 이 탭이 시작돼요.",
	},
	"omp.notFound": {
		en: "omp is not installed. OMPdesk is installing it on its own; this tab starts once it is done.",
		ko: "omp가 설치되어 있지 않아요. OMPdesk가 알아서 설치하고 있어요. 끝나면 이 탭이 시작돼요.",
	},
	"omp.sessionOwned": {
		en: "This session is still open in another omp (a terminal, or OMPdesk's last launch closing). Opening it here too would split it into a second file. Close the other one: it opens here by itself then, or press Restart.",
		ko: "이 세션이 아직 다른 omp(터미널, 또는 닫히는 중인 이전 OMPdesk)에 열려 있어요. 여기서도 열면 세션이 두 파일로 갈라져요. 다른 쪽을 닫으면 여기서 알아서 열려요. 다시 시작을 눌러도 돼요.",
	},
	"omp.overrideMissing": {
		en: "OMP_GUI_OMP points at a missing file ({path}). Fix or unset it, then press Restart.",
		ko: "OMP_GUI_OMP가 가리키는 파일이 없어요 ({path}). 값을 고치거나 지운 뒤 다시 시작을 눌러 주세요.",
	},
	"omp.tooOld": {
		en: "omp {version} is too old; this app needs {minimum} or newer. OMPdesk is updating it on its own; this tab starts once it is done.",
		ko: "omp {version}은 너무 오래된 버전이에요. 이 앱은 {minimum} 이상이 필요해요. OMPdesk가 알아서 업데이트하고 있어요. 끝나면 이 탭이 시작돼요.",
	},
	"quit.keepWorking": { en: "Keep working", ko: "계속 사용" },
	"quit.quitAnyway": { en: "Quit anyway", ko: "그래도 종료" },
	"quit.workingBody": {
		en: "Still working: {working} of {total} session{totalPlural}, in {windows} window{windowsPlural}. Quitting stops them and their agents.",
		ko: "{windows}개 창에서 세션 {total}개 중 {working}개가 아직 실행 중이에요. 종료하면 세션과 에이전트가 모두 중단돼요.",
	},
	"quit.workingTitle": { en: "Sessions are still running", ko: "아직 실행 중인 세션이 있어요" },
	"restart.body": {
		en: "OMPdesk's installed files were replaced while it was running, so this window can no longer load them reliably. Still working: {working} of {total} session{totalPlural}.",
		ko: "OMPdesk 실행 중에 설치 파일이 교체되어 이 창에서 더 이상 안정적으로 불러올 수 없어요. 세션 {total}개 중 {working}개가 아직 실행 중이에요.",
	},
	"restart.later": { en: "Later", ko: "나중에" },
	"restart.now": { en: "Restart now", ko: "지금 재시작" },
	"restart.title": { en: "Restart to finish updating", ko: "업데이트를 마치려면 재시작하세요" },
	// Batched completion notifications (notification-batch.ts): "3 tasks finished · 1 needs you".
	"batch.finished.one": { en: "{count} task finished", ko: "작업 {count}개 완료" },
	"batch.finished.other": { en: "{count} tasks finished", ko: "작업 {count}개 완료" },
	"batch.failed": { en: "{count} failed", ko: "{count}개 실패" },
	"batch.needsYou.one": { en: "{count} needs you", ko: "{count}개 확인 필요" },
	"batch.needsYou.other": { en: "{count} need you", ko: "{count}개 확인 필요" },
	"batch.more": { en: "{list} +{count} more", ko: "{list} 외 {count}개" },
	// A finished turn whose last reply waits for the person (notify-triage.ts), in the renderer's `attention.question`
	// word; {title} is the tab's title.
	"notify.needsInput": { en: "Needs input · {title}", ko: "답변 필요 · {title}" },
	// Web Push to a paired phone (web/web-push-notifier.ts). The body reads like the desktop banner's; a device that
	// hides content gets only the title, and the batch summary above.
	"push.complete": { en: "Complete", ko: "완료" },
	"push.error": { en: "Stopped with error", ko: "오류로 중단됨" },
	"push.errorDetail": { en: "Stopped with error: {error}", ko: "오류로 중단됨: {error}" },
	"push.ask": { en: "Waiting for your input", ko: "입력을 기다리고 있어요" },
	"push.hidden.completion": { en: "A task finished", ko: "작업이 끝났어요" },
	"push.hidden.error": { en: "A task stopped with an error", ko: "작업이 오류로 중단됐어요" },
	"push.hidden.ask": { en: "A task needs you", ko: "작업에 확인이 필요해요" },
	// Status of a tab whose omp runs on a paired device that is unreachable.
	"remote.offline": {
		en: "The device running this session is offline. Reconnecting…",
		ko: "이 세션을 실행하는 기기가 오프라인이에요. 다시 연결하는 중이에요…",
	},
	// Status of a host tab the paired device did not bring up in time (src/main/remote/remote-sidecar.ts).
	"remote.tabStalled": {
		en: "{device} has not started this session after {seconds} s. Restart to try again.",
		ko: "{device}에서 이 세션이 {seconds}초가 지나도 시작되지 않았어요. 다시 시작해 보세요.",
	},
	// Stats bridge failures that reach the renderer (toasts, the stats page).
	"stats.notReady": {
		en: "OMPdesk keeps starting it in the background. Stats appear here as soon as it answers.",
		ko: "OMPdesk가 백그라운드에서 계속 시작하고 있어요. 응답하면 바로 여기에 통계가 표시돼요.",
	},
	"stats.notRunning": {
		en: "The stats server isn't running. Restart OMPdesk to bring it back.",
		ko: "통계 서버가 실행되고 있지 않아요. OMPdesk를 다시 시작하면 복구돼요.",
	},
	"updates.checkFailed": {
		en: "Couldn't check for updates. Check your connection and try again.",
		ko: "업데이트를 확인하지 못했어요. 연결을 확인하고 다시 시도해 주세요.",
	},
	"updates.downloadFailed": {
		en: "The installer download failed. Check your connection and try again.",
		ko: "설치 프로그램을 다운로드하지 못했어요. 연결을 확인하고 다시 시도해 주세요.",
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
		en: "The update check ended without a result. Try again in a moment.",
		ko: "업데이트 확인이 결과 없이 끝났어요. 잠시 후 다시 시도해 주세요.",
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
} satisfies Record<string, Record<UiLanguage, string>>;

export type MainTextKey = keyof typeof MAIN_TEXT;
