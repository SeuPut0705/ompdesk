use super::*;
use serde_json::json;
use std::cell::{Cell, RefCell};

thread_local! {
    static CLOSES: Cell<usize> = const { Cell::new(0) };
}

fn unused_open(_: u64, _: &RawValue, _: Out) -> Result<(), Fault> {
    Ok(())
}
fn unused_call(_: u64, _: &str, _: &RawValue) -> Outcome {
    Outcome::done()
}
fn close(_: u64) {
    CLOSES.with(|count| count.set(count.get() + 1));
}
static KIND: Kind = Kind {
    name: "native-test",
    open: unused_open,
    call: unused_call,
    close,
};

#[derive(Default)]
struct Sink {
    events: RefCell<Vec<Value>>,
    out: Cell<Option<Out>>,
    answer: RefCell<Option<oneshot::Sender<Result<Value, Fault>>>>,
}

impl NativeSink for Sink {
    fn item(&self, item: Value) {
        self.events.borrow_mut().push(item.clone());
        if item == json!("reenter") {
            self.out.get().unwrap().push(&json!("nested"));
        }
    }

    fn ask(
        &self,
        question: String,
        payload: Value,
        sync: bool,
    ) -> LocalFuture<Result<Value, Fault>> {
        self.events
            .borrow_mut()
            .push(json!([question, payload, sync]));
        let (tx, rx) = oneshot::channel();
        *self.answer.borrow_mut() = Some(tx);
        Box::pin(async move { rx.await.unwrap() })
    }
}

#[test]
fn native_delivery_order_reentrancy_and_generation_fence() {
    let (done, result) = std::sync::mpsc::channel();
    post(move || {
        CLOSES.with(|count| count.set(0));
        let sink = Rc::new(Sink::default());
        let out = bind_native(991_001, &KIND, sink.clone(), |_| Ok(())).unwrap();
        sink.out.set(Some(out));
        out.push(&json!("before"));
        let answer = out.ask("question", &json!({"x": 1}));
        out.push(&json!("reenter"));
        let observed = Rc::new(RefCell::new(Vec::new()));
        let log = observed.clone();
        spawn(async move {
            log.borrow_mut().push(answer.await.unwrap());
        });
        drain();
        assert!(sink.events.borrow().is_empty());
        flush();
        assert_eq!(
            *sink.events.borrow(),
            vec![
                json!("before"),
                json!(["question", {"x": 1}, true]),
                json!("reenter")
            ]
        );
        flush();
        assert_eq!(sink.events.borrow().last(), Some(&json!("nested")));
        drain();
        sink.answer
            .borrow_mut()
            .take()
            .unwrap()
            .send(Ok(json!("answer")))
            .unwrap();
        drain();
        assert_eq!(*observed.borrow(), vec![json!("answer")]);

        let waiting = out.ask_later("later", &json!({}));
        let failed = Rc::new(RefCell::new(None));
        let save = failed.clone();
        spawn(async move {
            *save.borrow_mut() = Some(waiting.await.unwrap_err().code);
        });
        drain();
        flush();
        drain();
        let late = sink.answer.borrow_mut().take().unwrap();
        out.close();
        out.close();
        let replacement = bind_native(991_001, &KIND, sink.clone(), |_| Ok(())).unwrap();
        let replacement_answer = replacement.ask("replacement", &json!({}));
        let replacement_result = Rc::new(RefCell::new(None));
        let save_replacement = replacement_result.clone();
        spawn(async move {
            *save_replacement.borrow_mut() = Some(replacement_answer.await.unwrap());
        });
        drain();
        flush();
        drain();
        let current = sink.answer.borrow_mut().take().unwrap();
        assert!(!out.open());
        out.push(&json!("stale"));
        out.close();
        assert!(replacement.open());
        let _ = late.send(Ok(json!("late")));
        drain();
        assert!(replacement_result.borrow().is_none());
        current.send(Ok(json!("current"))).unwrap();
        drain();
        assert_eq!(*replacement_result.borrow(), Some(json!("current")));
        flush();
        assert_eq!(failed.borrow().as_deref(), Some("closed"));
        assert!(!sink.events.borrow().contains(&json!("stale")));
        replacement.close();
        assert_eq!(CLOSES.with(Cell::get), 2);

        let bad = bind_native(991_002, &KIND, sink.clone(), |out| {
            out.push(&json!("failed"));
            let _pending = out.ask("failed", &json!({}));
            Err(Fault::new("bad", "bad"))
        });
        assert!(bad.is_err());
        flush();
        assert!(!sink.events.borrow().contains(&json!("failed")));
        let replacement = bind_native(991_002, &KIND, sink, |_| Ok(())).unwrap();
        replacement.close();
        done.send(()).unwrap();
    });
    result.recv().unwrap();
}
