import {
  type HostedProject,
  MERGE_REQUEST_NOTE_CHARS_MAX,
  MERGE_REQUEST_THREAD_NOTES_MAX,
  MERGE_REQUEST_THREADS_READ_MAX,
  type MergeRequestNote,
  type MergeRequestThread,
  MergeRequestThreadId,
  type MergeRequestThreads,
  type RepoHostKind,
} from "@trackwall/protocol";
import { z } from "zod";

/**
 * The unresolved threads of a merge request on GitHub and GitLab (ADR-255): GitLab's discussions through its REST API,
 * GitHub's review threads through GraphQL, the only API that says whether a thread is resolved. Only reads; replying
 * and resolving stay with the user on the repo host. Running `gh` and `glab` is in `hosting.ts`.
 */

/** One `<cli> api <path>` call, its response checked by `schema`. */
type RestApi = <T>(path: string, schema: z.ZodType<T>) => Promise<T>;
/** One `gh api graphql` call with string and number variables, its response checked by `schema`. */
type GraphqlApi = <T>(query: string, variables: Record<string, string | number>, schema: z.ZodType<T>) => Promise<T>;

export interface ThreadsApi {
  rest: RestApi;
  graphql: GraphqlApi;
}

/** The merge request whose threads are read: its number on the repo host and its page. */
export interface ThreadsOf {
  number: number;
  url: string;
}

/** GitLab's largest page, and how many of them to read: a merge request with more discussions than that is rare. */
const GITLAB_PAGE = 100;
const GITLAB_MAX_PAGES = 3;

const GitLabNote = z.object({
  id: z.number().int().positive(),
  body: z.string(),
  author: z.object({ username: z.string() }),
  created_at: z.string(),
  system: z.boolean(),
  resolvable: z.boolean(),
  resolved: z.boolean().optional(),
  position: z
    .object({
      new_path: z.string().nullish(),
      old_path: z.string().nullish(),
      new_line: z.number().int().positive().nullish(),
      old_line: z.number().int().positive().nullish(),
    })
    .nullish(),
});
type GitLabNote = z.infer<typeof GitLabNote>;

const GitLabDiscussions = z.array(z.object({ id: MergeRequestThreadId, notes: z.array(GitLabNote) }));
type GitLabDiscussion = z.infer<typeof GitLabDiscussions>[number];

async function gitlabThreads(api: ThreadsApi, project: HostedProject, mr: ThreadsOf): Promise<MergeRequestThreads> {
  const base = `projects/${encodeURIComponent(project.path)}/merge_requests/${mr.number}/discussions`;
  const discussions: GitLabDiscussion[] = [];
  let full = true;
  for (let page = 1; full && page <= GITLAB_MAX_PAGES; page++) {
    const received = await api.rest(`${base}?per_page=${GITLAB_PAGE}&page=${page}`, GitLabDiscussions);
    discussions.push(...received);
    full = received.length === GITLAB_PAGE;
  }
  const threads = discussions.flatMap((d) => {
    const thread = gitlabThread(d, mr.url);
    return thread ? [thread] : [];
  });
  return atMostRead(mr.url, threads, full);
}

/**
 * A GitLab discussion as a thread while one of its notes is resolvable and not resolved: a comment that is not a
 * thread (GitLab cannot resolve it) and the notes GitLab writes itself are not review comments to address.
 */
function gitlabThread(discussion: GitLabDiscussion, mergeRequest: string): MergeRequestThread | null {
  if (!discussion.notes.some((n) => n.resolvable && n.resolved === false)) return null;
  const written = discussion.notes.filter((n) => !n.system);
  const [first] = written;
  if (!first) return null;
  const position = first.position;
  const file = position ? (position.new_path ?? position.old_path ?? null) : null;
  return {
    id: discussion.id,
    file,
    line: gitlabLine(first),
    url: `${mergeRequest}#note_${first.id}`,
    ...notes(written.map((n) => ({ author: n.author.username, text: n.body, at: n.created_at }))),
  };
}

/** A line of the new file when the note has one; otherwise a removed line of the old file. */
function gitlabLine({ position }: GitLabNote): MergeRequestThread["line"] {
  if (position?.new_line) return { side: "new", number: position.new_line };
  if (position?.old_line) return { side: "old", number: position.old_line };
  return null;
}

