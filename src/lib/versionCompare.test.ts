import { describe, expect, it } from 'vitest'
import { compareVersions } from './versionCompare'

describe('版本比较', () => {
  it('主版本号不同时按数值比较', () => {
    expect(compareVersions('0.7.13-iw01', '0.7.12-iw01')).toBeGreaterThan(0)
    expect(compareVersions('0.7.12-iw01', '0.8.0-iw01')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0)
  })

  it('主版本相同时比较 fork 序号', () => {
    // 这一条是关键：漏掉后缀的话同一上游版本下的新发布会被判成「无更新」。
    expect(compareVersions('0.7.12-iw02', '0.7.12-iw01')).toBeGreaterThan(0)
    expect(compareVersions('0.7.12-iw01', '0.7.12-iw02')).toBeLessThan(0)
    expect(compareVersions('0.7.12-iw01', '0.7.12-iw01')).toBe(0)
  })

  it('后缀里的数字按数值比较，不会出现 iw10 小于 iw2', () => {
    expect(compareVersions('0.7.12-iw10', '0.7.12-iw2')).toBeGreaterThan(0)
    expect(compareVersions('0.7.12-iw2', '0.7.12-iw10')).toBeLessThan(0)
  })

  it('预发布版本低于同主版本的正式版', () => {
    expect(compareVersions('0.7.12-iw01', '0.7.12')).toBeLessThan(0)
    expect(compareVersions('0.7.12', '0.7.12-iw01')).toBeGreaterThan(0)
  })

  it('段数不一致时缺失的段按 0 处理', () => {
    expect(compareVersions('0.7', '0.7.0')).toBe(0)
    expect(compareVersions('0.7.1', '0.7')).toBeGreaterThan(0)
  })

  it('能容忍上游那种不带后缀的版本号', () => {
    expect(compareVersions('0.7.12', '0.7.11')).toBeGreaterThan(0)
    expect(compareVersions('0.7.12', '0.7.12')).toBe(0)
  })
})
