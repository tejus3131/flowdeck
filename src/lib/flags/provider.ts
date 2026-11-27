// The PostHog adapter — the only module that knows how Flowdeck talks to
// PostHog's flag API on the server. It calls the public POST /flags
// endpoint (project token only — no secret on the evaluation path; the
// endpoint returns evaluated values and nothing sensitive). Deliberately
// no SDK: the contract requires a request-scoped fetch, not a per-
// invocation cached client (PostHog's edge guidance — a Worker-local
// client loses its cache between invocations; see
// docs/feature-flags-and-ui-playground.md).
import type { RawFlagValue } from './evaluate';

/** A transient, per-evaluation identity — the flag contract's context. */
export type FlagEvaluationRequest = {
  host: string;
  /** The public project token (publishable by design). */
  token: string;
  /** Flowdeck's authenticated user UUID — the PostHog distinct ID.
   *  Never an email, name, or any other PII. */
  distinctId: string;
  /** The VERIFIED active workspace UUID, sent as a transient person-
   *  property override: evaluated against flag rules, not persisted on
   *  the person, not emitted as a $set event. Null sends no override. */
  workspaceId: string | null;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Abort budget; SSR must never hang on a flag. Default 2500ms. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 2500;

/** Evaluate against PostHog's public /flags endpoint. Throws on network
 *  failure, timeout, or a non-OK response — the caller decides the
 *  fallback posture (every registered flag declares one). */
export async function posthogEvaluateFlags(
  request: FlagEvaluationRequest,
): Promise<Record<string, RawFlagValue>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await (request.fetchImpl ?? fetch)(
      `${request.host.replace(/\/+$/, '')}/flags?v=2`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: request.token,
          distinct_id: request.distinctId,
          // The workspace override rides ONLY when a workspace is active
          // — an empty object means "evaluate as this person, no workspace
          // context", which is the declared state for user-scoped flags.
          person_properties: request.workspaceId
            ? { flowdeck_workspace_id: request.workspaceId }
            : {},
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error(`posthog /flags responded ${response.status}`);
    const body = (await response.json()) as { flags?: Record<string, RawFlagValue> };
    // Quota limiting can yield an empty flags object — a valid result
    // that resolves every flag to its declared fallback downstream.
    return body.flags ?? {};
  } finally {
    clearTimeout(timer);
  }
}
