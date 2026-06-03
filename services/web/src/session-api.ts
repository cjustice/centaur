import type { RustSessionStreamEvent } from '@centaur/harness-events'
import {
  CodexAppServerRendererEventMapper,
  WebRenderer,
  type WebRendererOutput
} from '@centaur/rendering'
import type {
  AppendMessagesRequest,
  CentaurWebOptions,
  CreateSessionRequest,
  ExecuteSessionRequest,
  ExecuteSessionResponse,
  JsonObject,
  JsonValue,
  LoadedWebMessage,
  LoadedWebThread,
  SetSessionTitleRequest,
  SetSessionTitleResponse,
  SessionEventRecord,
  SessionMessageRecord,
  SessionRecord,
  WebPersonaOption,
  WebTurnRequest,
  WebTurnStreamItem
} from './types'

type ParsedSessionEvent = {
  data: string
  event?: string
  id?: number
}

type NormalizedWebTurnRequest = WebTurnRequest & {
  afterEventId: number
  harness_type: string
  message: string
  persona_id: string | null
  threadId: string
}

const DEFAULT_HARNESS_TYPE = 'codex'
const SUPPORTED_HARNESS_TYPES = new Set(['codex', 'amp', 'claudecode'])
const DEFAULT_STREAM_RECONNECT_ATTEMPTS = 3
const DEFAULT_STREAM_RECONNECT_DELAY_MS = 250
const TITLE_GENERATION_ACTION = 'generate_title'
const TITLE_UPDATE_ACTION = 'set_title'
const TITLE_GENERATION_IDLE_TIMEOUT_MS = 15_000
const TITLE_GENERATION_MAX_DURATION_MS = 60_000
const TITLE_MAX_CHARS = 56
export const BASE_PERSONA_VALUE = '__base__'

export async function* streamWebTurn(
  options: CentaurWebOptions,
  input: WebTurnRequest
): AsyncIterable<WebTurnStreamItem> {
  const normalized = normalizeTurnRequest(input)
  yield output({ type: 'web.status.update', status: 'Starting session' })
  await createSession(options, normalized)
  await appendSessionMessage(options, normalized)
  await executeSession(options, normalized)

  yield output({ type: 'web.status.update', status: 'Streaming response' })
  const mapper = new CodexAppServerRendererEventMapper({
    logInfo: (event, fields) => options.logger?.info(event, fields)
  })
  const renderer = new WebRenderer()
  let afterEventId = normalized.afterEventId ?? 0
  let reconnectAttempts = 0
  let streamDone = false

  while (!mapper.isDone() && !streamDone) {
    try {
      const events = await streamSessionEvents(options, normalized.threadId, afterEventId)
      for await (const source of events) {
        const eventId = typeof source.eventId === 'number' ? source.eventId : undefined
        if (eventId !== undefined) afterEventId = Math.max(afterEventId, eventId)
        for (const event of mapper.process(source)) {
          for (const rendered of renderer.render(normalized.threadId, event)) {
            yield output(rendered, eventId)
          }
        }
        if (mapper.isDone()) {
          streamDone = true
          break
        }
      }
      break
    } catch (error) {
      if (reconnectAttempts >= streamReconnectAttempts(options)) {
        throw error
      }
      reconnectAttempts += 1
      options.logger?.warn('centaur_web_stream_reconnect', {
        after_event_id: afterEventId,
        attempt: reconnectAttempts,
        error: errorMessage(error),
        thread_id: normalized.threadId
      })
      yield output({ type: 'web.status.update', status: 'Reconnecting' })
      await sleep(streamReconnectDelayMs(options))
    }
  }

  for (const event of mapper.flush()) {
    for (const rendered of renderer.render(normalized.threadId, event)) {
      yield output(rendered)
    }
  }

  const title = await maybeGenerateThreadTitle(options, normalized, afterEventId)
  if (title) {
    yield output({ type: 'web.title.update', title: title.title }, title.eventId)
  }
}

