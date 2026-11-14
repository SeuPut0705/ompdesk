use super::*;
use serde_json::{Value, json};

fn normalized(value: Value) -> Value {
    match value {
        Value::Number(n) => n.as_f64().map_or(Value::Null, |v| json!(v)),
        Value::Array(a) => Value::Array(a.into_iter().map(normalized).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, normalized(v))).collect()),
        other => other,
    }
}

#[test]
fn captured_typescript_records() {
    let data: Value = serde_json::from_str(include_str!("records_captured.json")).unwrap();
    for row in data["pending"].as_array().unwrap() {
        let got =
            serde_json::to_value(parse_pending_install(row["raw"].as_str().unwrap())).unwrap();
        assert_eq!(normalized(got), normalized(row["result"].clone()));
    }
    for row in data["failures"].as_array().unwrap() {
        let got = serde_json::to_value(parse_start_failure(row["raw"].as_str().unwrap())).unwrap();
        assert_eq!(normalized(got), normalized(row["result"].clone()));
    }
    for row in data["swaps"].as_array().unwrap() {
        assert_eq!(
            serde_json::to_value(last_swap_entry(row["raw"].as_str().unwrap())).unwrap(),
            row["result"]
        );
    }
    let pending = parse_pending_install(data["pending"][0]["raw"].as_str().unwrap()).unwrap();
    let swap = last_swap_entry(data["swaps"][0]["raw"].as_str().unwrap());
    if let Some(rows) = data["presence"].as_array() {
        for row in rows {
            let windows: Vec<WindowState> = row["windows"]
                .as_array()
                .unwrap()
                .iter()
                .map(|w| WindowState {
                    visible: w["visible"].as_bool().unwrap(),
                    minimized: w["minimized"].as_bool().unwrap(),
                    focused: w["focused"].as_bool().unwrap(),
                })
                .collect();
            assert_eq!(
                serde_json::to_value(window_presence_of(&windows)).unwrap(),
                row["result"]
            );
        }
    }
    if let Some(rows) = data["relaunch"].as_array() {
        for row in rows {
            assert_eq!(
                serde_json::to_value(relaunch_presence(
                    Some(&pending),
                    row["now"].as_f64().unwrap()
                ))
                .unwrap(),
                row["result"]
            );
        }
    }
    if let Some(rows) = data["details"].as_array() {
        for row in rows {
            assert_eq!(
                previous_install_details(&pending, row["current"].as_str().unwrap(), swap.as_ref())
                    .unwrap(),
                row["result"]
            );
        }
    }
    if !data["mark"].is_null() {
        assert_eq!(start_mark_json("2", 42, 5), data["mark"].as_str().unwrap());
        assert_eq!(
            normalized(
                serde_json::to_value(start_failure_of(&pending, "1", swap.as_ref(), 5.0, None))
                    .unwrap()
            ),
            normalized(data["failure"].clone())
        );
    }
}

#[test]
fn pure_presence_dates_and_outcomes() {
    let pending = parse_pending_install(
        r#"{"from":"1","to":"2","mode":"relaunch","trigger":"auto","at":0,"presence":"hidden"}"#,
    )
    .unwrap();
    assert_eq!(
        relaunch_presence(Some(&pending), 900_000.0),
        Some(WindowPresence::Hidden)
    );
    assert_eq!(relaunch_presence(Some(&pending), 900_001.0), None);
    assert_eq!(relaunch_presence(Some(&pending), -1.0), None);
    assert_eq!(window_presence_of(&[]), None);
    assert_eq!(
        window_presence_of(&[WindowState {
            visible: false,
            minimized: false,
            focused: false
        }]),
        Some(WindowPresence::Hidden)
    );
    assert_eq!(
        window_presence_of(&[WindowState {
            visible: true,
            minimized: true,
            focused: false
        }]),
        Some(WindowPresence::Minimized)
    );
    assert_eq!(
        window_presence_of(&[WindowState {
            visible: true,
            minimized: false,
            focused: false
        }]),
        Some(WindowPresence::Behind)
    );
    assert_eq!(
        window_presence_of(&[WindowState {
            visible: true,
            minimized: false,
            focused: true
        }]),
        None
    );
    assert_eq!(
        previous_install_details(&pending, "1", None).unwrap()["outcome"],
        "rolled back"
    );
    assert_eq!(
        previous_install_details(&pending, "2", None).unwrap()["outcome"],
        "installed"
    );
    assert_eq!(
        previous_install_details(&pending, "3", None).unwrap()["outcome"],
        "changed"
    );
    assert_eq!(iso_date(0.0).unwrap(), "1970-01-01T00:00:00.000Z");
    assert_eq!(iso_date(-1.0).unwrap(), "1969-12-31T23:59:59.999Z");
    assert_eq!(iso_date(8.64e15).unwrap(), "+275760-09-13T00:00:00.000Z");
    assert_eq!(iso_date(-8.64e15).unwrap(), "-271821-04-20T00:00:00.000Z");
    assert_eq!(iso_date(8.64e15 + 1.0), None);
    assert_eq!(
        start_mark_json("2", 42, 5),
        "{\"version\":\"2\",\"pid\":42,\"at\":5}"
    );
}

