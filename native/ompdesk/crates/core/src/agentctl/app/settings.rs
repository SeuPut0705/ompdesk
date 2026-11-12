//! Every Settings row an agent may write through `ompdesk_app` (was `app-settings.ts`), one action each
//! (`settings.<id>`): the stored preference (`PREFS_SET`, which also applies each key's validation and main-side
//! effects) or the stock setting (`set_setting`) the row's own control writes, with the value shape and the tier of the
//! change.
//!
//! Rows an agent never writes, or that another action covers, are in `ROW_NOT_WRITTEN` with the reason;
//! `app-catalog.test.ts` checks (through `app.catalog`) that every row of the Settings catalog is in one list or the
//! other, so a new row is a decision, not an oversight. Settings that gate what an agent may do are `never` here,
//! whichever way they are reached: `guard.rs` refuses them centrally.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde_json::{Value, json};

use super::guard::Tier;
use super::schema::Args;

/// What `agentControlManage` ("Let agents manage other sessions", default on) does to a `sensitive` action's card.
/// Every sensitive action decides, with the reason (`app-catalog.test.ts` fails on one that does not):
///   `Lifts`   the switch skips the card; the reason says why that is safe.
///   `Always`  the card appears whatever the switch says; the reason says what it protects (erased data, code that
///             runs, credentials, network exposure, running work). `when` narrows it to calls that need it.
#[derive(Clone, Copy)]
pub enum Manage {
    Always {
        reason: &'static str,
        when: Option<fn(&Args) -> bool>,
    },
    Lifts(&'static str),
}

/// What a row writes.
pub enum Kind {
    Pref {
        key: &'static str,
        /// Other stored keys that move with this one (the legacy mirror of a theme).
        mirror_theme: bool,
        /// The value is a credential-like string: it is never read back or shown.
        redact: bool,
    },
    Stock {
        path: &'static str,
    },
}

pub struct Setting {
    /// The Settings catalog row id, or the stock path of a curated schema row.
    pub id: &'static str,
    pub area: &'static str,
    pub en: &'static str,
    pub ko: &'static str,
    /// `Change` or `Sensitive`.
    pub tier: Tier,
    pub schema: Value,
    /// Required on a `Sensitive` row.
    pub manage: Option<Manage>,
    pub kind: Kind,
}

impl Setting {
    /// The stored key of a preference row.
    pub fn pref_key(&self) -> Option<&'static str> {
        match self.kind {
            Kind::Pref { key, .. } => Some(key),
            Kind::Stock { .. } => None,
        }
    }

    pub fn redact(&self) -> bool {
        matches!(self.kind, Kind::Pref { redact: true, .. })
    }

    /// The other stored keys that move with this row's.
    pub fn mirror_keys(&self) -> &'static [&'static str] {
        match self.kind {
            Kind::Pref {
                mirror_theme: true, ..
            } => &["theme"],
            _ => &[],
        }
    }

    /// The value a mirrored key takes when this row's value is `value`.
    pub fn mirrored(&self, value: &Value) -> Value {
        const DARK: [&str; 5] = ["dark", "nord", "tokyo-night", "gruvbox-dark", "hc-dark"];
        match value.as_str() {
            Some("system") => json!("system"),
            Some(name) if DARK.contains(&name) => json!("dark"),
            _ => json!("light"),
        }
    }
}

fn boolean() -> Value {
    json!({"type": "boolean"})
}

fn options(values: &[&str]) -> Value {
    json!({"type": "string", "enum": values})
}

fn pref(
    id: &'static str,
    key: &'static str,
    area: &'static str,
    en: &'static str,
    ko: &'static str,
    schema: Value,
) -> Setting {
    Setting {
        id,
        area,
        en,
        ko,
        tier: Tier::Change,
        schema,
        manage: None,
        kind: Kind::Pref {
            key,
            mirror_theme: false,
            redact: false,
        },
    }
}

