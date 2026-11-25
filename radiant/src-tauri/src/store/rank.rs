//! Fractional sibling keys. SQLite compares BLOB keys lexicographically, byte by byte.
//! A key always ends in a nonzero byte, so a new key can fit between any two distinct keys.

pub(super) fn valid(key: &[u8]) -> bool {
    key.last().is_some_and(|byte| *byte != 0)
}

fn between(left: &[u8], mut right: Option<&[u8]>) -> Vec<u8> {
    let mut key = Vec::new();
    for i in 0.. {
        let low = u16::from(left.get(i).copied().unwrap_or(0));
        let high = right.map_or(256, |r| u16::from(r[i]));
        if high > low + 1 {
            key.push(((low + high) / 2) as u8);
            return key;
        }
        key.push(low as u8);
        if high > low {
            // Choosing the smaller digit leaves the rest of the key unbounded above.
            right = None;
        }
    }
    unreachable!()
}

fn fill_gap(keys: &mut [Vec<u8>], left: &[u8], right: Option<&[u8]>) {
    if keys.is_empty() {
        return;
    }
    let middle = keys.len() / 2;
    let (earlier, at_and_after) = keys.split_at_mut(middle);
    let (at, later) = at_and_after.split_first_mut().unwrap();
    *at = between(left, right);
    fill_gap(earlier, left, Some(at));
    fill_gap(later, at, right);
}

/// Retain a longest increasing subsequence of existing sibling ranks. Inserts keep
/// every existing key, while a reorder changes only items outside that subsequence.
pub(super) fn assign(previous: &[Option<&[u8]>]) -> Vec<Vec<u8>> {
    let n = previous.len();
    let mut tails: Vec<usize> = Vec::new();
    let mut predecessor = vec![None; n];
    for (i, value) in previous.iter().copied().enumerate() {
        let Some(key) = value else { continue };
        let pos = tails.partition_point(|&j| previous[j].unwrap() < key);
        if pos != 0 {
            predecessor[i] = Some(tails[pos - 1]);
        }
        if pos == tails.len() {
            tails.push(i);
        } else {
            tails[pos] = i;
        }
    }
    if tails.is_empty() {
        // Leave wide initial gaps for legacy migration, fresh saves and new sibling lists.
        let step = u64::MAX / (n as u64 + 1);
        return (1..=n)
            .map(|i| {
                let mut key = (step * i as u64).to_be_bytes().to_vec();
                if !valid(&key) {
                    key.push(128);
                }
                key
            })
            .collect();
    }

    let mut kept = Vec::with_capacity(tails.len());
    let mut at = tails.last().copied();
    while let Some(i) = at {
        kept.push(i);
        at = predecessor[i];
    }
    let mut keys = vec![Vec::new(); n];
    let mut offset = 0;
    let mut left: &[u8] = &[];
    for i in kept.into_iter().rev() {
        let right = previous[i].unwrap();
        fill_gap(&mut keys[offset..i], left, Some(right));
        keys[i] = right.to_vec();
        offset = i + 1;
        left = right;
    }
    fill_gap(&mut keys[offset..], left, None);
    keys
}
