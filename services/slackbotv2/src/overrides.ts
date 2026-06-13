/**
 * Inline message directives, restored from the v1 slackbot:
 *   --claude | --claude-code | --amp | --codex   pick the harness for the thread
 *   --model <name> (or --model=<name>)           pick the model within that harness
 *   --opus | --sonnet | --haiku                  model shortcuts (imply claude-code)
 *   -rsn <effort> (or -rsn=<effort>)             per-turn reasoning effort (codex)
 *
 * Flags are stripped from the text before it reaches the agent. The harness
 * applies at session creation (the API pins a thread to one harness); the model
 * and reasoning effort apply per turn via the blocks-protocol `model` /
 * `reasoning` fields. Reasoning effort only affects the codex harness (it maps
 * to codex's `turn/start` `effort`); other harnesses ignore it.
 */

export type MessageOverrides = {
  cleanedText: string
  harnessType?: string
  model?: string
  reasoning?: string
}

// Flag name -> HarnessType wire value (serde lowercase of the Rust enum).
const HARNESS_FLAGS: Record<string, string> = {
  amp: 'amp',
  claude: 'claudecode',
  'claude-code': 'claudecode',
  claudecode: 'claudecode',
  codex: 'codex'
}

const MODEL_SHORTCUTS: Record<string, { harnessType: string; model: string }> = {
  haiku: { harnessType: 'claudecode', model: 'claude-haiku-4-5' },
  opus: { harnessType: 'claudecode', model: 'claude-opus-4-8' },
  sonnet: { harnessType: 'claudecode', model: 'claude-sonnet-4-6' }
}

const MODEL_FLAG_PATTERN = /(?:^|\s)--model[=\s]+([A-Za-z0-9._/-]+)(?=\s|$)/i

// Single dash by design: a short per-turn knob (`-rsn high`), so it can't reuse
// the `--`-prefixed flagPattern() helper. Value-capturing like --model.
const REASONING_FLAG_PATTERN = /(?:^|\s)-rsn[=\s]+([A-Za-z-]+)(?=\s|$)/i

// Codex reasoning efforts (turn/start `effort`), plus convenience aliases.
const REASONING_EFFORTS: Record<string, string> = {
  none: 'none',
  minimal: 'minimal',
  min: 'minimal',
  low: 'low',
  medium: 'medium',
  med: 'medium',
  high: 'high',
  hi: 'high',
  xhigh: 'xhigh',
  xhi: 'xhigh',
  'x-high': 'xhigh'
}

export function extractMessageOverrides(text: string): MessageOverrides {
  let cleaned = text
  let harnessType: string | undefined
  let model: string | undefined
  let reasoning: string | undefined

  const modelMatch = MODEL_FLAG_PATTERN.exec(cleaned)
  if (modelMatch) {
    model = modelMatch[1]
    cleaned = stripMatch(cleaned, modelMatch)
  }

  const reasoningMatch = REASONING_FLAG_PATTERN.exec(cleaned)
  if (reasoningMatch) {
    const normalized = REASONING_EFFORTS[reasoningMatch[1].toLowerCase()]
    if (normalized) {
      reasoning = normalized
      cleaned = stripMatch(cleaned, reasoningMatch)
    }
  }

  for (const [flag, harness] of Object.entries(HARNESS_FLAGS)) {
    const match = flagPattern(flag).exec(cleaned)
    if (!match) continue
    harnessType = harness
    cleaned = stripMatch(cleaned, match)
  }

  for (const [flag, shortcut] of Object.entries(MODEL_SHORTCUTS)) {
    const match = flagPattern(flag).exec(cleaned)
    if (!match) continue
    model ??= shortcut.model
    harnessType ??= shortcut.harnessType
    cleaned = stripMatch(cleaned, match)
  }

  return {
    cleanedText: cleaned === text ? text : cleaned.trim(),
    harnessType,
    model,
    reasoning
  }
}

function flagPattern(flag: string): RegExp {
  return new RegExp(`(?:^|\\s)--${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'i')
}

function stripMatch(text: string, match: RegExpExecArray): string {
  return `${text.slice(0, match.index)}${text.slice(match.index + match[0].length)}`
}
