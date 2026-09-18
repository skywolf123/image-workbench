interface HistoryPanelProps {
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
}

export function HistoryPanel({ canUndo, canRedo, onUndo, onRedo }: HistoryPanelProps) {
  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.03] p-3 md:rounded-2xl md:p-4">
      <div className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-white/45 md:mb-3">历史</div>
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => void onUndo()}
          disabled={!canUndo}
          className="rounded-lg bg-white/8 px-3 py-2 text-sm text-white transition hover:bg-white/12 disabled:cursor-not-allowed disabled:opacity-40 md:rounded-xl"
        >
          撤销
        </button>
        <button
          onClick={() => void onRedo()}
          disabled={!canRedo}
          className="rounded-lg bg-white/8 px-3 py-2 text-sm text-white transition hover:bg-white/12 disabled:cursor-not-allowed disabled:opacity-40 md:rounded-xl"
        >
          重做
        </button>
      </div>
    </section>
  )
}
