import type { GitHubAdapter } from "@chat-adapter/github";
import { emitWorkflowEvent } from "./session-api";
import type { GithubbotOptions } from "./types";
import { errorMessage, noopLogger, stringValue } from "./utils";

/**
 * Converts GitHub lifecycle webhooks into api-rs workflow events. Events are
 * immutable per (event_type, correlation_id), so CI emits only after every
 * check settles and each correlation includes every waiter discriminator.
 *
 *   commit-scoped: <owner>/<repo>:<head_sha>
 *   PR-scoped:     <owner>/<repo>:pr-<n>:<head_sha>:<actor>
 *
 * Correlations are lowercased. GitHub App actors retain the `[bot]` suffix,
 * so waiter configs must use the exact login.
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
  "startup_failure",
  "timed_out",
]);

const SETTLED_CHECK_STATES = new Set([
  "ACTION_REQUIRED",
  "CANCELLED",
  "COMPLETED",
  "FAILURE",
  "NEUTRAL",
  "SKIPPED",
  "STALE",
  "STARTUP_FAILURE",
  "SUCCESS",
  "TIMED_OUT",
]);

const SETTLED_STATUS_STATES = new Set(["ERROR", "FAILURE", "SUCCESS"]);

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
  const anyStatusPending = statuses.some(
    (s) => s.state !== "success" && s.state !== "failure" && s.state !== "error",
  );
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
const CI_ROLLUP_QUERY = `query($owner: String!, $repo: String!, $sha: GitObjectID!, $after: String) {
  repository(owner: $owner, name: $repo) {
    object(oid: $sha) {
      ... on Commit {
        statusCheckRollup {
          state
          contexts(first: 100, after: $after) {
            nodes {
              __typename
              ... on CheckRun {
                name
                status
                conclusion
                startedAt
                checkSuite {
                  app { slug }
                  workflowRun {
                    event
                    workflow { name }
                  }
                }
              }
              ... on StatusContext { context state createdAt }
            }
            pageInfo { hasNextPage endCursor }
            checkRunCountsByState { state count }
            statusContextCountsByState { state count }
          }
        }
      }
    }
  }
}`;

type CiRollupContext = {
  __typename: string;
  checkSuite?: {
    app?: { slug?: string | null } | null;
    workflowRun?: {
      event?: string | null;
      workflow?: { name?: string | null } | null;
    } | null;
  } | null;
  createdAt?: string | null;
  name?: string;
  status?: string;
  conclusion?: string | null;
  context?: string;
  state?: string;
  startedAt?: string | null;
};

type CiRollupCheck = CiRollupContext & { name: string; status: string };
type CiRollupStatus = CiRollupContext & { context: string; state: string };

type CiStateCount = {
  count: number;
  state: string;
};

type CiPageInfo = {
  endCursor?: string | null;
  hasNextPage: boolean;
};

type CiRollup = {
  state: string;
  contexts?: {
    nodes?: (CiRollupContext | null)[] | null;
    pageInfo?: CiPageInfo | null;
    checkRunCountsByState?: CiStateCount[] | null;
    statusContextCountsByState?: CiStateCount[] | null;
  } | null;
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
  const nodes: CiRollupContext[] = [];
  let after: string | null = null;
  let rollupState: string | undefined;
  let checkRunCounts: CiStateCount[] | null | undefined;
  let statusContextCounts: CiStateCount[] | null | undefined;
  let detailReadable = true;

  for (;;) {
    let rollup: CiRollup | null | undefined;
    try {
      const result: CiRollupResponse = await ctx.octokit.graphql<CiRollupResponse>(
        CI_ROLLUP_QUERY,
        { after, owner, repo, sha },
      );
      rollup = result.repository?.object?.statusCheckRollup;
    } catch (error) {
      const partial = (error as { data?: CiRollupResponse }).data;
      rollup = partial?.repository?.object?.statusCheckRollup;
      if (!rollup) {
        logger.warn("githubbot_ci_rollup_failed", { error: errorMessage(error) });
        return null;
      }
    }
    if (!rollup) return null;

    rollupState = rollup.state;
    checkRunCounts ??= rollup.contexts?.checkRunCountsByState;
    statusContextCounts ??= rollup.contexts?.statusContextCountsByState;
    const pageNodes = rollup.contexts?.nodes;
    const readableNodes = pageNodes?.filter(
      (node): node is CiRollupContext => node !== null,
    );
    if (!pageNodes || readableNodes?.length !== pageNodes.length) {
      detailReadable = false;
    } else {
      nodes.push(...readableNodes);
    }

    const pageInfo: CiPageInfo | null | undefined = rollup.contexts?.pageInfo;
    if (!detailReadable || !pageInfo?.hasNextPage) break;
    if (!pageInfo.endCursor) {
      logger.warn("githubbot_ci_rollup_pagination_failed", { ref: `${owner}/${repo}@${sha}` });
      return null;
    }
    after = pageInfo.endCursor;
  }

  if (!rollupState) return null;
  const detail = detailReadable ? evaluateCiRollupContexts(nodes) : null;
  const aggregatePending = rollupState === "PENDING" || rollupState === "EXPECTED";
  const countsPending = stateCountsPending(checkRunCounts, statusContextCounts);
  const settled = detail
    ? detail.settled && !aggregatePending
    : countsPending === undefined
      ? rollupState === "SUCCESS"
      : !aggregatePending && !countsPending;
  return {
    settled,
    failed:
      rollupState === "FAILURE" || rollupState === "ERROR" || detail?.failed === true,
    failingNames: detail?.failingNames ?? [],
  };
}

function evaluateCiRollupContexts(nodes: CiRollupContext[]): CiEvaluation {
  const checks = latestCiChecks(nodes).map((node) => ({
    status: node.status.toLowerCase(),
    conclusion: node.conclusion?.toLowerCase() ?? null,
    name: node.name,
  }));
  const statuses = latestCiStatuses(nodes).map((node) => ({
    state: node.state.toLowerCase(),
    context: node.context,
  }));
  return evaluateCi(checks, statuses);
}

function latestCiChecks(nodes: CiRollupContext[]): CiRollupCheck[] {
  const latest = new Map<string, CiRollupCheck>();
  for (const node of nodes) {
    if (node.__typename !== "CheckRun" || !node.name || !node.status) continue;
    const check: CiRollupCheck = { ...node, name: node.name, status: node.status };
    const workflowRun = node.checkSuite?.workflowRun;
    const key = [
      node.checkSuite?.app?.slug ?? "",
      node.name,
      workflowRun?.workflow?.name ?? "",
      workflowRun?.event ?? "",
    ].join("\0");
    const current = latest.get(key);
    if (!current || (node.startedAt ?? "") >= (current.startedAt ?? "")) {
      latest.set(key, check);
    }
  }
  return [...latest.values()];
}

function latestCiStatuses(nodes: CiRollupContext[]): CiRollupStatus[] {
  const latest = new Map<string, CiRollupStatus>();
  for (const node of nodes) {
    if (node.__typename !== "StatusContext" || !node.context || !node.state) continue;
    const current = latest.get(node.context);
    if (!current || (node.createdAt ?? "") >= (current.createdAt ?? "")) {
      latest.set(node.context, {
        ...node,
        context: node.context,
        state: node.state,
      });
    }
  }
  return [...latest.values()];
}

function stateCountsPending(
  checkRunCounts: CiStateCount[] | null | undefined,
  statusContextCounts: CiStateCount[] | null | undefined,
): boolean | undefined {
  if (!checkRunCounts || !statusContextCounts) return undefined;
  return (
    checkRunCounts.some(({ count, state }) => count > 0 && !SETTLED_CHECK_STATES.has(state)) ||
    statusContextCounts.some(({ count, state }) => count > 0 && !SETTLED_STATUS_STATES.has(state))
  );
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
 * not the verdict. The initial evaluation is returned for the owned-PR path;
 * confirmation and delivery run in the returned promise so they do not delay
 * PR management.
 */
