use super::*;

#[test]
fn a_live_descendant_refuses_removal_but_a_sibling_does_not() {
    let claims = RemovalClaims::new();
    let target = Folder("/work/gui-task".into());
    let child = Folder("/work/gui-task/src".into());
    assert_eq!(claims.try_claim(target.clone(), &[child]).err().unwrap().code, "in_use");
    let guard = claims.try_claim(target.clone(), &[Folder("/work/gui-task-other".into())]).unwrap();
    assert!(claims.holds(&target));
    assert!(claims.holds(&Folder("/work/gui-task/src/deeper".into())));
    assert!(!claims.holds(&Folder("/work/gui-task-other".into())));
    drop(guard);
    assert!(!claims.holds(&target));
}

#[test]
fn a_second_removal_cannot_take_the_first_removals_claim() {
    let claims = RemovalClaims::new();
    let target = Folder("/work/gui-task".into());
    let held = claims.try_claim(target.clone(), &[]).unwrap();
    assert_eq!(claims.try_claim(target.clone(), &[]).err().unwrap().code, "in_use");
    assert!(claims.holds(&target));
    drop(held);
    assert!(claims.try_claim(target, &[]).is_ok());
}

#[test]
fn an_unrelated_guard_cannot_release_a_live_removal() {
    let claims = RemovalClaims::new();
    let a = Folder("/work/gui-a".into());
    let b = Folder("/work/gui-b".into());
    let held_a = claims.try_claim(a.clone(), &[]).unwrap();
    let held_b = claims.try_claim(b.clone(), &[]).unwrap();
    drop(held_b);
    assert!(claims.holds(&a));
    assert!(!claims.holds(&b));
    drop(held_a);
}
