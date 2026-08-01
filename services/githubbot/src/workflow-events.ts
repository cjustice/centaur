import type { GitHubAdapter } from "@chat-adapter/github";
import { emitWorkflowEvent } from "./session-api";
import type { GithubbotOptions } from "./types";
import { errorMessage, noopLogger, stringValue } from "./utils";

/**
 * GitHub → durable-workflow-event producer.
 *
 * Lifecycle webhooks (check_run / check_suite / workflow_run / status /
 * pull_request_review) are translated into curated durable events on api-rs
 * (`POST /api/workflows/events`) that workflows suspend on via
 * `ctx.wait_for_event`. This module is deliberately independent of the
 * owned-PR manager in pr-manager.ts: it runs before any ownership gating,
 * because workflow waiters are not bot-owned PRs. The manager reuses this
 * module's settled-CI evaluation for its own gate so an owned PR is never
 * evaluated twice for the same webhook.
 *
 * Two curation rules, both forced by the engine — durable events are
 * immutable per (event_type, correlation_id); first write wins:
 *
 * 1. An event must be SEMANTICALLY COMPLETE when emitted. There is no
 *    re-emit, so firing early (one check completing while the rest of the
 *    suite runs) locks the correlation with a premature payload forever.
 *    `ci-completed` therefore fires only once every check for the sha has
 *    settled.
 * 2. Anything a waiter would filter on must be part of the correlation.
 *    await_event matches on the correlation alone and the first write wins,
 *    so a property that distinguishes signals (WHO reviewed) must be a
 *    correlation segment — otherwise one occurrence consumes the key and the
 *    occurrence the waiter wanted can never land. Waiters therefore key on
 *    exactly the discriminator they care about (e.g. one reviewer's login).
 *
 * Correlations are computable from data a waiter already has — the repo
 * slug, the head sha, the PR number, the author's login — and are
 * lowercased so case drift between a PR URL slug and repository.full_name
 * can never miss:
 *
 *   commit-scoped: <owner>/<repo>:<head_sha>
 *   PR-scoped:     <owner>/<repo>:pr-<n>:<head_sha>:<actor>
 *
 * <actor> is the author's login verbatim from the webhook (lowercased) —
 * GitHub App reviewers carry their canonical `[bot]`-suffixed login
 * (`chatgpt-codex-connector[bot]`), so waiter configs must name the exact
 * login. New events should follow both rules and this convention.
 */

type Octokit = GitHubAdapter["octokit"];

export type WorkflowEventProducerContext = {
  octokit: Octokit;
  options: GithubbotOptions;
};

type JsonRecord = Record<string, unknown>;

// The event-type contract waiters key on.
export const WORKFLOW_EVENT_CI_COMPLETED = "ci-completed";
export const WORKFLOW_EVENT_REVIEW_SUBMITTED = "review-submitted";

function ciCorrelationId(owner: string, repo: string, headSha: string): string {
  return `${owner}/${repo}:${headSha}`.toLowerCase();
}

function reviewCorrelationId(
  owner: string,
  repo: string,
  number: number,
  headSha: string,
  reviewer: string,
): string {
  return `${owner}/${repo}:pr-${number}:${headSha}:${reviewer}`.toLowerCase();
}

// ---------------------------------------------------------------------------
// Settled-CI evaluation (shared with the owned-PR manager).
// ---------------------------------------------------------------------------

// CI conclusions that count as a hard, fixable failure (neutral/skipped/success
// and the in-progress states are not failures).
const FAILED_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "stale",
  "timed_out",
]);

export type CiCheck = { status: string; conclusion: string | null; name: string };
export type CiStatus = { state: string; context: string };

export type CiEvaluation = {
  settled: boolean;
  failed: boolean;
  failingNames: string[];
};

/**
 * Decide whether all CI for a SHA is finished, and whether it's red. "Settled"
 * means no check run is still queued/in-progress and no legacy commit status is
 * pending — the point a waiter wants to wake at before acting.
 */
