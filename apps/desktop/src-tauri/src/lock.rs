//! Locking for the shell's small shared registries.

use std::sync::{Mutex, MutexGuard};

/// Locks a mutex that a panic cannot leave half-changed (every change under the shell's locks is a single step), so
/// a poisoned value is still usable.
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}
