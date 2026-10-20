/** Memory › Maintenance. `en` and `ko` carry exactly the same keys (locales.test.ts). */
export const en: Record<string, string> = {
	"memory.maint.care": "Tidied by itself this week: {what}",
	"memory.maint.care.retired": "{count} out-of-date pages hidden",
	"memory.maint.care.flagged": "{count} pages marked for review",
	"memory.maint.care.backfilled": "{count} conclusions filled in from older conversations",
	"memory.maint.care.info":
		"Memory checks itself after each update and then daily: it hides pages a newer one repeats or contradicts and pages naming files that no longer exist, and fills in what older conversations concluded. Undo puts the pages back as they were and leaves them alone from then on.",
	"memory.maint.care.undo": "Undo",
	"memory.maint.care.undone": "{count} pages put back",
	"memory.maint.lint": "Check pages",
	"memory.maint.lint.info":
		"A rule-based audit of this project's pages: duplicates, stale and orphaned pages, broken links. Writes nothing.",
	"memory.maint.lint.run": "Run check",
	"memory.maint.lint.none": "Nothing to fix.",
	"memory.maint.sweep": "Retention sweep",
	"memory.maint.sweep.info":
		"Lets go of pages and old observations the aging rules say are no longer worth keeping, and merges near-duplicates. Pinned pages are kept. Preview first: it changes nothing.",
	"memory.maint.sweep.preview": "Preview",
	"memory.maint.sweep.run": "Run sweep",
	"memory.maint.sweep.would":
		"Would evict {evicted}, compact {compacted}, merge {merged}, expire {expired}; prune {observations} observations ({evaluated} checked).",
	"memory.maint.sweep.done":
		"Evicted {evicted}, compacted {compacted}, merged {merged}, expired {expired}; pruned {observations} observations.",
	"memory.maint.sweep.title": "Run the sweep?",
	"memory.maint.sweep.confirm":
		"This applies what the preview showed to this project. Deleted pages can't be restored from Pages.",
	"memory.maint.sweep.ran": "Sweep done",
	"memory.maint.purge": "Delete all memory",
	"memory.maint.purge.info": "Erases every page, handoff, session and observation on this computer, for all projects.",
	"memory.maint.purge.title": "Delete all memory?",
	"memory.maint.purge.message":
		"This erases every page, handoff, recorded session and observation on this computer, for all projects. It can't be undone.",
	"memory.maint.purge.word": "delete",
	"memory.maint.purge.type": "Type “{word}” to confirm",
	"memory.maint.purged": "All memory deleted",
};
export const ko: Record<string, string> = {
	"memory.maint.care": "이번 주 스스로 정리함: {what}",
	"memory.maint.care.retired": "오래된 페이지 {count}개 숨김",
	"memory.maint.care.flagged": "검토할 페이지 {count}개 표시",
	"memory.maint.care.backfilled": "지난 대화의 결론 {count}개 채움",
	"memory.maint.care.info":
		"메모리는 업데이트 뒤와 매일 스스로 점검해요. 새 페이지가 되풀이하거나 뒤집은 페이지와 이제 없는 파일을 가리키는 페이지를 숨기고, 지난 대화의 결론을 채워요. 되돌리기는 페이지를 원래대로 돌려놓고 그 뒤로는 손대지 않아요.",
	"memory.maint.care.undo": "되돌리기",
	"memory.maint.care.undone": "페이지 {count}개를 되돌렸어요",
	"memory.maint.lint": "페이지 점검",
	"memory.maint.lint.info":
		"이 프로젝트 페이지를 규칙으로 점검해요. 중복, 오래된 페이지, 고립된 페이지, 깨진 링크를 찾고 아무것도 쓰지 않아요.",
	"memory.maint.lint.run": "점검 실행",
	"memory.maint.lint.none": "고칠 것이 없어요.",
	"memory.maint.sweep": "보존 정리",
	"memory.maint.sweep.info":
		"에이징 규칙상 더 둘 가치가 없는 페이지와 오래된 관찰을 내보내고, 거의 같은 페이지를 합쳐요. 고정한 페이지는 남아요. 미리보기는 아무것도 바꾸지 않아요.",
	"memory.maint.sweep.preview": "미리보기",
	"memory.maint.sweep.run": "정리 실행",
	"memory.maint.sweep.would":
		"내보내기 {evicted}개, 압축 {compacted}개, 병합 {merged}개, 만료 {expired}개, 관찰 정리 {observations}개 예정이에요(검사 {evaluated}개).",
	"memory.maint.sweep.done":
		"내보냄 {evicted}개, 압축 {compacted}개, 병합 {merged}개, 만료 {expired}개, 관찰 {observations}개를 정리했어요.",
	"memory.maint.sweep.title": "정리를 실행할까요?",
	"memory.maint.sweep.confirm":
		"미리보기로 본 내용을 이 프로젝트에 적용해요. 지워진 페이지는 페이지 탭에서 복원할 수 없어요.",
	"memory.maint.sweep.ran": "정리를 마쳤어요",
	"memory.maint.purge": "모든 메모리 삭제",
	"memory.maint.purge.info": "이 컴퓨터의 모든 페이지, 인계, 세션, 관찰을 모든 프로젝트에 걸쳐 지워요.",
	"memory.maint.purge.title": "모든 메모리를 삭제할까요?",
	"memory.maint.purge.message":
		"이 컴퓨터의 모든 페이지, 인계, 기록된 세션과 관찰을 모든 프로젝트에 걸쳐 지워요. 되돌릴 수 없어요.",
	"memory.maint.purge.word": "삭제",
	"memory.maint.purge.type": "확인하려면 “{word}”를 입력하세요",
	"memory.maint.purged": "모든 메모리를 삭제했어요",
};
