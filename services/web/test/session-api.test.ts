import { describe, expect, it } from 'bun:test'
import { createCentaurWebApp } from '../src/app'
import {
  loadWebThread,
  parseSessionEventStream,
  streamWebTurn,
  toCodexInputLine
} from '../src/session-api'
import type { CentaurWebFetch } from '../src/types'

describe('web session api helpers', () => {
  it('builds Codex app-server input lines for the Rust V2 session API', () => {
    const line = toCodexInputLine(
      {
        threadId: 'web:test-thread',
        message: 'Reply with PONG'
      },
      'msg-1'
    )

    expect(JSON.parse(line)).toEqual({
      type: 'user',
      thread_key: 'web:test-thread',
      trace_metadata: {
        action: 'execute',
        harness_type: 'codex',
        message_id: 'msg-1',
        platform: 'web',
        persona_id: null,
        source: 'centaur-web',
        thread_id: 'web:test-thread',
        timestamp: expect.any(String)
      },
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Reply with PONG' }]
      }
    })
  })

  it('passes persona id through session metadata and create session', async () => {
    const bodies: unknown[] = []
    const fetch: CentaurWebFetch = async (input, init) => {
      const url = new URL(String(input))
      if (typeof init?.body === 'string') {
        bodies.push(JSON.parse(init.body))
      }
      if (url.pathname.endsWith('/events')) {
        return new Response(terminalEventStream())
      }
      return new Response('{}', { status: 200 })
    }

    for await (const _ of streamWebTurn(
      {
        apiUrl: 'http://api.local',
        fetch
      },
      {
        threadId: 'web:test-thread',
        message: 'Reply with PONG',
        harnessType: 'amp',
        personaId: 'eng'
      }
    )) {
      // drain stream
    }

    expect(bodies[0]).toMatchObject({
      harness_type: 'amp',
      persona_id: 'eng',
      metadata: {
        harness_type: 'amp',
        persona_id: 'eng'
      }
    })
    expect(bodies[1]).toMatchObject({
      messages: [
        {
          metadata: {
            harness_type: 'amp',
            persona_id: 'eng'
          }
        }
      ]
    })
    expect(bodies[2]).toMatchObject({
      metadata: {
        harness_type: 'amp',
        persona_id: 'eng'
      }
    })
  })

  it('accepts threadKey as a web request alias', () => {
    const line = toCodexInputLine(
      {
        threadKey: 'web:test-thread',
        message: 'Reply with PONG'
      },
      'msg-1'
    )

    expect(JSON.parse(line)).toMatchObject({
      thread_key: 'web:test-thread',
      trace_metadata: {
        harness_type: 'codex',
        thread_id: 'web:test-thread'
      }
    })
  })

  it('passes supported harness type through session metadata', async () => {
    for (const harnessType of ['claudecode', 'amp']) {
      const bodies: unknown[] = []
      const fetch: CentaurWebFetch = async (input, init) => {
        const url = new URL(String(input))
        if (typeof init?.body === 'string') {
          bodies.push(JSON.parse(init.body))
        }
        if (url.pathname.endsWith('/events')) {
          return new Response(terminalEventStream())
        }
        return new Response('{}', { status: 200 })
      }

      for await (const _ of streamWebTurn(
        {
          apiUrl: 'http://api.local',
          fetch
        },
        {
          threadId: 'web:test-thread',
          message: 'Reply with PONG',
          harnessType
        }
      )) {
        // drain stream
      }

      expect(bodies[0]).toMatchObject({
        harness_type: harnessType,
        metadata: {
          harness_type: harnessType
        }
      })
      expect(bodies[1]).toMatchObject({
        messages: [
          {
            metadata: {
              harness_type: harnessType
            }
          }
        ]
      })
      expect(bodies[2]).toMatchObject({
        metadata: {
          harness_type: harnessType
        }
      })
    }
  })

  it('passes api chat harnessType through to Rust session API calls', async () => {
    const bodies: unknown[] = []
    const fetch: CentaurWebFetch = async (input, init) => {
      const url = new URL(String(input))
      if (typeof init?.body === 'string') {
        bodies.push(JSON.parse(init.body))
      }
      if (url.pathname.endsWith('/events')) {
        return new Response(terminalEventStream())
      }
      return new Response('{}', { status: 200 })
    }
    const app = createCentaurWebApp({
      apiUrl: 'http://api.local',
      fetch
    })

    const response = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        threadId: 'web:test-thread',
        message: 'Reply with PONG',
        harnessType: 'amp'
      })
    })

    expect(response.status).toBe(200)
    await response.text()
    expect(bodies[0]).toMatchObject({
      harness_type: 'amp',
      metadata: {
        harness_type: 'amp'
      }
    })
    expect(bodies[1]).toMatchObject({
      messages: [
        {
          metadata: {
            harness_type: 'amp'
          }
        }
      ]
    })
    expect(bodies[2]).toMatchObject({
      metadata: {
        harness_type: 'amp'
      }
    })
  })

  it('uses the selected harness to generate and persist a title update', async () => {
    const bodies: unknown[] = []
    const requests: string[] = []
    const fetch: CentaurWebFetch = async (input, init) => {
      const url = new URL(String(input))
      requests.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)
      if (typeof init?.body === 'string') {
        bodies.push(JSON.parse(init.body))
      }

      if (url.pathname === '/api/session/web%3Atest-thread') {
        return Response.json({
          created_at: [2026, 154, 12, 0, 0, 0, 0, 0, 0],
          harness_thread_id: null,
          harness_type: 'claudecode',
          persona_id: 'eng',
          sandbox_id: null,
          status: 'idle',
          thread_key: 'web:test-thread',
          updated_at: [2026, 154, 12, 0, 0, 0, 0, 0, 0]
        })
      }
      if (url.pathname === '/api/session/web%3Atest-thread/messages') {
        return Response.json({
          messages: [
            {
              client_message_id: null,
              created_at: [2026, 154, 12, 0, 1, 0, 0, 0, 0],
              message_id: 'msg_1',
              metadata: {},
              parts: [{ type: 'text', text: 'What is your base model and persona?' }],
              role: 'user',
              thread_key: 'web:test-thread'
            }
          ]
        })
      }
      if (url.pathname === '/api/session/web%3Atest-thread/event-log') {
        return Response.json({
          events: [
            {
              created_at: [2026, 154, 12, 0, 2, 0, 0, 0, 0],
              event_id: 9,
              event_type: 'session.output.line',
              execution_id: 'exe_1',
              payload: '{"type":"item.agentMessage.delta","itemId":"msg-1","delta":"Claude via Eng"}',
              thread_key: 'web:test-thread'
            },
            {
              created_at: [2026, 154, 12, 0, 3, 0, 0, 0, 0],
              event_id: 10,
              event_type: 'session.output.line',
              execution_id: 'exe_1',
              payload:
                '{"type":"item.completed","item":{"type":"agentMessage","id":"msg-1","text":"Claude via Eng","phase":"final_answer"}}',
              thread_key: 'web:test-thread'
            },
            {
              created_at: [2026, 154, 12, 0, 4, 0, 0, 0, 0],
              event_id: 11,
              event_type: 'session.output.line',
              execution_id: 'exe_1',
              payload: '{"type":"turn.completed"}',
              thread_key: 'web:test-thread'
            }
          ]
        })
      }
      if (url.pathname === '/api/session/web%3Atest-thread/events') {
        return new Response(
          url.searchParams.get('after_event_id') === '11'
            ? titleGenerationEventStream()
            : terminalEventStream()
        )
      }
      if (url.pathname === '/api/session/web%3Atest-thread/title') {
        const titleBody = bodies.at(-1) as { title?: string }
        return Response.json({
          ok: true,
          event: {
            created_at: [2026, 154, 12, 0, 8, 0, 0, 0, 0],
            event_id: 15,
            event_type: 'session.output.line',
            execution_id: null,
            payload: JSON.stringify({
              type: 'thread/name/updated',
              name: titleBody.title
            }),
            thread_key: 'web:test-thread'
          }
        })
      }
      return new Response('{}', { status: 200 })
    }

    const outputs = []
    for await (const item of streamWebTurn(
      {
        apiUrl: 'http://api.local',
        fetch
      },
      {
        threadId: 'web:test-thread',
        message: 'What is your base model and persona?',
        harnessType: 'claudecode',
        personaId: 'eng'
      }
    )) {
      outputs.push(item)
    }

    const executeBodies = bodies.filter(
      (body): body is { input_lines: string[]; metadata: { action: string; harness_type: string } } =>
        Boolean(
          body &&
            typeof body === 'object' &&
            'input_lines' in body &&
            'metadata' in body
        )
    )
    expect(executeBodies).toHaveLength(2)
    const titleExecuteBody = executeBodies[1]
    expect(titleExecuteBody).toMatchObject({
      metadata: {
        action: 'generate_title',
        harness_type: 'claudecode'
      }
    })
    const titleInputLine = titleExecuteBody?.input_lines[0] ?? ''
    expect(titleInputLine).toContain('Generate a concise title')
    expect(titleInputLine).toContain('Claude via Eng')
    expect(requests).toContain('POST /api/session/web%3Atest-thread/title')
    expect(outputs.at(-1)).toEqual({
      eventId: 15,
      output: {
        type: 'web.title.update',
        title: 'Base Model Persona'
      }
    })
  })

  it('loads linked web thread snapshots by local uuid path', async () => {
    const threadUuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    const requests: string[] = []
    const fetch: CentaurWebFetch = async (input, init) => {
      const url = new URL(String(input))
      requests.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)
      return webThreadSnapshotResponse(url)
    }
    const app = createCentaurWebApp({
      apiUrl: 'http://api.local',
      fetch
    })

    const response = await app.request(`/api/threads/${threadUuid}`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      harnessType: 'amp',
      lastEventId: 15,
      messages: [
        { role: 'user', text: 'Hello linked thread' },
        { role: 'assistant', text: 'Hello world' }
      ],
      personaId: 'eng',
      threadId: `web:${threadUuid}`,
      title: 'Linked Thread Summary'
    })
    expect(requests).toEqual([
      `GET /api/session/web%3A${threadUuid}`,
      `GET /api/session/web%3A${threadUuid}/messages`,
      `GET /api/session/web%3A${threadUuid}/event-log?after_event_id=0&limit=2000`
    ])
  })

  it('loads thread snapshots directly from the Rust session API', async () => {
    const fetch: CentaurWebFetch = async input => webThreadSnapshotResponse(new URL(String(input)))

    const snapshot = await loadWebThread(
      {
        apiUrl: 'http://api.local',
        fetch
      },
      'web:f47ac10b-58cc-4372-a567-0e02b2c3d479'
    )

    expect(snapshot).toMatchObject({
      harnessType: 'amp',
      lastEventId: 15,
      messages: [
        { role: 'user', text: 'Hello linked thread' },
        { role: 'assistant', text: 'Hello world' }
      ],
      personaId: 'eng'
    })
  })

  it('loads persona options from the configured control API', async () => {
    const fetch: CentaurWebFetch = async input => {
      const url = new URL(String(input))
      if (url.origin === 'http://api.local') {
        expect(url.pathname).toBe('/api/personas')
        return new Response('not found', { status: 404 })
      }
      expect(url.origin).toBe('http://control.local')
      expect(url.pathname).toBe('/tools/personas')
      return Response.json({
        eng: { description: 'Engineering', engine: 'codex' },
        legal: { description: 'Legal', engine: 'claudecode' }
      })
    }
    const app = createCentaurWebApp({
      apiUrl: 'http://api.local',
      controlApiUrl: 'http://control.local',
      fetch
    })

    const response = await app.request('/api/personas')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      personas: [
        { label: 'Base', value: '__base__' },
        { engine: 'codex', label: 'Eng', value: 'eng' },
        { engine: 'claudecode', label: 'Legal', value: 'legal' }
      ]
    })
  })

  it('loads persona options from the Rust session API when available', async () => {
    const fetch: CentaurWebFetch = async input => {
      const url = new URL(String(input))
      expect(url.origin).toBe('http://api.local')
      expect(url.pathname).toBe('/api/personas')
      return Response.json({
        eng: { description: 'Engineering', engine: 'codex' }
      })
    }
    const app = createCentaurWebApp({
      apiUrl: 'http://api.local',
      fetch
    })

    const response = await app.request('/api/personas')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      personas: [
        { label: 'Base', value: '__base__' },
        { engine: 'codex', label: 'Eng', value: 'eng' }
      ]
    })
  })

  it('falls back to codex for unsupported harness values', () => {
    const line = toCodexInputLine(
      {
        threadId: 'web:test-thread',
        message: 'Reply with PONG',
        harnessType: 'claude-code'
      },
      'msg-1'
    )

    expect(JSON.parse(line)).toMatchObject({
      trace_metadata: {
        harness_type: 'codex'
      }
    })
  })

  it('maps Rust session SSE output lines to renderer sources and stops at terminal output', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            [
              'id: 7',
              'event: session.output.line',
              'data: {"type":"item.agentMessage.delta","delta":"PONG"}',
              '',
              'id: 8',
              'event: session.output.line',
              'data: {"type":"turn.done","result":"PONG"}',
              '',
              'id: 9',
              'event: session.output.line',
              'data: {"type":"item.agentMessage.delta","delta":"LATE"}',
              '',
              ''
            ].join('\n')
          )
        )
        controller.close()
      }
    })

    const events = []
    for await (const event of parseSessionEventStream(stream)) {
      events.push(event)
    }

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ eventId: 7, eventKind: 'session.output.line' })
    expect(events[1]).toMatchObject({ eventId: 8, eventKind: 'session.output.line' })
  })

  it('reconnects session event streams from the last observed event id', async () => {
    const requests: string[] = []
    let eventStreamCalls = 0
    const fetch: CentaurWebFetch = async (input, init) => {
      const url = new URL(String(input))
      requests.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)
      if (url.pathname.endsWith('/events')) {
        eventStreamCalls += 1
        return new Response(eventStreamCalls === 1 ? erroredEventStream() : terminalEventStream())
      }
      return new Response('{}', { status: 200 })
    }

    const outputs = []
    for await (const item of streamWebTurn(
      {
        apiUrl: 'http://api.local',
        fetch,
        streamReconnectAttempts: 1,
        streamReconnectDelayMs: 0
      },
      {
        threadId: 'web:test-thread',
        message: 'continue after disconnect'
      }
    )) {
      outputs.push(item)
    }

    expect(requests).toContain('GET /api/session/web%3Atest-thread/events?after_event_id=0')
    expect(requests).toContain('GET /api/session/web%3Atest-thread/events?after_event_id=8')
    expect(outputs.map(item => item.output.type)).toContain('web.status.update')
    expect(outputs).toContainEqual({
      eventId: 11,
      output: {
        type: 'web.message.delta',
        delta: 'Hello world',
        force: true,
        planPrefix: false
      }
    })
    expect(outputs.at(-1)?.output).toMatchObject({
      answerMarkdown: 'Hello world',
      type: 'web.session.closed'
    })
  })
})

function erroredEventStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          [
            'id: 7',
            'event: session.output.line',
            'data: {"type":"item.started","item":{"type":"agentMessage","id":"msg-1","text":"","phase":"final_answer"}}',
            '',
            'id: 8',
            'event: session.output.line',
            'data: {"type":"item.agentMessage.delta","itemId":"msg-1","delta":"Hello"}',
            '',
            ''
          ].join('\n')
        )
      )
      setTimeout(() => controller.error(new Error('network error')), 0)
    }
  })
}

function terminalEventStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          [
            'id: 9',
            'event: session.output.line',
            'data: {"type":"item.agentMessage.delta","itemId":"msg-1","delta":" world"}',
            '',
            'id: 10',
            'event: session.output.line',
            'data: {"type":"item.completed","item":{"type":"agentMessage","id":"msg-1","text":"Hello world","phase":"final_answer"}}',
            '',
            'id: 11',
            'event: session.output.line',
            'data: {"type":"turn.completed"}',
            '',
            ''
          ].join('\n')
        )
      )
      controller.close()
    }
  })
}

function titleGenerationEventStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          [
            'id: 12',
            'event: session.output.line',
            'data: {"type":"item.agentMessage.delta","itemId":"title-msg","delta":"Title: Base Model Persona."}',
            '',
            'id: 13',
            'event: session.output.line',
            'data: {"type":"turn.completed"}',
            '',
            ''
          ].join('\n')
        )
      )
      controller.close()
    }
  })
}

