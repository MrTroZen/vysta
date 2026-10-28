import type { Insight } from '../lib/insights';

const toneStyle = {
  positive: { label: 'Up', symbol: '↑', className: 'bg-emerald-50 text-emerald-700' },
  negative: { label: 'Down', symbol: '↓', className: 'bg-amber-50 text-amber-800' },
  neutral: { label: 'Notable', symbol: '•', className: 'bg-stone-100 text-stone-600' },
} as const;

export function InsightsPanel({ insights }: { insights: Insight[] | null }) {
  return (
    <section className="card p-5" aria-labelledby="what-changed-title" aria-live="polite">
      <div>
        <h2 id="what-changed-title" className="text-lg font-semibold">What changed</h2>
        <p className="mt-1 text-sm text-stone-500">The most meaningful differences from the previous matching period.</p>
      </div>

      {insights === null ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2" aria-label="Loading performance changes">
          {[1, 2].map((item) => <div key={item} className="h-24 animate-pulse rounded-xl bg-stone-100" />)}
        </div>
      ) : insights.length === 0 ? (
        <div className="mt-4 rounded-xl bg-stone-50 p-4">
          <p className="font-medium text-stone-700">No meaningful change stands out yet</p>
          <p className="mt-1 text-sm text-stone-500">Traffic and actions were steady, or the available volumes are still too small for a useful comparison.</p>
        </div>
      ) : (
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {insights.map((insight) => {
            const tone = toneStyle[insight.tone];
            return (
              <li key={insight.id} className="rounded-xl border border-stone-100 bg-stone-50 p-4">
                <div className="flex items-start gap-3">
                  <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs font-medium ${tone.className}`}>
                    <span aria-hidden="true">{tone.symbol}</span>{tone.label}
                  </span>
                  <div className="min-w-0">
                    <h3 className="font-semibold text-stone-800">{insight.title}</h3>
                    <p className="mt-1 text-sm leading-6 text-stone-600">{insight.detail}</p>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
