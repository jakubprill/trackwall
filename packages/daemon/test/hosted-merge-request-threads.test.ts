import { describe, expect, test } from "bun:test";
import { fakeHosting } from "./support/hosting.ts";

const GITLAB = { kind: "gitlab", host: "gitlab.example.com", path: "shop/backend/orders" } as const;
const GITHUB = { kind: "github", host: "github.com", path: "me/shop" } as const;
const GITLAB_MR = { number: 12, url: "https://gitlab.example.com/shop/backend/orders/-/merge_requests/12" };
const GITHUB_PR = { number: 7, url: "https://github.com/me/shop/pull/7" };
const DISCUSSIONS = "projects/shop%2Fbackend%2Forders/merge_requests/12/discussions";
const AT = "2026-11-16T10:00:00Z";

const note = (id: number, body: string, more: Record<string, unknown> = {}) => ({
  id,
  body,
  author: { username: "reviewer" },
  created_at: AT,
  system: false,
  resolvable: true,
  resolved: false,
  ...more,
});
const onLine = (newLine: number | null, oldLine: number | null) => ({
  position: { new_path: "src/cart.ts", old_path: "src/cart.ts", new_line: newLine, old_line: oldLine },
});

describe("the unresolved threads of a GitLab merge request", () => {
  test("are its resolvable discussions not resolved yet, each with its file, line and notes, without GitLab's own notes", async () => {
    const { hosting, calls } = fakeHosting({
      apiResponses: {
        [DISCUSSIONS]: [
          {
            id: "a".repeat(40),
            notes: [note(1, "Use a constant here.", onLine(14, null)), note(2, "Agreed.", { author: { username: "lead" } })],
          },
          { id: "b".repeat(40), notes: [note(3, "Why remove this check?", onLine(null, 30))] },
          { id: "c".repeat(40), notes: [note(4, "Fixed, thanks.", { ...onLine(20, null), resolved: true })] },
          // A plain comment is not a thread GitLab can resolve, and a system note is GitLab's own.
          { id: "d".repeat(40), notes: [note(5, "Nice work!", { resolvable: false, resolved: undefined })] },
          { id: "e".repeat(40), notes: [note(6, "added 1 commit", { system: true, resolvable: false, resolved: undefined })] },
          { id: "f".repeat(40), notes: [note(7, "Please split this merge request.", { position: null })] },
        ],
      },
    });

    expect(await hosting.mergeRequestThreads(GITLAB, GITLAB_MR)).toEqual({
      mergeRequest: GITLAB_MR.url,
      threads: [
        {
          id: "a".repeat(40),
          file: "src/cart.ts",
          line: { side: "new", number: 14 },
          url: `${GITLAB_MR.url}#note_1`,
          notes: [
            { author: "reviewer", text: "Use a constant here.", at: AT },
            { author: "lead", text: "Agreed.", at: AT },
          ],
          moreNotes: 0,
        },
        {
          id: "b".repeat(40),
          file: "src/cart.ts",
          line: { side: "old", number: 30 },
          url: `${GITLAB_MR.url}#note_3`,
          notes: [{ author: "reviewer", text: "Why remove this check?", at: AT }],
          moreNotes: 0,
        },
        {
          id: "f".repeat(40),
          file: null,
          line: null,
          url: `${GITLAB_MR.url}#note_7`,
          notes: [{ author: "reviewer", text: "Please split this merge request.", at: AT }],
          moreNotes: 0,
        },
      ],
      more: false,
    });
    expect(calls()[0]?.args).toEqual(["api", "--hostname", "gitlab.example.com", `${DISCUSSIONS}?per_page=100&page=1`]);
  });

  test("a long note is cut at 1,000 characters and a long thread keeps its first five notes", async () => {
    const long = "x".repeat(1200);
    const { hosting } = fakeHosting({
      apiResponses: {
        [DISCUSSIONS]: [{ id: "a".repeat(40), notes: Array.from({ length: 7 }, (_, i) => note(i + 1, i === 0 ? long : `reply ${i}`)) }],
      },
    });

    const [thread] = (await hosting.mergeRequestThreads(GITLAB, GITLAB_MR)).threads;
    expect(thread?.notes).toHaveLength(5);
    expect(thread?.notes[0]?.text).toBe(`${"x".repeat(1000)}…`);
    expect(thread?.moreNotes).toBe(2);
  });

  test("an error from glab is the error of the read", async () => {
    const { hosting } = fakeHosting({ apiPathErrors: { [DISCUSSIONS]: "HTTP 401: 401 Unauthorized" } });

    await expect(hosting.mergeRequestThreads(GITLAB, GITLAB_MR)).rejects.toThrow("HTTP 401");
  });
});

