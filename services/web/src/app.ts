import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import {
  generateMissingWebThreadTitle,
  loadWebPersonas,
  loadWebThread,
  streamWebTurn
} from './session-api'
import type { CentaurWebOptions, WebTurnRequest, WebTurnStreamItem } from './types'

const encoder = new TextEncoder()
const WEB_THREAD_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function createCentaurWebApp(options: CentaurWebOptions): Hono {
  const app = new Hono()

  app.get('/health', c => c.json({ ok: true }))
  app.get('/healthz', c => c.json({ ok: true }))

  app.get('/api/personas', async c => {
    const personas = await loadWebPersonas(options)
    return c.json({ personas })
  })

  app.get('/api/threads/:thread_uuid', async c => {
    const threadUuid = c.req.param('thread_uuid').trim()
    if (!WEB_THREAD_UUID_PATTERN.test(threadUuid)) {
      return c.json({ error: 'Invalid thread UUID' }, 400)
    }

    try {
      const thread = await loadWebThread(options, `web:${threadUuid}`)
      if (!thread) return c.json({ error: 'Thread not found' }, 404)
      return c.json(thread)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      options.logger?.error('centaur_web_thread_load_failed', {
        error: message,
        thread_id: `web:${threadUuid}`
      })
      return c.json({ error: message }, 502)
    }
  })

  app.post('/api/threads/:thread_uuid/title', async c => {
    const threadUuid = c.req.param('thread_uuid').trim()
    if (!WEB_THREAD_UUID_PATTERN.test(threadUuid)) {
      return c.json({ error: 'Invalid thread UUID' }, 400)
    }

    try {
      const title = await generateMissingWebThreadTitle(options, `web:${threadUuid}`)
      if (!title) return c.json({ error: 'Thread not found or has no messages' }, 404)
      return c.json(title)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      options.logger?.error('centaur_web_thread_title_failed', {
        error: message,
        thread_id: `web:${threadUuid}`
      })
      return c.json({ error: message }, 502)
    }
  })

  app.post('/api/chat', async c => {
    let input: WebTurnRequest
    try {
      input = (await c.req.json()) as WebTurnRequest
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    return new Response(createTurnStream(options, input), {
      headers: {
        'cache-control': 'no-cache',
        'content-type': 'text/event-stream; charset=utf-8',
        'x-accel-buffering': 'no'
      }
    })
  })

  app.use('/assets/*', serveStatic({ root: './dist/client' }))
  app.get('/favicon.svg', serveStatic({ path: './dist/client/favicon.svg' }))
  app.get('*', serveStatic({ path: './dist/client/index.html' }))

  return app
}

function createTurnStream(
  options: CentaurWebOptions,
  input: WebTurnRequest
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const item of streamWebTurn(options, input)) {
          controller.enqueue(encoder.encode(sseItem(item)))
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        options.logger?.error('centaur_web_turn_failed', {
          error: message,
          thread_id: input.threadId ?? input.threadKey ?? input.thread_key
        })
        controller.enqueue(
          encoder.encode(
            sseItem({
              output: {
                type: 'web.session.closed',
                error: message
              }
            })
          )
        )
      } finally {
        controller.close()
      }
    }
  })
}

function sseItem(item: WebTurnStreamItem): string {
  const id = item.eventId === undefined ? '' : `id: ${item.eventId}\n`
  return `${id}event: ${item.output.type}\ndata: ${JSON.stringify(item.output)}\n\n`
}
