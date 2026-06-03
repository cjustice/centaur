import { Fragment, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { ArrowUp, Bot } from 'lucide-react'
import { Select } from 'regen-ui'
import type { WebRendererOutput, WebRendererTask } from '@centaur/rendering'
import type { LoadedWebThread, WebPersonaOption } from '../types'

type ChatMessage = {
  id: string
  role: 'assistant' | 'user'
  tasks?: WebRendererTask[]
  text: string
}

type ThreadSummary = {
  activeAssistantMessageIds: string[]
  harnessType: string
  id: string
  lastMessage: string
  lastEventId: number
  loadedFromDatabase: boolean
  messages: ChatMessage[]
  personaId: string
  status: string
  title: string
}

type StreamEvent = {
  data: WebRendererOutput
  id?: number
}

const INITIAL_THREAD_ID = initialThreadId()
const DEFAULT_HARNESS_TYPE = 'codex'
const DEFAULT_PERSONA_ID = '__base__'
const WEB_THREAD_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HARNESS_OPTIONS = [
  { label: 'Codex', value: DEFAULT_HARNESS_TYPE },
  { label: 'Claude', value: 'claudecode' },
  { label: 'Amp', value: 'amp' }
]
const DEFAULT_PERSONA_OPTIONS = [{ label: 'Base', value: DEFAULT_PERSONA_ID }]

export function App() {
  const composerRef = useRef<HTMLFormElement | null>(null)
  const [threadId, setThreadId] = useState(INITIAL_THREAD_ID)
  const [input, setInput] = useState('')
  const [personaOptions, setPersonaOptions] = useState<WebPersonaOption[]>(DEFAULT_PERSONA_OPTIONS)
  const [threads, setThreads] = useState<ThreadSummary[]>(() => [
    createThreadSummary(INITIAL_THREAD_ID)
  ])
  const activeThread = threads.find(thread => thread.id === threadId) ?? threads[0]
  const title = activeThread?.title ?? 'New chat'
  const status = activeThread?.status ?? 'Idle'
  const lastEventId = activeThread?.lastEventId ?? 0
  const messages = activeThread?.messages ?? []
  const streaming = Boolean(activeThread?.activeAssistantMessageIds.length)
  const isLanding = messages.length === 0
  const harnessType = activeThread?.harnessType ?? DEFAULT_HARNESS_TYPE
  const personaId = activeThread?.personaId ?? DEFAULT_PERSONA_ID
  const activePersonaOptions = ensureSelectedPersonaOption(personaOptions, personaId)

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

  useEffect(() => {
    if (threadIdFromLocation() !== threadId) {
      replaceRouteForThread(threadId)
    }

    function handlePopState() {
      const nextThreadId = threadIdFromLocation() ?? newThreadId()
      setThreads(current =>
        current.some(thread => thread.id === nextThreadId)
          ? current
          : [createThreadSummary(nextThreadId), ...current]
      )
      setThreadId(nextThreadId)
      focusComposerInputSoon()
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadPersonas() {
      try {
        const response = await fetch('/api/personas')
        if (!response.ok) throw new Error(`Persona load failed: ${response.status}`)
        const body = (await response.json()) as { personas?: WebPersonaOption[] }
        if (!cancelled) setPersonaOptions(normalizePersonaOptions(body.personas))
      } catch (error) {
        if (!cancelled) console.error(error)
      }
    }

    void loadPersonas()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const targetThread = activeThread
    if (!targetThread || targetThread.loadedFromDatabase) return
    const targetThreadId = targetThread.id
    let cancelled = false

    async function loadThread() {
      const threadUuid = threadUuidFromId(targetThreadId)
      if (!threadUuid) {
        updateThread(targetThreadId, { loadedFromDatabase: true })
        return
      }

      try {
        const response = await fetch(`/api/threads/${threadUuid}`)
        if (cancelled) return
        if (response.status === 404) {
          updateThread(targetThreadId, { loadedFromDatabase: true })
          return
        }
        if (!response.ok) {
          throw new Error(`Thread load failed: ${response.status} ${response.statusText}`)
        }
        const snapshot = (await response.json()) as LoadedWebThread
        if (cancelled) return
        applyLoadedThread(snapshot)
        if (shouldRequestThreadTitle(snapshot)) {
          void requestLoadedThreadTitle(threadUuid, targetThreadId)
        }
      } catch (error) {
        if (cancelled) return
        updateThread(targetThreadId, {
          loadedFromDatabase: true,
          status: 'Error'
        })
        console.error(error)
      }
    }

    void loadThread()
    return () => {
      cancelled = true
    }
  }, [activeThread?.id, activeThread?.loadedFromDatabase])

  useEffect(() => {
    focusComposerInput()
  })

  async function submit() {
    const currentThread = activeThread
    const message = input.trim()
    if (!currentThread || !message) return
    const currentThreadId = currentThread.id
    const assistantMessageId = newMessageId()
    setInput('')
    updateThread(currentThreadId, {
      activeAssistantMessageIds: [...currentThread.activeAssistantMessageIds, assistantMessageId],
      lastMessage: message,
      messages: [
        ...currentThread.messages,
        { id: newMessageId(), role: 'user', text: message },
        { id: assistantMessageId, role: 'assistant', tasks: [], text: '' }
      ],
      status: 'Starting'
    })

    try {
      const response = await fetch('api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          threadId: currentThreadId,
          message,
          harnessType,
          personaId: personaIdForRequest(personaId),
          afterEventId: currentThread.lastEventId
        })
      })
      if (!response.ok || !response.body) {
        throw new Error(`Request failed: ${response.status} ${response.statusText}`)
      }
      for await (const event of parseSse(response.body)) {
        if (typeof event.id === 'number') {
          updateThreadLastEventId(currentThreadId, event.id)
        }
        applyOutput(currentThreadId, assistantMessageId, event.data)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      updateThread(currentThreadId, { status: 'Error' })
      updateAssistant(
        currentThreadId,
        assistantMessageId,
        text => `${text}${text ? '\n\n' : ''}${message}`
      )
    } finally {
      completeAssistantMessage(currentThreadId, assistantMessageId)
    }
  }

  function applyOutput(targetThreadId: string, assistantMessageId: string, output: WebRendererOutput) {
    if (output.type === 'web.status.update') {
      updateThread(targetThreadId, { status: output.status })
      return
    }
    if (output.type === 'web.message.delta') {
      updateAssistant(targetThreadId, assistantMessageId, text =>
        output.force ? output.delta : text + output.delta
      )
      return
    }
    if (output.type === 'web.message.snapshot') {
      updateAssistant(targetThreadId, assistantMessageId, () => output.markdown)
      return
    }
    if (output.type === 'web.task.upsert') {
      updateAssistantTask(targetThreadId, assistantMessageId, output.task)
      return
    }
    if (output.type === 'web.plan.update') {
      return
    }
    if (output.type === 'web.title.update') {
      updateThreadTitleIfUntitled(targetThreadId, output.title)
      return
    }
    const nextStatus = output.error ? 'Error' : 'Complete'
    updateThread(targetThreadId, { status: nextStatus })
    if (output.answerMarkdown) {
      updateAssistant(targetThreadId, assistantMessageId, text =>
        text.trim() ? text : output.answerMarkdown ?? ''
      )
    }
    if (output.error) {
      updateAssistant(targetThreadId, assistantMessageId, text =>
        `${text}${text ? '\n\n' : ''}${output.error ?? ''}`
      )
    }
  }

  function updateAssistant(
    targetThreadId: string,
    assistantMessageId: string,
    update: (text: string) => string
  ) {
    updateThreadMessages(targetThreadId, messages =>
      messages.map(message =>
        message.id === assistantMessageId ? { ...message, text: update(message.text) } : message
      )
    )
  }

  function updateAssistantTask(
    targetThreadId: string,
    assistantMessageId: string,
    task: WebRendererTask
  ) {
    updateThreadMessages(targetThreadId, messages =>
      messages.map(message =>
        message.id === assistantMessageId
          ? { ...message, tasks: upsertTaskItem(message.tasks ?? [], task) }
          : message
      )
    )
  }

  function resetThread() {
    const nextThreadId = newThreadId()
    setThreads(current => [createThreadSummary(nextThreadId, harnessType, personaId), ...current])
    setThreadId(nextThreadId)
    pushRouteForThread(nextThreadId)
    focusComposerInputSoon()
  }

  function selectThread(thread: ThreadSummary) {
    if (thread.id !== threadId) {
      setThreadId(thread.id)
      pushRouteForThread(thread.id)
    }
    focusComposerInputSoon()
  }

  function changeHarnessType(nextHarnessType: string) {
    const currentThread = activeThread
    if (!currentThread || nextHarnessType === currentThread.harnessType) return
    const canReuseThread =
      currentThread.messages.length === 0 && currentThread.activeAssistantMessageIds.length === 0
    if (canReuseThread) {
      updateThread(currentThread.id, { harnessType: nextHarnessType })
      focusComposerInputSoon()
      return
    }

    const nextThreadId = newThreadId()
    setThreads(current => [
      createThreadSummary(nextThreadId, nextHarnessType, currentThread.personaId),
      ...current
    ])
    setThreadId(nextThreadId)
    pushRouteForThread(nextThreadId)
    focusComposerInputSoon()
  }

  function changePersonaId(nextPersonaId: string) {
    const currentThread = activeThread
    const normalizedPersonaId = normalizePersonaIdValue(nextPersonaId)
    if (!currentThread || normalizedPersonaId === currentThread.personaId) return
    const canReuseThread =
      currentThread.messages.length === 0 && currentThread.activeAssistantMessageIds.length === 0
    if (canReuseThread) {
      updateThread(currentThread.id, { personaId: normalizedPersonaId })
      focusComposerInputSoon()
      return
    }

    const nextThreadId = newThreadId()
    setThreads(current => [
      createThreadSummary(nextThreadId, currentThread.harnessType, normalizedPersonaId),
      ...current
    ])
    setThreadId(nextThreadId)
    pushRouteForThread(nextThreadId)
    focusComposerInputSoon()
  }

  function applyLoadedThread(snapshot: LoadedWebThread) {
    setThreads(current =>
      current.map(thread => {
        if (thread.id !== snapshot.threadId) return thread
        const hasLocalMessages =
          thread.messages.length > 0 || thread.activeAssistantMessageIds.length > 0
        const messages = hasLocalMessages ? thread.messages : snapshot.messages
        const hasActiveAssistant = thread.activeAssistantMessageIds.length > 0
        const lastMessage =
          thread.lastMessage ||
          [...messages].reverse().find(message => message.role === 'user')?.text ||
          ''
        return {
          ...thread,
          harnessType: snapshot.harnessType,
          lastEventId: Math.max(thread.lastEventId, snapshot.lastEventId),
          lastMessage,
          loadedFromDatabase: true,
          messages,
          personaId: normalizePersonaIdValue(snapshot.personaId),
          status: hasActiveAssistant ? thread.status : snapshot.status,
          title: isUntitledThread(thread) ? snapshot.title : thread.title
        }
      })
    )
  }

  async function requestLoadedThreadTitle(threadUuid: string, targetThreadId: string) {
    try {
      const response = await fetch(`/api/threads/${threadUuid}/title`, { method: 'POST' })
      if (!response.ok) return
      const body = (await response.json()) as { eventId?: number; title?: string }
      if (body.title) updateThreadTitleIfUntitled(targetThreadId, body.title)
      if (typeof body.eventId === 'number') updateThreadLastEventId(targetThreadId, body.eventId)
    } catch (error) {
      console.error(error)
    }
  }

  function updateThread(id: string, patch: Partial<ThreadSummary>) {
    setThreads(current =>
      current.map(thread => (thread.id === id ? { ...thread, ...patch } : thread))
    )
  }

  function updateThreadLastEventId(id: string, eventId: number) {
    setThreads(current =>
      current.map(thread =>
        thread.id === id ? { ...thread, lastEventId: Math.max(thread.lastEventId, eventId) } : thread
      )
    )
  }

  function updateThreadMessages(
    id: string,
    update: (messages: ChatMessage[]) => ChatMessage[]
  ) {
    setThreads(current =>
      current.map(thread =>
        thread.id === id ? { ...thread, messages: update(thread.messages) } : thread
      )
    )
  }

  function completeAssistantMessage(id: string, assistantMessageId: string) {
    setThreads(current =>
      current.map(thread =>
        thread.id === id
          ? {
              ...thread,
              activeAssistantMessageIds: thread.activeAssistantMessageIds.filter(
                messageId => messageId !== assistantMessageId
              )
            }
          : thread
      )
    )
  }

  function updateThreadTitleIfUntitled(id: string, nextTitle: string) {
    const title = nextTitle.trim()
    if (!title) return
    setThreads(current =>
      current.map(thread =>
        thread.id === id && isUntitledThread(thread) ? { ...thread, title } : thread
      )
    )
  }

  function focusComposerInput() {
    const input = composerRef.current?.querySelector<
      HTMLInputElement | HTMLTextAreaElement
    >('[aria-label="Message"]')
    if (!input || input.disabled) return
    input.focus({ preventScroll: true })
  }

  function focusComposerInputSoon() {
    window.requestAnimationFrame(focusComposerInput)
  }

  const composer = (
    <Composer
      input={input}
      isLanding={isLanding}
      harnessType={harnessType}
      personaId={personaId}
      personaOptions={activePersonaOptions}
      onInputChange={setInput}
      onHarnessTypeChange={changeHarnessType}
      onPersonaIdChange={changePersonaId}
      onSubmit={() => void submit()}
      composerRef={composerRef}
    />
  )

  if (isLanding) {
    return (
      <main className="app-shell landing-shell">
        <section className="landing-route">
          <div className="landing-content">
            <h1>What should Centaur run?</h1>
            {composer}
          </div>
        </section>
      </main>
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
            <span>New chat</span>
            <kbd>⌘N</kbd>
          </button>
        </nav>

        <nav className="thread-list" aria-label="Threads">
          {threads.map(thread => (
            <a
              className={`thread-item ${thread.id === threadId ? 'active' : ''}`}
              href={threadPath(thread.id)}
              key={thread.id}
              onClick={event => {
                event.preventDefault()
                selectThread(thread)
              }}
            >
              <span className="thread-title">{thread.title}</span>
            </a>
          ))}
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="min-w-0">
            <h1>{title}</h1>
            {status !== 'Idle' && (
              <p className="topbar-status">
                {status} · Events {lastEventId}
              </p>
            )}
          </div>
        </header>

        <div className="content-grid">
          <section className="conversation">
            <div className="message-list" aria-live="polite">
              {messages.map(message => {
                const messageTasks = visibleTasks(message.tasks ?? [])
                return (
                  <Fragment key={message.id}>
                    {message.role === 'assistant' && messageTasks.length > 0 && (
                      <TaskList
                        streaming={Boolean(
                          activeThread?.activeAssistantMessageIds.includes(message.id)
                        )}
                        tasks={messageTasks}
                      />
                    )}
                    <article className={`message ${message.role}`}>
                      <MarkdownText text={message.text || (message.role === 'assistant' ? '...' : '')} />
                    </article>
                  </Fragment>
                )
              })}
            </div>

            {composer}
          </section>
        </div>
      </section>
    </main>
  )
}

const Composer = (props: {
  input: string
  isLanding: boolean
  harnessType: string
  personaId: string
  personaOptions: WebPersonaOption[]
  composerRef: RefObject<HTMLFormElement | null>
  onHarnessTypeChange: (value: string) => void
  onInputChange: (value: string) => void
  onPersonaIdChange: (value: string) => void
  onSubmit: () => void
}) => {
  return (
    <form
      className={`composer ${props.isLanding ? 'landing-composer' : ''}`}
      onSubmit={event => {
        event.preventDefault()
        props.onSubmit()
      }}
      ref={props.composerRef}
    >
      <div className="composer-panel">
        <textarea
          aria-label="Message"
          onChange={event => props.onInputChange(event.target.value)}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey) return
            event.preventDefault()
            props.onSubmit()
          }}
          placeholder={props.isLanding ? 'Do anything' : 'Ask Centaur for anything'}
          rows={props.isLanding ? 3 : 1}
          value={props.input}
        />
        <div className="composer-controls">
          <div className="composer-control-group">
            <DropdownPill
              label="Model"
              onChange={props.onHarnessTypeChange}
              options={HARNESS_OPTIONS}
              value={props.harnessType}
            />
            <DropdownPill
              icon="bot"
              label="Persona"
              onChange={props.onPersonaIdChange}
              options={props.personaOptions}
              value={props.personaId}
            />
          </div>
          <div className="composer-control-group align-end">
            <button
              aria-label="Send message"
              className="composer-send"
              disabled={!props.input.trim()}
              type="submit"
            >
              <ArrowUp size={20} />
            </button>
          </div>
        </div>
      </div>
    </form>
  )
}

