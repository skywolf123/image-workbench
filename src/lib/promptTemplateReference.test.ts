import { describe, expect, it } from 'vitest'
import {
  composePromptWithImageReference,
  isTemplateSubjectReplaceable,
  resolveTemplateSize,
} from './promptTemplateReference'
import { BUILT_IN_PROMPT_TEMPLATES } from './promptTemplates'

describe('promptTemplateReference', () => {
  it('identifies subject replaceable templates correctly', () => {
    expect(
      isTemplateSubjectReplaceable({
        title: '香水大理石台面',
        category: '商品与电商',
        subcategory: '商品广告',
        description: '电商展示',
        tags: ['商业'],
        prompt: '高端香水摄影',
      }),
    ).toBe(true)

    expect(
      isTemplateSubjectReplaceable({
        title: 'MacBook 屏幕样机展示',
        category: 'UI 与界面',
        subcategory: '屏幕样机',
        description: '样机展示',
        tags: ['样机'],
        prompt: '现代极简风格',
      }),
    ).toBe(true)

    expect(
      isTemplateSubjectReplaceable({
        title: '知识图谱总结',
        category: '图表与信息图',
        subcategory: '知识图谱',
        description: '结构化思维导图',
        tags: ['学习'],
        prompt: '绘制一张知识图谱',
      }),
    ).toBe(false)
  })

  it('matches a meaningful subset of built-in templates', () => {
    const matches = BUILT_IN_PROMPT_TEMPLATES.filter(isTemplateSubjectReplaceable)
    expect(matches.length).toBeGreaterThan(150)
  })

  it('resolves recommended template size', () => {
    expect(resolveTemplateSize('1:1')).toBe('1024x1024')
    expect(resolveTemplateSize('3:4')).toBe('768x1024')
    expect(resolveTemplateSize('16:9')).toBe('1280x720')
    expect(resolveTemplateSize('1024x1024')).toBe('1024x1024')
    expect(resolveTemplateSize('auto')).toBeNull()
    expect(resolveTemplateSize('')).toBeNull()
  })

  it('composes prompt with image reference', () => {
    const promptWithPlaceholder = '请为 [商品] 拍摄一张广告大片，背景为海滩日落。'
    const composed1 = composePromptWithImageReference(promptWithPlaceholder, '@图1')
    expect(composed1).toContain('@图1 中的主体')
    expect(composed1).toContain('海滩日落')

    const rawPrompt = '高端护肤品摄影，柔和晨光，大理石台面，水波纹反光。'
    const composed2 = composePromptWithImageReference(rawPrompt, '@图1')
    expect(composed2).toContain('画面主体参考 @图1')
    expect(composed2).toContain(rawPrompt)

    const alreadyHasMention = '根据 @图1 的商品，生成背景'
    expect(composePromptWithImageReference(alreadyHasMention, '@图1')).toBe(alreadyHasMention)
  })
})