fn stock(
    path: &'static str,
    area: &'static str,
    en: &'static str,
    ko: &'static str,
    schema: Value,
) -> Setting {
    Setting {
        id: path,
        area,
        en,
        ko,
        tier: Tier::Change,
        schema,
        manage: None,
        kind: Kind::Stock { path },
    }
}

impl Setting {
    fn sensitive(mut self, manage: Manage) -> Setting {
        self.tier = Tier::Sensitive;
        self.manage = Some(manage);
        self
    }

    fn mirror_theme(mut self) -> Setting {
        if let Kind::Pref { mirror_theme, .. } = &mut self.kind {
            *mirror_theme = true;
        }
        self
    }

    fn redacted(mut self) -> Setting {
        if let Kind::Pref { redact, .. } = &mut self.kind {
            *redact = true;
        }
        self
    }
}

pub static SETTINGS: LazyLock<Vec<Setting>> = LazyLock::new(|| {
    vec![
        pref("replyLanguage", "replyLanguage", "general", "Conversation language", "대화 언어", json!({"type":"string","minLength":1,"maxLength":60})),
        pref("notifications", "notifications", "general", "Notifications", "알림", boolean()),
        pref("notificationSound", "notificationSound", "general", "Notification sound", "알림 소리", boolean()),
        pref("linkPreview", "linkPreview", "general", "Open links in the preview", "링크를 미리보기에서 열기", boolean()),
        pref("panelDefault", "defaultPanelTab", "general", "Default side panel", "기본 사이드 패널", options(&["terminal", "diff", "preview", "files"])),
        pref("panelSide", "panelSide", "general", "Side panel edge", "사이드 패널 위치", options(&["left", "right"])),
        pref("closeToTray", "closeToTray", "general", "Close to tray", "창 닫으면 트레이로", boolean()),
        pref("keepAwakeWorking", "keepAwakeWhileWorking", "general", "Keep this computer awake while it is used", "쓰는 동안 잠자기 막기", boolean()),
        pref("resumeInterrupted", "resumeInterrupted", "general", "Resume interrupted work", "중단된 작업 이어서 하기", boolean()),
        pref("autoPreviewDevServer", "autoPreviewDevServer", "agent", "Open dev servers in the preview", "개발 서버 미리보기 자동 열기", boolean()),
        pref("autoOpenChanges", "autoOpenChanges", "agent", "Open changes after a turn", "턴이 끝나면 변경 사항 열기", boolean()),
        pref("autoMode", "autoMode", "agent", "Auto mode", "자동 모드", boolean()),
        pref("nextPromptSuggestions", "nextPromptSuggestions", "agent", "Next prompt suggestions", "다음 메시지 제안", boolean()),
        pref("nextPromptInline", "nextPromptInline", "agent", "Inline completion", "이어서 완성", boolean()),
        pref("defaultBrowser", "defaultBrowser", "agent", "Default browser", "기본 브라우저", options(&["auto", "ego", "builtin"])),
        pref("autoTitle", "autoTitle", "agent", "Automatic session titles", "세션 제목 자동 생성", boolean()),
        pref("autoTitleEvolve", "autoTitleEvolve", "agent", "Keep titles current", "제목 최신으로 유지", boolean()),
        pref("judgeAssist", "judgeAssist", "agent", "Use the judge model for small decisions", "작은 판단에 판정 모델 쓰기", boolean()),
        pref("theme", "themeName", "appearance", "Theme", "테마", options(&["system", "light", "github-light", "solarized-light", "sepia", "hc-light", "dark", "nord", "tokyo-night", "gruvbox-dark", "hc-dark"])).mirror_theme(),
        pref("followAgentTheme", "followAgentTheme", "appearance", "Follow the agent's theme", "에이전트 테마 따르기", boolean()),
        pref("fontSize", "fontSize", "appearance", "Font size", "글꼴 크기", json!({"type":"integer","minimum":12,"maximum":20})),
        pref("compactDensity", "compactDensity", "appearance", "Compact density", "촘촘한 간격", boolean()),
        pref("colorBlindMode", "colorBlindMode", "appearance", "Color-blind mode", "색각 보정 모드", boolean()),
        pref("transcriptDetail", "transcriptDetail", "appearance", "Transcript detail", "대화 상세도", options(&["compact", "full"])),
        pref("thinkingExpanded", "thinkingExpanded", "appearance", "Expand thinking", "생각 펼치기", boolean()),
        pref("lineNumbers", "codeLineNumbers", "appearance", "Code line numbers", "코드 줄 번호", boolean()),
        pref("hideThinkingBlock", "displayPreferences.hideThinkingBlock", "appearance", "Hide thinking blocks", "생각 블록 숨기기", boolean()),
        pref("proseOnlyThinking", "displayPreferences.proseOnlyThinking", "appearance", "Prose-only thinking", "생각을 글로만 보기", boolean()),
        pref("showTokenUsage", "displayPreferences.showTokenUsage", "appearance", "Show token usage", "토큰 사용량 표시", boolean()),
        pref("collapseCompacted", "displayPreferences.collapseCompacted", "appearance", "Collapse compacted history", "압축된 기록 접기", boolean()),
        pref("goalStatusInFooter", "displayPreferences.goalStatusInFooter", "appearance", "Goal status in the footer", "푸터에 목표 상태", boolean()),
        pref("emojiAutocomplete", "displayPreferences.emojiAutocomplete", "appearance", "Emoji autocomplete", "이모지 자동 완성", boolean()),
        pref("mobileEnterSends", "displayPreferences.mobileEnterSends", "appearance", "Enter sends on a touch keyboard", "터치 키보드에서 Enter로 전송", boolean()),
        pref("pasteMenuThreshold", "displayPreferences.pasteMenuThreshold", "appearance", "Large paste menu threshold", "큰 붙여넣기 메뉴 기준", json!({"type":"integer","minimum":0,"maximum":1000000})),
        pref("proxy", "proxyUrl", "general", "Network proxy", "네트워크 프록시", json!({"type":"string","maxLength":300})).redacted().sensitive(Manage::Always { reason: "the proxy sees all of this app's traffic and may carry credentials", when: None }),
        pref("appAutoUpdate", "appAutoUpdate", "updates", "Update OMPdesk automatically", "OMPdesk 자동 업데이트", boolean()).sensitive(Manage::Lifts("only the person's own update schedule; installing one now (updates.apply) still asks")),
        pref("toolsAutoUpdate", "toolsAutoUpdate", "updates", "Keep tools up to date (omp, tool CLIs, extensions)", "도구 최신으로 유지 (omp, 도구 CLI, 확장)", boolean()).sensitive(Manage::Lifts("updates omp, tools and extensions the person already has; running turns keep the code they loaded and installing something new still asks")),
        pref("builtinRea", "builtinMcp.rea", "tools", "Built-in REA tools", "내장 REA 도구", boolean()).sensitive(Manage::Lifts("switches a bundled tool pack on or off; it adds no code the app does not ship")),
        pref("rotation", "accountRotation", "models", "Account rotation", "계정 순환", options(&["quota", "even"])).sensitive(Manage::Lifts("picks which signed-in account a session uses next; no credential is read or changed")),
        pref("localEngines", "localEngineDetect", "models", "Detect local inference engines", "로컬 추론 엔진 자동 탐지", boolean()),
        stock("steeringMode", "agent", "Steering mode", "스티어링 방식", options(&["all", "one-at-a-time"])),
        stock("followUpMode", "agent", "Follow-up mode", "후속 메시지 방식", options(&["all", "one-at-a-time"])),
        stock("interruptMode", "agent", "Interrupt mode", "중단 방식", options(&["immediate", "wait"])),
        stock("compaction.enabled", "agent", "Auto compaction", "자동 압축", boolean()),
        stock("tui.renderMermaid", "agent", "Render Mermaid", "Mermaid 렌더링", boolean()),
        stock("defaultThinkingLevel", "models", "Thinking level", "사고 수준", options(&["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"])),
        stock("retry.modelFallback", "models", "Use fallback models", "대체 모델 사용", boolean()),
        stock("retry.maxRetries", "agent", "Max retries", "최대 재시도", json!({"type":"integer","minimum":0,"maximum":20})),
        stock("plan.enabled", "agent", "Plan mode", "계획 모드", boolean()),
        stock("goal.enabled", "agent", "Goal mode", "목표 모드", boolean()),
        stock("ttsr.enabled", "agent", "Rule injection (TTSR)", "규칙 주입(TTSR)", boolean()),
        stock("advisor.enabled", "agent", "Advisor", "어드바이저", boolean()),
    ]
});

