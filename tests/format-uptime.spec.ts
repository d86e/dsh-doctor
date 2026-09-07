import { describe, it, expect } from 'vitest'
import { formatUptime } from '../src/index.js'

describe('formatUptime', () => {
  it('formats seconds', () => {
    expect(formatUptime(5)).toBe('5s')
    expect(formatUptime(0)).toBe('0s')
  })

  it('formats minutes and seconds (no hours)', () => {
    expect(formatUptime(61)).toBe('1m 1s')
    expect(formatUptime(300)).toBe('5m') // trailing zero second is dropped
    expect(formatUptime(59)).toBe('59s')
  })

  it('formats hours, minutes, seconds', () => {
    expect(formatUptime(3661)).toBe('1h 1m 1s')
    expect(formatUptime(7200)).toBe('2h') // trailing zero min/second dropped
    expect(formatUptime(3600 + 30)).toBe('1h 0m 30s') // interior zero unit is kept
  })

  it('caps at three units (days shown, no seconds)', () => {
    expect(formatUptime(86400 + 3600)).toBe('1d 1h')
    expect(formatUptime(86400 + 3600 + 61)).toBe('1d 1h 1m')
    expect(formatUptime(2 * 86400 + 7200 + 3600 + 61)).toBe('2d 3h 1m')
  })

  it('clamps negatives to zero', () => {
    expect(formatUptime(-5)).toBe('0s')
  })

  it('truncates fractional seconds', () => {
    expect(formatUptime(61.9)).toBe('1m 1s')
    expect(formatUptime(1.5)).toBe('1s')
  })
})