export function evaluateCi(
  checks: CiCheck[],
  statuses: CiStatus[],
): CiEvaluation {
  const anyCheckPending = checks.some((c) => c.status !== "completed");
  const anyStatusPending = statuses.some((s) => s.state === "pending");
  const failingChecks = checks.filter(
    (c) =>
      c.status === "completed" &&
      c.conclusion !== null &&
      FAILED_CONCLUSIONS.has(c.conclusion),
  );
  const failingStatuses = statuses.filter(
    (s) => s.state === "failure" || s.state === "error",
  );
  const failingNames = [
    ...failingChecks.map((c) => c.name),
    ...failingStatuses.map((s) => s.context),
  ];
  return {
    settled: !anyCheckPending && !anyStatusPending,
    failed: failingNames.length > 0,
    failingNames,
  };
}

// The settled gate reads GitHub's own check rollup, not the per-check REST
// lists: one authoritative aggregate (the same rollup `gh pr checks` uses),
// including EXPECTED — a required check that hasn't reported yet, which no
// list merge can see. The REST check-runs list is also unreadable by
// fine-grained PATs (403), while the rollup state is not.
const CI_ROLLUP_QUERY = `query($owner: String!, $repo: String!, $sha: GitObjectID!) {
  repository(owner: $owner, name: $repo) {
    object(oid: $sha) {
      ... on Commit {
        statusCheckRollup {
          state
          contexts(first: 100) {
            nodes {
              __typename
              ... on CheckRun { name status conclusion }
              ... on StatusContext { context state }
            }
          }
        }
      }
    }
  }
}`;

type CiRollupContext = {
  __typename: string;
  name?: string;
  status?: string;
  conclusion?: string | null;
  context?: string;
  state?: string;
};

type CiRollup = {
  state: string;
  contexts?: { nodes?: (CiRollupContext | null)[] | null } | null;
};

type CiRollupResponse = {
  repository?: { object?: { statusCheckRollup?: CiRollup | null } | null } | null;
};

/**
 * Read the aggregate CI state for a sha. Returns null when the rollup can't
 * be read: an unreadable rollup is UNKNOWN, never "settled" — emitting or
 * acting on an empty evaluation would manufacture a green signal out of thin
 * air (a commit with genuinely no checks has no rollup either, and emits
 * nothing because no CI webhook ever fires for it).
 *
 * Per-context detail is best-effort: fine-grained PATs get FORBIDDEN on the
 * context nodes (they arrive null with a partial-data error we salvage the
 * state from), so `failingNames` is empty under a PAT and full under GitHub
 * App auth. Callers needing names should re-read with their own credentials.
 */
export async function fetchCiEvaluation(
  ctx: WorkflowEventProducerContext,
  owner: string,
  repo: string,
  sha: string,
): Promise<CiEvaluation | null> {
  const logger = ctx.options.logger ?? noopLogger;
  let rollup: CiRollup | null | undefined;
  try {
    const result = await ctx.octokit.graphql<CiRollupResponse>(CI_ROLLUP_QUERY, {
      owner,
      repo,
      sha,
    });
    rollup = result.repository?.object?.statusCheckRollup;
  } catch (error) {
    // octokit throws on ANY GraphQL errors, including the partial-data
    // FORBIDDEN on context nodes — salvage the rollup state when it came back.
    const partial = (error as { data?: CiRollupResponse }).data;
    rollup = partial?.repository?.object?.statusCheckRollup;
    if (!rollup) {
      logger.warn("githubbot_ci_rollup_failed", { error: errorMessage(error) });
      return null;
    }
  }
  if (!rollup) return null;
  if (rollup.state === "PENDING" || rollup.state === "EXPECTED") {
    return { settled: false, failed: false, failingNames: [] };
  }
  const checks: CiCheck[] = [];
  const statuses: CiStatus[] = [];
  for (const node of rollup.contexts?.nodes ?? []) {
    if (!node) continue;
    if (node.__typename === "CheckRun" && node.name && node.status) {
      checks.push({
        status: node.status.toLowerCase(),
        conclusion: node.conclusion?.toLowerCase() ?? null,
        name: node.name,
      });
    } else if (node.__typename === "StatusContext" && node.context && node.state) {
      statuses.push({ state: node.state.toLowerCase(), context: node.context });
    }
  }
  const detail = evaluateCi(checks, statuses);
  return {
    settled: true,
    failed:
      rollup.state === "FAILURE" || rollup.state === "ERROR" || detail.failed,
    failingNames: detail.failingNames,
  };
}

