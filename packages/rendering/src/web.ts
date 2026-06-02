import type { RendererEvent, RendererTaskBlock, RendererTaskStatus, RendererTaskUpdate } from './types'
import type { RendererInterface } from './interface'

export type WebRendererTask = {
  id: string
  title: string
  status: RendererTaskStatus
  details?: string
  output?: string
}

export type WebRendererOutput =
  | { type: 'web.status.update'; status: string }
  | { type: 'web.message.delta'; delta: string; force?: boolean; planPrefix?: boolean }
  | { type: 'web.message.snapshot'; markdown: string }
  | { type: 'web.task.upsert'; task: WebRendererTask; flush?: boolean }
  | { type: 'web.plan.update'; title: string }
  | { type: 'web.title.update'; title: string }
  | {
      type: 'web.session.closed'
      answerMarkdown?: string
      error?: string
      streamFinalUpdates?: boolean
      threadId?: string
    }

export class WebRenderer implements RendererInterface<WebRendererOutput> {
  open(): WebRendererOutput[] {
    return []
  }

  render(_sessionId: string, event: RendererEvent): WebRendererOutput[] {
    return this.consume(event)
  }

  close(_sessionId: string, event?: Extract<RendererEvent, { type: 'renderer.done' }>): WebRendererOutput[] {
    return event ? this.consume(event) : []
  }

  consume(event: RendererEvent): WebRendererOutput[] {
    if (event.type === 'renderer.session.open') {
      return []
    }
    if (event.type === 'renderer.status') {
      return [{ type: 'web.status.update', status: event.status }]
    }
    if (event.type === 'renderer.message.delta') {
      return [
        {
          type: 'web.message.delta',
          delta: event.delta,
          force: event.force,
          planPrefix: event.planPrefix
        }
      ]
    }
    if (event.type === 'renderer.message.snapshot') {
      return [{ type: 'web.message.snapshot', markdown: event.markdown }]
    }
    if (event.type === 'renderer.task.update') {
      return [{ type: 'web.task.upsert', task: webTask(event.task), flush: event.flush }]
    }
    if (event.type === 'renderer.plan.update') {
      return [{ type: 'web.plan.update', title: event.title }]
    }
    if (event.type === 'renderer.title.update') {
      return [{ type: 'web.title.update', title: event.title }]
    }
    return [
      {
        type: 'web.session.closed',
        answerMarkdown: event.answerMarkdown,
        error: event.error,
        streamFinalUpdates: event.streamFinalUpdates,
        threadId: event.threadId
      }
    ]
  }
}

function webTask(task: RendererTaskUpdate): WebRendererTask {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    ...(task.details?.length ? { details: taskBodyToMarkdown(task.details) } : {}),
    ...(task.output?.length ? { output: taskBodyToMarkdown(task.output) } : {})
  }
}

function taskBodyToMarkdown(blocks: RendererTaskBlock[]): string {
  return blocks
    .map(block => {
      if (block.type === 'text') return block.text
      const language = block.language ?? ''
      return `\`\`\`${language}\n${block.text}\n\`\`\``
    })
    .filter(Boolean)
    .join('\n')
}
