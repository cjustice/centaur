import { useEffect, useRef, useState } from 'react'
import { Clock3, Search, Send, SquarePen } from 'lucide-react'
import { Button, Input, Tag } from 'regen-ui'
import type { WebRendererOutput } from '@centaur/rendering'

type ChatMessage = {
  id: string
  role: 'assistant' | 'user'
  text: string
}

type ThreadSummary = {
  id: string
  lastMessage: string
  status: string
  title: string
}

type StreamEvent = {
  data: WebRendererOutput
  id?: number
}

const INITIAL_THREAD_ID = newThreadId()

export function App() {
  const [threadId, setThreadId] = useState(INITIAL_THREAD_ID)
  const [lastEventId, setLastEventId] = useState(0)
  const [status, setStatus] = useState('Idle')
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [threads, setThreads] = useState<ThreadSummary[]>(() => [
    createThreadSummary(INITIAL_THREAD_ID)
  ])
  const [streaming, setStreaming] = useState(false)
  const assistantIdRef = useRef<string | null>(null)
  const activeThread = threads.find(thread => thread.id === threadId) ?? threads[0]
  const title = activeThread?.title ?? 'New chat'

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const key = event.key.toLowerCase()
      const isNewChatShortcut =
        key === 'n' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
      if (!isNewChatShortcut) return
      event.preventDefault()
      resetThread()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  async function submit() {
    const message = input.trim()
    if (!message || streaming) return
    setInput('')
    setStreaming(true)
    setStatus('Starting')
    updateThread(threadId, {
      lastMessage: message,
      status: 'Starting',
      title: threadTitleFromMessage(message)
    })
    const userMessage: ChatMessage = { id: newMessageId(), role: 'user', text: message }
    const assistantMessage: ChatMessage = { id: newMessageId(), role: 'assistant', text: '' }
    assistantIdRef.current = assistantMessage.id
    setMessages(current => [...current, userMessage, assistantMessage])

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId, message, afterEventId: lastEventId })
      })
      if (!response.ok || !response.body) {
        throw new Error(`Request failed: ${response.status} ${response.statusText}`)
      }
      for await (const event of parseSse(response.body)) {
        if (typeof event.id === 'number') {
          setLastEventId(current => Math.max(current, event.id ?? 0))
        }
        applyOutput(event.data)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStatus('Error')
      updateThread(threadId, { status: 'Error' })
      updateAssistant(text => `${text}${text ? '\n\n' : ''}${message}`)
    } finally {
      setStreaming(false)
    }
  }

  function applyOutput(output: WebRendererOutput) {
    if (output.type === 'web.status.update') {
      setStatus(output.status)
      updateThread(threadId, { status: output.status })
      return
    }
    if (output.type === 'web.message.delta') {
      updateAssistant(text => (output.force ? output.delta : text + output.delta))
      return
    }
    if (output.type === 'web.message.snapshot') {
      updateAssistant(() => output.markdown)
      return
    }
    if (output.type === 'web.task.upsert') {
      return
    }
    if (output.type === 'web.plan.update') {
      return
    }
    if (output.type === 'web.title.update') {
      updateThread(threadId, { title: output.title })
      return
    }
    const nextStatus = output.error ? 'Error' : 'Complete'
    setStatus(nextStatus)
    updateThread(threadId, { status: nextStatus })
    if (output.answerMarkdown) {
      updateAssistant(text => (text.trim() ? text : output.answerMarkdown ?? ''))
    }
    if (output.error) {
      updateAssistant(text => `${text}${text ? '\n\n' : ''}${output.error ?? ''}`)
    }
  }

  function updateAssistant(update: (text: string) => string) {
    const assistantId = assistantIdRef.current
    if (!assistantId) return
    setMessages(current =>
      current.map(message =>
        message.id === assistantId ? { ...message, text: update(message.text) } : message
      )
    )
  }

  function resetThread() {
    const nextThreadId = newThreadId()
    setThreads(current => [createThreadSummary(nextThreadId), ...current])
    setThreadId(nextThreadId)
    setLastEventId(0)
    setStatus('Idle')
    setMessages([])
    assistantIdRef.current = null
  }

  function selectThread(thread: ThreadSummary) {
    if (streaming || thread.id === threadId) return
    setThreadId(thread.id)
    setLastEventId(0)
    setStatus(thread.status)
    setMessages([])
    assistantIdRef.current = null
  }

  function updateThread(id: string, patch: Partial<ThreadSummary>) {
    setThreads(current =>
      current.map(thread => (thread.id === id ? { ...thread, ...patch } : thread))
    )
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <nav className="sidebar-actions" aria-label="Actions">
          <button
            aria-keyshortcuts="Meta+N Control+N"
            className="sidebar-action primary"
            onClick={resetThread}
            type="button"
          >
            <SquarePen size={20} />
            <span>New chat</span>
            <kbd>⌘N</kbd>
          </button>
          <button className="sidebar-action" type="button">
            <Search size={20} />
            <span>Search</span>
          </button>
          <button className="sidebar-action" type="button">
            <Clock3 size={20} />
            <span>Automations</span>
          </button>
        </nav>

        <nav className="thread-list" aria-label="Threads">
          {threads.map(thread => (
            <button
              className={`thread-item ${thread.id === threadId ? 'active' : ''}`}
              disabled={streaming}
              key={thread.id}
              onClick={() => selectThread(thread)}
              type="button"
            >
              <span className="thread-title">{thread.title}</span>
              <span className="thread-key">{thread.id}</span>
              {thread.lastMessage && <span className="thread-preview">{thread.lastMessage}</span>}
            </button>
          ))}
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="min-w-0">
            <h1>{title}</h1>
            <div className="topbar-meta">
              {status !== 'Idle' && <Tag>{status}</Tag>}
              <Tag>Rust V2</Tag>
              <Tag>Codex</Tag>
              <Tag>Renderer</Tag>
              <Tag>Events {lastEventId}</Tag>
            </div>
          </div>
        </header>

        <div className="content-grid">
          <section className="conversation">
            <div className="message-list" aria-live="polite">
              {messages.map(message => (
                <article className={`message ${message.role}`} key={message.id}>
                  <MarkdownText text={message.text || (message.role === 'assistant' ? '...' : '')} />
                </article>
              ))}
            </div>

            <form
              className="composer"
              onSubmit={event => {
                event.preventDefault()
                void submit()
              }}
            >
              <Input
                aria-label="Message"
                disabled={streaming}
                onChange={event => setInput(event.target.value)}
                placeholder="Ask Codex"
                value={input}
              />
              <Button disabled={!input.trim()} icon={<Send size={16} />} loading={streaming} type="submit">
                Send
              </Button>
            </form>
          </section>
        </div>
      </section>
    </main>
  )
}

