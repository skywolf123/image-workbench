import type { ToolMode } from './types'

interface ToolPanelProps {
  toolMode: ToolMode
  canDeleteActiveObject: boolean
  isMobileDevice: boolean
  hasActiveObject: boolean
  fileInputRef: React.RefObject<HTMLInputElement | null>
  onSelectTool: (mode: ToolMode) => void
  onDelete: () => void
  onFlipX: () => void
  onFlipY: () => void
  onAddMaskRegion: () => void
  onAddText: () => void
  onFileSelect: (event: React.ChangeEvent<HTMLInputElement>) => void
  onShowClipboardHint: () => void
}

export function ToolPanel({
  toolMode,
  canDeleteActiveObject,
  isMobileDevice,
  hasActiveObject,
  fileInputRef,
  onSelectTool,
  onDelete,
  onFlipX,
  onFlipY,
  onAddMaskRegion,
  onAddText,
  onFileSelect,
  onShowClipboardHint,
}: ToolPanelProps) {
  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.03] p-3 md:rounded-2xl md:p-4">
      <div className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-white/45 md:mb-3">工具</div>
      <div className="grid grid-cols-2 gap-2">
        <div className={canDeleteActiveObject && isMobileDevice ? 'grid grid-cols-2 gap-2' : ''}>
          <button
          onClick={() => onSelectTool('select')}
            className={`w-full rounded-lg px-3 py-2 text-sm transition md:rounded-xl ${toolMode === 'select' ? 'bg-blue-500 text-white' : 'bg-white/8 text-white hover:bg-white/12'}`}
          >
            选择
          </button>
          {canDeleteActiveObject && isMobileDevice && (
            <button
              onClick={onDelete}
              className="w-full rounded-lg bg-red-500/90 px-3 py-2 text-sm text-white transition hover:bg-red-500"
            >
              删除
            </button>
          )}
        </div>
        <button
          onClick={() => onSelectTool('mask-brush')}
          className={`rounded-lg px-3 py-2 text-sm transition md:rounded-xl ${toolMode === 'mask-brush' ? 'bg-blue-500 text-white' : 'bg-white/8 text-white hover:bg-white/12'}`}
        >
          涂抹
        </button>
        <button
          onClick={onFlipX}
          disabled={!hasActiveObject}
          className="rounded-lg bg-white/8 px-3 py-2 text-sm text-white transition hover:bg-white/12 disabled:cursor-not-allowed disabled:opacity-40 md:rounded-xl"
        >
          水平翻转
        </button>
        <button
          onClick={onFlipY}
          disabled={!hasActiveObject}
          className="rounded-lg bg-white/8 px-3 py-2 text-sm text-white transition hover:bg-white/12 disabled:cursor-not-allowed disabled:opacity-40 md:rounded-xl"
        >
          垂直翻转
        </button>
        <button
          onClick={onAddMaskRegion}
          className="rounded-lg bg-white/8 px-3 py-2 text-sm text-white transition hover:bg-white/12 md:rounded-xl"
        >
          区域填色
        </button>
        <button
          onClick={onAddText}
          className="rounded-lg bg-white/8 px-3 py-2 text-sm text-white transition hover:bg-white/12 md:rounded-xl"
        >
          添加文字
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="rounded-lg bg-white/8 px-3 py-2 text-sm text-white transition hover:bg-white/12 md:rounded-xl"
        >
          从文件贴图
        </button>
        <button
          onClick={onShowClipboardHint}
          className="rounded-lg bg-white/8 px-3 py-2 text-sm text-white transition hover:bg-white/12 md:rounded-xl"
        >
          从剪贴板贴图
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => void onFileSelect(event)}
      />
    </section>
  )
}