export async function loadWebThread(
  options: CentaurWebOptions,
  threadId: string
): Promise<LoadedWebThread | undefined> {
  const sessionResponse = await apiFetch(options, sessionPath(threadId), {
    method: 'GET',
    jsonBody: false
  })
  if (sessionResponse.status === 404) return undefined
  await ensureApiOk(sessionResponse, 'load session')
  const session = (await sessionResponse.json()) as SessionRecord

  const messagesResponse = await apiFetch(options, sessionPath(threadId, 'messages'), {
    method: 'GET',
    jsonBody: false
  })
  await ensureApiOk(messagesResponse, 'load messages')
  const messagesBody = (await messagesResponse.json()) as { messages?: SessionMessageRecord[] }

  const eventsResponse = await apiFetch(
    options,
    `${sessionPath(threadId, 'event-log')}?after_event_id=0&limit=2000`,
    { method: 'GET', jsonBody: false }
  )
  await ensureApiOk(eventsResponse, 'load events')
  const eventsBody = (await eventsResponse.json()) as { events?: SessionEventRecord[] }

  return hydrateLoadedThread(
    session,
    messagesBody.messages ?? [],
    eventsBody.events ?? []
  )
}

export async function loadWebPersonas(options: CentaurWebOptions): Promise<WebPersonaOption[]> {
  const base = [{ label: 'Base', value: BASE_PERSONA_VALUE }]
  const fromSessionApi = await fetchPersonaOptions(options, 'session-api')
  if (fromSessionApi.length > 0) return [...base, ...fromSessionApi]
  const fromControlApi = await fetchPersonaOptions(options, 'control-api')
  return fromControlApi.length > 0 ? [...base, ...fromControlApi] : base
}

export async function generateMissingWebThreadTitle(
  options: CentaurWebOptions,
  threadId: string
): Promise<{ generated: boolean; title: string; eventId?: number } | undefined> {
  const snapshot = await loadWebThread(options, threadId)
  if (!snapshot) return undefined
  if (!isUntitledTitle(snapshot.title)) {
    return { generated: false, title: snapshot.title, eventId: snapshot.lastEventId }
  }
  const input = normalizeTurnRequest({
    afterEventId: snapshot.lastEventId,
    harnessType: snapshot.harnessType,
    message: 'Generate a thread title.',
    personaId: snapshot.personaId,
    threadId: snapshot.threadId
  })
  const generated = await generateThreadTitleFromSnapshot(
    options,
    input,
    snapshot,
    snapshot.lastEventId
  )
  return generated ? { ...generated, generated: true } : undefined
}

async function maybeGenerateThreadTitle(
  options: CentaurWebOptions,
  input: NormalizedWebTurnRequest,
  afterEventId: number
): Promise<{ title: string; eventId?: number } | undefined> {
  try {
    const snapshot = await loadWebThread(options, input.threadId)
    if (!snapshot || !isUntitledTitle(snapshot.title)) return undefined
    return await generateThreadTitleFromSnapshot(options, input, snapshot, afterEventId)
  } catch (error) {
    options.logger?.warn('centaur_web_title_generation_failed', {
      error: errorMessage(error),
      thread_id: input.threadId
    })
    return undefined
  }
}

async function generateThreadTitleFromSnapshot(
  options: CentaurWebOptions,
  input: NormalizedWebTurnRequest,
  snapshot: LoadedWebThread,
  afterEventId: number
): Promise<{ title: string; eventId?: number } | undefined> {
  if (!snapshot.messages.some(isUserMessage)) return undefined
  const rawTitle = await generateThreadTitleWithHarness(
    options,
    input,
    threadTitlePrompt(snapshot.messages),
    afterEventId
  )
  const title = sanitizeGeneratedTitle(rawTitle)
  if (!title) return undefined

  const event = await persistThreadTitle(options, input, title)
  return { title, eventId: event?.event_id }
}