static BY_ID: LazyLock<HashMap<&'static str, usize>> = LazyLock::new(|| {
    SETTINGS
        .iter()
        .enumerate()
        .map(|(at, setting)| (setting.id, at))
        .collect()
});

pub fn by_id(id: &str) -> Option<&'static Setting> {
    BY_ID.get(id).map(|at| &SETTINGS[*at])
}

pub fn setting_action_id(id: &str) -> String {
    format!("settings.{id}")
}

/// Rows whose Settings control acts on the paired host the focused tab runs on, not on this computer: Models &
/// accounts and Tools & extensions are `host` sections, and these three read and write the host's own machine
/// services through a channel that takes the device. For a caller tab on a host the row goes the same way, keyed by
/// its preference key; every other pref row is this device's own value in the Settings UI too.
pub struct HostPref {
    /// Channel `(device)` answering the host's state.
    pub get: &'static str,
    /// Channel `(value, device)` storing it on the host.
    pub set: &'static str,
    /// The row's value inside the state `get` answers.
    pub field: &'static str,
}

pub fn host_pref(key: &str) -> Option<&'static HostPref> {
    static HOST_PREFS: [(&str, HostPref); 3] = [
        (
            "accountRotation",
            HostPref {
                get: "account-rotation:get",
                set: "account-rotation:set",
                field: "mode",
            },
        ),
        (
            "builtinMcp.rea",
            HostPref {
                get: "builtin-rea:get",
                set: "builtin-rea:set",
                field: "enabled",
            },
        ),
        (
            "localEngineDetect",
            HostPref {
                get: "local-engines:get",
                set: "local-engines:set",
                field: "enabled",
            },
        ),
    ];
    HOST_PREFS
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, host)| host)
}

