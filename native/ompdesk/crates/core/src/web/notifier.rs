//! Phone notifications driven by typed tab activity. The fixed batch window is shared with
//! desktop banners; device settings, visibility and tab facts are read again when a timer fires.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Weak};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinSet;

use super::deps::{BoxFuture, Clock};
use super::devices::{Device, PushSubscription};
use super::notification_batch::{
    Batcher, Kind, Notice, Shown, Text, flatten, notification_summary,
};
use super::push::{self, Keys, Options, Subscription, Urgency};
use super::store::FileDevices;

pub const COMPLETION_DEBOUNCE_MS: i64 = 1_500;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub stop_reason: String,
    #[serde(default)]
    pub reply: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
}

pub enum Activity {
    Busy {
        tab: String,
    },
    Idle {
        tab: String,
        outcome: Option<Arc<Outcome>>,
    },
    Ask {
        tab: String,
        request: String,
        text: String,
    },
    AskClosed {
        request: String,
    },
    Released {
        tab: String,
    },
}

pub struct TabFacts {
    pub title: String,
    pub busy: bool,
    pub awaiting_connection: bool,
    pub retrying: bool,
}

pub trait Context: Text {
    fn devices(&self) -> Vec<Device>;
    fn device(&self, id: &str) -> Option<Device>;
    fn visible(&self, id: &str) -> bool;
    fn tab(&self, id: &str) -> Option<TabFacts>;
}

pub struct Delivery {
    pub device: String,
    pub subscription: PushSubscription,
    pub payload: Value,
    pub options: Options,
}

struct Ask {
    tab: String,
    pushed: HashSet<String>,
    fed: HashSet<String>,
}
struct Settle {
    at: i64,
    outcome: Arc<Outcome>,
    order: u64,
}

struct Candidate<'a> {
    kind: Kind,
    tab: &'a str,
    title: &'a str,
    body: &'a str,
}

#[derive(Default)]
pub struct Notifier {
    batcher: Batcher,
    key_of: HashMap<String, i64>,
    device_of: HashMap<i64, String>,
    next_key: i64,
    settling: HashMap<String, Settle>,
    announced: HashMap<usize, Weak<Outcome>>,
    asks: HashMap<String, Ask>,
    seq: u64,
}

impl Notifier {
    pub fn handle(&mut self, activity: Activity, now: i64, context: &dyn Context) -> Vec<Delivery> {
        self.announced
            .retain(|_, outcome| outcome.strong_count() > 0);
        match activity {
            Activity::Busy { tab } => {
                self.settling.remove(&tab);
                Vec::new()
            }
            Activity::Idle { tab, outcome } => {
                if let Some(outcome) = outcome
                    && outcome.stop_reason != "aborted"
                    && !self
                        .announced
                        .contains_key(&(Arc::as_ptr(&outcome) as usize))
                {
                    self.settling.insert(
                        tab,
                        Settle {
                            at: now.saturating_add(COMPLETION_DEBOUNCE_MS),
                            outcome,
                            order: self.seq,
                        },
                    );
                    self.seq += 1;
                }
                Vec::new()
            }
            Activity::Ask { tab, request, text } => {
                if self.asks.contains_key(&request) {
                    return Vec::new();
                }
                self.asks.insert(
                    request.clone(),
                    Ask {
                        tab: tab.clone(),
                        pushed: HashSet::new(),
                        fed: HashSet::new(),
                    },
                );
                let title = context.tab(&tab).map_or_else(String::new, |f| f.title);
                let body = if text.is_empty() {
                    context.text("push.ask", &[])
                } else {
                    text
                };
                self.feed(
                    Candidate {
                        kind: Kind::Ask,
                        tab: &tab,
                        title: &title,
                        body: &body,
                    },
                    Some(&request),
                    now,
                    context,
                )
            }
            Activity::AskClosed { request } => self.close_ask(&request, context),
            Activity::Released { tab } => {
                self.settling.remove(&tab);
                let requests: Vec<_> = self
                    .asks
                    .iter()
                    .filter(|(_, ask)| ask.tab == tab)
                    .map(|(id, _)| id.clone())
                    .collect();
                requests
                    .into_iter()
                    .flat_map(|id| self.close_ask(&id, context))
                    .collect()
            }
        }
    }

