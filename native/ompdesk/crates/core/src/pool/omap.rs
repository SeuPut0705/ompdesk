//! An insertion-ordered map, as JavaScript's `Map`: `insert` on a key already there keeps its place, a removed key that
//! returns goes last. The pool's maps are short (tabs, windows, open requests) and their order is observable (which tab
//! or request is told first), so a vector of pairs is the honest structure.

#[derive(Clone, Debug)]
pub(crate) struct OMap<K, V> {
    items: Vec<(K, V)>,
}

impl<K, V> Default for OMap<K, V> {
    fn default() -> Self {
        OMap { items: Vec::new() }
    }
}

impl<K: PartialEq, V> OMap<K, V> {
    pub(crate) fn len(&self) -> usize {
        self.items.len()
    }

    pub(crate) fn get(&self, key: &K) -> Option<&V> {
        self.items
            .iter()
            .find(|(candidate, _)| candidate == key)
            .map(|(_, value)| value)
    }

    pub(crate) fn get_mut(&mut self, key: &K) -> Option<&mut V> {
        self.items
            .iter_mut()
            .find(|(candidate, _)| candidate == key)
            .map(|(_, value)| value)
    }

    pub(crate) fn contains(&self, key: &K) -> bool {
        self.get(key).is_some()
    }

    pub(crate) fn insert(&mut self, key: K, value: V) {
        match self
            .items
            .iter_mut()
            .find(|(candidate, _)| *candidate == key)
        {
            Some((_, slot)) => *slot = value,
            None => self.items.push((key, value)),
        }
    }

    pub(crate) fn remove(&mut self, key: &K) -> Option<V> {
        let at = self
            .items
            .iter()
            .position(|(candidate, _)| candidate == key)?;
        Some(self.items.remove(at).1)
    }

    pub(crate) fn clear(&mut self) {
        self.items.clear();
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = (&K, &V)> {
        self.items.iter().map(|(key, value)| (key, value))
    }

    pub(crate) fn keys(&self) -> impl Iterator<Item = &K> {
        self.items.iter().map(|(key, _)| key)
    }

    pub(crate) fn values(&self) -> impl Iterator<Item = &V> {
        self.items.iter().map(|(_, value)| value)
    }

    pub(crate) fn retain(&mut self, mut keep: impl FnMut(&K, &V) -> bool) {
        self.items.retain(|(key, value)| keep(key, value));
    }

    /// The oldest key.
    pub(crate) fn first_key(&self) -> Option<&K> {
        self.items.first().map(|(key, _)| key)
    }
}
