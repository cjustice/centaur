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
  JsonObject,
  JsonValue,
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
  message: string
  threadId: string
}

export async function* streamWebTurn(
  options: CentaurWebOptions,
  input: WebTurnRequest
): AsyncIterable<WebTurnStreamItem> {
  const normalized = normalizeTurnRequest(input)
  yield output({ type: 'web.status.update', status: 'Starting session' })
  await createSession(options, normalized.threadId)
  await appendSessionMessage(options, normalized)
  await executeSession(options, normalized)

  yield output({ type: 'web.status.update', status: 'Streaming response' })
  const mapper = new CodexAppServerRendererEventMapper({
    logInfo: (event, fields) => options.logger?.info(event, fields)
  })
  const renderer = new WebRenderer()
  const events = await streamSessionEvents(options, normalized.threadId, normalized.afterEventId ?? 0)

  for await (const source of events) {
    const eventId = typeof source.eventId === 'number' ? source.eventId : undefined
    for (const event of mapper.process(source)) {
      for (const rendered of renderer.render(normalized.threadId, event)) {
        yield output(rendered, eventId)
      }
    }
    if (mapper.isDone()) return
  }

  for (const event of mapper.flush()) {
    for (const rendered of renderer.render(normalized.threadId, event)) {
      yield output(rendered)
    }
  }
}

export function toCodexInputLine(input: WebTurnRequest, messageId = newMessageId()): string {
  const normalized = normalizeTurnRequest(input)
  const metadata = sessionMetadata(normalized, messageId, { action: 'execute' })
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
    afterEventId: normalizeAfterEventId(input.afterEventId)
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

async function createSession(options: CentaurWebOptions, threadId: string): Promise<void> {
  const body: CreateSessionRequest = {
    harness_type: 'codex',
    metadata: {
      source: 'centaur-web',
      platform: 'web',
      thread_id: threadId
    }
  }
  await ensureApiOk(
    await apiFetch(options, sessionPath(threadId), {
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
): Promise<void> {
  const messageId = newMessageId()
  const body: ExecuteSessionRequest = {
    metadata: sessionMetadata(input, messageId, { action: 'execute' }),
    input_lines: [toCodexInputLine(input, messageId)],
    ...(options.idleTimeoutMs === undefined ? {} : { idle_timeout_ms: options.idleTimeoutMs }),
    ...(options.maxDurationMs === undefined ? {} : { max_duration_ms: options.maxDurationMs })
  }
  await ensureApiOk(
    await apiFetch(options, sessionPath(input.threadId, 'execute'), {
      method: 'POST',
      body: JSON.stringify(body)
    }),
    'execute session'
  )
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

function sessionPath(threadId: string, suffix?: 'messages' | 'execute' | 'events'): string {
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
    thread_id: input.threadId,
    timestamp: new Date().toISOString(),
    ...extra
  }
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