function MarkdownText(props: { className?: string; text: string }) {
  const parts = splitCodeFences(props.text)
  return (
    <div className={props.className ?? 'markdown-text'}>
      {parts.map((part, index) =>
        part.kind === 'code' ? (
          <pre key={index}>
            <code>{part.text}</code>
          </pre>
        ) : (
          <p key={index}>{part.text}</p>
        )
      )}
    </div>
  )
}

function splitCodeFences(value: string): Array<{ kind: 'code' | 'text'; text: string }> {
  const parts: Array<{ kind: 'code' | 'text'; text: string }> = []
  const regex = /```[^\n]*\n([\s\S]*?)```/g
  let lastIndex = 0
  for (const match of value.matchAll(regex)) {
    if (match.index > lastIndex) {
      const text = value.slice(lastIndex, match.index).trim()
      if (text) parts.push({ kind: 'text', text })
    }
    parts.push({ kind: 'code', text: match[1] ?? '' })
    lastIndex = match.index + match[0].length
  }
  const tail = value.slice(lastIndex).trim()
  if (tail) parts.push({ kind: 'text', text: tail })
  return parts.length ? parts : [{ kind: 'text', text: value }]
}

function createThreadSummary(threadId: string): ThreadSummary {
  return {
    id: threadId,
    lastMessage: '',
    status: 'Idle',
    title: 'New chat'
  }
}

function threadTitleFromMessage(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, ' ')
  return trimmed.length > 42 ? `${trimmed.slice(0, 39)}...` : trimmed || 'New chat'
}

async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncIterable<StreamEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventId: number | undefined
  let data: string[] = []

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const event = parseSseLine(line, { data, eventId })
      data = event.state.data
      eventId = event.state.eventId
      if (event.data) yield event.data
    }
  }
}

function parseSseLine(
  line: string,
  state: { data: string[]; eventId?: number }
): { data?: StreamEvent; state: { data: string[]; eventId?: number } } {
  if (!line.trim()) {
    if (!state.data.length) return { state: { data: [] } }
    const raw = state.data.join('\n')
    return {
      data: { data: JSON.parse(raw) as WebRendererOutput, id: state.eventId },
      state: { data: [] }
    }
  }
  if (line.startsWith('id:')) {
    const id = Number.parseInt(line.slice(3).trim(), 10)
    return { state: { ...state, eventId: Number.isFinite(id) ? id : undefined } }
  }
  if (line.startsWith('data:')) {
    return { state: { ...state, data: [...state.data, line.slice(5).trimStart()] } }
  }
  return { state }
}

function newThreadId(): string {
  return `web:${crypto.randomUUID()}`
}

function newMessageId(): string {
  return `msg-${crypto.randomUUID()}`
}
