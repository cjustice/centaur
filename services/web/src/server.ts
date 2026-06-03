import { createCentaurWebApp } from './app'
import type { CentaurWebLogger, CentaurWebOptions } from './types'

const port = numberEnv('PORT', 3003)
const apiUrl = stringEnv('CENTAUR_API_RS_URL', stringEnv('CENTAUR_API_URL', 'http://127.0.0.1:8080'))
const controlApiUrl = optionalEnv('CENTAUR_CONTROL_API_URL') ?? optionalEnv('CENTAUR_API_URL')

const consoleLogger: CentaurWebLogger = {
  info: (event, fields) => log('info', event, fields),
  warn: (event, fields) => log('warn', event, fields),
  error: (event, fields) => log('error', event, fields)
}

const options: CentaurWebOptions = {
  apiUrl,
  apiKey: optionalEnv('CENTAUR_API_KEY') ?? optionalEnv('SLACKBOT_API_KEY'),
  controlApiUrl,
  idleTimeoutMs: optionalNumberEnv('SESSION_IDLE_TIMEOUT_MS'),
  maxDurationMs: optionalNumberEnv('SESSION_MAX_DURATION_MS'),
  streamReconnectAttempts: optionalNumberEnv('SESSION_STREAM_RECONNECT_ATTEMPTS'),
  streamReconnectDelayMs: optionalNumberEnv('SESSION_STREAM_RECONNECT_DELAY_MS'),
  logger: consoleLogger
}

const app = createCentaurWebApp(options)
const server = Bun.serve({
  port,
  fetch: app.fetch
})

console.log(
  JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'info',
    event: 'centaur_web_started',
    service: 'centaur-web',
    port: server.port,
    api_url: apiUrl,
    control_api_url: controlApiUrl
  })
)

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

function stringEnv(name: string, fallback: string): string {
  return optionalEnv(name) ?? fallback
}

function numberEnv(name: string, fallback: number): number {
  return optionalNumberEnv(name) ?? fallback
}

function optionalNumberEnv(name: string): number | undefined {
  const value = optionalEnv(name)
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function log(level: string, event: string, fields?: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      level,
      service: 'centaur-web',
      timestamp: new Date().toISOString(),
      event,
      ...(fields ?? {})
    })
  )
}
