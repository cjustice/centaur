/**
 * Per-channel default model / reasoning effort.
 *
 * A deployment can pin a default model and/or codex reasoning effort for
 * specific Slack channels without every user typing `--model` / `-rsn`. The map
 * is loaded from the `SLACKBOTV2_CHANNEL_DEFAULTS` env var as JSON, keyed by
 * Slack conversation id (the `C…`/`G…`/`D…` segment of the thread key):
 *
 *   SLACKBOTV2_CHANNEL_DEFAULTS='{
 *     "C0ENG":    {"model": "claude-opus-4-8", "reasoning": "high"},
 *     "C0TRIAGE": {"reasoning": "low"}
 *   }'
 *
 * Precedence, applied in index.ts: an explicit/sticky per-thread override
 * (`--model` / `-rsn`) wins, then the channel default, then the deployment or
 * baked harness default. The channel default is forwarded onto the harness
 * input line (the harness does not otherwise know about it), so unlike the
 * global default it takes effect on the turn. Channel defaults do NOT change
 * the harness; set a `model` compatible with the deployment's default harness.
 * `reasoning` only affects the codex harness (claude/amp ignore it).
 */

export type ChannelDefault = {
  model?: string
  reasoning?: string
}

export type ChannelDefaults = Record<string, ChannelDefault>

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Parses the `SLACKBOTV2_CHANNEL_DEFAULTS` JSON map. Returns an empty map for an
 * unset/empty value, and tolerates malformed input: invalid JSON, a non-object
 * top level, or entries that resolve to no usable `model`/`reasoning` are
 * skipped rather than throwing, so a bad config never crashes the bot. Callers
 * may pass `onError` to surface the reason a non-empty value was ignored.
 */
export function parseChannelDefaults(
  raw: string | undefined,
  onError?: (message: string) => void
): ChannelDefaults {
  const trimmed = raw?.trim()
  if (!trimmed) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    onError?.(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    onError?.('expected a JSON object keyed by channel id')
    return {}
  }
  const result: ChannelDefaults = {}
  for (const [channelId, rawEntry] of Object.entries(parsed as Record<string, unknown>)) {
    const key = channelId.trim()
    if (!key) continue
    if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) continue
    const entry = rawEntry as Record<string, unknown>
    const model = cleanString(entry.model)
    const reasoning = cleanString(entry.reasoning)
    if (!model && !reasoning) continue
    result[key] = {
      ...(model ? { model } : {}),
      ...(reasoning ? { reasoning } : {})
    }
  }
  return result
}

/**
 * Extracts the Slack conversation id from a thread key of the shape
 * `slack:CHANNEL[:THREAD_TS]` (or `slack:TEAM:CHANNEL:…`), mirroring the
 * classification in session-api's `slackConversationId`: the first segment
 * after the namespace whose first character is `C`, `G`, or `D`.
 */
export function channelIdFromThreadId(threadId: string): string | undefined {
  const segments = threadId.split(':').slice(1)
  for (const segment of segments) {
    const first = segment.charAt(0)
    if (first === 'C' || first === 'G' || first === 'D') return segment
  }
  return undefined
}

/** Resolves the channel default for a thread, or undefined when none applies. */
export function resolveChannelDefault(
  defaults: ChannelDefaults | undefined,
  threadId: string
): ChannelDefault | undefined {
  if (!defaults) return undefined
  const channelId = channelIdFromThreadId(threadId)
  if (!channelId) return undefined
  return defaults[channelId]
}
