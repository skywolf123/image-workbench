import { buildMaskColor } from './utils'
import type { MaskShapeType } from './types'

interface MaskStylePanelProps {
  maskOpacity: number
  maskWidth: number
  maskHue: number
  maskShapeType: MaskShapeType
  onOpacityChange: (value: number) => void
  onWidthChange: (value: number) => void
  onHueChange: (value: number) => void
  onShapeChange: (shape: MaskShapeType) => void
}

export function MaskStylePanel({
  maskOpacity,
  maskWidth,
  maskHue,
  maskShapeType,
  onOpacityChange,
  onWidthChange,
  onHueChange,
  onShapeChange,
}: MaskStylePanelProps) {
  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.03] p-3 md:rounded-2xl md:p-4">
      <div className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-white/45 md:mb-3">填色样式</div>
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs text-white/55">透明度</span>
          <input
            type="range"
            min={0.05}
            max={1}
            step={0.05}
            value={maskOpacity}
            onChange={(e) => onOpacityChange(Number(e.target.value))}
            className="w-full accent-blue-500"
          />
          <span className="mt-1 block text-xs text-white/45">{Math.round(maskOpacity * 100)}%</span>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-white/55">笔刷大小</span>
          <input
            type="range"
            min={4}
            max={160}
            step={1}
            value={maskWidth}
            onChange={(e) => onWidthChange(Number(e.target.value))}
            className="w-full accent-blue-500"
          />
          <span className="mt-1 block text-xs text-white/45">{maskWidth}px</span>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-white/55">颜色</span>
          <input
            type="range"
            min={0}
            max={360}
            step={1}
            value={maskHue}
            onChange={(e) => onHueChange(Number(e.target.value))}
            className="w-full"
            style={{ accentColor: buildMaskColor(maskHue, 1) }}
          />
          <span
            className="mt-1 block h-6 rounded-lg border border-white/10"
            style={{ background: buildMaskColor(maskHue, maskOpacity) }}
          />
        </label>
        <div>
          <div className="mb-1 text-xs text-white/55">区域形状</div>
          <div className="grid grid-cols-3 gap-2">
            {(['rect', 'ellipse', 'triangle'] as const).map((shapeType) => (
              <button
                key={shapeType}
                onClick={() => onShapeChange(shapeType)}
                className={`rounded-lg px-3 py-2 text-sm transition md:rounded-xl ${maskShapeType === shapeType ? 'bg-blue-500 text-white' : 'bg-white/8 text-white hover:bg-white/12'}`}
              >
                {shapeType === 'rect' ? '矩形' : shapeType === 'ellipse' ? '圆形' : '三角'}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