function DropdownPill(props: {
  icon?: 'bot'
  label: string
  onChange: (value: string) => void
  options: Array<{ label: string; value: string }>
  value: string
}) {
  return (
    <div className="dropdown-pill">
      {props.icon === 'bot' && (
        <Bot aria-hidden="true" className="dropdown-pill-icon" size={16} />
      )}
      <Select
        aria-label={props.label}
        className="dropdown-pill-select"
        items={props.options.map(option => ({
          label: option.label,
          textValue: option.label,
          value: option.value
        }))}
        onChange={props.onChange}
        value={props.value}
      />
    </div>
  )
}

function TaskList(props: { tasks: WebRendererTask[]; streaming: boolean }) {
  return (
    <section className="task-list" aria-label="Model activity">
      {props.tasks.map(task => (
        <TaskPanel key={task.id} streaming={props.streaming} task={task} />
      ))}
    </section>
  )
}

function TaskPanel(props: { task: WebRendererTask; streaming: boolean }) {
  const active = isTaskActive(props.task)
  const open = active || hasTaskBody(props.task)

  return (
    <details className="task-panel" open={open}>
      <summary>
        <span className={`task-dot ${active ? 'active' : ''}`} />
        <span className="task-title">{props.task.title}</span>
        <span className="task-status">{taskStatusLabel(props.task, props.streaming)}</span>
      </summary>
      <div className="task-content">
        {props.task.details && (
          <MarkdownText className="markdown-text task-text" text={props.task.details} />
        )}
        {props.task.output && (
          <MarkdownText className="markdown-text task-output" text={props.task.output} />
        )}
        {!hasTaskBody(props.task) && active && (
          <p className="task-placeholder">Waiting for the first update...</p>
        )}
      </div>
    </details>
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

function createThreadSummary(
  threadId: string,
  harnessType = DEFAULT_HARNESS_TYPE,
  personaId = DEFAULT_PERSONA_ID,
  loadedFromDatabase = false
): ThreadSummary {
  return {
    activeAssistantMessageIds: [],
    harnessType,
    id: threadId,
    lastMessage: '',
    lastEventId: 0,
    loadedFromDatabase,
    messages: [],
    personaId: normalizePersonaIdValue(personaId),
    status: 'Idle',
    title: 'New chat'
  }
}

function normalizePersonaOptions(options: WebPersonaOption[] | undefined): WebPersonaOption[] {
  const normalized = (options ?? [])
    .map(option => ({
      ...option,
      value: normalizePersonaIdValue(option.value)
    }))
    .filter(option => option.value && option.label.trim())
  return ensureSelectedPersonaOption(normalized, DEFAULT_PERSONA_ID)
}

function ensureSelectedPersonaOption(
  options: WebPersonaOption[],
  personaId: string
): WebPersonaOption[] {
  const selected = normalizePersonaIdValue(personaId)
  const deduped = new Map<string, WebPersonaOption>()
  for (const option of DEFAULT_PERSONA_OPTIONS) deduped.set(option.value, option)
  for (const option of options) deduped.set(normalizePersonaIdValue(option.value), option)
  if (!deduped.has(selected)) {
    deduped.set(selected, { label: labelFromPersonaId(selected), value: selected })
  }
  return [...deduped.values()]
}

function normalizePersonaIdValue(value: string | null | undefined): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!normalized || normalized === 'base' || normalized === DEFAULT_PERSONA_ID) {
    return DEFAULT_PERSONA_ID
  }
  return normalized
}