    pub fn notice(
        &mut self,
        tab: &str,
        kind: Kind,
        title: &str,
        body: &str,
        now: i64,
        context: &dyn Context,
    ) -> Vec<Delivery> {
        self.feed(
            Candidate {
                kind,
                tab,
                title,
                body,
            },
            None,
            now,
            context,
        )
    }

    pub fn next_due(&self) -> Option<i64> {
        self.settling
            .values()
            .map(|s| s.at)
            .chain(self.batcher.next_due())
            .min()
    }

    pub fn advance(&mut self, now: i64, context: &dyn Context) -> Vec<Delivery> {
        let mut due: Vec<_> = self
            .settling
            .iter()
            .filter(|(_, s)| s.at <= now)
            .map(|(tab, s)| (tab.clone(), s.at, s.order))
            .collect();
        due.sort_by_key(|(_, at, order)| (*at, *order));
        let mut deliveries = Vec::new();
        for (tab, at, _) in due {
            // Settle any earlier batch before feeding a completion whose callback would have
            // run later, even when the timer task wakes after both deadlines.
            for shown in self.batcher.advance(at, context) {
                if let Some(delivery) = self.show(shown, context) {
                    deliveries.push(delivery);
                }
            }
            let Some(settle) = self.settling.remove(&tab) else {
                continue;
            };
            let Some(facts) = context
                .tab(&tab)
                .filter(|f| !f.busy && !f.awaiting_connection && !f.retrying)
            else {
                continue;
            };
            self.announced.insert(
                Arc::as_ptr(&settle.outcome) as usize,
                Arc::downgrade(&settle.outcome),
            );
            let (kind, body) = if settle.outcome.stop_reason == "error" {
                let detail = settle
                    .outcome
                    .error_message
                    .as_deref()
                    .map(|s| clip(s, 120))
                    .unwrap_or_default();
                (
                    Kind::Error,
                    if detail.is_empty() {
                        context.text("push.error", &[])
                    } else {
                        context.text("push.errorDetail", &[("error", detail)])
                    },
                )
            } else {
                let summary = settle
                    .outcome
                    .reply
                    .as_deref()
                    .map(|s| notification_summary(s, 160))
                    .unwrap_or_default();
                (
                    Kind::Completion,
                    if summary.is_empty() {
                        context.text("push.complete", &[])
                    } else {
                        summary
                    },
                )
            };
            deliveries.extend(self.feed(
                Candidate {
                    kind,
                    tab: &tab,
                    title: &facts.title,
                    body: &body,
                },
                None,
                at,
                context,
            ));
        }
        for shown in self.batcher.advance(now, context) {
            if let Some(delivery) = self.show(shown, context) {
                deliveries.push(delivery);
            }
        }
        deliveries
    }

    pub fn drop_device(&mut self, id: &str) {
        if let Some(key) = self.key_of.remove(id) {
            self.batcher.drop_window(key);
            self.device_of.remove(&key);
        }
        for ask in self.asks.values_mut() {
            ask.fed.remove(id);
            ask.pushed.remove(id);
        }
    }

    pub fn dispose(&mut self) {
        self.settling.clear();
        self.batcher.dispose();
        self.asks.clear();
    }

    fn feed(
        &mut self,
        candidate: Candidate<'_>,
        request: Option<&str>,
        now: i64,
        context: &dyn Context,
    ) -> Vec<Delivery> {
        let Candidate {
            kind,
            tab,
            title,
            body,
        } = candidate;
        let mut deliveries = Vec::new();
        for device in context.devices() {
            let settings = device.push.as_ref().cloned().unwrap_or_default();
            if settings.subscription.is_none()
                || !settings.categories.iter().any(|k| k == kind.name())
                || context.visible(&device.device_id)
            {
                continue;
            }
            if let Some(ask) = request.and_then(|id| self.asks.get_mut(id)) {
                ask.fed.insert(device.device_id.clone());
            }
            let key = match self.key_of.get(&device.device_id) {
                Some(key) => *key,
                None => {
                    self.next_key += 1;
                    self.key_of.insert(device.device_id.clone(), self.next_key);
                    self.device_of
                        .insert(self.next_key, device.device_id.clone());
                    self.next_key
                }
            };
            let title = clip(title, 120);
            let notice = Notice {
                title: if title.is_empty() {
                    "OMPdesk".into()
                } else {
                    title
                },
                body: clip(body, 240),
                tab: Some(tab.into()),
                kind: Some(kind),
            };
            if let Some(shown) = self.batcher.notify(key, notice, now)
                && let Some(delivery) = self.show(shown, context)
            {
                deliveries.push(delivery);
            }
        }
        deliveries
    }

