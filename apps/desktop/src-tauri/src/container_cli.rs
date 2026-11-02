//! The `trackwall-container` command of the Trackwall Dev Container Feature as the window runs it through `docker exec`
//! (ADR-164 `start`, ADR-165 `update`; ADR-139): its command lines, and what the window reads of the one JSON object it
//! prints (`ContainerStartResult` and `ContainerUpdateResult` in `protocol`). Only `ok` and the error's code and message
//! matter here; the message is shown, never run.

use serde::Deserialize;

/// Starts the daemon when it does not answer; idempotent. Run without `--user`: as root it runs itself again as the
/// remote user, whose `daemon.json` the window reads.
pub const START: [&str; 2] = ["trackwall-container", "start"];

/// Replaces Trackwall in the container with a signed release of the version that follows, in the background.
pub const UPDATE: [&str; 2] = ["trackwall-container", "update"];

/// The stable error codes of `CONTAINER_START_ERRORS` and `CONTAINER_UPDATE_ERRORS` (protocol).
pub const START_ERRORS: [&str; 2] = ["bad-arguments", "start-failed"];
pub const UPDATE_ERRORS: [&str; 3] = ["bad-arguments", "update-running", "update-failed"];

/// What `docker exec` exits with when the command is not in the container: an image without the Feature, or a Feature
/// whose binary is gone.
const COMMAND_NOT_FOUND: i32 = 127;

/// The command's answer as the window acts on it.
#[derive(Debug, PartialEq)]
pub enum Answer {
    Done,
    NoFeature,
    Failed {
        code: &'static str,
        message: String,
    },
    /// Not an answer of Trackwall's: no JSON, or an error code the protocol does not have.
    Unreadable,
}

#[derive(Deserialize)]
struct Raw {
    ok: bool,
    error: Option<RawError>,
}

#[derive(Deserialize)]
struct RawError {
    code: String,
    message: String,
}

/// Reads the last non-empty line of `stdout`; `codes` are the error codes the command may answer with.
pub fn read(exit_code: Option<i32>, stdout: &str, codes: &[&'static str]) -> Answer {
    if exit_code == Some(COMMAND_NOT_FOUND) {
        return Answer::NoFeature;
    }
    let last_line = stdout.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or_default();
    match serde_json::from_str::<Raw>(last_line) {
        Ok(Raw { ok: true, .. }) => Answer::Done,
        Ok(Raw { error: Some(RawError { code, message }), .. }) => match codes.iter().find(|known| **known == code) {
            Some(known) => Answer::Failed { code: known, message },
            None => Answer::Unreadable,
        },
        _ => Answer::Unreadable,
    }
}

/// The `docker exec` arguments that run `command` in the container `id`.
pub fn exec<'a>(id: &'a str, command: [&'a str; 2]) -> Vec<&'a str> {
    vec!["exec", id, command[0], command[1]]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_last_line_of_a_successful_answer() {
        let stdout = "starting...\n{\"ok\":true,\"version\":\"0.6.0\",\"status\":\"starting\",\"port\":7700}\n\n";

        assert_eq!(read(Some(0), stdout, &START_ERRORS), Answer::Done);
    }

    #[test]
    fn reads_a_known_error_code_with_its_message() {
        let stdout = r#"{"ok":false,"version":"0.6.0","error":{"code":"update-running","message":"Another update is running."}}"#;

        let answer = read(Some(1), stdout, &UPDATE_ERRORS);

        assert_eq!(answer, Answer::Failed { code: "update-running", message: "Another update is running.".into() });
    }

    #[test]
    fn takes_an_error_code_of_the_other_command_or_no_json_for_no_answer_of_trackwalls() {
        let other = r#"{"ok":false,"version":"0.6.0","error":{"code":"update-running","message":"x"}}"#;

        assert_eq!(read(Some(1), other, &START_ERRORS), Answer::Unreadable);
        assert_eq!(read(Some(126), "OCI runtime exec failed", &START_ERRORS), Answer::Unreadable);
    }

    #[test]
    fn takes_exit_code_127_for_an_image_without_the_feature() {
        assert_eq!(read(Some(127), "", &UPDATE_ERRORS), Answer::NoFeature);
    }
}