export async function prepareCiCompleted(
  ctx: WorkflowEventProducerContext,
  eventType: string,
  repo: { owner: string; repo: string },
  payload: JsonRecord,
  headSha: string,
): Promise<{
  emission: Promise<void> | null;
  evaluation: CiEvaluation | null;
}> {
  if (ctx.options.workflowEvents !== true || !ciCompletionSignaled(eventType, payload)) {
    return { emission: null, evaluation: null };
  }
  const evaluation = await fetchCiEvaluation(ctx, repo.owner, repo.repo, headSha);
  if (!evaluation?.settled) return { emission: null, evaluation };

  return {
    evaluation,
    emission: emitCiCompleted(ctx, repo, headSha, evaluation),
  };
}

async function emitCiCompleted(
  ctx: WorkflowEventProducerContext,
  repo: { owner: string; repo: string },
  headSha: string,
  evaluation: CiEvaluation,
): Promise<void> {
  if (!evaluation.failed) {
    await sleep(ctx.options.ciSettleConfirmMs ?? DEFAULT_CI_SETTLE_CONFIRM_MS);
    const confirmed = await fetchCiEvaluation(ctx, repo.owner, repo.repo, headSha);
    if (!confirmed?.settled || confirmed.failed) return;
  }
  await emitWorkflowEvent(ctx.options, {
    eventType: WORKFLOW_EVENT_CI_COMPLETED,
    correlationId: ciCorrelationId(repo.owner, repo.repo, headSha),
    payload: { failed: evaluation.failed, failing: evaluation.failingNames },
  });
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
