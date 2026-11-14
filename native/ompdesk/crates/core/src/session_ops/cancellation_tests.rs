use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicUsize, Ordering};

use ompdesk_app_contract::OwnerIssuer;
use tokio::sync::Notify;

use super::*;

#[derive(Default)]
struct ObservedEffects {
    capture_entered: Notify,
    capture_resume: Notify,
    releases: AtomicUsize,
    renames: AtomicUsize,
    invalidations: AtomicUsize,
    owners: Mutex<Vec<Owner>>,
    release_entered: Notify,
    release_resume: Notify,
    exit_entered: Notify,
    exit_resume: Notify,
}

struct CaptureHost {
    admitted: Owner,
    effects: Arc<ObservedEffects>,
    pause_release: bool,
    holders: usize,
}

impl Host for CaptureHost {
    type Runtime = ();
    type Notices = ();

    fn authorize(&self, owner: &Owner, target: Target) -> Result<Target, Fault> {
        assert_eq!(owner, &self.admitted);
        self.effects.owners.lock().unwrap().push(owner.clone());
        Ok(target)
    }

    fn capture(&self, owner: &Owner, _: &Target) -> Effect<Captured<(), ()>> {
        assert_eq!(owner, &self.admitted);
        let effects = Arc::clone(&self.effects);
        let holders = self.holders;
        Box::pin(async move {
            effects.capture_entered.notify_one();
            effects.capture_resume.notified().await;
            Ok(Captured {
                holders: (0..holders).map(|_| Holder {
                    runtime: (),
                    hosted: false,
                    activity: Activity::Idle,
                    state: RuntimeState::Ready,
                }).collect(),
                notices: (),
            })
        })
    }

    fn release(&self, _: &Holder<()>) -> Effect<Release> {
        let effects = Arc::clone(&self.effects);
        effects.releases.fetch_add(1, Ordering::SeqCst);
        let pause = self.pause_release;
        Box::pin(async move {
            if !pause {
                return Ok(Release { exits: Vec::new(), failure: None });
            }
            effects.release_entered.notify_one();
            effects.release_resume.notified().await;
            let exit: Effect<()> = Box::pin(async move {
                effects.exit_entered.notify_one();
                effects.exit_resume.notified().await;
                Ok(())
            });
            Ok(Release { exits: vec![exit], failure: None })
        })
    }

    fn stop(&self, _: &Holder<()>) -> Effect<()> {
        panic!("stop is not part of the capture cancellation regression")
    }

    fn rename_live(&self, _: &Holder<()>, _: &str) -> Effect<()> {
        self.effects.renames.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }

    fn rename_stored(&self, _: &Owner, _: &Target, _: &str, _: ReadyStoredClaim, _: Scope) -> Effect<()> {
        panic!("a ready live holder must not start stored rename")
    }

    fn note_name(&self, _: &Holder<()>, _: &str) -> Effect<()> {
        panic!("a ready live holder must not receive a dormant name update")
    }

    fn delete_stored(&self, _: &Owner, _: &Target, _: Scope) -> Effect<()> {
        panic!("a cancelled capture must never reach storage deletion")
    }

    fn move_stored(&self, _: &Owner, _: &Target, _: PathBuf, _: ReadyStoredClaim, _: Scope) -> Effect<String> {
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
    let effects = Arc::new(ObservedEffects::default());
    let authority = Arc::new(SessionAuthority::open(None));
    let coordinator = Coordinator::new(Config {
        host: Arc::new(CaptureHost {
            admitted: owner.clone(),
            effects: Arc::clone(&effects),
            pause_release: false,
            holders: 1,
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

#[tokio::test]
async fn cancellation_after_release_joins_its_receipt_and_keeps_admission_closed_until_cleanup() {
    let issuer = OwnerIssuer::new(8);
    let owner = issuer.admit_authenticated().unwrap();
    let effects = Arc::new(ObservedEffects::default());
    let authority = Arc::new(SessionAuthority::open(None));
    let coordinator = Coordinator::new(Config {
        host: Arc::new(CaptureHost {
            admitted: owner.clone(),
            effects: Arc::clone(&effects),
            pause_release: true,
            holders: 2,
        }),
        authority: Arc::clone(&authority),
        now_ms: || 0.0,
    });
    let (scope, gone) = Scope::watched();
    let supervisor = scope.clone();
    let cancellation = scope.cancellation();
    let path = Path::new("/isolated/release-cancel.jsonl");
    let work = tokio::spawn(async move {
        coordinator.execute(
            &owner,
            Target { path: path.to_string_lossy().into_owned(), device: None },
            Mutation::Delete,
            scope,
        ).await
    });
    effects.capture_entered.notified().await;
    effects.capture_resume.notify_one();
    effects.release_entered.notified().await;
    cancellation.cancel();
    effects.release_resume.notify_one();
    effects.exit_entered.notified().await;
    assert!(!work.is_finished(), "deletion returned before its captured exit receipt");
    assert_eq!(effects.releases.load(Ordering::SeqCst), 1);
    assert_eq!(authority.admit(path, None, || ()), Err(AdmissionRefusal::Deleting));
    effects.exit_resume.notify_one();
    assert_eq!(work.await.unwrap(), Err(Error::Effect(Fault::cancelled())));
    assert_eq!(authority.admit(path, None, || ()), Err(AdmissionRefusal::Deleting));
    drop(supervisor);
    gone.wait().await;
    assert_eq!(authority.admit(path, None, || ()), Ok(()));
    assert!(authority.list().is_empty());
    assert_eq!(effects.invalidations.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn cancellation_during_capture_never_stops_a_holder() {
    cancelled_capture(Mutation::Stop).await;
}

#[tokio::test]
async fn cancellation_during_capture_never_moves_a_saved_session() {
    cancelled_capture(Mutation::Move(PathBuf::from("/isolated/destination"))).await;
}
