//! Native mail account metadata and OS-protected passwords.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

use base64::Engine as _;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::control::js;
use crate::disk::tree::write_atomic_if;
use crate::routines::imap::{self, Login, Mailbox};
use crate::server::{Fault, Scope};

pub type SecretFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, ()>> + Send + 'a>>;

/// The application's shared, no-dialog OS secret provider. Errors never contain secret material.
pub trait SecretBox: Send + Sync {
    fn available(&self) -> SecretFuture<'_, bool>;
    fn blocked(&self) -> SecretFuture<'_, bool>;
    fn encrypt<'a>(&'a self, text: &'a str) -> SecretFuture<'a, Vec<u8>>;
    fn decrypt<'a>(&'a self, bytes: &'a [u8]) -> SecretFuture<'a, String>;
}

#[derive(Clone, Serialize)]
struct Stored {
    id: String,
    label: String,
    host: String,
    port: u16,
    username: String,
    mailbox: String,
}

struct State {
    accounts: Vec<Stored>,
    passwords: HashMap<String, String>,
    blocked: Option<bool>,
}

pub struct Accounts {
    dir: PathBuf,
    secrets: Arc<dyn SecretBox>,
    remember_saved: bool,
    state: Mutex<State>,
}

fn fault(message: impl Into<String>) -> Fault {
    Fault::new("mail_accounts", message.into())
}
fn missing() -> Fault {
    fault("Mail account not found")
}
fn address(account: &Stored) -> &str {
    if account.username.contains('@') {
        &account.username
    } else {
        ""
    }
}
fn valid_text(text: &str, max: usize, newline: bool) -> bool {
    !js::trim(text).is_empty()
        && text.encode_utf16().count() <= max
        && (!newline || !text.contains(['\r', '\n']))
}
fn problem(account: &Stored, password: Option<&str>, editing: bool) -> Option<&'static str> {
    if !valid_text(&account.label, 60, false) {
        return Some("label");
    }
    if account.host.encode_utf16().count() > 253
        || js::trim(&account.host).is_empty()
        || !js::trim(&account.host)
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-')
    {
        return Some("host");
    }
    if account.port == 0 {
        return Some("port");
    }
    if !valid_text(&account.username, 320, true) {
        return Some("username");
    }
    if !valid_text(&account.mailbox, 200, true) {
        return Some("mailbox");
    }
    let password = password.unwrap_or("");
    if password.contains(['\r', '\n'])
        || password.encode_utf16().count() > 1000
        || (!editing && password.is_empty())
    {
        return Some("password");
    }
    None
}
fn string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(v) => js::string_of_value(v),
    }
}
fn number(value: Option<&Value>) -> f64 {
    match value {
        None | Some(Value::Null) => 993.0,
        Some(Value::Bool(b)) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(value) => crate::ssh::js_to_number(&js::string_of_value(value)),
    }
}
fn port(value: Option<&Value>) -> u16 {
    let n = number(value);
    if n.is_finite() && n.fract() == 0.0 && (1.0..=65535.0).contains(&n) {
        n as u16
    } else {
        0
    }
}
fn clean(draft: &Value) -> Stored {
    let trimmed = |key| js::trim(&string(draft.get(key))).to_owned();
    let mailbox = trimmed("mailbox");
    Stored {
        id: String::new(),
        label: trimmed("label"),
        host: trimmed("host"),
        port: port(draft.get("port")),
        username: trimmed("username"),
        mailbox: if mailbox.is_empty() {
            "INBOX".into()
        } else {
            mailbox
        },
    }
}
fn load(dir: &Path) -> Vec<Stored> {
    let Some(value) = std::fs::read(dir.join("mail-accounts.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
    else {
        return Vec::new();
    };
    let Some(items) = value.get("accounts").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut accounts = Vec::new();
    for item in items {
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(label) = item.get("label").and_then(Value::as_str) else {
            return Vec::new();
        };
        if !valid_text(label, 60, false) {
            continue;
        }
        let Some(host) = item.get("host").and_then(Value::as_str) else {
            return Vec::new();
        };
        let trimmed_host = js::trim(host);
        if trimmed_host.is_empty()
            || host.encode_utf16().count() > 253
            || !trimmed_host
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-')
        {
            continue;
        }
        let Some(port) = item.get("port").and_then(Value::as_f64) else {
            continue;
        };
        if !port.is_finite() || port.fract() != 0.0 || !(1.0..=65535.0).contains(&port) {
            continue;
        }
        let Some(username) = item.get("username").and_then(Value::as_str) else {
            return Vec::new();
        };
        if !valid_text(username, 320, true) {
            continue;
        }
        let Some(mailbox) = item.get("mailbox").and_then(Value::as_str) else {
            return Vec::new();
        };
        if !valid_text(mailbox, 200, true) {
            continue;
        }
        accounts.push(Stored {
            id: id.into(),
            label: label.into(),
            host: host.into(),
            port: port as u16,
            username: username.into(),
            mailbox: mailbox.into(),
        });
    }
    accounts
}

impl Accounts {
    pub fn open(user_data: &Path, secrets: Arc<dyn SecretBox>, remember_saved: bool) -> Arc<Self> {
        Arc::new(Self {
            dir: user_data.to_owned(),
            secrets,
            remember_saved,
            state: Mutex::new(State {
                accounts: load(user_data),
                passwords: HashMap::new(),
                blocked: None,
            }),
        })
    }
    fn secret_file(&self, id: &str) -> PathBuf {
        let safe: String = id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
            .collect();
        self.dir.join("mail-accounts").join(format!("{safe}.bin"))
    }
    async fn blocked(&self, state: &mut State) -> bool {
        if let Some(answer) = state.blocked {
            return answer;
        }
        if !state
            .accounts
            .iter()
            .any(|a| !state.passwords.contains_key(&a.id) && self.secret_file(&a.id).exists())
        {
            return false;
        }
        let answer = self.secrets.blocked().await.unwrap_or(false);
        state.blocked = Some(answer);
        answer
    }
    async fn state_locked(&self, state: &mut State) -> Value {
        let blocked = self.blocked(state).await;
        let accounts: Vec<Value> = state.accounts.iter().map(|a| {
            let cached = state.passwords.contains_key(&a.id);
            let stored = self.secret_file(&a.id).exists();
            let needs = !cached && stored && blocked;
            json!({"id":a.id,"label":a.label,"host":a.host,"port":a.port,"username":a.username,"mailbox":a.mailbox,"address":address(a),"hasPassword":!needs && (cached || stored),"needsReentry":needs})
        }).collect();
        json!({"accounts":accounts})
    }
    pub async fn state(&self) -> Value {
        let mut state = self.state.lock().await;
        self.state_locked(&mut state).await
    }
    pub async fn resolve(&self, name: &str) -> Option<Value> {
        let mut state = self.state.lock().await;
        let name = js::trim(name);
        let account = state
            .accounts
            .iter()
            .find(|a| a.id == name || a.label.to_lowercase() == name.to_lowercase())
            .cloned();
        if account.is_some() {
            self.blocked(&mut state).await;
        }
        account.map(|a| json!({"id":a.id,"label":a.label,"address":address(&a)}))
    }
    fn write_metadata(&self, state: &State) -> Result<(), Fault> {
        let bytes = serde_json::to_vec_pretty(&json!({"version":1,"accounts":state.accounts}))
            .map_err(|_| fault("Could not encode mail accounts"))?;
        write_atomic_if(
            &self.dir.join("mail-accounts.json"),
            &bytes,
            Some(0o600),
            0o777,
            &|| true,
        )?;
        Ok(())
    }
    pub async fn save(&self, draft: &Value, id: Option<&str>) -> Result<Value, Fault> {
        let mut state = self.state.lock().await;
        let existing = match id {
            Some(id) => Some(
                state
                    .accounts
                    .iter()
                    .find(|a| a.id == id)
                    .cloned()
                    .ok_or_else(missing)?,
            ),
            None => None,
        };
        let mut account = clean(draft);
        let password = draft
            .get("password")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        let editing = if let Some(existing) = &existing {
            let cached = state.passwords.contains_key(&existing.id);
            let stored = self.secret_file(&existing.id).exists();
            cached || (stored && !self.blocked(&mut state).await)
        } else {
            false
        };
        if let Some(field) = problem(&account, password, editing) {
            return Err(fault(format!("Invalid mail account: {field}")));
        }
        if state.accounts.iter().any(|a| {
            Some(a.id.as_str()) != id && a.label.to_lowercase() == account.label.to_lowercase()
        }) {
            return Err(fault(
                "Invalid mail account: label (another account has it)",
            ));
        }
        account.id = existing
            .as_ref()
            .map(|a| a.id.clone())
            .unwrap_or_else(crate::web::router::uuid);
        if let Some(password) = password {
            if !self.secrets.available().await.unwrap_or(false) {
                if self.secrets.blocked().await.unwrap_or(false) {
                    return Err(Fault::new(
                        "keychain_would_ask",
                        "macOS would ask for the login password to open the keychain",
                    ));
                }
                return Err(fault("This computer cannot store a password safely"));
            }
            let sealed = self
                .secrets
                .encrypt(password)
                .await
                .map_err(|_| fault("Could not store the password safely"))?;
            let encoded = base64::engine::general_purpose::STANDARD.encode(sealed);
            write_atomic_if(
                &self.secret_file(&account.id),
                encoded.as_bytes(),
                Some(0o600),
                0o700,
                &|| true,
            )?;
            if self.remember_saved {
                state
                    .passwords
                    .insert(account.id.clone(), password.to_owned());
            }
        }
        if let Some(index) = state.accounts.iter().position(|a| a.id == account.id) {
            state.accounts[index] = account;
        } else {
            state.accounts.push(account);
        }
        self.write_metadata(&state)?;
        Ok(self.state_locked(&mut state).await)
    }
    pub async fn remove(&self, id: &str) -> Result<Value, Fault> {
        let mut state = self.state.lock().await;
        if !state.accounts.iter().any(|a| a.id == id) {
            return Err(missing());
        }
        state.accounts.retain(|a| a.id != id);
        state.passwords.remove(id);
        let file = self.secret_file(id);
        match std::fs::remove_file(&file) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => {
                return Err(crate::fs::error::NodeError::new(
                    &e,
                    "unlink",
                    Some(&file.to_string_lossy()),
                )
                .fault(crate::fs::error::Codes::None));
            }
        }
        self.write_metadata(&state)?;
        Ok(self.state_locked(&mut state).await)
    }
    pub async fn mailbox(&self, name: &str) -> Result<Option<Mailbox>, Fault> {
        let mut state = self.state.lock().await;
        let name = js::trim(name);
        let Some(account) = state
            .accounts
            .iter()
            .find(|a| a.id == name || a.label.to_lowercase() == name.to_lowercase())
            .cloned()
        else {
            return Ok(None);
        };
        let password = if let Some(password) = state.passwords.get(&account.id) {
            password.clone()
        } else {
            let encoded = std::fs::read(self.secret_file(&account.id)).map_err(|_| fault("no password is stored for this account (Settings › Schedules › Email accounts)"))?;
            if self.blocked(&mut state).await {
                return Err(fault(
                    "its stored password cannot be read without macOS asking for your login password; enter it again in Settings › Schedules › Email accounts",
                ));
            }
            let data = crate::remotebytes::node_base64(&String::from_utf8_lossy(&encoded));
            let password = self.secrets.decrypt(&data).await.map_err(|_| fault("its stored password could not be read on this computer; enter it again in Settings"))?;
            state.passwords.insert(account.id.clone(), password.clone());
            password
        };
        Ok(Some(Mailbox::new(
            account.id.clone(),
            account.label.clone(),
            address(&account).to_owned(),
            account.host,
            account.port,
            Login::new(account.username, password, account.mailbox),
        )))
    }
    pub async fn test(&self, id: &str, scope: &Scope) -> Value {
        let result = async {
            let account = {
                let state = self.state.lock().await;
                state
                    .accounts
                    .iter()
                    .find(|a| a.id == id)
                    .cloned()
                    .ok_or_else(missing)?
            };
            let mailbox = self.mailbox(&account.id).await?.ok_or_else(missing)?;
            imap::read_mailbox(&mailbox, None, scope).await
        }
        .await;
        match result {
            Ok(read) => json!({"ok":true,"messages":read.exists}),
            Err(error) => json!({"ok":false,"error":error.message}),
        }
    }
    pub async fn command(&self, request: &Value, scope: &Scope) -> Result<Value, Fault> {
        let id = request.get("id").and_then(Value::as_str);
        match request.get("action").and_then(Value::as_str) {
            Some("list") => Ok(self.state().await),
            Some("save")
                if request
                    .get("draft")
                    .is_some_and(|v| v.is_object() || v.is_array()) =>
            {
                self.save(&request["draft"], id).await
            }
            Some("remove") if id.is_some() => self.remove(id.unwrap_or_default()).await,
            Some("test") if id.is_some() => Ok(self.test(id.unwrap_or_default(), scope).await),
            _ => Err(fault("Invalid mail accounts request")),
        }
    }
}

#[cfg(test)]
#[path = "accounts_tests.rs"]
mod tests;
