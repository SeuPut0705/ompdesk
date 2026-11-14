use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicUsize, Ordering};

use ompdesk_app_contract::OwnerIssuer;
use tokio::sync::Notify;

use super::*;

struct ObservedEffects {
    capture_entered: Notify,
    capture_resume: Notify,
    releases: AtomicUsize,
    renames: AtomicUsize,
    invalidations: AtomicUsize,
    owners: Mutex<Vec<Owner>>,
}

struct CaptureHost {
    admitted: Owner,
    effects: Arc<ObservedEffects>,
}

impl Host for CaptureHost {
    type Runtime = ();
    type Notices = ();

    fn authorize(&self, owner: &Owner, target: Target) -> Result<Target, Fault> {
        assert_eq!(owner, &self.admitted);
        self.effects.owners.lock().unwrap().push(owner.clone());
        Ok(target)
    }

    fn capture(&self, _: &Target) -> Effect<Captured<(), ()>> {
        let effects = Arc::clone(&self.effects);
        Box::pin(async move {
            effects.capture_entered.notify_one();
            effects.capture_resume.notified().await;
            Ok(Captured {
                holders: vec![Holder {
                    runtime: (),
                    hosted: false,
                    activity: Activity::Idle,
                    state: RuntimeState::Ready,
                }],
                notices: (),
            })
        })
    }

    fn release(&self, _: &Holder<()>) -> Effect<Release> {
        self.effects.releases.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(Release { exits: Vec::new(), failure: None }) })
    }

    fn stop(&self, _: &Holder<()>) -> Effect<()> {
        panic!("stop is not part of the capture cancellation regression")
    }

    fn rename_live(&self, _: &Holder<()>, _: &str) -> Effect<()> {
        self.effects.renames.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }

    fn rename_stored(&self, _: &Target, _: &str, _: Scope) -> Effect<()> {
        panic!("a ready live holder must not start stored rename")
    }

    fn note_name(&self, _: &Holder<()>, _: &str) -> Effect<()> {
        panic!("a ready live holder must not receive a dormant name update")
    }

    fn delete_stored(&self, _: &Target, _: Scope) -> Effect<()> {
        panic!("a cancelled capture must never reach storage deletion")
    }

    fn move_stored(&self, _: &Target, _: PathBuf, _: Scope) -> Effect<String> {
        panic!("move is not part of the capture cancellation regression")
    }

    fn invalidate(&self, _: &Target) -> Effect<()> {
        self.effects.invalidations.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }

    fn notify_deleted(&self, _: &Target, _: ()) -> Effect<()> {
        panic!("a cancelled capture must never notify deletion")
    }
}

async fn cancelled_capture(mutation: Mutation) {
    // Test-only authenticated admission uses the shared opaque type, not a page-constructed owner or registry.
    let issuer = OwnerIssuer::new(7);
    let owner = issuer.admit_authenticated().unwrap();
    let effects = Arc::new(ObservedEffects {
        capture_entered: Notify::new(),
        capture_resume: Notify::new(),
        releases: AtomicUsize::new(0),
        renames: AtomicUsize::new(0),
        invalidations: AtomicUsize::new(0),
        owners: Mutex::new(Vec::new()),
    });
    let authority = Arc::new(SessionAuthority::open(None));
    let coordinator = Coordinator::new(Config {
        host: Arc::new(CaptureHost {
            admitted: owner.clone(),
            effects: Arc::clone(&effects),
        }),
        authority: Arc::clone(&authority),
        now_ms: || 0.0,
    });
    let scope = Scope::detached();
    let cancellation = scope.cancellation();
    let task_owner = owner.clone();
    let work = tokio::spawn(async move {
        coordinator.execute(
            &task_owner,
            Target { path: "/isolated/capture-cancel.jsonl".to_owned(), device: None },
            mutation,
            scope,
        ).await
    });
    effects.capture_entered.notified().await;
    cancellation.cancel();
    effects.capture_resume.notify_one();
    let outcome = work.await.unwrap();
    assert_eq!(effects.releases.load(Ordering::SeqCst), 0, "cancelled capture released a holder");
    assert_eq!(effects.renames.load(Ordering::SeqCst), 0, "cancelled capture renamed the live session");
    assert_eq!(effects.invalidations.load(Ordering::SeqCst), 0);
    assert_eq!(outcome, Err(Error::Effect(Fault::cancelled())));
    assert_eq!(*effects.owners.lock().unwrap(), vec![owner]);
    assert!(!authority.any_in_progress());
    assert!(authority.list().is_empty());
}

#[tokio::test]
async fn cancellation_during_capture_never_closes_the_idle_holder() {
    cancelled_capture(Mutation::Delete).await;
}

#[tokio::test]
async fn cancellation_during_capture_never_renames_the_ready_holder() {
    cancelled_capture(Mutation::Rename("new title".to_owned())).await;
}
