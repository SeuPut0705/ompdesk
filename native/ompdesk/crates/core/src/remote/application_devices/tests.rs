//! Isolated application policy over native stores and encrypted links. The Host is an effect double, not evidence
//! that Base's pool/Web/settings adapters or the desktop artifact have been assembled.
use super::*;
use crate::remote::devices::native::{
    self, Accepted, AccessPolicy, AuthenticatedPeer, Effects, Visitor,
};
use crate::remote::identity::load_or_create;
use crate::remote::quota::PeerStore;
use crate::remotebytes::native::{Words, tests::Dir};
use crate::server::test_events;
struct DeviceEffects;
impl Effects for DeviceEffects {
    fn policy<'a>(&'a self, _: &'a str, _: &'a str) -> Task<'a, Result<AccessPolicy, Fault>> {
        Box::pin(async { panic!("not a tailnet/gate test") })
    }
    fn approve<'a>(&'a self, _: Visitor, _: String) -> Task<'a, Result<bool, Fault>> {
        Box::pin(async { panic!("not an approval test") })
    }
    fn accept<'a>(
        &'a self,
        _: AuthenticatedPeer,
        _: Value,
        _: RemoteRequests,
        _: u64,
    ) -> Task<'a, Result<Accepted, Fault>> {
        Box::pin(async { panic!("not a native assembly test") })
    }
    fn changed(&self, _: Value) {}
    fn computers(&self, _: Vec<Map<String, Value>>) {}
    fn adopt_login(&self, _: &str) {}
    fn migrated(&self, _: f64, _: Vec<String>, _: Vec<String>) {}
}
struct AppHost {
    prefs: Mutex<Preferences>,
    output: mpsc::UnboundedSender<Output>,
}
impl Host for AppHost {
    fn preferences(&self) -> Preferences {
        lock(&self.prefs).clone()
    }
    fn save(&self, change: Saved) -> Result<(), Fault> {
        let mut prefs = lock(&self.prefs);
        match change {
            Saved::HostEnabled(on) => prefs.host_enabled = on,
            Saved::DeviceName(name) => prefs.device_name = Some(name),
            Saved::Forgotten(names) => prefs.forgotten = names,
            Saved::Migrated(_) => {}
        }
        Ok(())
    }
    fn hostname(&self) -> String {
        "Mac.LOCAL".into()
    }
    fn keeping_awake(&self) -> bool {
        false
    }
    fn hosted_running(&self) -> Vec<String> {
        Vec::new()
    }
    fn allows_peer(&self, _: &str) -> bool {
        true
    }
    fn block(&self, _: Block) -> Result<(), Fault> {
        panic!("not a Web block adapter test")
    }
    fn close_peer<'a>(&'a self, _: &'a str) -> Task<'a, Result<(), Fault>> {
        Box::pin(async { Ok(()) })
    }
    fn close_hosted<'a>(&'a self) -> Task<'a, Result<(), Fault>> {
        Box::pin(async { Ok(()) })
    }
    fn tailscale_action<'a>(&'a self, _: TailscaleAction) -> Task<'a, Result<(), Fault>> {
        Box::pin(async { panic!("not a machine setup test") })
    }
    fn offline_message(&self) -> String {
        "offline".into()
    }
    fn unanswered_message(&self, _: &str) -> String {
        "waiting".into()
    }
    fn sign_in_failure(&self, _: &str) -> Words {
        Words::default()
    }
    fn output(&self, event: Output) {
        let _ = self.output.send(event);
    }
}
fn rig(dir: &Dir) -> (Arc<Service<AppHost>>, mpsc::UnboundedReceiver<Output>) {
    let (events, _frames) = mpsc::unbounded_channel();
    let core = Devices::new(
        native::Config {
            events: test_events(&events),
            identity: Arc::new(load_or_create(dir.path()).unwrap()),
            user_data: dir.path().to_owned(),
            app_version: "1.0.0".into(),
            name: "Mac".into(),
            loopback: false,
            port: None,
            port_setting: None,
            refuse: HashMap::new(),
            liveness: None,
            traffic: false,
            traffic_ms: None,
            keep_awake: None,
            keep_awake_enabled: true,
            migrated_at: Some(0.0),
        },
        0,
        Arc::new(DeviceEffects),
    );
    lock(&core.peer_store()).put(json!({"deviceId":"peer","name":"peer","staticPub":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","nodeId":"node","login":"login","pairedAt":0}).as_object().unwrap().clone()).unwrap();
    let quota = Arc::new(PeerQuota::new(Arc::new(PeerStore(core.peer_store()))));
    let (output, received) = mpsc::unbounded_channel();
    let host = Arc::new(AppHost {
        prefs: Mutex::new(Preferences {
            host_enabled: false,
            device_name: None,
            keep_awake: true,
            keep_tabs_on_quit: true,
            forgotten: Vec::new(),
        }),
        output,
    });
    (
        Service::new(
            core,
            host,
            quota,
            Arc::new(ContentCache::new(dir.path().to_owned())),
        ),
        received,
    )
}
#[tokio::test(start_paused = true)]
async fn quota_notifications_are_coalesced_and_read_the_single_native_peer_record() {
    let dir = Dir::new();
    let (service, mut output) = rig(&dir);
    assert_eq!(service.device_name(), "Mac");
    service
        .set_limits(
            "peer",
            Limits {
                requests_per_day: Some(5.0),
                tokens_per_day: None,
            },
        )
        .unwrap();
    let held = service.quota.reserve("peer", 1.0).unwrap();
    service.quota.record("peer", 0.0, 17.0).unwrap();
    held.refund().unwrap();
    service
        .input
        .send(Input::Output(Output::HostOnline("barrier".into())))
        .unwrap();
    while !matches!(&output.recv().await.unwrap(),Output::HostOnline(id) if id=="barrier") {}
    tokio::time::advance(Duration::from_secs(1)).await;
    let Output::State(state) = output.recv().await.unwrap() else {
        panic!("quota broadcast expected")
    };
    assert_eq!(
        state["host"]["peers"][0]["usage"]["requests"].as_f64(),
        Some(0.0)
    );
    assert_eq!(
        state["host"]["peers"][0]["usage"]["tokens"].as_f64(),
        Some(17.0)
    );
    assert!(output.try_recv().is_err());
    service.dispose().await.unwrap();
}
#[tokio::test]
async fn a_known_offline_host_keeps_a_tab_waiting_without_accepting_a_user_answer() {
    let dir = Dir::new();
    let (service, _output) = rig(&dir);
    let (events, _frames) = mpsc::unbounded_channel();
    let record = json!({"deviceId":"host","name":"Host","staticPub":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","nodeId":"node-host","addresses":[],"pairedAt":0});
    lock(&crate::remote::store::open(dir.path(), Kind::Hosts))
        .put(record.as_object().unwrap().clone())
        .unwrap();
    let client = Client::new(super::super::devices::client::ClientOptions {
        events: test_events(&events),
        identity: Arc::new(load_or_create(dir.path()).unwrap()),
        host: record.as_object().unwrap().clone(),
        name: "Mac".into(),
        app_version: "1.0.0".into(),
        capabilities: Map::new(),
        liveness: Default::default(),
        store: None,
        addresses: Box::new(super::super::devices::client::Stored),
    });
    let sessions = HostSessionList::new("host".into(), Arc::new(|_| {}));
    lock(&service.state).links.insert(
        "host".into(),
        Link {
            serial: 1,
            client,
            change: None,
            requests: None,
            tabs: HashMap::new(),
            closes: Arc::default(),
            sessions,
            summaries: None,
            remote_opened: None,
            web_url: None,
            reading_summaries: false,
        },
    );
    let options = TabOptions {
        rtab: "tab".into(),
        cwd: "/workspace".into(),
        kind: "agent".into(),
        fresh: false,
        session_path: Some("/session".into()),
        offline_message: String::new(),
        unanswered_message: String::new(),
        execution_host: "visible-other-host".into(),
        sign_in_failure: Words::default(),
    };
    let (tab, mut events) = service.create_tab("host", options).unwrap();
    tab.start();
    let status = events.recv().await.unwrap();
    assert_eq!(status.name, "status");
    let status = events.recv().await.unwrap();
    assert_eq!(status.arg["reconnecting"], true);
    assert_eq!(
        tab.side_channel(json!({"type":"extension_ui_response","id":"ask"}))
            .await
            .unwrap_err()
            .fault
            .code,
        "remote_offline"
    );
    service.release_tab("host", "tab", &tab, true);
    assert!(lock(&service.state).links["host"].tabs.is_empty());
    service.dispose().await.unwrap();
}
