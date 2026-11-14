mod local_regressions {
    use super::*;
    use tokio::sync::Notify;

    #[tokio::test]
    async fn a_paused_destination_refuses_a_paired_computers_local_run() {
        let _serial = clock::TEST_CLOCK.lock().await;
        let runner = FakeRunner::new(Ok(journal("passed", &[])));
        let hub = Hub::with_runner(github(CI), Arc::new(FakeLocal::default()), runner.clone());
        let ask = LocalRunAsk {
            repo: REPO.into(),
            sha: SHA.into(),
            argv: vec!["npm".into(), "test".into()],
            release: false,
        };
        hub.pause(true).await.unwrap();
        let refused = hub.run_local(ask.clone(), Scope::detached()).await;
        let calls_while_paused = locked(&runner.asks).len();
        hub.pause(false).await.unwrap();
        let resumed = hub.run_local(ask, Scope::detached()).await;
        assert!(refused.is_err(), "a paused destination must refuse the run");
        assert_eq!(calls_while_paused, 0);
        assert_eq!(resumed.unwrap().verdict, AnswerVerdict::Green);
        assert_eq!(locked(&runner.asks).len(), 1);
    }

    struct HeldRunner {
        scope: Mutex<Option<Scope>>,
        entered: Notify,
        finished: Notify,
    }

    impl crate::checks::local_run::LocalRunner for HeldRunner {
        fn run<'a>(
            &'a self,
            _ask: &'a LocalRunAsk,
            started: Box<dyn FnOnce(&str) + Send + 'a>,
            scope: Scope,
        ) -> Fut<'a, Result<crate::checks::sources::LocalRun, String>> {
            Box::pin(async move {
                *locked(&self.scope) = Some(scope.clone());
                started("held-journal");
                self.entered.notify_one();
                scope.on_cancel().await;
                self.finished.notify_one();
                Ok(journal("killed", &[]))
            })
        }
    }

    #[tokio::test]
    async fn closing_a_hub_cancels_its_placed_local_run() {
        use crate::checks::contract::Os;
        let _serial = clock::TEST_CLOCK.lock().await;
        let (github, local) = private_with_check(vec![free_pool("local", Os::Linux)]);
        let runner = Arc::new(HeldRunner {
            scope: Mutex::new(None),
            entered: Notify::new(),
            finished: Notify::new(),
        });
        let hub = Hub::with_runner(github, local, runner.clone());
        hub.poller.round().await;
        let reply = hub.start(samples::session(), start(Purpose::Branch, "feat")).await.unwrap();
        assert_eq!(reply.decision, StartDecision::Started);
        runner.entered.notified().await;
        let scope = locked(&runner.scope).clone().unwrap();
        drop(hub);
        let cancelled_on_close = scope.cancelled();
        scope.cancel();
        runner.finished.notified().await;
        assert!(cancelled_on_close, "closing the hub must cancel its local run");
    }

    #[tokio::test]
    async fn a_failed_local_release_answer_names_its_blocked_gate() {
        use crate::checks::contract::Os;
        let _serial = clock::TEST_CLOCK.lock().await;
        let (github, local) = private_with_check(vec![free_pool("local", Os::Linux)]);
        github.with(|facts| {
            facts.files.insert(
                format!("{REPO}\n{SHA}\n.ompdesk/checks.json"),
                r#"{"release":{"workflow":"ci.yml","local":["npm","test"]}}"#.into(),
            );
        });
        let runner = FakeRunner::new(Ok(journal("failed", &["release test"])));
        let hub = Hub::with_runner(github, local, runner);
        hub.poller.round().await;
        let reply = hub.start(samples::session(), start(Purpose::Release, "feat")).await.unwrap();
        assert_eq!(reply.decision, StartDecision::Started, "{}", reply.reason);
        let answer = waited(&hub, reply.run_id.as_deref().unwrap()).await;
        assert_eq!(answer.verdict, AnswerVerdict::Red);
        assert_eq!(answer.blocks_release.unwrap().gate, "release ci.yml");
    }
}
