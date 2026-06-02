import type { WebRendererOutput } from '@centaur/rendering'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export type JsonObject = { [key: string]: JsonValue | undefined }

export type CentaurWebFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type CentaurWebOptions = {
  apiKey?: string
  apiUrl: string
  fetch?: CentaurWebFetch
  idleTimeoutMs?: number
  logger?: CentaurWebLogger
  maxDurationMs?: number
  streamReconnectAttempts?: number
  streamReconnectDelayMs?: number
}

export type CentaurWebLogger = {
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

export type WebTurnRequest = {
  afterEventId?: number
  message: string
  threadId?: string
  threadKey?: string
  thread_key?: string
}

export type WebTurnStreamItem = {
  eventId?: number
  output: WebRendererOutput
}

export type SessionMessageRole = 'user' | 'assistant' | 'system' | 'tool'

export type SessionMessage = {
  metadata: JsonObject
  parts: JsonValue[]
  role: SessionMessageRole
}

export type AppendMessagesRequest = {
  messages: SessionMessage[]
}

export type CreateSessionRequest = {
  harness_type: string
  metadata: JsonObject
}

export type ExecuteSessionRequest = {
  idle_timeout_ms?: number
  input_lines: string[]
  max_duration_ms?: number
  metadata: JsonObject
}
