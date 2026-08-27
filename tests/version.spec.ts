import { describe, it, expect } from 'vitest'
import { parseSemver, satisfiesCaret, TESTED_PEER_RANGE } from '../src/version.js'

describe('parseSemver', () => {
  it('parses plain semver', () => {
    expect(parseSemver('0.1.0')).toEqual({ maj: 0, min: 1, pat: 0, pre: [] })
    expect(parseSemver('1.2.3')).toEqual({ maj: 1, min: 2, pat: 3, pre: [] })
  })
  it('parses prerelease', () => {
    expect(parseSemver('0.1.0-rc.6')).toEqual({ maj: 0, min: 1, pat: 0, pre: ['rc', '6'] })
    expect(parseSemver('1.0.0-alpha.1')).toEqual({ maj: 1, min: 0, pat: 0, pre: ['alpha', '1'] })
  })
  it('strips build metadata', () => {
    expect(parseSemver('0.1.0-rc.6+sha.abc')).toEqual({ maj: 0, min: 1, pat: 0, pre: ['rc', '6'] })
  })
  it('returns null on garbage', () => {
    expect(parseSemver('not-a-version')).toBeNull()
    expect(parseSemver('1.0')).toBeNull()
    expect(parseSemver('')).toBeNull()
  })
})

describe('satisfiesCaret', () => {
  const R = TESTED_PEER_RANGE

  it('matches the tested version', () => {
    expect(satisfiesCaret('0.1.0-rc.6', R)).toBe(true)
  })
  it('matches later RCs of the same 0.1.x line', () => {
    expect(satisfiesCaret('0.1.0-rc.7', R)).toBe(true)
    expect(satisfiesCaret('0.1.0-rc.10', R)).toBe(true)
  })
  it('matches the release of the same 0.1.x line', () => {
    expect(satisfiesCaret('0.1.0', R)).toBe(true)
    expect(satisfiesCaret('0.1.1', R)).toBe(true)
  })
  it('does not match earlier RCs of 0.1.x', () => {
    expect(satisfiesCaret('0.1.0-rc.5', R)).toBe(false)
    expect(satisfiesCaret('0.1.0-rc.3', R)).toBe(false)
  })
  it('does not match the 0.0.x train', () => {
    expect(satisfiesCaret('0.0.1-rc.6', R)).toBe(false)
  })
  it('does not match the 0.2.x train', () => {
    expect(satisfiesCaret('0.2.0', R)).toBe(false)
  })
  it('does not match the 1.x train', () => {
    expect(satisfiesCaret('1.0.0', R)).toBe(false)
  })
  it('does not match garbage', () => {
    expect(satisfiesCaret('unknown', R)).toBe(false)
    expect(satisfiesCaret('', R)).toBe(false)
  })
})
