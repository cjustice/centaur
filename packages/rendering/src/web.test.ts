import { describe, expect, it } from 'bun:test'
import { WebRenderer } from './web'
import type { RendererInterface } from './interface'

describe('WebRenderer', () => {
  it('implements the generic renderer interface for browser stream outputs', () => {
    const renderer: RendererInterface = new WebRenderer()

    expect(renderer.open({ title: 'Execution' })).toEqual([])
    expect(
      renderer.render('session-1', {
        type: 'renderer.message.delta',
        delta: 'Hello',
        force: true
      })
    ).toEqual([{ type: 'web.message.delta', delta: 'Hello', force: true, planPrefix: undefined }])
    expect(
      renderer.close('session-1', {
        type: 'renderer.done',
        answerMarkdown: 'Done',
        threadId: 'thread-1',
        streamFinalUpdates: true
      })
    ).toEqual([
      {
        type: 'web.session.closed',
        answerMarkdown: 'Done',
        error: undefined,
        streamFinalUpdates: true,
        threadId: 'thread-1'
      }
    ])
  })

  it('converts rich task blocks into markdown strings', () => {
    const renderer = new WebRenderer()

    expect(
      renderer.render('session-1', {
        type: 'renderer.task.update',
        task: {
          id: 'task-1',
          title: 'Run tests',
          status: 'complete',
          details: [{ type: 'text', text: 'bun test' }],
          output: [{ type: 'code', language: 'text', text: 'ok 1' }]
        }
      })
    ).toEqual([
      {
        type: 'web.task.upsert',
        flush: undefined,
        task: {
          id: 'task-1',
          title: 'Run tests',
          status: 'complete',
          details: 'bun test',
          output: '```text\nok 1\n```'
        }
      }
    ])
  })
})
