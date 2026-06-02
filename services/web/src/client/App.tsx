import { useMemo, useRef, useState } from 'react'
import { Bot, CheckCircle2, Circle, CircleAlert, LoaderCircle, Plus, Send, Terminal } from 'lucide-react'
import { Button, Frame, Input, Rows, Tag } from 'regen-ui'
import type { WebRendererOutput, WebRendererTask } from '@centaur/rendering'

type ChatMessage = {
  id: string
  role: 'assistant' | 'user'
  text: string
}

type StreamEvent = {
  data: WebRendererOutput
  id?: number
}

export function App() {
  const [threadId, setThreadId] = useState(() => newThreadId())
  const [lastEventId, setLastEventId] = useState(0)
  const [title, setTitle] = useState('Centaur Web')
  const [status, setStatus] = useState('Idle')
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [tasks, setTasks] = useState<WebRendererTask[]>([])
  const [planTitle, setPlanTitle] = useState('')
  const [streaming, setStreaming] = useState(false)
  const assistantIdRef = useRef<string | null>(null)
  const taskCount = tasks.length
  const completedTasks = tasks.filter(task => task.status === 'complete').length
  const sortedTasks = useMemo(() => tasks, [tasks])

  async function submit() {
    const message = input.trim()
    if (!message || streaming) return
    setInput('')
    setStreaming(true)
    setStatus('Starting')
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
      updateAssistant(text => `${text}${text ? '\n\n' : ''}${message}`)
    } finally {
      setStreaming(false)
    }
  }

  function applyOutput(output: WebRendererOutput) {
    if (output.type === 'web.status.update') {
      setStatus(output.status)
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
      setTasks(current => upsertTask(current, output.task))
      return
    }
    if (output.type === 'web.plan.update') {
      setPlanTitle(output.title)
      return
    }
    if (output.type === 'web.title.update') {
      setTitle(output.title)
      return
    }
    setStatus(output.error ? 'Error' : 'Complete')
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
    setThreadId(newThreadId())
    setLastEventId(0)
    setTitle('Centaur Web')
    setStatus('Idle')
    setMessages([])
    setTasks([])
    setPlanTitle('')
    assistantIdRef.current = null
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark">
            <Bot size={18} />
          </div>
          <div className="min-w-0">
            <div className="brand-title">Centaur</div>
            <div className="thread-key">{threadId}</div>
          </div>
        </div>

        <Button icon={<Plus size={16} />} onClick={resetThread} size="small" variant="secondary">
          New Thread
        </Button>

        <Frame title="Run State" variant="plain" className="side-panel">
          <Rows variant="pane">
            <Rows.Row label="Status">
              <Tag dot intent={streaming ? 'info' : status === 'Error' ? 'negative' : 'positive'}>
                {status}
              </Tag>
            </Rows.Row>
            <Rows.Row label="Events">{lastEventId}</Rows.Row>
            <Rows.Row label="Tasks">
              {completedTasks}/{taskCount}
            </Rows.Row>
          </Rows>
        </Frame>

        {planTitle && (
          <Frame title="Plan" variant="plain" className="side-panel">
            <p className="plan-title">{planTitle}</p>
          </Frame>
        )}
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="min-w-0">
            <h1>{title}</h1>
            <div className="topbar-meta">
              <Tag>Rust V2</Tag>
              <Tag>Codex</Tag>
              <Tag>Renderer</Tag>
            </div>
          </div>
        </header>

        <div className="content-grid">
          <section className="conversation">
            <div className="message-list" aria-live="polite">
              {messages.length === 0 ? (
                <div className="empty-pane">
                  <Terminal size={20} />
                  <span>Ready</span>
                </div>
              ) : (
                messages.map(message => (
                  <article className={`message ${message.role}`} key={message.id}>
                    <div className="message-role">{message.role}</div>
                    <MarkdownText text={message.text || (message.role === 'assistant' ? '...' : '')} />
                  </article>
                ))
              )}
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

          <section className="activity">
            <div className="activity-header">
              <h2>Activity</h2>
            </div>
            <div className="task-list">
              {sortedTasks.length === 0 ? (
                <div className="task-empty">No activity</div>
              ) : (
                sortedTasks.map(task => <TaskRow key={task.id} task={task} />)
              )}
            </div>
          </section>
        </div>
      </section>
    </main>
  )
}

function TaskRow(props: { task: WebRendererTask }) {
  const { task } = props
  const icon =
    task.status === 'complete' ? (
      <CheckCircle2 size={16} />
    ) : task.status === 'error' ? (
      <CircleAlert size={16} />
    ) : task.status === 'in_progress' ? (
      <LoaderCircle className="spin" size={16} />
    ) : (
      <Circle size={16} />
    )

  return (
    <article className={`task ${task.status}`}>
      <div className="task-title">
        {icon}
        <span>{task.title}</span>
      </div>
      {task.details && <MarkdownText className="task-body" text={task.details} />}
      {task.output && <MarkdownText className="task-output" text={task.output} />}
    </article>
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

function upsertTask(tasks: WebRendererTask[], task: WebRendererTask): WebRendererTask[] {
  const index = tasks.findIndex(item => item.id === task.id)
  if (index < 0) return [...tasks, task]
  return tasks.map(item => (item.id === task.id ? task : item))
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