async function generateThreadTitleWithHarness(
  options: CentaurWebOptions,
  input: NormalizedWebTurnRequest,
  prompt: string,
  afterEventId: number
): Promise<string> {
  const messageId = newMessageId()
  const titleInput = { ...input, message: prompt }
  await executeSessionInputLines(
    options,
    titleInput,
    [toCodexInputLine(titleInput, messageId, TITLE_GENERATION_ACTION)],
    messageId,
    TITLE_GENERATION_ACTION,
    {
      idleTimeoutMs: TITLE_GENERATION_IDLE_TIMEOUT_MS,
      maxDurationMs: TITLE_GENERATION_MAX_DURATION_MS
    }
  )

  const mapper = new CodexAppServerRendererEventMapper({
    logInfo: (event, fields) => options.logger?.info(event, fields)
  })
  const renderer = new WebRenderer()
  let titleText = ''
  let lastEventId = afterEventId
  let reconnectAttempts = 0

  while (!mapper.isDone()) {
    try {
      const events = await streamSessionEvents(options, input.threadId, lastEventId)
      for await (const source of events) {
        const eventId = typeof source.eventId === 'number' ? source.eventId : undefined
        if (eventId !== undefined) lastEventId = Math.max(lastEventId, eventId)
        for (const event of mapper.process(source)) {
          for (const rendered of renderer.render(input.threadId, event)) {
            titleText = collectTitleText(titleText, rendered)
          }
        }
        if (mapper.isDone()) return titleText
      }
      break
    } catch (error) {
      if (reconnectAttempts >= streamReconnectAttempts(options)) throw error
      reconnectAttempts += 1
      await sleep(streamReconnectDelayMs(options))
    }
  }

  for (const event of mapper.flush()) {
    for (const rendered of renderer.render(input.threadId, event)) {
      titleText = collectTitleText(titleText, rendered)
    }
  }
  return titleText
}

async function persistThreadTitle(
  options: CentaurWebOptions,
  input: NormalizedWebTurnRequest,
  title: string
): Promise<SessionEventRecord | undefined> {
  const body: SetSessionTitleRequest = {
    title,
    metadata: sessionMetadata(input, newMessageId(), { action: TITLE_UPDATE_ACTION })
  }
  const response = await apiFetch(options, sessionPath(input.threadId, 'title'), {
    method: 'POST',
    body: JSON.stringify(body)
  })
  await ensureApiOk(response, 'set title')
  const parsed = (await response.json()) as SetSessionTitleResponse
  return parsed.event
}

function collectTitleText(current: string, output: WebRendererOutput): string {
  if (output.type === 'web.message.delta') {
    return output.force ? output.delta : current + output.delta
  }
  if (output.type === 'web.message.snapshot') return output.markdown
  if (output.type === 'web.session.closed' && output.answerMarkdown && !current.trim()) {
    return output.answerMarkdown
  }
  return current
}

