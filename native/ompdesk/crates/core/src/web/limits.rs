//! The edge's limits (`web/rate-limit.ts`, the parts the HTTP edge uses): a sliding window per key, an exponential
//! back-off for repeated failures, the pairing guard made of both, and the throttle that tells the desktop once about
//! failed device authentications. Time is an argument (milliseconds), so a test steps it.

use std::collections::HashMap;
use std::sync::Mutex;

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// At most `max` hits per `window_ms` for each key.
pub struct SlidingWindow {
    max: usize,
    window_ms: i64,
    hits: Mutex<HashMap<String, Vec<i64>>>,
}

impl SlidingWindow {
    pub fn new(max: usize, window_ms: i64) -> Self {
        Self {
            max,
            window_ms,
            hits: Mutex::new(HashMap::new()),
        }
    }

    /// Count one hit of `key`; false (and nothing counted) when the window is full.
    pub fn hit(&self, key: &str, now: i64) -> bool {
        let mut hits = locked(&self.hits);
        let mut recent = Self::recent(&hits, key, now, self.window_ms);
        if recent.len() >= self.max {
            return false;
        }
        recent.push(now);
        hits.insert(key.to_owned(), recent);
        // Drop keys whose hits all aged out, so a scan over many addresses cannot grow the map without bound.
        if hits.len() >= 1024 {
            let window = self.window_ms;
            hits.retain(|_, times| times.iter().any(|&at| now - at < window));
        }
        true
    }

    /// Milliseconds until `key` may hit again (0 when it may now).
    pub fn retry_after_ms(&self, key: &str, now: i64) -> i64 {
        let hits = locked(&self.hits);
        let recent = Self::recent(&hits, key, now, self.window_ms);
        match recent.first() {
            Some(&oldest) if recent.len() >= self.max => oldest + self.window_ms - now,
            _ => 0,
        }
    }

