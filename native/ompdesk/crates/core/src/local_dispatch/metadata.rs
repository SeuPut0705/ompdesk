use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};
use tokio::sync::Mutex;
use url::{Host, Url};

use super::protocol::{CommandError, CommandResult, RpcCommand};
use crate::http::{self, Request};
use crate::schedules::rules::{Local, date_parse, iso};

pub const COMMANDS: &[&str] = &["get_model_release_dates", "login_cancel"];

struct Cache {
    dates: Map<String, Value>,
    expires: Option<Instant>,
}

/// App-wide, lazy and independent of catalog membership. A failed metadata read retains the last good dates.
pub struct Metadata {
    cache: Mutex<Cache>,
}

impl Default for Metadata {
    fn default() -> Self { Self { cache: Mutex::new(Cache { dates: Map::new(), expires: None }) } }
}

impl Metadata {
    pub async fn handle(&self, command: &RpcCommand) -> CommandResult {
        match command.kind.as_str() {
            "get_model_release_dates" => Ok(Some(self.release_dates().await)),
            "login_cancel" => {
                let url = command.string("url").and_then(loopback_callback).ok_or_else(||CommandError::local("no_loopback_callback", "This sign-in has no loopback callback to end"))?;
                let _ = tokio::time::timeout(Duration::from_secs(5), http::send(Request { url: url.as_str(), headers: &[], body: None })).await;
                Ok(None)
            }
            _ => Err(CommandError::Other(format!("Unknown metadata RPC command {}", command.kind))),
        }
    }

    pub async fn release_dates(&self) -> Value {
        let mut cache = self.cache.lock().await;
        if !cache.expires.is_some_and(|expires| Instant::now() < expires) {
            let read = async {
                let response = http::send(Request {url:"https://models.dev/catalog.json",headers:&[],body:None}).await.ok()?;
                if !(200..300).contains(&response.status) { return None; }
                parse_dates(&serde_json::from_slice::<Value>(&response.body).ok()?)
            };
            let result = tokio::time::timeout(Duration::from_secs(5), read).await.ok().flatten();
            let success = result.is_some();
            if let Some(dates) = result { cache.dates = dates; }
            cache.expires = Some(Instant::now() + if success {Duration::from_secs(24*60*60)} else {Duration::from_secs(5*60)});
        }
        json!({"dates":cache.dates})
    }
}

fn parse_dates(payload: &Value) -> Option<Map<String, Value>> {
    let provider = payload["providers"]["openrouter"]["models"].as_object()?;
    let canonical = payload["models"].as_object()?;
    let mut dates = Map::new();
    for (id, row) in provider {
        if row["id"].as_str() != Some(id) { continue; }
        let Some(canonical_id) = row["canonical_model_id"].as_str() else {continue};
        let Some(row) = canonical.get(canonical_id) else {continue};
        if row["id"].as_str() != Some(canonical_id) {continue;}
        let Some(date) = row["release_date"].as_str() else {continue};
        let bytes = date.as_bytes();
        if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' || !bytes.iter().enumerate().all(|(index, byte)| matches!(index,4|7) || byte.is_ascii_digit()) {continue;}
        let Some(timestamp) = date_parse(&format!("{date}T00:00:00.000Z"), &Local) else {continue};
        if iso(timestamp).get(..10) == Some(date) {dates.insert(id.clone(), json!(timestamp));}
    }
    Some(dates)
}

fn loopback_callback(authorization: &str) -> Option<Url> {
    let authorization = Url::parse(authorization).ok()?;
    let redirect = authorization.query_pairs().find(|(key, _)|key == "redirect_uri")?.1.into_owned();
    let mut target = Url::parse(&redirect).ok()?;
    let loopback = match target.host()? {
        Host::Domain(domain) => domain == "localhost",
        Host::Ipv4(address) => address.octets() == [127,0,0,1],
        Host::Ipv6(address) => address == std::net::Ipv6Addr::LOCALHOST,
    };
    if target.scheme() != "http" || !loopback || target.port().is_none() {return None;}
    target.set_query(None);
    target.set_fragment(None);
    let state = authorization.query_pairs().find(|(key, _)|key == "state").map(|(_,value)|value.into_owned()).filter(|value|!value.is_empty());
    {
        let mut query = target.query_pairs_mut();
        query.append_pair("error", "access_denied");
        query.append_pair("error_description", "Sign-in cancelled in OMPdesk");
        if let Some(state) = state {query.append_pair("state", &state);}
    }
    Some(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_dates_require_exact_provider_mapping_and_a_valid_full_calendar_date() {
        let payload = json!({"providers":{"openrouter":{"models":{
            "good":{"id":"good","canonical_model_id":"canonical","release_date":"1999-01-01"},
            "listing-only":{"id":"listing-only","release_date":"2026-01-01"},
            "bad":{"id":"bad","canonical_model_id":"invalid"},
            "month":{"id":"month","canonical_model_id":"partial"}}}},
            "models":{"canonical":{"id":"canonical","release_date":"2026-01-15"},"invalid":{"id":"invalid","release_date":"2026-02-30"},"partial":{"id":"partial","release_date":"2026-01"}}});
        let dates = parse_dates(&payload).unwrap();
        assert_eq!(dates, serde_json::from_value::<Map<String,Value>>(json!({"good":1768435200000_i64})).unwrap());
    }

    #[test]
    fn login_cancel_can_only_target_stocks_explicit_loopback_callback() {
        let url = loopback_callback("https://auth.invalid/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A45821%2Fcallback%3Fold%3Dtrue%23hash&state=flow").unwrap();
        assert_eq!(url.path(), "/callback");
        let query: Map<String,Value> = url.query_pairs().map(|(key,value)|(key.into_owned(),json!(value))).collect();
        assert_eq!(query, serde_json::from_value::<Map<String,Value>>(json!({"error":"access_denied","error_description":"Sign-in cancelled in OMPdesk","state":"flow"})).unwrap());
        for callback in ["http://127.0.0.2:4567/callback", "http://localhost/callback", "https://localhost:4567/callback", "http://example.invalid:4567/callback"] {
            let mut auth = Url::parse("https://auth.invalid").unwrap();
            auth.query_pairs_mut().append_pair("redirect_uri", callback);
            assert!(loopback_callback(auth.as_str()).is_none());
        }
    }
}
