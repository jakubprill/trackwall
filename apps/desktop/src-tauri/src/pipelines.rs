//! Failed pipelines of the merge requests from task branches (ADR-154): the daemon follows each task's merge request
//! and marks the moment it saw a pipeline fail (`pipelineFailedAt` in `TaskOutcome`); the shell announces each new mark
//! with a system notification, the same way `attention.rs` announces sessions that start waiting. The rule of when a
//! pipeline failed stays in the daemon; here only a new mark counts. Described in §5.4 of docs/architecture.md.

use serde::Deserialize;
use std::collections::HashMap;

/// A pipeline that failed: what its notification says and the task it opens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailedPipeline {
    pub task: String,
    pub repo: String,
    /// `!12` on GitLab, `#12` on GitHub, as each host writes it.
    pub number: String,
    pub title: String,
    pub jobs: Vec<String>,
    /// When the daemon saw it fail (`pipelineFailedAt`): a new value is a new failure.
    pub failed_at: String,
}

/// Only the fields of the `POST /api/task-outcomes/list` reply the notification needs (`TaskOutcome` in protocol).
#[derive(Deserialize)]
struct Reply {
    data: Vec<Outcome>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Outcome {
    task: String,
    repo: String,
    merge_request: Option<MergeRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MergeRequest {
    number: u64,
    title: String,
    project: Project,
    pipeline: Option<Pipeline>,
    pipeline_failed_at: Option<String>,
}

#[derive(Deserialize)]
struct Project {
    kind: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pipeline {
    failed_jobs: Vec<Job>,
}

#[derive(Deserialize)]
struct Job {
    name: String,
}

/// The tasks whose merge request has a pipeline failure mark; `None` for a reply unlike the contract.
pub fn parse_failed(body: &str) -> Option<Vec<FailedPipeline>> {
    let reply: Reply = serde_json::from_str(body).ok()?;
    Some(
        reply
            .data
            .into_iter()
            .filter_map(|o| {
                let mr = o.merge_request?;
                let failed_at = mr.pipeline_failed_at?;
                let prefix = if mr.project.kind == "gitlab" { "!" } else { "#" };
                Some(FailedPipeline {
                    task: o.task,
                    repo: o.repo,
                    number: format!("{prefix}{}", mr.number),
                    title: mr.title,
                    jobs: mr.pipeline.map(|p| p.failed_jobs.into_iter().map(|j| j.name).collect()).unwrap_or_default(),
                    failed_at,
                })
            })
            .collect(),
    )
}

/// The failure marks of the previous poll, by task; `None` before the first, at which nothing is new, like a session
/// already waiting when the shell starts.
#[derive(Debug, Default)]
pub struct PipelineFailures(Option<HashMap<String, String>>);

impl PipelineFailures {
    /// The pipelines whose failure mark is new since the previous poll.
    pub fn after_poll(&mut self, failed: Vec<FailedPipeline>) -> Vec<FailedPipeline> {
        let previous = self.0.replace(failed.iter().map(|f| (f.task.clone(), f.failed_at.clone())).collect());
        let Some(previous) = previous else { return Vec::new() };
        failed.into_iter().filter(|f| previous.get(&f.task) != Some(&f.failed_at)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(failed_at: Option<&str>, kind: &str) -> String {
        let mark = failed_at.map_or("null".to_owned(), |at| format!(r#""{at}""#));
        format!(
            r#"{{"ok":true,"data":[
                {{"task":"t1","repo":"orders-api","verification":"passed","mergeRequest":{{"number":12,"title":"Add a discount",
                  "url":"u","state":"open","pipeline":{{"state":"failed","url":"p","commit":"c",
                  "failedJobs":[{{"name":"unit-tests","url":null}},{{"name":"lint","url":"j"}}]}},
                  "project":{{"kind":"{kind}","host":"h","path":"shop"}},"pipelineFailedAt":{mark}}}}},
                {{"task":"t2","repo":"shop","verification":"failed","mergeRequest":null}}
            ]}}"#
        )
    }

    #[test]
    fn a_failure_mark_names_the_merge_request_as_its_host_writes_it_and_the_failed_jobs() {
        let failed = parse_failed(&body(Some("2026-10-31T08:00:00.000Z"), "gitlab")).expect("a valid reply");
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].task, "t1");
        assert_eq!(failed[0].repo, "orders-api");
        assert_eq!(failed[0].number, "!12");
        assert_eq!(failed[0].title, "Add a discount");
        assert_eq!(failed[0].jobs, vec!["unit-tests", "lint"]);
        assert_eq!(parse_failed(&body(Some("x"), "github")).unwrap()[0].number, "#12");
    }

    #[test]
    fn a_pipeline_without_a_failure_mark_is_not_listed() {
        assert_eq!(parse_failed(&body(None, "gitlab")), Some(Vec::new()));
        assert_eq!(parse_failed("not json"), None);
    }

    #[test]
    fn only_a_new_mark_is_announced_and_nothing_at_the_first_poll() {
        let mut failures = PipelineFailures::default();
        let first = parse_failed(&body(Some("2026-10-31T08:00:00.000Z"), "gitlab")).unwrap();
        assert_eq!(failures.after_poll(first.clone()), Vec::new());
        assert_eq!(failures.after_poll(first), Vec::new());
        let again = parse_failed(&body(Some("2026-10-31T09:00:00.000Z"), "gitlab")).unwrap();
        assert_eq!(failures.after_poll(again).len(), 1);
    }
}
