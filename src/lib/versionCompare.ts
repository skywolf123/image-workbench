/**
 * 比较两个版本号，返回正数表示 a 更新。
 *
 * 本项目的版本号形如 `0.7.12-iw02`：主版本跟上游对齐，后缀是本 fork 的发布序号。
 * 比较时先逐个数字段比大小，全部相等时再比后缀——否则同一主版本下的 iw02 会被
 * 判成与 iw01 相等，用户永远收不到更新提示。
 */
export function compareVersions(a: string, b: string) {
  const split = (value: string) => {
    const [main = '', ...rest] = value.split('-')
    return { parts: main.split('.'), suffix: rest.join('-') }
  }
  const left = split(a)
  const right = split(b)
  const length = Math.max(left.parts.length, right.parts.length)

  for (let i = 0; i < length; i += 1) {
    const diff = (Number.parseInt(left.parts[i] ?? '', 10) || 0) - (Number.parseInt(right.parts[i] ?? '', 10) || 0)
    if (diff !== 0) return diff
  }

  if (!left.suffix || !right.suffix) return left.suffix ? -1 : right.suffix ? 1 : 0

  // 后缀里的数字按数值比（iw2 < iw10），非数字部分按字典序兜底。
  const tokenize = (value: string) => value.match(/\d+|\D+/g) ?? []
  const leftTokens = tokenize(left.suffix)
  const rightTokens = tokenize(right.suffix)
  const tokenLength = Math.max(leftTokens.length, rightTokens.length)

  for (let i = 0; i < tokenLength; i += 1) {
    const a1 = leftTokens[i]
    const b1 = rightTokens[i]
    if (a1 === undefined) return -1
    if (b1 === undefined) return 1
    if (a1 === b1) continue
    const aNum = /^\d+$/.test(a1)
    const bNum = /^\d+$/.test(b1)
    if (aNum && bNum) return Number(a1) - Number(b1)
    if (aNum !== bNum) return aNum ? -1 : 1
    return a1 < b1 ? -1 : 1
  }

  return 0
}
