use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use ompdesk_app_contract::OwnerIssuer;
use tokio::sync::{Notify, oneshot};

use super::*;

#[derive(Default)]
struct Effects {
    storage_entered: Notify,
    storage_resume: Notify,
    stored: AtomicBool,
    invalidated: AtomicBool,
    notified: AtomicBool,
}

struct ReceiptHost(Arc<Effects>);

impl Host for ReceiptHost {
    type Runtime = ();
    type Notices = ();

    fn authorize(&self, _: &Owner, target: Target) -> Result<Target, Fault> { Ok(target) }
    fn capture(&self, _: &Owner, _: &Target) -> Effect<Captured<(), ()>> {
        Box::pin(async { Ok(Captured { holders: Vec::new(), notices: () }) })
    }
    fn release(&self, _: &Holder<()>) -> Effect<Release> { unreachable!() }
    fn stop(&self, _: &Holder<()>) -> Effect<()> { unreachable!() }
    fn rename_live(&self, _: &Holder<()>, _: &str) -> Effect<()> { unreachable!() }
    fn rename_stored(&self, _: &Owner, _: &Target, _: &str, _: ReadyStoredClaim, _: Scope) -> Effect<()> {
        unreachable!()
    }
    fn note_name(&self, _: &Holder<()>, _: &str) -> Effect<()> { unreachable!() }
    fn move_stored(&self, _: &Owner, _: &Target, _: PathBuf, _: ReadyStoredClaim, _: Scope) -> Effect<String> {
        unreachable!()
    }
    fn delete_stored(&self, _: &Owner, _: &Target, scope: Scope) -> Effect<()> {
        let effects = Arc::clone(&self.0);
        let (reply, answer) = oneshot::channel();
        // A known successful mutation receipt. The worker owns the real request Scope until it settles,
        // independently of the caller dropping its answer. This is a domain-boundary fixture, not Stock proof.
        tokio::spawn(async move {
            let _scope = scope;
            effects.storage_entered.notify_one();
            effects.storage_resume.notified().await;
            effects.stored.store(true, Ordering::SeqCst);
            let _ = reply.send(Ok(()));
        });
        Box::pin(async move { answer.await.map_err(|_| Fault::new("receipt_lost", "Receipt lost"))? })
    }
    fn invalidate(&self, _: &Target) -> Effect<()> {
        self.0.invalidated.store(true, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }
    fn notify_deleted(&self, _: &Target, _: ()) -> Effect<()> {
        self.0.notified.store(true, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }
}

#[tokio::test]
async fn dropping_cancelled_caller_keeps_known_storage_commit_and_notices_owned() {
    let effects = Arc::new(Effects::default());
    let authority = Arc::new(SessionAuthority::open(None));
    let coordinator = Coordinator::new(Config {
        host: Arc::new(ReceiptHost(Arc::clone(&effects))),
        authority: Arc::clone(&authority),
        now_ms: || 19.0,
    });
    let owner = OwnerIssuer::new(9).admit_authenticated().unwrap();
    let path = Path::new("/isolated/drop-after-storage.jsonl");
    let (scope, gone) = Scope::watched();
    let cancellation = scope.cancellation();
    let caller = tokio::spawn(async move {
        coordinator.execute(&owner, Target { path: path.to_string_lossy().into_owned(), device: None }, Mutation::Delete, scope).await
    });
    effects.storage_entered.notified().await;
    cancellation.cancel();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    effects.storage_resume.notify_one();
    gone.wait().await;
    assert!(effects.stored.load(Ordering::SeqCst));
    assert_eq!(authority.at(path.to_str().unwrap(), None), Some(19.0), "known successful storage lost its tombstone when the caller dropped");
    assert!(effects.invalidated.load(Ordering::SeqCst), "known storage commit never invalidated its index");
    assert!(effects.notified.load(Ordering::SeqCst), "known storage commit never delivered deletion notices");
    assert!(!authority.any_in_progress());
}