function personaIdForRequest(value: string): string | null {
  const normalized = normalizePersonaIdValue(value)
  return normalized === DEFAULT_PERSONA_ID ? null : normalized
}

function labelFromPersonaId(value: string): string {
  if (value === DEFAULT_PERSONA_ID) return 'Base'
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function isUntitledThread(thread: ThreadSummary): boolean {
  return thread.title.trim() === '' || thread.title === 'New chat'
}

function shouldRequestThreadTitle(thread: LoadedWebThread): boolean {
  return (
    (thread.title.trim() === '' || thread.title === 'New chat') &&
    thread.messages.some(message => message.role === 'user' && message.text.trim())
  )
}

function upsertTaskItem(items: WebRendererTask[], task: WebRendererTask): WebRendererTask[] {
  const existingIndex = items.findIndex(item => item.id === task.id)
  if (existingIndex === -1) return [...items, task]
  return items.map((item, index) =>
    index === existingIndex
      ? {
          ...item,
          ...task,
          details: task.details ?? item.details,
          output: task.output ?? item.output
        }
      : item
  )
}

function visibleTasks(tasks: WebRendererTask[]): WebRendererTask[] {
  return tasks.filter(task => hasTaskBody(task) || isTaskActive(task))
}

function hasTaskBody(task: WebRendererTask): boolean {
  return Boolean(task.details?.trim() || task.output?.trim())
}

function isTaskActive(task: WebRendererTask): boolean {
  return task.status === 'pending' || task.status === 'in_progress'
}

function taskStatusLabel(task: WebRendererTask, streaming: boolean): string {
  if (task.status === 'error') return 'Error'
  if (isTaskActive(task)) return streaming ? 'Working' : 'Pending'
  return 'Done'
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

function initialThreadId(): string {
  return threadIdFromLocation() ?? newThreadId()
}

function threadIdFromLocation(): string | undefined {
  if (typeof window === 'undefined') return undefined
  const pathname = window.location.pathname.replace(/^\/+|\/+$/g, '')
  const [threadUuid] = pathname.split('/')
  return isWebThreadUuid(threadUuid) ? `web:${threadUuid}` : undefined
}

function threadPath(threadId: string): string {
  const threadUuid = threadUuidFromId(threadId)
  return threadUuid ? `/${threadUuid}` : '/'
}

function pushRouteForThread(threadId: string) {
  if (typeof window === 'undefined') return
  const path = threadPath(threadId)
  if (window.location.pathname === path) return
  window.history.pushState({ threadId }, '', path)
}

function replaceRouteForThread(threadId: string) {
  if (typeof window === 'undefined') return
  const path = threadPath(threadId)
  if (window.location.pathname === path) return
  window.history.replaceState({ threadId }, '', path)
}

function threadUuidFromId(threadId: string): string | undefined {
  if (!threadId.startsWith('web:')) return undefined
  const threadUuid = threadId.slice('web:'.length)
  return isWebThreadUuid(threadUuid) ? threadUuid : undefined
}

function isWebThreadUuid(value: string | undefined): value is string {
  return Boolean(value && WEB_THREAD_UUID_PATTERN.test(value))
}

function newThreadId(): string {
  return `web:${crypto.randomUUID()}`
}

function newMessageId(): string {
  return `msg-${crypto.randomUUID()}`
}