/// Rows another action covers (`Covered`) or an agent never writes (`Never`), each with the reason.
pub enum Decision {
    Covered(&'static str),
    Never(&'static str),
}

pub static ROW_NOT_WRITTEN: &[(&str, Decision)] = &[
    (
        "thinkingDisplay",
        Decision::Covered("settings.hideThinkingBlock"),
    ),
    (
        "language",
        Decision::Never("the window's own language switch applies it; ask the person"),
    ),
    (
        "profileName",
        Decision::Never("the person's own profile text"),
    ),
    (
        "profileExperience",
        Decision::Never("the person's own profile"),
    ),
    (
        "githubAccount",
        Decision::Covered("accounts.github_sign_in"),
    ),
    (
        "machineSetup",
        Decision::Never("machine setup installs tools by itself; there is nothing to set"),
    ),
    (
        "pstack",
        Decision::Never(
            "the engineering-mode pack changes the prompt and skills every session runs with",
        ),
    ),
    (
        "ecc",
        Decision::Never(
            "the ECC skill pack changes which skills and slash commands every session runs with",
        ),
    ),
    (
        "computerUse",
        Decision::Never(
            "the computer-use engine decides how every session sees and drives the desktop: a power switch",
        ),
    ),
    (
        "agentControl",
        Decision::Never("this switch gates the agent's own power over the app"),
    ),
    (
        "ssh",
        Decision::Never("SSH hosts and keys are credentials and network reach"),
    ),
    ("remote", Decision::Covered("remote.connect")),
    ("mobileWeb", Decision::Covered("mobile_web.set_enabled")),
    (
        "hostAppearance",
        Decision::Never("a paired host's look; the person's own choice"),
    ),
    (
        "creditSpend",
        Decision::Never(
            "running an account on paid credits or extra usage spends the person's money",
        ),
    ),
    ("accounts", Decision::Covered("accounts.provider_sign_in")),
    (
        "custom",
        Decision::Never("custom providers set endpoints and credentials"),
    ),
    (
        "modelOverrides",
        Decision::Never("model overrides change limits and wire behavior of providers"),
    ),
    ("roles", Decision::Covered("models.set_role")),
    ("modelRoles", Decision::Covered("models.set_role")),
    (
        "pools",
        Decision::Never("account pools route work across the person's accounts"),
    ),
    (
        "task.agentAccountPools",
        Decision::Never("account pools route work across the person's accounts"),
    ),
    (
        "reset-passes",
        Decision::Never("redeeming a reset pass spends an account's allowance"),
    ),
    (
        "setup",
        Decision::Never("model setup picks providers and accounts"),
    ),
    (
        "launch",
        Decision::Never("launch profiles inject prompts, tools and config into every session"),
    ),
    (
        "agentWorktrees",
        Decision::Never(
            "clearing worktrees deletes work; ompdesk_merge and the review queue own that",
        ),
    ),
    (
        "tools.approvalMode",
        Decision::Never(
            "the person decides this in Settings; an agent changing it would widen its own power or spend",
        ),
    ),
    (
        "tools.approval",
        Decision::Never(
            "the person decides this in Settings; an agent changing it would widen its own power or spend",
        ),
    ),
    (
        "secrets.enabled",
        Decision::Never(
            "the person decides this in Settings; an agent changing it would widen its own power or spend",
        ),
    ),
    (
        "memory.backend",
        Decision::Never(
            "the person decides this in Settings; an agent changing it would widen its own power or spend",
        ),
    ),
    (
        "compaction.modelThresholds",
        Decision::Never("a structured per-model table with its own editor"),
    ),
    (
        "retry.fallbackChains",
        Decision::Covered("omp_settings.set"),
    ),
    ("retry.fallbackOn", Decision::Covered("omp_settings.set")),
    (
        "disabledExtensions",
        Decision::Never("extension switches change what code runs in every session"),
    ),
    (
        "launch-systemPrompt",
        Decision::Never("launch profiles inject prompts, tools and config into every session"),
    ),
    (
        "launch-appendSystemPrompt",
        Decision::Never("launch profiles inject prompts, tools and config into every session"),
    ),
    (
        "launch-addDirs",
        Decision::Never("launch profiles inject prompts, tools and config into every session"),
    ),
    (
        "launch-tools",
        Decision::Never("launch profiles inject prompts, tools and config into every session"),
    ),
    (
        "launch-noRules",
        Decision::Never("launch profiles inject prompts, tools and config into every session"),
    ),
    (
        "launch-noLsp",
        Decision::Never("launch profiles inject prompts, tools and config into every session"),
    ),
    (
        "launch-planYolo",
        Decision::Never("launch profiles inject prompts, tools and config into every session"),
    ),
    (
        "launch-profile",
        Decision::Never("launch profiles inject prompts, tools and config into every session"),
    ),
    (
        "launch-sessionDir",
        Decision::Never("launch profiles inject prompts, tools and config into every session"),
    ),
    (
        "launch-config",
        Decision::Never("launch profiles inject prompts, tools and config into every session"),
    ),
];