    fn show(&mut self, shown: Shown, context: &dyn Context) -> Option<Delivery> {
        let id = self.device_of.get(&shown.window)?;
        let device = context.device(id)?;
        let settings = device.push.unwrap_or_default();
        let subscription = settings.subscription?;
        if context.visible(id) {
            return None;
        }
        let kind = shown.notice.kind?;
        let mut payload = json!({ "v":1, "kind":kind.name(), "title":shown.notice.title, "body":if settings.hide_content { "" } else { &shown.notice.body } });
        if let Some(counts) = &shown.summary {
            payload["kind"] = "batch".into();
            payload["tag"] = shown
                .first_tab
                .as_deref()
                .map(tab_tag)
                .unwrap_or_else(|| "batch".into())
                .into();
            if shown.replace_first {
                payload["silent"] = true.into();
            }
            if counts.total() == 1
                && let Some(tab) = &shown.notice.tab
            {
                payload["tabId"] = tab.clone().into();
            }
        } else {
            if settings.hide_content {
                payload["title"] = context
                    .text(&format!("push.hidden.{}", kind.name()), &[])
                    .into();
            }
            payload["tag"] = shown
                .notice
                .tab
                .as_deref()
                .map(tab_tag)
                .unwrap_or_else(|| "batch".into())
                .into();
            if let Some(tab) = &shown.notice.tab {
                payload["tabId"] = tab.clone().into();
                if kind == Kind::Ask {
                    for ask in self.asks.values_mut().filter(|a| a.tab == *tab) {
                        ask.pushed.insert(id.clone());
                    }
                }
            }
        }
        Some(Delivery {
            device: id.clone(),
            subscription,
            payload,
            options: options(kind),
        })
    }

    fn close_ask(&mut self, request: &str, context: &dyn Context) -> Vec<Delivery> {
        let Some(ask) = self.asks.remove(request) else {
            return Vec::new();
        };
        let remaining: Vec<_> = self.asks.values().filter(|a| a.tab == ask.tab).collect();
        if remaining.is_empty() {
            for key in self.device_of.keys() {
                self.batcher.retract(*key, &ask.tab);
            }
        }
        let mut deliveries = Vec::new();
        for id in ask.pushed {
            if context.visible(&id) || remaining.iter().any(|a| a.fed.contains(&id)) {
                continue;
            }
            if let Some(subscription) = context
                .device(&id)
                .and_then(|d| d.push)
                .and_then(|p| p.subscription)
            {
                deliveries.push(Delivery { device: id, subscription, payload: json!({"v":1,"kind":"clear","title":"","body":"","tabId":ask.tab,"tag":tab_tag(&ask.tab),"silent":true}), options: Options { ttl:120, urgency:Urgency::Normal, topic:None } });
            }
        }
        deliveries
    }
}

fn tab_tag(tab: &str) -> String {
    format!("tab:{tab}")
}
fn options(kind: Kind) -> Options {
    Options {
        ttl: if kind == Kind::Ask { 21600 } else { 3600 },
        urgency: if kind == Kind::Ask {
            Urgency::High
        } else {
            Urgency::Normal
        },
        topic: None,
    }
}
fn clip(text: &str, max: usize) -> String {
    let flat = flatten(text);
    if flat.encode_utf16().count() <= max {
        flat
    } else {
        format!(
            "{}…",
            crate::json::utf16_prefix(&flat, max.saturating_sub(1))
        )
    }
}

pub trait Sender: Send + Sync {
    fn send(&self, delivery: Delivery) -> BoxFuture<'_, ()>;
}

