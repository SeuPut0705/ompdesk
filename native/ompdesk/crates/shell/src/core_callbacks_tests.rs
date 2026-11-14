use super::*;
use std::sync::atomic::AtomicUsize;

struct Observed {
    events: mpsc::Sender<(String, Value, Option<Vec<u8>>)>,
    disconnected: mpsc::Sender<()>,
}
impl Events for Observed {
    fn event(&self, name: String, data: Value, bin: Option<Vec<u8>>) {
        self.events.send((name, data, bin)).unwrap();
    }
    fn disconnected(&self) {
        self.disconnected.send(()).unwrap();
    }
}
fn events() -> Arc<dyn Events> {
    let (events, _) = mpsc::channel();
    let (disconnected, _) = mpsc::channel();
    Arc::new(Observed {
        events,
        disconnected,
    })
}
fn call(id: u64, writer: &mpsc::Sender<Vec<u8>>) -> Call {
    Call::new(
        id,
        "test.platform".into(),
        Value::Null,
        None,
        writer.clone(),
    )
}
fn answer(receiver: &mpsc::Receiver<Vec<u8>>) -> Value {
    serde_json::from_slice(&receiver.recv().unwrap()).unwrap()
}

#[test]
fn a_cancelled_queued_operation_never_reaches_the_platform() {
    let (writer, answers) = mpsc::channel();
    let (started, starting) = mpsc::channel();
    let (release, blocked) = mpsc::channel();
    let executed = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&executed);
    let callbacks = Callbacks::with_executor(
        events(),
        Box::new(move |call| {
            observed.fetch_add(1, Ordering::SeqCst);
            started.send(()).unwrap();
            blocked.recv().unwrap();
            call.ok(Value::Null, None);
        }),
    )
    .unwrap();
    callbacks.request(call(1, &writer));
    starting.recv().unwrap();
    callbacks.request(call(2, &writer));
    callbacks.cancel(2);
    release.send(()).unwrap();
    drop(release);
    assert_eq!(answer(&answers)["id"], 1);
    let cancelled = answer(&answers);
    assert_eq!(cancelled["id"], 2);
    assert_eq!(cancelled["error"]["code"], "cancelled");
    callbacks.stop();
    assert_eq!(executed.load(Ordering::SeqCst), 1);
    assert!(callbacks.pending.lock().unwrap().is_empty());
}

#[test]
fn stopping_joins_active_work_and_rejects_further_admission() {
    let (writer, answers) = mpsc::channel();
    let (started, starting) = mpsc::channel();
    let (release, blocked) = mpsc::channel();
    let order = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&order);
    let callbacks = Arc::new(
        Callbacks::with_executor(
            events(),
            Box::new(move |call| {
                started.send(()).unwrap();
                blocked.recv().unwrap();
                observed.lock().unwrap().push("finished");
                call.ok(Value::Null, None);
            }),
        )
        .unwrap(),
    );
    callbacks.request(call(1, &writer));
    starting.recv().unwrap();
    callbacks.request(call(2, &writer));
    callbacks.cancel(2);
    let stopping = Arc::clone(&callbacks);
    let held = Arc::clone(&order);
    let stop = thread::spawn(move || {
        stopping.stop();
        held.lock().unwrap().push("stopped");
    });
    release.send(()).unwrap();
    drop(release);
    stop.join().unwrap();
    assert_eq!(*order.lock().unwrap(), vec!["finished", "stopped"]);
    callbacks.request(call(3, &writer));
    let replies = [answer(&answers), answer(&answers), answer(&answers)];
    assert_eq!(replies[2]["id"], 3);
    assert_eq!(replies[2]["error"]["code"], "unavailable");
}