function threadTitlePrompt(messages: LoadedWebMessage[]): string {
  const transcript = messages
    .slice(-8)
    .map(message => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text.trim()}`)
    .filter(line => line.length > 'User: '.length)
    .join('\n\n')

  return [
    'Generate a concise title for this conversation.',
    'Return only the title text.',
    'Use 2 to 6 words.',
    'Do not use quotes, Markdown, trailing punctuation, or the phrase New chat.',
    '',
    'Conversation:',
    transcript
  ].join('\n')
}

function sanitizeGeneratedTitle(value: string): string {
  const firstLine = value.trim().split('\n')[0] ?? ''
  const title = firstLine
    .replace(/^title\s*[:=-]\s*/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!title || isUntitledTitle(title)) return ''
  return title.length > TITLE_MAX_CHARS ? `${title.slice(0, TITLE_MAX_CHARS - 3).trim()}...` : title
}

function isUserMessage(message: LoadedWebMessage): boolean {
  return message.role === 'user' && Boolean(message.text.trim())
}

function streamReconnectAttempts(options: CentaurWebOptions): number {
  const value = options.streamReconnectAttempts ?? DEFAULT_STREAM_RECONNECT_ATTEMPTS
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : DEFAULT_STREAM_RECONNECT_ATTEMPTS
}

function streamReconnectDelayMs(options: CentaurWebOptions): number {
  const value = options.streamReconnectDelayMs ?? DEFAULT_STREAM_RECONNECT_DELAY_MS
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : DEFAULT_STREAM_RECONNECT_DELAY_MS
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function toCodexInputLine(
  input: WebTurnRequest,
  messageId = newMessageId(),
  action = 'execute'
): string {
  const normalized = normalizeTurnRequest(input)
  const metadata = sessionMetadata(normalized, messageId, { action })
  return JSON.stringify({
    type: 'user',
    thread_key: normalized.threadId,
    trace_metadata: metadata,
    message: {
      role: 'user',
      content: codexInputContent(normalized.message)
    }
  })
}

export async function* parseSessionEventStream(
  stream: ReadableStream<Uint8Array>
): AsyncIterable<RustSessionStreamEvent> {
  for await (const event of parseSseEvents(stream)) {
    if (event.event === 'session.output.line') {
      yield {
        data: event.data,
        event: event.event,
        eventId: event.id,
        eventKind: event.event
      } satisfies RustSessionStreamEvent
      if (isTerminalCodexOutputLine(event.data)) return
      continue
    }
    if (event.event === 'session.execution_failed' || event.event === 'session.stream_error') {
      yield {
        data: { error: sessionErrorMessage(event) },
        event: event.event,
        eventId: event.id,
        eventKind: event.event
      } satisfies RustSessionStreamEvent
      return
    }
  }
}

function output(output: WebRendererOutput, eventId?: number): WebTurnStreamItem {
  return eventId === undefined ? { output } : { eventId, output }
}

function hydrateLoadedThread(
  session: SessionRecord,
  persistedMessages: SessionMessageRecord[],
  persistedEvents: SessionEventRecord[]
): LoadedWebThread {
  const messages: LoadedWebMessage[] = []
  let title = 'New chat'
  let currentAssistantId: string | undefined
  let status = session.status ? titleCaseStatus(session.status) : 'Idle'
  let lastEventId = 0
  let mapper = new CodexAppServerRendererEventMapper()
  let renderer = new WebRenderer()
  const hiddenExecutionIds = new Set<string>()

  const timeline = [
    ...persistedMessages.map(message => ({
      createdAt: timestampSortKey(message.created_at),
      kind: 'message' as const,
      message
    })),
    ...persistedEvents.map(event => ({
      createdAt: timestampSortKey(event.created_at),
      event,
      kind: 'event' as const
    }))
  ].sort((left, right) => {
    const byTime = left.createdAt.localeCompare(right.createdAt)
    if (byTime !== 0) return byTime
    if (left.kind === right.kind) return 0
    return left.kind === 'message' ? -1 : 1
  })

  for (const item of timeline) {
    if (item.kind === 'message') {
      if (item.message.role !== 'user') continue
      const text = textFromParts(item.message.parts)
      if (!text) continue
      messages.push({
        id: item.message.client_message_id ?? item.message.message_id,
        role: 'user',
        text
      })
      currentAssistantId = undefined
      continue
    }

    lastEventId = Math.max(lastEventId, item.event.event_id)
    const executionId = eventExecutionId(item.event)
    if (item.event.event_type === 'session.execution_started') {
      if (eventAction(item.event) === TITLE_GENERATION_ACTION && executionId) {
        hiddenExecutionIds.add(executionId)
      }
      continue
    }
    if (executionId && hiddenExecutionIds.has(executionId)) continue

    const source = {
      data:
        item.event.event_type === 'session.output.line'
          ? typeof item.event.payload === 'string'
            ? item.event.payload
            : JSON.stringify(item.event.payload)
          : item.event.payload,
      event: item.event.event_type,
      eventId: item.event.event_id,
      eventKind: item.event.event_type
    }
    for (const event of mapper.process(source)) {
      for (const rendered of renderer.render(session.thread_key, event)) {
        currentAssistantId = applyHydratedOutput(
          messages,
          currentAssistantId,
          rendered,
          nextTitle => {
            if (isUntitledTitle(title)) title = nextTitle
          }
        )
        if (rendered.type === 'web.session.closed') {
          status = rendered.error ? 'Error' : 'Complete'
          currentAssistantId = undefined
          mapper = new CodexAppServerRendererEventMapper()
          renderer = new WebRenderer()
        }
      }
    }
  }

  return {
    harnessType: normalizeHarnessType(session.harness_type),
    lastEventId,
    messages,
    personaId: normalizePersonaId(session.persona_id),
    status,
    threadId: session.thread_key,
    title
  }
}

function applyHydratedOutput(
  messages: LoadedWebMessage[],
  currentAssistantId: string | undefined,
  output: WebRendererOutput,
  setTitle: (title: string) => void
): string | undefined {
  if (output.type === 'web.title.update') {
    setTitle(output.title)
    return currentAssistantId
  }
  if (output.type === 'web.status.update' || output.type === 'web.plan.update') {
    return currentAssistantId
  }
  if (output.type === 'web.message.delta' || output.type === 'web.message.snapshot') {
    const assistant = ensureHydratedAssistant(messages, currentAssistantId)
    if (output.type === 'web.message.delta') {
      assistant.text = output.force ? output.delta : assistant.text + output.delta
    } else {
      assistant.text = output.markdown
    }
    return assistant.id
  }
  if (output.type === 'web.task.upsert') {
    const assistant = ensureHydratedAssistant(messages, currentAssistantId)
    assistant.tasks = upsertHydratedTask(assistant.tasks ?? [], output.task)
    return assistant.id
  }
  if (output.answerMarkdown) {
    const assistant = ensureHydratedAssistant(messages, currentAssistantId)
    if (!assistant.text.trim()) assistant.text = output.answerMarkdown
    return assistant.id
  }
  return currentAssistantId
}

function ensureHydratedAssistant(
  messages: LoadedWebMessage[],
  currentAssistantId: string | undefined
): LoadedWebMessage {
  const existing = currentAssistantId
    ? messages.find(message => message.id === currentAssistantId)
    : undefined
  if (existing) return existing
  const next: LoadedWebMessage = {
    id: newMessageId(),
    role: 'assistant',
    tasks: [],
    text: ''
  }
  messages.push(next)
  return next
}

function upsertHydratedTask(
  items: NonNullable<LoadedWebMessage['tasks']>,
  task: NonNullable<LoadedWebMessage['tasks']>[number]
): NonNullable<LoadedWebMessage['tasks']> {
  const index = items.findIndex(item => item.id === task.id)
  if (index === -1) return [...items, task]
  return items.map((item, itemIndex) =>
    itemIndex === index
      ? {
          ...item,
          ...task,
          details: task.details ?? item.details,
          output: task.output ?? item.output
        }
      : item
  )
}

function textFromParts(parts: JsonValue[]): string {
  return parts
    .map(part => {
      if (typeof part === 'string') return part
      if (!part || typeof part !== 'object' || Array.isArray(part)) return ''
      const maybeText = part.text
      return typeof maybeText === 'string' ? maybeText : ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

function eventAction(event: SessionEventRecord): string {
  const metadata = payloadObject(event.payload)?.metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return ''
  const action = metadata.action
  return typeof action === 'string' ? action : ''
}

function eventExecutionId(event: SessionEventRecord): string {
  if (typeof event.execution_id === 'string' && event.execution_id) return event.execution_id
  const executionId = payloadObject(event.payload)?.execution_id
  return typeof executionId === 'string' ? executionId : ''
}

function payloadObject(payload: JsonValue): JsonObject | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  return payload
}

function timestampSortKey(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map(part => (typeof part === 'number' ? String(part).padStart(12, '0') : String(part)))
      .join(':')
  }
  if (typeof value === 'number') return String(value).padStart(16, '0')
  if (typeof value === 'string') return value
  return ''
}

function isUntitledTitle(title: string): boolean {
  return title.trim() === '' || title === 'New chat'
}

function titleCaseStatus(status: string): string {
  const normalized = status.trim().toLowerCase()
  if (!normalized) return 'Idle'
  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

function normalizeTurnRequest(input: WebTurnRequest): NormalizedWebTurnRequest {
  const threadId = requestThreadId(input).trim()
  const message = typeof input.message === 'string' ? input.message.trim() : ''
  if (!threadId) throw new Error('threadId is required')
  if (!threadId.includes(':')) throw new Error("threadId must be namespaced as '<source>:<id>'")
  if (!message) throw new Error('message is required')
  return {
    ...input,
    threadId,
    message,
    afterEventId: normalizeAfterEventId(input.afterEventId),
    harness_type: normalizeHarnessType(input.harness_type ?? input.harnessType),
    persona_id: normalizePersonaId(input.persona_id ?? input.personaId)
  }
}

function requestThreadId(input: WebTurnRequest): string {
  return input.threadId ?? input.threadKey ?? input.thread_key ?? ''
}

function normalizeAfterEventId(value: number | undefined): number {
  if (value === undefined) return 0
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.floor(value)
}

function normalizeHarnessType(value: string | undefined): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return SUPPORTED_HARNESS_TYPES.has(normalized) ? normalized : DEFAULT_HARNESS_TYPE
}

function normalizePersonaId(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!normalized || normalized === BASE_PERSONA_VALUE || normalized === 'base') return null
  return normalized
}

async function createSession(
  options: CentaurWebOptions,
  input: NormalizedWebTurnRequest
): Promise<void> {
  const body: CreateSessionRequest = {
    harness_type: input.harness_type,
    metadata: {
      source: 'centaur-web',
      platform: 'web',
      harness_type: input.harness_type,
      persona_id: input.persona_id,
      thread_id: input.threadId
    },
    persona_id: input.persona_id
  }
  await ensureApiOk(
    await apiFetch(options, sessionPath(input.threadId), {
      method: 'POST',
      body: JSON.stringify(body)
    }),
    'create session'
  )
}

async function appendSessionMessage(
  options: CentaurWebOptions,
  input: NormalizedWebTurnRequest
): Promise<void> {
  const messageId = newMessageId()
  const body: AppendMessagesRequest = {
    messages: [
      {
        role: 'user',
        parts: [{ type: 'text', text: input.message }],
        metadata: sessionMetadata(input, messageId)
      }
    ]
  }
  await ensureApiOk(
    await apiFetch(options, sessionPath(input.threadId, 'messages'), {
      method: 'POST',
      body: JSON.stringify(body)
    }),
    'append message'
  )
}

async function executeSession(
  options: CentaurWebOptions,
  input: NormalizedWebTurnRequest
): Promise<ExecuteSessionResponse> {
  const messageId = newMessageId()
  return executeSessionInputLines(
    options,
    input,
    [toCodexInputLine(input, messageId)],
    messageId,
    'execute'
  )
}

async function executeSessionInputLines(
  options: CentaurWebOptions,
  input: NormalizedWebTurnRequest,
  inputLines: string[],
  messageId: string,
  action: string,
  durationOverrides?: { idleTimeoutMs?: number; maxDurationMs?: number }
): Promise<ExecuteSessionResponse> {
  const body: ExecuteSessionRequest = {
    metadata: sessionMetadata(input, messageId, { action }),
    input_lines: inputLines,
    ...(durationOverrides?.idleTimeoutMs === undefined && options.idleTimeoutMs === undefined
      ? {}
      : { idle_timeout_ms: durationOverrides?.idleTimeoutMs ?? options.idleTimeoutMs }),
    ...(durationOverrides?.maxDurationMs === undefined && options.maxDurationMs === undefined
      ? {}
      : { max_duration_ms: durationOverrides?.maxDurationMs ?? options.maxDurationMs })
  }
  const response = await apiFetch(options, sessionPath(input.threadId, 'execute'), {
      method: 'POST',
      body: JSON.stringify(body)
    })
  await ensureApiOk(response, 'execute session')
  return (await response.json()) as ExecuteSessionResponse
}

async function streamSessionEvents(
  options: CentaurWebOptions,
  threadId: string,
  afterEventId: number
): Promise<AsyncIterable<RustSessionStreamEvent>> {
  const response = await apiFetch(
    options,
    `${sessionPath(threadId, 'events')}?after_event_id=${afterEventId}`,
    {
      method: 'GET',
      jsonBody: false
    }
  )
  await ensureApiOk(response, 'stream events')
  if (!response.body) return toAsyncIterable([])
  return parseSessionEventStream(response.body)
}

async function ensureApiOk(response: Response, action: string): Promise<void> {
  if (response.ok) return
  let body = ''
  try {
    body = await response.text()
  } catch {
    body = ''
  }
  const suffix = body ? `: ${body}` : ''
  throw new Error(`Centaur session ${action} failed: ${response.status} ${response.statusText}${suffix}`)
}

async function apiFetch(
  options: CentaurWebOptions,
  path: string,
  init: RequestInit & { jsonBody?: boolean }
): Promise<Response> {
  const fetchFn = options.fetch ?? fetch
  const jsonBody = init.jsonBody !== false
  const headers = apiHeaders(options, jsonBody)
  const { jsonBody: _jsonBody, ...requestInit } = init
  void _jsonBody
  return fetchFn(new URL(path, ensureTrailingSlash(options.apiUrl)), {
    ...requestInit,
    headers: {
      ...headers,
      ...headersToObject(requestInit.headers)
    }
  })
}

async function controlApiFetch(
  options: CentaurWebOptions,
  path: string,
  init: RequestInit & { jsonBody?: boolean }
): Promise<Response> {
  const controlApiUrl = options.controlApiUrl
  if (!controlApiUrl) throw new Error('controlApiUrl is not configured')
  const fetchFn = options.fetch ?? fetch
  const jsonBody = init.jsonBody !== false
  const headers = apiHeaders(options, jsonBody)
  const { jsonBody: _jsonBody, ...requestInit } = init
  void _jsonBody
  return fetchFn(new URL(path, ensureTrailingSlash(controlApiUrl)), {
    ...requestInit,
    headers: {
      ...headers,
      ...headersToObject(requestInit.headers)
    }
  })
}

async function fetchPersonaOptions(
  options: CentaurWebOptions,
  source: 'control-api' | 'session-api'
): Promise<WebPersonaOption[]> {
  try {
    const response =
      source === 'session-api'
        ? await apiFetch(options, '/api/personas', { method: 'GET', jsonBody: false })
        : await controlApiFetch(options, '/tools/personas', { method: 'GET', jsonBody: false })
    if (!response.ok) return []
    return personaOptionsFromResponse(await response.json())
  } catch (error) {
    if (source === 'control-api' || errorMessage(error) !== 'controlApiUrl is not configured') {
      options.logger?.warn('centaur_web_personas_load_failed', {
        error: errorMessage(error),
        source
      })
    }
    return []
  }
}

function apiHeaders(options: CentaurWebOptions, jsonBody = true): Record<string, string> {
  const apiKey = options.apiKey
  return {
    ...(jsonBody ? { 'content-type': 'application/json' } : {}),
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
  }
}

function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return headers
}

function sessionPath(
  threadId: string,
  suffix?: 'messages' | 'execute' | 'events' | 'event-log' | 'title'
): string {
  return `/api/session/${encodeURIComponent(threadId)}${suffix ? `/${suffix}` : ''}`
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

function sessionMetadata(
  input: NormalizedWebTurnRequest,
  messageId: string,
  extra: JsonObject = {}
): JsonObject {
  return {
    source: 'centaur-web',
    platform: 'web',
    message_id: messageId,
    harness_type: input.harness_type,
    persona_id: input.persona_id,
    thread_id: input.threadId,
    timestamp: new Date().toISOString(),
    ...extra
  }
}

function personaOptionsFromResponse(body: unknown): WebPersonaOption[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return []
  return Object.entries(body)
    .map(([name, value]) => personaOptionFromEntry(name, value))
    .filter((option): option is WebPersonaOption => Boolean(option))
    .sort((left, right) => left.label.localeCompare(right.label))
}

function personaOptionFromEntry(name: string, value: unknown): WebPersonaOption | undefined {
  const personaId = normalizePersonaId(name)
  if (!personaId) return undefined
  const details =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  const description = details && typeof details.description === 'string' ? details.description : undefined
  const engine = details && typeof details.engine === 'string' ? details.engine : undefined
  return {
    description,
    engine,
    label: formatOptionLabel(personaId),
    value: personaId
  }
}

function formatOptionLabel(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function codexInputContent(message: string): JsonValue[] {
  return [{ type: 'text', text: message.trim() || 'continue' }]
}

function newMessageId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `web-msg-${crypto.randomUUID()}`
  }
  return `web-msg-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

async function* toAsyncIterable<T>(values: Iterable<T>): AsyncIterable<T> {
  for (const value of values) yield value
}

async function* parseSseEvents(stream: ReadableStream<Uint8Array>): AsyncIterable<ParsedSessionEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName: string | undefined
  let eventId: number | undefined
  let data: string[] = []

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const emitted = parseSseLine(line, { data, eventId, eventName })
      data = emitted.state.data
      eventId = emitted.state.eventId
      eventName = emitted.state.eventName
      if (emitted.event) yield emitted.event
    }
  }

  buffer += decoder.decode()
  if (buffer) {
    const emitted = parseSseLine(buffer, { data, eventId, eventName })
    data = emitted.state.data
    eventId = emitted.state.eventId
    eventName = emitted.state.eventName
    if (emitted.event) yield emitted.event
  }
  if (data.length > 0) {
    yield { data: data.join('\n'), event: eventName, id: eventId }
  }
}