/// Uses the same VAPID store, encryption and HTTP transport as `push.send`. A rejected old endpoint
/// is forgotten only if it is still this device's subscription when the request ends.
pub struct NativeSender {
    pub user_data: PathBuf,
    pub devices: Arc<FileDevices>,
}
impl Sender for NativeSender {
    fn send(&self, delivery: Delivery) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let payload = match serde_json::to_vec(&delivery.payload) {
                Ok(payload) => payload,
                Err(error) => {
                    eprintln!("web push failed: {error}");
                    return;
                }
            };
            if payload.len() > 3800 {
                eprintln!(
                    "web push not sent: payload of {} bytes is over the limit",
                    payload.len()
                );
                return;
            }
            let Some(vapid) = push::loaded(&self.user_data) else {
                eprintln!("web push failed: no VAPID keypair loaded");
                return;
            };
            let endpoint = delivery.subscription.endpoint;
            let subscription = Subscription {
                endpoint: endpoint.clone(),
                keys: Keys {
                    p256dh: delivery.subscription.p256dh,
                    auth: delivery.subscription.auth,
                },
            };
            match push::send_message(
                &vapid,
                &subscription,
                &payload,
                &delivery.options,
                Duration::from_secs(10),
            )
            .await
            {
                Ok(404 | 410) => {
                    self.devices
                        .apply(None, |book| book.forget_push(&delivery.device, &endpoint));
                }
                Ok(status) if (200..300).contains(&status) => {}
                Ok(status) => eprintln!("web push refused with status {status}"),
                Err(error) => eprintln!("web push failed: {}", error.message),
            }
        })
    }
}

enum Message {
    Activity(Activity),
    Notice {
        tab: String,
        kind: Kind,
        title: String,
        body: String,
    },
    Drop(String),
    Stop(oneshot::Sender<()>),
}

pub struct Service {
    tx: mpsc::UnboundedSender<Message>,
    task: tokio::task::JoinHandle<()>,
}
impl Service {
    pub fn start(context: Arc<dyn Context>, sender: Arc<dyn Sender>, clock: Clock) -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            let mut notifier = Notifier::default();
            let mut sends = JoinSet::new();
            loop {
                let wait = notifier
                    .next_due()
                    .map(|due| Duration::from_millis(due.saturating_sub(clock()).max(0) as u64));
                let mut stop = None;
                let deliveries = tokio::select! {
                    message = rx.recv() => match message {
                        Some(Message::Activity(activity)) => notifier.handle(activity, clock(), &*context),
                        Some(Message::Notice {tab,kind,title,body}) => notifier.notice(&tab,kind,&title,&body,clock(),&*context),
                        Some(Message::Drop(id)) => { notifier.drop_device(&id); Vec::new() },
                        Some(Message::Stop(done)) => { stop = Some(done); Vec::new() },
                        None => break,
                    },
                    () = async { if let Some(wait) = wait { tokio::time::sleep(wait).await } else { std::future::pending().await } } => notifier.advance(clock(), &*context),
                    _ = sends.join_next(), if !sends.is_empty() => Vec::new(),
                };
                if let Some(done) = stop {
                    notifier.dispose();
                    sends.abort_all();
                    while sends.join_next().await.is_some() {}
                    let _ = done.send(());
                    break;
                }
                for delivery in deliveries {
                    let sender = sender.clone();
                    sends.spawn(async move { sender.send(delivery).await });
                }
            }
        });
        Self { tx, task }
    }
    pub fn activity(&self, activity: Activity) {
        let _ = self.tx.send(Message::Activity(activity));
    }
    pub fn notice(&self, tab: &str, kind: Kind, title: &str, body: &str) {
        let _ = self.tx.send(Message::Notice {
            tab: tab.into(),
            kind,
            title: title.into(),
            body: body.into(),
        });
    }
    pub fn drop_device(&self, id: &str) {
        let _ = self.tx.send(Message::Drop(id.into()));
    }
    pub async fn stop(self) {
        let (tx, rx) = oneshot::channel();
        let _ = self.tx.send(Message::Stop(tx));
        let _ = rx.await;
        let _ = self.task.await;
    }
}

#[cfg(test)]
#[path = "notifier_tests.rs"]
mod tests;
