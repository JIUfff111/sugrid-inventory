'use client';
import { useEffect, useState } from 'react';
import { useWorkspace } from '@/components/WorkspaceContext';

type Selection = { id: string; sn: string };
/** Revalidate preserved selections when activated; never silently discard a draft. */
export function useMachineEligibility(items: Selection[], context: string, extraQuery = '') {
  const { active } = useWorkspace();
  const key = JSON.stringify(items.map(({ id, sn }) => ({ id, sn })));
  const [invalidIds, setInvalidIds] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!active) return;
    const selected: Selection[] = JSON.parse(key);
    if (!selected.length) { setInvalidIds([]); setChecking(false); setError(''); return; }
    const controller = new AbortController();
    setChecking(true); setError('');
    void Promise.all(selected.map(async item => {
      const query = new URLSearchParams(extraQuery);
      query.set('context', context); query.set('q', item.sn); query.set('limit', '100');
      const response = await fetch('/api/inventory/lookup?' + query.toString(), { cache: 'no-store', signal: controller.signal });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || '无法验证所选机器，请刷新后重试');
      return payload.data?.items?.some((row: { id: string }) => row.id === item.id) ? null : item.id;
    })).then(result => { if (!controller.signal.aborted) setInvalidIds(result.filter((id): id is string => id !== null)); })
      .catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '无法验证所选机器'); })
      .finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  }, [active, context, extraQuery, key]);
  return { invalidIds, checking, error };
}

