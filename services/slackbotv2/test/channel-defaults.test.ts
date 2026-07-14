import { describe, expect, test } from 'bun:test'
import {
  channelIdFromThreadId,
  parseChannelDefaults,
  resolveChannelDefault
} from '../src/channel-defaults'

describe('parseChannelDefaults', () => {
  test('returns an empty map for unset or blank input', () => {
    expect(parseChannelDefaults(undefined)).toEqual({})
    expect(parseChannelDefaults('')).toEqual({})
    expect(parseChannelDefaults('   ')).toEqual({})
  })

  test('parses model and reasoning per channel and trims values', () => {
    const parsed = parseChannelDefaults(
      JSON.stringify({
        C0ENG: { model: ' claude-opus-4-8 ', reasoning: 'high' },
        C0TRIAGE: { reasoning: 'low' }
      })
    )
    expect(parsed).toEqual({
      C0ENG: { model: 'claude-opus-4-8', reasoning: 'high' },
      C0TRIAGE: { reasoning: 'low' }
    })
  })

  test('skips entries with no usable model or reasoning', () => {
    const parsed = parseChannelDefaults(
      JSON.stringify({
        C0EMPTY: {},
        C0BLANK: { model: '   ', reasoning: '' },
        C0OK: { model: 'gpt-5.2' }
      })
    )
    expect(parsed).toEqual({ C0OK: { model: 'gpt-5.2' } })
  })

  test('reports and ignores invalid JSON without throwing', () => {
    const reasons: string[] = []
    expect(parseChannelDefaults('{not json', reason => reasons.push(reason))).toEqual({})
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('invalid JSON')
  })

  test('reports and ignores a non-object top level', () => {
    const reasons: string[] = []
    expect(parseChannelDefaults('["C0ENG"]', reason => reasons.push(reason))).toEqual({})
    expect(reasons[0]).toContain('object')
  })
})

describe('channelIdFromThreadId', () => {
  test('extracts the channel segment from a slack thread key', () => {
    expect(channelIdFromThreadId('slack:C0ENG:1700000000.0001')).toBe('C0ENG')
    expect(channelIdFromThreadId('slack:T0TEAM:C0ENG:1700000000.0001')).toBe('C0ENG')
    expect(channelIdFromThreadId('slack:D0DM')).toBe('D0DM')
    expect(channelIdFromThreadId('slack:G0GROUP:ts')).toBe('G0GROUP')
  })

  test('returns undefined when no conversation segment is present', () => {
    expect(channelIdFromThreadId('web:t1')).toBeUndefined()
    expect(channelIdFromThreadId('slack')).toBeUndefined()
  })
})

describe('resolveChannelDefault', () => {
  const defaults = { C0ENG: { model: 'claude-opus-4-8', reasoning: 'high' } }

  test('returns the default for a matching channel', () => {
    expect(resolveChannelDefault(defaults, 'slack:C0ENG:1700000000.0001')).toEqual({
      model: 'claude-opus-4-8',
      reasoning: 'high'
    })
  })

  test('returns undefined for an unmapped channel or missing config', () => {
    expect(resolveChannelDefault(defaults, 'slack:C0OTHER:ts')).toBeUndefined()
    expect(resolveChannelDefault(undefined, 'slack:C0ENG:ts')).toBeUndefined()
    expect(resolveChannelDefault(defaults, 'web:t1')).toBeUndefined()
  })
})