const githubThread = (id: string, resolved: boolean, more: Record<string, unknown> = {}) => ({
  id,
  isResolved: resolved,
  path: "src/cart.ts",
  line: 14,
  originalLine: 12,
  diffSide: "RIGHT",
  comments: {
    totalCount: 1,
    nodes: [{ author: { login: "reviewer" }, body: `Comment of ${id}.`, createdAt: AT, url: `${GITHUB_PR.url}#discussion_r${id}` }],
  },
  ...more,
});
const reviewThreads = (nodes: unknown[], totalCount = nodes.length) => ({
  data: { repository: { pullRequest: { reviewThreads: { totalCount, nodes } } } },
});

describe("the unresolved review threads of a GitHub pull request", () => {
  test("come from GraphQL, which alone says whether a thread is resolved, with the variables as fields", async () => {
    const { hosting, calls } = fakeHosting({
      apiResponses: {
        graphql: reviewThreads([
          githubThread("PRRT_1", false),
          githubThread("PRRT_2", true),
          // An outdated thread has only the line the reviewer saw; a removed line is on the left.
          githubThread("PRRT_3", false, { line: null, originalLine: 9, diffSide: "LEFT" }),
          githubThread("PRRT_4", false, {
            comments: {
              totalCount: 8,
              nodes: [{ author: null, body: "From a deleted account.", createdAt: AT, url: `${GITHUB_PR.url}#4` }],
            },
          }),
        ]),
      },
    });

    const read = await hosting.mergeRequestThreads(GITHUB, GITHUB_PR);
    expect(read.threads.map((t) => [t.id, t.line, t.notes[0]?.author, t.moreNotes])).toEqual([
      ["PRRT_1", { side: "new", number: 14 }, "reviewer", 0],
      ["PRRT_3", { side: "old", number: 9 }, "reviewer", 0],
      ["PRRT_4", { side: "new", number: 14 }, "ghost", 7],
    ]);
    expect(read.threads[0]).toEqual({
      id: "PRRT_1",
      file: "src/cart.ts",
      line: { side: "new", number: 14 },
      url: `${GITHUB_PR.url}#discussion_rPRRT_1`,
      notes: [{ author: "reviewer", text: "Comment of PRRT_1.", at: AT }],
      moreNotes: 0,
    });
    expect(read.more).toBe(false);
    const args = calls()[0]?.args ?? [];
    expect(args.slice(0, 5)).toEqual(["api", "--hostname", "github.com", "graphql", "-f"]);
    expect(args[5]).toStartWith("query=query($owner: String!, $name: String!, $number: Int!)");
    expect(args.slice(6)).toEqual(["-f", "owner=me", "-f", "name=shop", "-F", "number=7"]);
  });

  test("more threads than one page says so, and a pull request GitHub does not show is an error", async () => {
    const more = fakeHosting({ apiResponses: { graphql: reviewThreads([githubThread("PRRT_1", false)], 140) } });
    expect((await more.hosting.mergeRequestThreads(GITHUB, GITHUB_PR)).more).toBe(true);

    const gone = fakeHosting({ apiResponses: { graphql: { data: { repository: { pullRequest: null } } } } });
    await expect(gone.hosting.mergeRequestThreads(GITHUB, GITHUB_PR)).rejects.toThrow("GitHub does not show pull request #7 of me/shop");
  });
});