/** GitHub's review threads, with the first comments of each; `isResolved` is GraphQL's alone. */
const GITHUB_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: ${MERGE_REQUEST_THREADS_READ_MAX}) {
        totalCount
        nodes {
          id
          isResolved
          path
          line
          originalLine
          diffSide
          comments(first: ${MERGE_REQUEST_THREAD_NOTES_MAX}) {
            totalCount
            nodes { author { login } body createdAt url }
          }
        }
      }
    }
  }
}`;

/** A deleted account's comments have no author; GitHub shows them as "ghost". */
const GITHUB_GHOST = "ghost";

const GitHubThreads = z.object({
  data: z.object({
    repository: z
      .object({
        pullRequest: z
          .object({
            reviewThreads: z.object({
              totalCount: z.number().int().nonnegative(),
              nodes: z.array(
                z.object({
                  id: MergeRequestThreadId,
                  isResolved: z.boolean(),
                  path: z.string(),
                  line: z.number().int().positive().nullable(),
                  originalLine: z.number().int().positive().nullable(),
                  diffSide: z.enum(["LEFT", "RIGHT"]),
                  comments: z.object({
                    totalCount: z.number().int().nonnegative(),
                    nodes: z.array(
                      z.object({
                        author: z.object({ login: z.string() }).nullable(),
                        body: z.string(),
                        createdAt: z.string(),
                        url: z.string(),
                      }),
                    ),
                  }),
                }),
              ),
            }),
          })
          .nullable(),
      })
      .nullable(),
  }),
});

async function githubThreads(api: ThreadsApi, project: HostedProject, mr: ThreadsOf): Promise<MergeRequestThreads> {
  const [owner = "", name = ""] = project.path.split("/");
  const answer = await api.graphql(GITHUB_THREADS_QUERY, { owner, name, number: mr.number }, GitHubThreads);
  const found = answer.data.repository?.pullRequest?.reviewThreads;
  if (!found) throw new Error(`GitHub does not show pull request #${mr.number} of ${project.path}`);
  const threads = found.nodes.flatMap((t): MergeRequestThread[] => {
    const [first] = t.comments.nodes;
    if (t.isResolved || !first) return [];
    // `line` follows the thread through later commits; an outdated thread has only the line the reviewer saw.
    const number = t.line ?? t.originalLine;
    const written = t.comments.nodes.map((c) => ({ author: c.author?.login ?? GITHUB_GHOST, text: c.body, at: c.createdAt }));
    const { notes: kept, moreNotes } = notes(written);
    return [
      {
        id: t.id,
        file: t.path,
        line: number === null ? null : { side: t.diffSide === "LEFT" ? "old" : "new", number },
        url: first.url,
        notes: kept,
        moreNotes: moreNotes + Math.max(0, t.comments.totalCount - t.comments.nodes.length),
      },
    ];
  });
  return atMostRead(mr.url, threads, found.totalCount > found.nodes.length);
}

/** The first notes of a thread, each cut to `MERGE_REQUEST_NOTE_CHARS_MAX` characters, and how many were left out. */
function notes(written: MergeRequestNote[]): { notes: [MergeRequestNote, ...MergeRequestNote[]]; moreNotes: number } {
  const [first, ...rest] = written.slice(0, MERGE_REQUEST_THREAD_NOTES_MAX).map((n) => ({ ...n, text: cut(n.text) }));
  if (!first) throw new Error("a thread without a note");
  return { notes: [first, ...rest], moreNotes: Math.max(0, written.length - MERGE_REQUEST_THREAD_NOTES_MAX) };
}

/** By code points, so a cut never splits an emoji. */
function cut(text: string): string {
  const chars = Array.from(text);
  return chars.length <= MERGE_REQUEST_NOTE_CHARS_MAX ? text : `${chars.slice(0, MERGE_REQUEST_NOTE_CHARS_MAX).join("")}…`;
}

function atMostRead(mergeRequest: string, threads: MergeRequestThread[], unread: boolean): MergeRequestThreads {
  return {
    mergeRequest,
    threads: threads.slice(0, MERGE_REQUEST_THREADS_READ_MAX),
    more: unread || threads.length > MERGE_REQUEST_THREADS_READ_MAX,
  };
}

const THREADS: Record<RepoHostKind, (api: ThreadsApi, project: HostedProject, mr: ThreadsOf) => Promise<MergeRequestThreads>> = {
  github: githubThreads,
  gitlab: gitlabThreads,
};

/** The unresolved threads of merge request `mr` in `project`, oldest first, at most `MERGE_REQUEST_THREADS_READ_MAX`. */
export function findMergeRequestThreads(api: ThreadsApi, project: HostedProject, mr: ThreadsOf): Promise<MergeRequestThreads> {
  return THREADS[project.kind](api, project, mr);
}
