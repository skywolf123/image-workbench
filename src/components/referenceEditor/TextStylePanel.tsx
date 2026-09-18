import { clamp, normalizeColorValue } from './utils'
import type { TextStyleState } from './types'

interface TextStylePanelProps {
  textStyle: TextStyleState
  hasTextSelected: boolean
  onStyleChange: (patch: Partial<TextStyleState>) => void
}

export function TextStylePanel({ textStyle, hasTextSelected, onStyleChange }: TextStylePanelProps) {
  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.03] p-3 md:rounded-2xl md:p-4">
      <div className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-white/45 md:mb-3">文字样式</div>
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs text-white/55">文字内容</span>
          <textarea
            value={textStyle.text}
            onChange={(e) => onStyleChange({ text: e.target.value })}
            rows={2}
            className="w-full rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-sm text-white outline-none focus:border-blue-400 md:rounded-xl"
            placeholder="输入要添加到画布的文字"
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-white/55">颜色</span>
            <input
              type="color"
              value={normalizeColorValue(textStyle.fill)}
              onChange={(e) => onStyleChange({ fill: e.target.value })}
              className="h-10 w-full rounded-lg border border-white/10 bg-black/25 p-1 md:rounded-xl"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-white/55">字号</span>
            <input
              type="number"
              min={12}
              max={240}
              value={textStyle.fontSize}
              onChange={(e) => onStyleChange({ fontSize: clamp(Number(e.target.value) || 12, 12, 240) })}
              className="h-10 w-full rounded-lg border border-white/10 bg-black/25 px-3 text-sm text-white outline-none focus:border-blue-400 md:rounded-xl"
            />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onStyleChange({ fontWeight: textStyle.fontWeight === 'bold' ? 'normal' : 'bold' })}
            className={`rounded-lg px-3 py-2 text-sm transition md:rounded-xl ${textStyle.fontWeight === 'bold' ? 'bg-blue-500 text-white' : 'bg-white/8 text-white hover:bg-white/12'}`}
          >
            粗体
          </button>
          <button
            onClick={() => onStyleChange({ fontStyle: textStyle.fontStyle === 'italic' ? 'normal' : 'italic' })}
            className={`rounded-lg px-3 py-2 text-sm transition md:rounded-xl ${textStyle.fontStyle === 'italic' ? 'bg-blue-500 text-white' : 'bg-white/8 text-white hover:bg-white/12'}`}
          >
            斜体
          </button>
        </div>
        {!hasTextSelected && (
          <div className="text-xs text-white/45">当前没有选中文字对象，样式会用于下一个新建文字。</div>
        )}
      </div>
    </section>
  )
}
