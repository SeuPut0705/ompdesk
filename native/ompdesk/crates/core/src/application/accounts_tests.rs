use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

struct BoxFixture {
    blocked: bool,
    reads: AtomicUsize,
    checks: AtomicUsize,
}
impl BoxFixture {
    fn new(blocked: bool) -> Arc<Self> {
        Arc::new(Self {
            blocked,
            reads: AtomicUsize::new(0),
            checks: AtomicUsize::new(0),
        })
    }
}
impl SecretBox for BoxFixture {
    fn available(&self) -> SecretFuture<'_, bool> {
        Box::pin(async move { Ok(!self.blocked) })
    }
    fn blocked(&self) -> SecretFuture<'_, bool> {
        Box::pin(async move {
            self.checks.fetch_add(1, Ordering::SeqCst);
            Ok(self.blocked)
        })
    }
    fn encrypt<'a>(&'a self, text: &'a str) -> SecretFuture<'a, Vec<u8>> {
        Box::pin(async move { Ok(text.bytes().map(|b| b ^ 0xa5).collect()) })
    }
    fn decrypt<'a>(&'a self, bytes: &'a [u8]) -> SecretFuture<'a, String> {
        Box::pin(async move {
            self.reads.fetch_add(1, Ordering::SeqCst);
            String::from_utf8(bytes.iter().map(|b| b ^ 0xa5).collect()).map_err(|_| ())
        })
    }
}
struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("mail-accounts-{}", crate::web::router::uuid()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn draft() -> Value {
    json!({"label":"Work", "host":"imap.example.com", "port":993, "username":"owner@example.com", "mailbox":"INBOX", "password":"secret-value"})
}

#[tokio::test]
async fn saves_edits_reloads_and_removes_without_disclosing_password() {
    let dir = Dir::new();
    let secrets = BoxFixture::new(false);
    let accounts = Accounts::open(&dir.0, secrets.clone(), true);
    let state = accounts.save(&draft(), None).await.unwrap();
    let id = state["accounts"][0]["id"].as_str().unwrap().to_owned();
    assert_eq!(state["accounts"][0]["address"], "owner@example.com");
    assert!(!state.to_string().contains("secret-value"));
    let metadata = std::fs::read_to_string(dir.0.join("mail-accounts.json")).unwrap();
    assert!(!metadata.contains("password"));
    assert!(
        !std::fs::read_to_string(accounts.secret_file(&id))
            .unwrap()
            .contains("secret-value")
    );
    let mut edited = draft();
    edited["label"] = json!("Work mail");
    edited.as_object_mut().unwrap().remove("password");
    accounts.save(&edited, Some(&id)).await.unwrap();
    let reopened = Accounts::open(&dir.0, secrets.clone(), true);
    assert_eq!(reopened.state().await["accounts"][0]["label"], "Work mail");
    assert_eq!(secrets.reads.load(Ordering::SeqCst), 0);
    assert!(reopened.mailbox(" work MAIL ").await.unwrap().is_some());
    assert!(reopened.mailbox(&id).await.unwrap().is_some());
    assert_eq!(secrets.reads.load(Ordering::SeqCst), 1);
    assert!(reopened.mailbox("unknown").await.unwrap().is_none());
    reopened.remove(&id).await.unwrap();
    assert!(!accounts.secret_file(&id).exists());
    assert_eq!(reopened.state().await["accounts"], json!([]));
}

#[tokio::test]
async fn blocked_is_checked_once_only_for_unread_stored_passwords() {
    let dir = Dir::new();
    let blocked = BoxFixture::new(true);
    let empty = Accounts::open(&dir.0, blocked.clone(), true);
    assert_eq!(empty.state().await["accounts"], json!([]));
    assert_eq!(blocked.checks.load(Ordering::SeqCst), 0);
    let writing = Accounts::open(&dir.0, BoxFixture::new(false), true);
    let id = writing.save(&draft(), None).await.unwrap()["accounts"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let reopened = Accounts::open(&dir.0, blocked.clone(), true);
    let state = reopened.state().await;
    assert_eq!(state["accounts"][0]["needsReentry"], true);
    assert_eq!(state["accounts"][0]["hasPassword"], false);
    reopened.state().await;
    assert!(
        reopened
            .mailbox(&id)
            .await
            .err()
            .unwrap()
            .message
            .contains("enter it again")
    );
    assert_eq!(blocked.checks.load(Ordering::SeqCst), 1);
    assert!(
        !reopened
            .test(&id, &Scope::detached())
            .await
            .to_string()
            .contains("secret-value")
    );
    let refusal = empty.save(&draft(), None).await.err().unwrap();
    assert_eq!(refusal.code, "keychain_would_ask");
}

#[tokio::test]
async fn validates_coercion_duplicates_and_utf16_bounds() {
    let dir = Dir::new();
    let accounts = Accounts::open(&dir.0, BoxFixture::new(false), true);
    let mut value = draft();
    value["port"] = json!("0x3e1");
    value["mailbox"] = json!("");
    let result = accounts.save(&value, None).await.unwrap();
    assert_eq!(result["accounts"][0]["port"], 993);
    assert_eq!(result["accounts"][0]["mailbox"], "INBOX");
    value["label"] = json!("work");
    assert!(
        accounts
            .save(&value, None)
            .await
            .err()
            .unwrap()
            .message
            .contains("another account")
    );
    value["label"] = json!("😀".repeat(31));
    assert_eq!(
        accounts.save(&value, None).await.err().unwrap().message,
        "Invalid mail account: label"
    );
    value["label"] = json!("Other");
    value["port"] = json!(0);
    assert_eq!(
        accounts.save(&value, None).await.err().unwrap().message,
        "Invalid mail account: port"
    );
}

#[tokio::test]
async fn malformed_metadata_and_path_sanitization() {
    let dir = Dir::new();
    std::fs::write(dir.0.join("mail-accounts.json"), b"not json").unwrap();
    let accounts = Accounts::open(&dir.0, BoxFixture::new(false), true);
    assert_eq!(accounts.state().await["accounts"], json!([]));
    assert_eq!(
        accounts.secret_file("../a/한-b"),
        dir.0.join("mail-accounts/a-b.bin")
    );
}

#[tokio::test]
async fn metadata_filters_bad_ports_before_later_fields_but_aborts_on_invalid_string_access() {
    let dir = Dir::new();
    let good = |id: &str| json!({"id":id,"label":id,"host":"imap.example.com","port":993,"username":"owner","mailbox":"INBOX"});
    let bad_port = json!({"id":"bad","label":"bad","host":"imap.example.com","port":"993"});
    let path = dir.0.join("mail-accounts.json");
    std::fs::write(
        &path,
        json!({"version":1,"accounts":[good("first"),bad_port,good("last")]}).to_string(),
    )
    .unwrap();
    let accounts = Accounts::open(&dir.0, BoxFixture::new(false), true);
    let state = accounts.state().await;
    assert_eq!(
        state["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["first", "last"]
    );

    let bad_label = json!({"id":"broken","label":7,"host":"imap.example.com","port":0});
    std::fs::write(
        &path,
        json!({"accounts":[good("first"),bad_label,good("last")]}).to_string(),
    )
    .unwrap();
    assert_eq!(
        Accounts::open(&dir.0, BoxFixture::new(false), true)
            .state()
            .await["accounts"],
        json!([])
    );

    let skipped_before_bad_host = json!({"id":"skipped","label":"","host":7,"port":993});
    std::fs::write(
        &path,
        json!({"accounts":[good("first"),skipped_before_bad_host,good("last")]}).to_string(),
    )
    .unwrap();
    assert_eq!(
        Accounts::open(&dir.0, BoxFixture::new(false), true)
            .state()
            .await["accounts"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn native_mailbox_uses_selected_account_and_cached_credentials() {
    let dir = Dir::new();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (server, client) = crate::routines::imap::tests::tls();
    let serving = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        crate::routines::imap::tests::transaction(
            TlsAcceptor::from(server).accept(socket).await.unwrap(),
            true,
        )
        .await;
    });
    let secrets = BoxFixture::new(false);
    let accounts = Accounts::open(&dir.0, secrets.clone(), true);
    let mut value = draft();
    value["host"] = json!("127.0.0.1");
    value["port"] = json!(port);
    value["username"] = json!("fixture");
    value["password"] = json!("unused");
    accounts.save(&value, None).await.unwrap();
    let reopened = Accounts::open(&dir.0, secrets.clone(), true);
    let mailbox = reopened
        .mailbox("WORK")
        .await
        .unwrap()
        .unwrap()
        .trusted_fixture(client);
    let read = imap::read_mailbox(&mailbox, None, &Scope::detached())
        .await
        .unwrap();
    assert_eq!(read.exists, 30);
    assert_eq!(secrets.reads.load(Ordering::SeqCst), 1);
    serving.await.unwrap();
}
