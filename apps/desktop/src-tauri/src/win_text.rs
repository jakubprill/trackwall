//! Text for Windows API calls.

/// UTF-16 with the terminating zero that `*W` functions expect.
pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}