struct Fixture(PathBuf);
impl Fixture {
    fn new(root: &Path) -> Self {
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).unwrap();
        let name: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let path = root.join(format!("updater-records-{name}"));
        fs::create_dir_all(path.join("updates")).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn lifecycle_preserves_marker_until_failure_is_saved() {
    let root = Fixture::new(&std::env::temp_dir());
    let marker = root.0.join("update-install.json");
    fs::write(
        &marker,
        r#"{"from":"1","to":"2","mode":"relaunch","trigger":"auto","at":0,"presence":"hidden"}"#,
    )
    .unwrap();
    fs::write(
        root.0.join("updates/swap.log"),
        "swap today: /a -> /b\ninstalled\nstart failed; previous app restored\n",
    )
    .unwrap();
    let mut records = Records::new(root.0.clone(), "1".into(), 42).unwrap();
    assert_eq!(
        records.launch_presence(20.0, false).unwrap(),
        Some(WindowPresence::Hidden)
    );
    assert_eq!(records.launch_presence(20.0, true).unwrap(), None);
    let result = records.first_page_loaded(5, |path, bytes| {
        if path.ends_with(START_FAILED_FILE) {
            assert!(marker.exists());
            assert_eq!(
                fs::read_to_string(root.0.join(START_MARK_FILE)).unwrap(),
                start_mark_json("1", 42, 5)
            );
            return Err(io::Error::other("disk full"));
        }
        fs::write(path, bytes)
    });
    assert!(matches!(result, Err(FirstPageError::StartFailure(_))));
    assert!(marker.exists());
    assert!(records.start_failed_before(Some("2")).unwrap());
    let report = records
        .first_page_loaded(5, |p, b| fs::write(p, b))
        .unwrap()
        .unwrap();
    assert_eq!(report["outcome"], "rolled back");
    assert_eq!(report["swapOutcome"], "start failed; previous app restored");
    assert!(!marker.exists());
    assert!(records.start_failed_before(Some("2")).unwrap());
    assert_eq!(
        records
            .first_page_loaded(6, |p, b| fs::write(p, b))
            .unwrap(),
        None
    );
    assert!(!records.start_failed_before(None).unwrap());
    assert!(records.start_failed_before(Some("2")).unwrap());
    assert!(!records.start_failed_before(Some("3")).unwrap());
    assert!(!root.0.join(START_FAILED_FILE).exists());
}

#[test]
fn start_mark_error_preserves_pending_and_success_clears_hold() {
    let root = Fixture::new(&std::env::temp_dir());
    let marker = root.0.join("update-install.json");
    fs::write(
        &marker,
        r#"{"from":"1","to":"2","mode":"nsis","trigger":"quit","at":0}"#,
    )
    .unwrap();
    fs::write(
        root.0.join(START_FAILED_FILE),
        r#"{"version":"2","count":2,"at":5}"#,
    )
    .unwrap();
    let mut records = Records::new(root.0.clone(), "2".into(), 1).unwrap();
    assert!(matches!(
        records.first_page_loaded(7, |_, _| Err(io::Error::other("disk full"))),
        Err(FirstPageError::StartMark(_))
    ));
    assert!(marker.exists());
    assert_eq!(
        records
            .first_page_loaded(7, |p, b| fs::write(p, b))
            .unwrap()
            .unwrap()["outcome"],
        "installed"
    );
    assert!(!root.0.join(START_FAILED_FILE).exists());
}

#[test]
fn reopening_after_a_pending_cleanup_failure_does_not_count_the_install_twice() {
    let root = Fixture::new(&std::env::temp_dir());
    let marker = root.0.join("update-install.json");
    let pending = r#"{"from":"1","to":"2","mode":"relaunch","trigger":"auto","at":0}"#;
    fs::write(&marker, pending).unwrap();
    fs::write(
        root.0.join("updates/swap.log"),
        "swap today: /a -> /b\nstart failed; previous app restored\n",
    )
    .unwrap();
    let mut records = Records::new(root.0.clone(), "1".into(), 42).unwrap();
    let error = records.first_page_loaded(5, |path, bytes| {
        fs::write(path, bytes)?;
        if path.ends_with(START_FAILED_FILE) {
            fs::remove_file(&marker)?;
            fs::create_dir(&marker)?;
        }
        Ok(())
    });
    assert!(matches!(error, Err(FirstPageError::Records(_))));
    // The file was temporarily undeletable; reopening sees exactly the pending bytes the old process saw.
    fs::remove_dir(&marker).unwrap();
    fs::write(&marker, pending).unwrap();
    let mut reopened = Records::new(root.0.clone(), "1".into(), 43).unwrap();
    reopened
        .first_page_loaded(6, |p, b| fs::write(p, b))
        .unwrap();
    let failure =
        parse_start_failure(&fs::read_to_string(root.0.join(START_FAILED_FILE)).unwrap()).unwrap();
    assert_eq!(failure.count, 1.0);
    assert_eq!(failure.at, 5.0);
    assert!(!marker.exists());
}