function webThreadSnapshotResponse(url: URL): Response {
  const threadKey = 'web:f47ac10b-58cc-4372-a567-0e02b2c3d479'
  if (url.pathname === `/api/session/${encodeURIComponent(threadKey)}`) {
    return Response.json({
      created_at: [2026, 154, 12, 0, 0, 0, 0, 0, 0],
      harness_thread_id: null,
      harness_type: 'amp',
      persona_id: 'eng',
      sandbox_id: null,
      status: 'idle',
      thread_key: threadKey,
      updated_at: [2026, 154, 12, 0, 0, 0, 0, 0, 0]
    })
  }
  if (url.pathname === `/api/session/${encodeURIComponent(threadKey)}/messages`) {
    return Response.json({
      messages: [
        {
          client_message_id: 'client-msg-1',
          created_at: [2026, 154, 12, 0, 1, 0, 0, 0, 0],
          message_id: 'msg_1',
          metadata: {},
          parts: [{ type: 'text', text: 'Hello linked thread' }],
          role: 'user',
          thread_key: threadKey
        }
      ]
    })
  }
  if (url.pathname === `/api/session/${encodeURIComponent(threadKey)}/event-log`) {
    return Response.json({
      events: [
        {
          created_at: [2026, 154, 12, 0, 2, 0, 0, 0, 0],
          event_id: 9,
          event_type: 'session.output.line',
          execution_id: 'exe_1',
          payload: '{"type":"item.agentMessage.delta","itemId":"msg-1","delta":"Hello"}',
          thread_key: threadKey
        },
        {
          created_at: [2026, 154, 12, 0, 3, 0, 0, 0, 0],
          event_id: 10,
          event_type: 'session.output.line',
          execution_id: 'exe_1',
          payload:
            '{"type":"item.completed","item":{"type":"agentMessage","id":"msg-1","text":"Hello world","phase":"final_answer"}}',
          thread_key: threadKey
        },
        {
          created_at: [2026, 154, 12, 0, 4, 0, 0, 0, 0],
          event_id: 11,
          event_type: 'session.output.line',
          execution_id: 'exe_1',
          payload: '{"type":"turn.completed"}',
          thread_key: threadKey
        },
        {
          created_at: [2026, 154, 12, 0, 5, 0, 0, 0, 0],
          event_id: 12,
          event_type: 'session.execution_started',
          execution_id: 'exe_title',
          payload: {
            execution_id: 'exe_title',
            input_line_count: 1,
            metadata: { action: 'generate_title' },
            thread_key: threadKey
          },
          thread_key: threadKey
        },
        {
          created_at: [2026, 154, 12, 0, 6, 0, 0, 0, 0],
          event_id: 13,
          event_type: 'session.output.line',
          execution_id: 'exe_title',
          payload: '{"type":"item.agentMessage.delta","itemId":"title-msg","delta":"Hidden Bad Title"}',
          thread_key: threadKey
        },
        {
          created_at: [2026, 154, 12, 0, 7, 0, 0, 0, 0],
          event_id: 14,
          event_type: 'session.output.line',
          execution_id: 'exe_title',
          payload: '{"type":"turn.completed"}',
          thread_key: threadKey
        },
        {
          created_at: [2026, 154, 12, 0, 8, 0, 0, 0, 0],
          event_id: 15,
          event_type: 'session.output.line',
          execution_id: null,
          payload: '{"type":"thread/name/updated","name":"Linked Thread Summary"}',
          thread_key: threadKey
        }
      ]
    })
  }
  return new Response('not found', { status: 404 })
}
