import { calculateImageSize, normalizeImageSize, parseRatio, type SizeTier } from './size'
import type { PromptTemplate } from './promptTemplates'

/**
 * 判断模板是否适合或推荐使用参考图进行主体替换（特别是电商、商品、样机、产品摄影、人像写真等）
 */
export function isTemplateSubjectReplaceable(template: Pick<PromptTemplate, 'title' | 'category' | 'subcategory' | 'description' | 'tags' | 'prompt'>): boolean {
  if (template.category === '商品与电商') return true
  if (
    template.subcategory === '屏幕样机' ||
    template.subcategory === '产品摄影' ||
    template.subcategory === '包装卖点' ||
    template.subcategory === '商品广告' ||
    template.subcategory === '电商详情'
  ) {
    return true
  }
  if (
    template.category === '人物写真' ||
    template.subcategory === '人像写真' ||
    template.subcategory === '时尚写真'
  ) {
    return true
  }

  const text = `${template.title} ${template.description} ${template.tags.join(' ')} ${template.prompt}`
  return /商品|产品|样机|白底图|瓶身|包装|替换主体|模特|香水|护肤品|鞋子|包包|服装/i.test(text)
}

export interface TemplateSizeCandidate {
  raw: string
  ratioLabel: string
  size: string
}

/**
 * 从模板推荐尺寸文本中解析出所有有效的候选尺寸选项（例如 "4:5 / 1:1" 拆分为 4:5 和 1:1 对应的分辨率）
 */
export function parseTemplateSizeCandidates(recommendedSize: string, tier: SizeTier = '1K'): TemplateSizeCandidate[] {
  const trimmed = recommendedSize.trim()
  if (!trimmed || trimmed === 'auto') return []

  const parts = trimmed.split(/[/,，、|]/).map((p) => p.trim()).filter(Boolean)
  const results: TemplateSizeCandidate[] = []
  const seenSizes = new Set<string>()

  for (const part of parts) {
    const match = part.match(/(\d+(?:\.\d+)?)\s*[:：xX×]\s*(\d+(?:\.\d+)?)/)
    if (!match) continue

    const w = Number(match[1])
    const h = Number(match[2])
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) continue

    let size = ''
    let ratioLabel = ''

    if (w >= 256 && h >= 256) {
      size = normalizeImageSize(`${Math.round(w)}x${Math.round(h)}`)
      ratioLabel = size
    } else {
      ratioLabel = `${w}:${h}`
      const calculated = calculateImageSize(tier, ratioLabel)
      if (calculated) {
        size = calculated
      } else {
        const scale = 1024 / Math.max(w, h)
        size = normalizeImageSize(`${Math.round(w * scale)}x${Math.round(h * scale)}`)
      }
    }

    if (size && !seenSizes.has(size)) {
      seenSizes.add(size)
      results.push({
        raw: part,
        ratioLabel,
        size,
      })
    }
  }

  return results
}

/**
 * 解析模板推荐的尺寸或比例为标准分辨率（例如 1024x1024, 768x1024）
 * 优先取首个有效推荐比例
 */
export function resolveTemplateSize(recommendedSize: string, tier: SizeTier = '1K'): string | null {
  const candidates = parseTemplateSizeCandidates(recommendedSize, tier)
  return candidates[0]?.size ?? null
}

/**
 * 组装带有主体参考图引用的提示词
 */
export function composePromptWithImageReference(
  templatePrompt: string,
  imageMention = '@图1',
  options?: { isProduct?: boolean },
): string {
  const trimmed = templatePrompt.trim()
  if (!trimmed) return imageMention

  const placeholderRegex = /\[(商品|主题|主体|产品|物品|模特|人物)\]|【(商品|主题|主体|产品|物品|模特|人物)】/
  if (placeholderRegex.test(trimmed)) {
    return trimmed.replace(placeholderRegex, `${imageMention} 中的主体（保持外形、标签与细节不变）`)
  }

  if (trimmed.includes(imageMention)) {
    return trimmed
  }

  const preserveInstruction = options?.isProduct !== false
    ? `画面主体参考 ${imageMention}，严格保持其原始外形、品牌标识、包装比例与材质细节完整无损，将其自然融入到以下场景与构图中：`
    : `画面主体参考 ${imageMention}，保持其核心特征与比例，将其自然融入到以下场景与构图中：`

  return `${preserveInstruction}\n\n${trimmed}`
}