function parseSseLine(
  line: string,
  state: {
    data: string[]
    eventId?: number
    eventName?: string
  }
): {
  event?: ParsedSessionEvent
  state: { data: string[]; eventId?: number; eventName?: string }
} {
  if (!line.trim()) {
    const event =
      state.data.length > 0
        ? { data: state.data.join('\n'), event: state.eventName, id: state.eventId }
        : undefined
    return { event, state: { data: [] } }
  }
  if (line.startsWith(':')) return { state }

  const separator = line.indexOf(':')
  const field = separator >= 0 ? line.slice(0, separator) : line
  const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : ''
  if (field === 'event') return { state: { ...state, eventName: value } }
  if (field === 'id') {
    const id = Number.parseInt(value, 10)
    return { state: { ...state, eventId: Number.isFinite(id) ? id : undefined } }
  }
  if (field === 'data' && value !== '[DONE]') {
    return { state: { ...state, data: [...state.data, value] } }
  }

  return { state }
}

function isTerminalCodexOutputLine(line: string): boolean {
  let payload: unknown
  try {
    payload = JSON.parse(line)
  } catch {
    return true
  }
  if (!isRecord(payload)) return false

  return (
    payload.type === 'turn.completed' ||
    payload.type === 'turn.failed' ||
    payload.type === 'turn.done' ||
    payload.method === 'error' ||
    payload.method === 'turn/completed'
  )
}

function sessionErrorMessage(event: ParsedSessionEvent): string {
  let message = `${event.event ?? 'session error'}`
  try {
    const payload = JSON.parse(event.data)
    if (isRecord(payload)) {
      message = stringValue(payload.error) ?? stringValue(payload.message) ?? message
    }
  } catch {
    if (event.data.trim()) message = event.data.trim()
  }
  return message
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
