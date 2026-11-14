use std::collections::HashMap;

/// Supplied by the runtime from the tab owner, never a page-selected window.
#[derive(Debug, PartialEq, Eq)]
pub struct NoticeTarget {
    pub win_id: u64,
    pub wc_id: u64,
    pub tab_id: String,
}

pub struct NoticeRoute {
    pub target: NoticeTarget,
    /// Native Chrome reveal/focus and the runtime's page push, called on the UI thread.
    pub activate: fn(NoticeTarget),
}

#[derive(Default)]
pub struct NoticeRoutes(HashMap<u64, NoticeRoute>);

impl NoticeRoutes {
    pub fn track(&mut self, id: u64, route: NoticeRoute) {
        self.0.insert(id, route);
    }

    /// A click activates once. A dismissal or failed delivery releases the retained target without activating it.
    pub fn event(&mut self, id: u64, name: &str) -> Option<NoticeRoute> {
        match name {
            "click" => self.0.remove(&id),
            "close" | "failed" => {
                self.0.remove(&id);
                None
            }
            _ => None,
        }
    }

    pub fn drain_ids(&mut self) -> impl Iterator<Item = u64> + '_ {
        self.0.drain().map(|(id, _)| id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(tab_id: &str) -> NoticeRoute {
        NoticeRoute {
            target: NoticeTarget {
                win_id: 10,
                wc_id: 20,
                tab_id: tab_id.into(),
            },
            activate: |_| panic!("the registry never activates a window itself"),
        }
    }

    #[test]
    fn a_click_activates_only_its_own_tab_and_only_once() {
        let mut routes = NoticeRoutes::default();
        routes.track(1, route("a"));
        routes.track(2, route("b"));
        assert!(routes.event(1, "show").is_none());
        assert_eq!(routes.event(2, "click").unwrap().target.tab_id, "b");
        assert!(routes.event(2, "click").is_none());
        assert_eq!(routes.event(1, "click").unwrap().target.tab_id, "a");
    }

    #[test]
    fn a_dismissed_or_failed_notice_never_activates_later() {
        let mut routes = NoticeRoutes::default();
        for event in ["close", "failed"] {
            routes.track(1, route("closed"));
            assert!(routes.event(1, event).is_none());
            assert!(routes.event(1, "click").is_none());
        }
        routes.track(1, route("quit"));
        assert_eq!(routes.drain_ids().collect::<Vec<_>>(), [1]);
        assert!(routes.event(1, "click").is_none());
    }
}
