import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { LEGACY_STORAGE_NAME, STORAGE_NAME } from '../src/lib/storageNamespace'

describe('storage namespace', () => {
  it('uses the project name instead of the upstream one', () => {
    expect(STORAGE_NAME).toBe('image-workbench')
    expect(LEGACY_STORAGE_NAME).toBe('gpt-image-playground')
  })

  it('keeps the service worker cache aligned with the namespace', () => {
    const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf-8')
    expect(sw).toContain(`'${STORAGE_NAME}-v`)
    expect(sw).not.toContain(LEGACY_STORAGE_NAME)
  })

  it('does not leave the upstream database name in the storage layer', () => {
    const db = readFileSync(new URL('../src/lib/db.ts', import.meta.url), 'utf-8')
    expect(db).not.toContain(`'${LEGACY_STORAGE_NAME}'`)
    expect(existsSync(new URL('../src/lib/storageMigration.ts', import.meta.url))).toBe(true)
  })
})
