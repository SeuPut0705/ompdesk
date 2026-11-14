//! Idle-sleep and lid holds follow the same work, even when an OS idle assertion fails to apply.

use std::collections::BTreeSet;

pub trait Platform {
    fn idle(&mut self, key: &str, held: bool) -> Result<(), String>;
    fn lid(&mut self, key: &str, held: bool);
}

#[derive(Default)]
pub struct Awake {
    /// An unsuccessful idle release still needs a cleanup attempt at shutdown.
    cleanup: BTreeSet<u64>,
}

impl Awake {
    pub const fn new() -> Self {
        Self {
            cleanup: BTreeSet::new(),
        }
    }

    pub fn set(&mut self, id: u64, held: bool, platform: &mut impl Platform) -> Result<(), String> {
        if held {
            self.cleanup.insert(id);
        }
        let key = id.to_string();
        let result = platform.idle(&key, held);
        platform.lid(&key, held);
        if !held && result.is_ok() {
            self.cleanup.remove(&id);
        }
        result
    }

    pub fn take_cleanup(&mut self) -> BTreeSet<u64> {
        std::mem::take(&mut self.cleanup)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Computer {
        idle: BTreeSet<String>,
        lid: BTreeSet<String>,
        fail_idle_apply: bool,
    }

    impl Platform for Computer {
        fn idle(&mut self, key: &str, held: bool) -> Result<(), String> {
            // power.rs changes its registry before applying the OS assertion.
            if held {
                self.idle.insert(key.into());
            } else {
                self.idle.remove(key);
            }
            if self.fail_idle_apply {
                Err("idle assertion failed".into())
            } else {
                Ok(())
            }
        }

        fn lid(&mut self, key: &str, held: bool) {
            if held {
                self.lid.insert(key.into());
            } else {
                self.lid.remove(key);
            }
        }
    }

    #[test]
    fn a_failed_idle_hold_still_protects_work_from_lid_sleep() {
        let mut awake = Awake::new();
        let mut computer = Computer {
            fail_idle_apply: true,
            ..Computer::default()
        };
        assert_eq!(
            awake.set(7, true, &mut computer),
            Err("idle assertion failed".into())
        );
        assert!(
            !computer.lid.is_empty(),
            "running work must still hold the lid policy"
        );
        assert_eq!(awake.take_cleanup(), BTreeSet::from([7]));
    }

    #[test]
    fn a_failed_idle_release_never_leaves_the_lid_overridden() {
        let mut awake = Awake::new();
        let mut computer = Computer::default();
        awake.set(7, true, &mut computer).unwrap();
        computer.fail_idle_apply = true;
        assert_eq!(
            awake.set(7, false, &mut computer),
            Err("idle assertion failed".into())
        );
        assert!(computer.idle.is_empty());
        assert!(
            computer.lid.is_empty(),
            "ended work must release its lid override despite the idle error"
        );
        assert_eq!(
            awake.take_cleanup(),
            BTreeSet::from([7]),
            "shutdown still retries the failed idle release"
        );
    }

    #[test]
    fn ending_one_failed_hold_does_not_release_other_work() {
        let mut awake = Awake::new();
        let mut computer = Computer {
            fail_idle_apply: true,
            ..Computer::default()
        };
        assert!(awake.set(7, true, &mut computer).is_err());
        assert!(awake.set(8, true, &mut computer).is_err());
        assert!(awake.set(7, false, &mut computer).is_err());
        assert_eq!(computer.lid, BTreeSet::from(["8".into()]));
        computer.fail_idle_apply = false;
        awake.set(8, false, &mut computer).unwrap();
        assert!(computer.lid.is_empty());
        assert_eq!(awake.take_cleanup(), BTreeSet::from([7]));
    }
}