    fn recent(hits: &HashMap<String, Vec<i64>>, key: &str, now: i64, window_ms: i64) -> Vec<i64> {
        hits.get(key)
            .map(|times| {
                times
                    .iter()
                    .copied()
                    .filter(|&at| now - at < window_ms)
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// After each failure of a key the next attempt waits twice as long (base, 2 x base, ... capped); a success forgets it.
pub struct FailureBackoff {
    base_ms: i64,
    max_ms: i64,
    state: Mutex<HashMap<String, (u32, i64)>>,
}

impl FailureBackoff {
    pub fn new(base_ms: i64, max_ms: i64) -> Self {
        Self {
            base_ms,
            max_ms,
            state: Mutex::new(HashMap::new()),
        }
    }

    pub fn retry_after_ms(&self, key: &str, now: i64) -> i64 {
        locked(&self.state)
            .get(key)
            .map_or(0, |&(_, until)| (until - now).max(0))
    }

    pub fn fail(&self, key: &str, now: i64) {
        let mut state = locked(&self.state);
        let failures = state.get(key).map_or(0, |&(n, _)| n) + 1;
        // `2 ** (failures - 1)` in doubles: past 2^53 the cap decides anyway.
        let delay =
            (self.base_ms as f64 * 2f64.powi(failures as i32 - 1)).min(self.max_ms as f64) as i64;
        state.insert(key.to_owned(), (failures, now + delay));
        if state.len() > 1024 {
            let max = self.max_ms;
            state.retain(|_, &mut (_, until)| until + max >= now);
        }
    }

    pub fn succeed(&self, key: &str) {
        locked(&self.state).remove(key);
    }
}

pub enum Pairing {
    Ok,
    RetryAfterMs(i64),
}

/// `/api/pair`: 10 a minute per source address, 30 a minute overall, and a growing wait after refused attempts.
pub struct PairingGuard {
    per_address: SlidingWindow,
    overall: SlidingWindow,
    backoff: FailureBackoff,
}

impl Default for PairingGuard {
    fn default() -> Self {
        Self {
            per_address: SlidingWindow::new(10, 60_000),
            overall: SlidingWindow::new(30, 60_000),
            backoff: FailureBackoff::new(1000, 5 * 60_000),
        }
    }
}

impl PairingGuard {
    /// Count one attempt of `address`.
    pub fn check(&self, address: &str, now: i64) -> Pairing {
        let wait = self.backoff.retry_after_ms(address, now);
        if wait > 0 {
            return Pairing::RetryAfterMs(wait);
        }
        if !self.per_address.hit(address, now) {
            return Pairing::RetryAfterMs(self.per_address.retry_after_ms(address, now));
        }
        if !self.overall.hit("*", now) {
            return Pairing::RetryAfterMs(self.overall.retry_after_ms("*", now));
        }
        Pairing::Ok
    }

    pub fn fail(&self, address: &str, now: i64) {
        self.backoff.fail(address, now);
    }

    pub fn succeed(&self, address: &str) {
        self.backoff.succeed(address);
    }
}

/// Failed device authentications from anything unpaired: `record` is true exactly once when `threshold` of them land
/// within `window_ms` (the desktop is told once), then false until `quiet_ms` has passed.
pub struct UnpairedThrottle {
    threshold: usize,
    window_ms: i64,
    quiet_ms: i64,
    state: Mutex<(Vec<i64>, i64)>,
}

impl Default for UnpairedThrottle {
    fn default() -> Self {
        Self {
            threshold: 3,
            window_ms: 60_000,
            quiet_ms: 10 * 60_000,
            state: Mutex::new((Vec::new(), 0)),
        }
    }
}

impl UnpairedThrottle {
    pub fn record(&self, now: i64) -> bool {
        let mut state = locked(&self.state);
        let (times, muted_until) = &mut *state;
        times.push(now);
        times.retain(|&at| now - at < self.window_ms);
        if now < *muted_until || times.len() < self.threshold {
            return false;
        }
        *muted_until = now + self.quiet_ms;
        times.clear();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_counts_and_ages_out() {
        let window = SlidingWindow::new(2, 1000);
        assert!(window.hit("a", 0));
        assert!(window.hit("a", 10));
        assert!(!window.hit("a", 20));
        assert_eq!(window.retry_after_ms("a", 20), 980);
        assert!(window.hit("b", 20));
        assert!(window.hit("a", 1000), "the first hit left the window");
        assert_eq!(window.retry_after_ms("c", 0), 0);
    }

    #[test]
    fn backoff_doubles_to_its_cap() {
        let backoff = FailureBackoff::new(1000, 5000);
        backoff.fail("a", 0);
        assert_eq!(backoff.retry_after_ms("a", 0), 1000);
        backoff.fail("a", 0);
        assert_eq!(backoff.retry_after_ms("a", 0), 2000);
        backoff.fail("a", 0);
        backoff.fail("a", 0);
        assert_eq!(backoff.retry_after_ms("a", 0), 5000);
        assert_eq!(backoff.retry_after_ms("a", 6000), 0);
        backoff.succeed("a");
        assert_eq!(backoff.retry_after_ms("a", 0), 0);
    }

    #[test]
    fn pairing_guard_limits_each_address_and_all() {
        let guard = PairingGuard::default();
        for _ in 0..10 {
            assert!(matches!(guard.check("a", 0), Pairing::Ok));
        }
        assert!(matches!(guard.check("a", 0), Pairing::RetryAfterMs(60_000)));
        for n in 0..20 {
            assert!(matches!(guard.check(&format!("b{n}"), 0), Pairing::Ok));
        }
        assert!(
            matches!(guard.check("c", 0), Pairing::RetryAfterMs(60_000)),
            "30 a minute overall"
        );
        guard.fail("d", 100_000);
        assert!(matches!(
            guard.check("d", 100_500),
            Pairing::RetryAfterMs(500)
        ));
    }

    #[test]
    fn unpaired_throttle_speaks_once_then_is_quiet() {
        let throttle = UnpairedThrottle::default();
        assert!(!throttle.record(0));
        assert!(!throttle.record(1000));
        assert!(throttle.record(2000));
        for t in [3000, 4000, 5000, 6000] {
            assert!(!throttle.record(t), "muted");
        }
        let later = 2000 + 10 * 60_000;
        assert!(!throttle.record(later));
        assert!(!throttle.record(later + 1));
        assert!(throttle.record(later + 2));
    }
}
