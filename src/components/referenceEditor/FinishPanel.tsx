interface FinishPanelProps {
  onClose: () => void
  onSave: () => void
  saveLabel: string
}

export function FinishPanel({ onClose, onSave, saveLabel }: FinishPanelProps) {
  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.03] p-3 md:rounded-2xl md:p-4">
      <div className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-white/45 md:mb-3">完成</div>
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={onClose}
          className="rounded-lg bg-white/8 px-3 py-2 text-sm text-white transition hover:bg-white/12 md:rounded-xl"
        >
          放弃修改
        </button>
        <button
          onClick={() => void onSave()}
          className="rounded-lg bg-blue-500 px-3 py-2 text-sm text-white transition hover:bg-blue-600 md:rounded-xl"
        >
          {saveLabel}
        </button>
      </div>
    </section>
  )
}
