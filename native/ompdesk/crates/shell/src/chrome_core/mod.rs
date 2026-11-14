//! The pure rules of the shell's `chrome` module (PROTOCOL.md §15.4: windows, the application menu, the tray, the quit,
//! deep links, the GPU fallback and the main-thread watchdog), moved from `src/main/{window,menu,tray,app-quit,
//! deep-link,gpu-fallback,hang-watchdog,app-icon}.ts` and their helper files. CEF-free: `modules/chrome/` carries the
//! decisions out. `captured/<area>.json` holds the TypeScript's own answers (`scripts/shell-port/capture-chrome.ts`;
//! one file per area so the areas are captured independently), and each area's tests replay its file.

pub mod deep_link;
pub mod gpu;
pub mod hang;
pub mod launch;
pub mod menu;
pub mod quit;
pub mod tray;
pub mod window;

#[cfg(test)]
pub(crate) mod captured {
    use serde::Deserialize;
    use serde_json::Value;

    /// One recorded step of the TypeScript (`scripts/shell-port/capture-chrome.ts` `Step`).
    #[derive(Deserialize, Debug)]
    pub struct Step {
        #[serde(rename = "fn")]
        pub function: String,
        pub input: Value,
        pub output: Value,
    }

    #[derive(Deserialize)]
    struct File {
        steps: Vec<Step>,
    }

    fn source(area: &str) -> &'static str {
        match area {
            "window" => include_str!("captured/window.json"),
            "menu" => include_str!("captured/menu.json"),
            "tray" => include_str!("captured/tray.json"),
            "quit" => include_str!("captured/quit.json"),
            "deeplink" => include_str!("captured/deeplink.json"),
            "hang" => include_str!("captured/hang.json"),
            "gpu" => include_str!("captured/gpu.json"),
            other => panic!("no captured area {other:?}"),
        }
    }

    /// Every step captured for `area`; an area captured empty fails the test (the capture was not run).
    pub fn steps(area: &str) -> Vec<Step> {
        let file: File = serde_json::from_str(source(area)).expect("captured file parses");
        assert!(!file.steps.is_empty(), "area {area:?} captured nothing");
        file.steps
    }

    /// The steps of `area` recorded for one function or scenario (`<file>#<name>`).
    pub fn of(area: &str, function: &str) -> Vec<Step> {
        let steps: Vec<Step> = steps(area)
            .into_iter()
            .filter(|step| step.function == function)
            .collect();
        assert!(!steps.is_empty(), "area {area:?} has no step of {function}");
        steps
    }
}
