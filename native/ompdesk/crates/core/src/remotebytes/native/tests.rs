use super::*;

pub(crate) struct Dir(std::path::PathBuf);
impl Dir {
    pub(crate) fn new() -> Self {
        Self(crate::fs::disk::make_temp_dir("ompdesk-native-remote-").unwrap())
    }
    pub(crate) fn path(&self) -> &std::path::Path {
        &self.0
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn journal_resumes_from_held_tail_and_merges_only_the_requested_prefix() {
    let dir = Dir::new();
    let cache = ContentCache::new(dir.path().to_owned());
    let first=cache.journal("host\0session\0agent",0.into(),|from,tail|async move {
        assert_eq!(from,0);assert!(tail.is_none());
        Ok(json!({"success":true,"data":{"fromByte":0,"nextByte":10,"tail":"one","messages":[{"text":"first"}]}}))
    }).await.unwrap();
    assert_eq!(first["data"]["messages"][0]["text"], "first");
    let cache = ContentCache::new(dir.path().to_owned());
    let merged=cache.journal("host\0session\0agent",0.into(),|from,tail|async move {
        assert_eq!(from,10);assert_eq!(tail,Some(json!("one")));
        Ok(json!({"success":true,"data":{"fromByte":10,"nextByte":20,"tail":"two","messages":[{"text":"second"}]}}))
    }).await.unwrap();
    assert_eq!(
        merged["data"]["messages"],
        json!([{"text":"first"},{"text":"second"}])
    );
    assert_eq!(merged["data"]["fromByte"], 0);
    let another=cache.journal("other-host\0session\0agent",0.into(),|from,tail|async move {
        assert_eq!(from,0);assert!(tail.is_none());
        Ok(json!({"success":true,"data":{"fromByte":0,"nextByte":5,"tail":"other","messages":[{"text":"isolated"}]}}))
    }).await.unwrap();
    assert_eq!(another["data"]["messages"], json!([{"text":"isolated"}]));
}
