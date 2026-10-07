import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const activity = require('../../electron/activityMonitor.cjs')

afterEach(() => activity.cancelUpdateInstall())

describe('desktop update activity guard', () => {
  it('defers installation while POS or print work is active', () => {
    const finish = activity.beginActivity()
    expect(activity.hasActiveOperations()).toBe(true)
    expect(activity.beginUpdateInstall()).toBe(false)
    finish()
    expect(activity.beginUpdateInstall()).toBe(true)
  })

  it('rejects new POS work after installation has been reserved', () => {
    expect(activity.beginUpdateInstall()).toBe(true)
    expect(() => activity.beginActivity()).toThrow(/preparing to install/)
  })
})