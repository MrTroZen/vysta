import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

interface OutcomeGoal {
  id: string;
  name: string;
  matchType: 'exact' | 'starts_with';
  path: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

const emptyForm = { name: '', matchType: 'exact' as const, path: '', enabled: true };

export function OutcomeGoalsSettings({ siteId }: { siteId: string }) {
  const [goals, setGoals] = useState<OutcomeGoal[] | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState<{ name: string; matchType: 'exact' | 'starts_with'; path: string; enabled: boolean }>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const result = await api<{ goals: OutcomeGoal[] }>(`/api/sites/${siteId}/outcome-goals`);
      setGoals(result.goals);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Outcome goals could not be loaded.');
    }
  }, [siteId]);

  useEffect(() => void load(), [load]);

  function beginEdit(goal: OutcomeGoal) {
    setEditing(goal.id);
    setForm({ name: goal.name, matchType: goal.matchType, path: goal.path, enabled: goal.enabled });
    setError('');
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      const path = editing === 'new' ? `/api/sites/${siteId}/outcome-goals` : `/api/sites/${siteId}/outcome-goals/${editing}`;
      await api(path, { method: editing === 'new' ? 'POST' : 'PUT', json: form });
      await load();
      setEditing(null);
      setForm(emptyForm);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That outcome goal could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function toggle(goal: OutcomeGoal) {
    setError('');
    try {
      const result = await api<{ goal: OutcomeGoal }>(`/api/sites/${siteId}/outcome-goals/${goal.id}`, {
        method: 'PUT', json: { enabled: !goal.enabled },
      });
      setGoals((current) => current?.map((item) => item.id === goal.id ? result.goal : item) ?? current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That outcome goal could not be updated.');
    }
  }

  async function remove(goal: OutcomeGoal) {
    if (!window.confirm(`Delete “${goal.name}”? Historical reports will keep its existing results.`)) return;
    setError('');
    try {
      await api(`/api/sites/${siteId}/outcome-goals/${goal.id}`, { method: 'DELETE' });
      setGoals((current) => current?.filter((item) => item.id !== goal.id) ?? current);
      if (editing === goal.id) setEditing(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That outcome goal could not be deleted.');
    }
  }

  return (
    <section className="card p-6" aria-labelledby="outcome-goals-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-xl">
          <h2 id="outcome-goals-title" className="text-lg font-semibold">Confirmed outcomes</h2>
          <p className="mt-1 text-sm text-stone-500">Count meaningful completions when someone reaches a success or confirmation page—no code changes needed.</p>
        </div>
        <button className="btn-dark" onClick={() => { setEditing('new'); setForm(emptyForm); setError(''); }} disabled={editing === 'new'}>
          Add outcome goal
        </button>
      </div>

      {error && <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert"><p>{error}</p>{goals === null && <button className="btn mt-3" onClick={load}>Try again</button>}</div>}

      {editing && (
        <div className="mt-5 rounded-xl border border-stone-200 bg-stone-50 p-4">
          <h3 className="font-medium">{editing === 'new' ? 'New outcome goal' : 'Edit outcome goal'}</h3>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="label" htmlFor="outcome-name">Owner-friendly name</label>
              <input id="outcome-name" className="input" maxLength={64} placeholder="Lead submitted" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="outcome-match">Match pages where</label>
              <select id="outcome-match" className="input" value={form.matchType} onChange={(event) => setForm({ ...form, matchType: event.target.value as 'exact' | 'starts_with' })}>
                <option value="exact">Path is exactly</option>
                <option value="starts_with">Path starts with</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="outcome-path">Page path</label>
              <input id="outcome-path" className="input" maxLength={300} placeholder="/thank-you" value={form.path} onChange={(event) => setForm({ ...form, path: event.target.value })} />
              <p className="mt-1 text-xs text-stone-500">Use only the path. Query strings and page contents are not read.</p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button className="btn-dark" onClick={save} disabled={saving || !form.name.trim() || !form.path.trim()}>{saving ? 'Saving…' : 'Save outcome goal'}</button>
            <button className="btn" onClick={() => setEditing(null)} disabled={saving}>Cancel</button>
          </div>
        </div>
      )}

      <div className="mt-5" aria-live="polite">
        {goals === null && !error && <div className="space-y-3" aria-label="Loading outcome goals">{[1, 2].map((item) => <div key={item} className="h-16 animate-pulse rounded-xl bg-stone-100" />)}</div>}
        {goals?.length === 0 && <div className="rounded-xl bg-stone-50 p-4 text-sm text-stone-600">No confirmed outcomes configured yet. Add a success or confirmation page to get started.</div>}
        {goals && goals.length > 0 && (
          <ul className="divide-y divide-stone-100">
            {goals.map((goal) => (
              <li key={goal.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2"><span className="font-medium">{goal.name}</span><span className={`rounded-full px-2 py-0.5 text-xs ${goal.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-stone-100 text-stone-500'}`}>{goal.enabled ? 'Active' : 'Paused'}</span></div>
                  <p className="mt-1 truncate text-sm text-stone-500"><span className="font-medium text-stone-600">{goal.matchType === 'exact' ? 'Exactly' : 'Starts with'}</span> {goal.path}</p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <button className="btn" onClick={() => toggle(goal)}>{goal.enabled ? 'Pause' : 'Enable'}</button>
                  <button className="btn" onClick={() => beginEdit(goal)}>Edit</button>
                  <button className="btn text-red-600" onClick={() => remove(goal)}>Delete</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="mt-4 text-xs text-stone-500">An outcome is counted once per visit. Contact clicks and form attempts remain separate intent signals.</p>
    </section>
  );
}