// ---------------------------------------------------------------------------
// Emission.
// ---------------------------------------------------------------------------

// How long to wait before re-reading a settled-green rollup: a push can read
// SUCCESS for a few seconds between the first no-op checks completing and the
// real suite registering (observed live: SUCCESS at T+1s, PENDING at T+7s),
// and an emission on that false green locks the immutable event row while the
// suite is still running. A red rollup needs no confirm — a completed failure
// is already complete.
const DEFAULT_CI_SETTLE_CONFIRM_MS = 15_000;

/**
 * Emit `ci-completed` for workflow waiters once every check for a head sha has
 * settled — per rule 1 above, a single check's completion must never fire it,
 * and a green rollup is confirmed with a delayed second read against the
 * registration race. The aggregate payload can't see *required* checks, so
 * waiters still verify with one live read on wake: the event is the wake-up,
 * not the verdict. Returns the settled evaluation for the owned-PR path to
 * reuse, or null when it wasn't computed.
 */
export async function maybeEmitCiCompleted(
  ctx: WorkflowEventProducerContext,
  eventType: string,
  repo: { owner: string; repo: string },
  payload: JsonRecord,
  headSha: string,
): Promise<CiEvaluation | null> {
  if (ctx.options.workflowEvents !== true) return null;
  if (!ciCompletionSignaled(eventType, payload)) return null;
  const evaluation = await fetchCiEvaluation(ctx, repo.owner, repo.repo, headSha);
  if (!evaluation?.settled) return null;
  if (!evaluation.failed) {
    await sleep(ctx.options.ciSettleConfirmMs ?? DEFAULT_CI_SETTLE_CONFIRM_MS);
    const confirmed = await fetchCiEvaluation(ctx, repo.owner, repo.repo, headSha);
    if (!confirmed?.settled || confirmed.failed) return null;
  }
  await emitWorkflowEvent(ctx.options, {
    eventType: WORKFLOW_EVENT_CI_COMPLETED,
    correlationId: ciCorrelationId(repo.owner, repo.repo, headSha),
    payload: { failed: evaluation.failed, failing: evaluation.failingNames },
  });
  return evaluation;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cheap pre-filter before spending two GitHub API reads on the settled
 * evaluation: only an event signaling something finished (a completed
 * run/suite, or a terminal legacy status) can flip the aggregate to settled.
 */
function ciCompletionSignaled(eventType: string, payload: JsonRecord): boolean {
  if (eventType === "status") {
    const state = stringValue(payload.state);
    return Boolean(state) && state !== "pending";
  }
  return stringValue(payload.action) === "completed";
}

/**
 * Emit `review-submitted` for every submitted review on any PR (owned or
 * not), keyed by head sha AND reviewer login: reviews from different authors
 * get independent rows, so a waiter keys on the author it cares about and a
 * review from anyone else can never consume its correlation. One row per
 * (PR, sha, author) — a second review by the same author on the same sha
 * collapses, which is the complete signal: "author reviewed this head".
 */
export async function maybeEmitReviewSubmitted(
  ctx: WorkflowEventProducerContext,
  repo: { owner: string; repo: string },
  number: number,
  headSha: string,
  reviewer: string | undefined,
  reviewState: string | undefined,
  reviewId: number,
): Promise<void> {
  if (ctx.options.workflowEvents !== true || !reviewer) return;
  await emitWorkflowEvent(ctx.options, {
    eventType: WORKFLOW_EVENT_REVIEW_SUBMITTED,
    correlationId: reviewCorrelationId(repo.owner, repo.repo, number, headSha, reviewer),
    payload: { review_id: reviewId, state: reviewState ?? null },
  });
}
