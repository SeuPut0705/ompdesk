use super::*;

fn input(kind: LaunchKind) -> LaunchInput {
    LaunchInput {
        kind,
        inherited_env: BTreeMap::from([
            ("OMP_GUI_MCP_AUTH".into(), "old secret".into()),
            ("OMP_GUI_MCP_HUB_SECRET".into(), "parent hub secret".into()),
            ("OMP_GUI_BRIDGE".into(), "old bridge".into()),
            ("OMPDESK_SOCKET".into(), "old socket".into()),
            ("KEEP".into(), "yes".into()),
        ]),
        memory_args: vec![],
        memory_state_file: None,
        rea_available: false,
        desktop_executable: None,
    }
}

fn config() -> BuiltinConfig {
    BuiltinConfig {
        builtin_dir: PathBuf::from("builtins"),
        rea_enabled: false,
        agent_control: true,
        pstack: true,
        ecc: true,
        computer_use: ComputerUse::Builtin,
    }
}

fn root(name: &str) -> String {
    Path::new("builtins").join(name).to_string_lossy().into_owned()
}

#[test]
fn agent_and_chat_get_roots_but_only_agent_gets_pack_sections() {
    let config = config();
    for (kind, section) in [(LaunchKind::Agent, "1"), (LaunchKind::Chat, "0")] {
        let launch = assemble(&config, &input(kind));
        assert_eq!(launch.args, ["-e".to_owned(), "builtins".into(), "-e".into(), root("pstack"), "-e".into(), root("ecc"), "-e".into(), root("formal")]);
        assert_eq!(launch.env.get("OMP_GUI_PSTACK").map(String::as_str), Some(section));
        assert_eq!(launch.env.get("OMP_GUI_ECC").map(String::as_str), Some(section));
        assert_eq!(launch.env.get("OMP_GUI_COMPUTER_USE").map(String::as_str), Some("builtin"));
        assert_eq!(launch.env.get("KEEP").map(String::as_str), Some("yes"));
        assert!(!launch.env.contains_key("OMP_GUI_MCP_AUTH"));
        assert!(!launch.env.contains_key("OMP_GUI_MCP_HUB_SECRET"));
        assert!(!launch.env.contains_key("OMP_GUI_BRIDGE"));
        assert!(!launch.env.contains_key("OMPDESK_SOCKET"));
        assert!(!launch.needs_hub);
    }
    let mut disabled = config;
    disabled.agent_control = false;
    disabled.pstack = false;
    disabled.ecc = false;
    let launch = assemble(&disabled, &input(LaunchKind::Agent));
    assert_eq!(launch.args, ["-e".to_owned(), root("formal")]);
    assert_eq!(launch.env.get("OMP_GUI_PSTACK").map(String::as_str), Some("0"));
}

#[test]
fn schedule_uses_only_native_memory_arguments_and_clean_environment() {
    let config = config();
    let mut run = input(LaunchKind::Schedule);
    run.rea_available = true;
    run.desktop_executable = Some("desktop".into());
    let empty = assemble(&config, &run);
    assert!(empty.args.is_empty());
    assert!(!empty.needs_hub);
    run.memory_args = vec!["-e".into(), "memory".into()];
    run.memory_state_file = Some("state".into());
    let launch = assemble(&config, &run);
    assert_eq!(launch.args, ["-e", "memory"]);
    assert!(launch.needs_hub);
    assert!(!launch.env.contains_key("OMP_GUI_MEMORY"));
    assert!(!launch.env.contains_key("OMP_GUI_MCP_AUTH"));
}

#[test]
fn resolved_rea_and_desktop_facts_produce_consumer_arguments() {
    let mut config = config();
    let mut run = input(LaunchKind::Agent);
    run.rea_available = true;
    run.desktop_executable = Some("desktop-bin".into());
    run.memory_args = vec!["-e".into(), "memory".into()];
    run.memory_state_file = Some("state".into());
    config.computer_use = ComputerUse::AgentDesktop;
    let disabled = assemble(&config, &run);
    assert!(disabled.rea_root.is_none());
    config.rea_enabled = true;
    let launch = assemble(&config, &run);
    assert_eq!(launch.args, ["-e".to_owned(), "builtins".into(), "-e".into(), root("rea"), "-e".into(), root("agent-desktop"), "-e".into(), root("pstack"), "-e".into(), root("ecc"), "-e".into(), root("formal"), "-e".into(), "memory".into()]);
    assert_eq!(launch.rea_root, Some(PathBuf::from(root("rea"))));
    assert_eq!(launch.env.get("OMP_GUI_REA_ROOT"), Some(&root("rea")));
    assert_eq!(launch.env.get("OMP_GUI_AGENT_DESKTOP").map(String::as_str), Some("desktop-bin"));
    assert_eq!(launch.env.get("OMP_GUI_MEMORY").map(String::as_str), Some("state"));
    assert!(launch.needs_hub);
    run.rea_available = false;
    run.desktop_executable = None;
    run.memory_args.clear();
    let missing = assemble(&config, &run);
    assert!(missing.rea_root.is_none());
    assert!(!missing.needs_hub);
    assert_eq!(missing.env.get("OMP_GUI_COMPUTER_USE").map(String::as_str), Some("missing"));
    assert!(!missing.env.contains_key("OMP_GUI_AGENT_DESKTOP"));
}
