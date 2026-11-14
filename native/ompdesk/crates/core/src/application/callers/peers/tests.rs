use super::*;
use crate::remote::requests::tests::pair;

async fn close(connection: &RemoteRequests) {
    let mut changes = connection.changes();
    connection.disconnect_for_test();
    changes.wait_for(|online| !*online).await.unwrap();
}

#[tokio::test]
async fn a_numeric_link_id_never_substitutes_for_the_bound_live_connection() {
    let callers = Callers::new(43);
    let (link, other, _keep) = pair().await;
    let admitted = callers
        .admit_peer("peer".into(), link.link_id().unwrap())
        .unwrap();
    assert!(
        callers
            .admit_peer_connection(&admitted.owner, &link, || Ok(()))
            .is_err()
    );
    assert!(
        callers
            .bind_peer_connection(&admitted.owner, other.clone())
            .is_err()
    );
    callers
        .bind_peer_connection(&admitted.owner, link.clone())
        .unwrap();
    let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
    callers
        .admit_peer_connection(&admitted.owner, &link, || {
            sent.send("accepted").unwrap();
            Ok(())
        })
        .unwrap();
    assert_eq!(received.recv().await, Some("accepted"));
    assert!(
        callers
            .admit_peer_connection(&admitted.owner, &other, || {
                sent.send("wrong connection").unwrap();
                Ok(())
            })
            .is_err()
    );
    assert!(received.try_recv().is_err());
    let foreign_generation = Callers::new(44)
        .admit_peer("peer".into(), link.link_id().unwrap())
        .unwrap();
    assert!(
        callers
            .admit_peer_connection(&foreign_generation.owner, &link, || Ok(()))
            .is_err()
    );
    close(&link).await;
    assert!(
        callers
            .admit_peer_connection(&admitted.owner, &link, || {
                sent.send("disconnected").unwrap();
                Ok(())
            })
            .is_err()
    );
    assert!(received.try_recv().is_err());
    close(&other).await;
}

#[tokio::test]
async fn reconnect_preserves_the_execution_owner_but_revokes_the_old_connection() {
    let callers = Callers::new(45);
    let (first, first_remote, _keep_first) = pair().await;
    let admitted = callers
        .admit_peer("peer".into(), first.link_id().unwrap())
        .unwrap();
    callers
        .bind_peer_connection(&admitted.owner, first.clone())
        .unwrap();
    let reservation = callers
        .reserve_execution(&admitted.owner, "peer:original:rtab", 0)
        .unwrap();
    let execution = callers.execution_owner("peer:original:rtab").unwrap();
    callers.finish_execution_reservation(reservation, true);
    callers
        .admit_peer_execution(&admitted.owner, &first, &execution, || Ok(()))
        .unwrap();

    let (next, next_remote, _keep_next) = pair().await;
    let rejoined = callers
        .admit_peer("peer".into(), next.link_id().unwrap())
        .unwrap();
    callers
        .bind_peer_connection(&rejoined.owner, next.clone())
        .unwrap();
    assert!(callers.principal(&admitted.owner).is_err());
    assert!(
        callers
            .admit_peer_execution(&admitted.owner, &first, &execution, || Ok(()))
            .is_err()
    );
    callers
        .admit_peer_execution(&rejoined.owner, &next, &execution, || Ok(()))
        .unwrap();
    assert_eq!(
        callers.execution_owner("peer:original:rtab").unwrap(),
        execution
    );
    assert_eq!(
        callers.execution_facts(&execution).unwrap().creator,
        admitted.principal
    );

    let foreign = callers
        .admit_peer("another peer".into(), next_remote.link_id().unwrap())
        .unwrap();
    callers
        .bind_peer_connection(&foreign.owner, next_remote.clone())
        .unwrap();
    assert!(
        callers
            .admit_peer_execution(&foreign.owner, &next_remote, &execution, || Ok(()))
            .is_err()
    );
    assert!(callers.retire_execution(&execution));
    assert!(
        callers
            .admit_peer_execution(&rejoined.owner, &next, &execution, || Ok(()))
            .is_err()
    );
    close(&first).await;
    close(&first_remote).await;
    close(&next).await;
    close(&next_remote).await;
}
