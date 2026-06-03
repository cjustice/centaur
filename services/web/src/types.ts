import type { WebRendererOutput, WebRendererTask } from '@centaur/rendering'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export type JsonObject = { [key: string]: JsonValue | undefined }

export type CentaurWebFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type CentaurWebOptions = {
  apiKey?: string
  apiUrl: string
  controlApiUrl?: string
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
  harnessType?: string
  harness_type?: string
  message: string
  personaId?: string | null
  persona_id?: string | null
  threadId?: string
  threadKey?: string
  thread_key?: string
}

export type WebTurnStreamItem = {
  eventId?: number
  output: WebRendererOutput
}

export type LoadedWebMessage = {
  id: string
  role: 'assistant' | 'user'
  tasks?: WebRendererTask[]
  text: string
}

export type LoadedWebThread = {
  harnessType: string
  lastEventId: number
  messages: LoadedWebMessage[]
  personaId: string | null
  status: string
  threadId: string
  title: string
}

export type WebPersonaOption = {
  description?: string
  engine?: string
  label: string
  value: string
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

export type SessionMessageRecord = SessionMessage & {
  client_message_id?: string | null
  created_at: string
  message_id: string
  thread_key: string
}

export type SessionRecord = {
  created_at: string
  harness_thread_id?: string | null
  harness_type: string
  persona_id?: string | null
  sandbox_id?: string | null
  status: string
  thread_key: string
  updated_at: string
}

export type SessionEventRecord = {
  created_at: string
  event_id: number
  event_type: string
  execution_id?: string | null
  payload: JsonValue
  thread_key: string
}

export type CreateSessionRequest = {
  harness_type: string
  metadata: JsonObject
  persona_id?: string | null
}

export type ExecuteSessionRequest = {
  idle_timeout_ms?: number
  input_lines: string[]
  max_duration_ms?: number
  metadata: JsonObject
}

export type ExecuteSessionResponse = {
  execution_id: string
  ok: boolean
  status: string
  thread_key: string
}

export type SetSessionTitleRequest = {
  metadata: JsonObject
  title: string
}

export type SetSessionTitleResponse = {
  event?: SessionEventRecord
  ok: boolean
}
