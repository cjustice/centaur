import { describe, expect, it } from 'bun:test'
import { parseSessionEventStream, toCodexInputLine } from '../src/session-api'

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
        message_id: 'msg-1',
        platform: 'web',
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
        thread_id: 'web:test-thread'
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
})
