type AssetConfiguration = { ram?: unknown; storage?: unknown };
type AssetChangeSnapshot = { before?: AssetConfiguration; after?: AssetConfiguration };

export function assetChangeLines(snapshot: unknown): string[] {
  let change: AssetChangeSnapshot;
  try {
    change = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot as AssetChangeSnapshot;
  } catch {
    return [];
  }
  if (!change || typeof change !== 'object' || !change.before || !change.after) return [];

  return ([['ram', '内存'], ['storage', '硬盘']] as const).flatMap(([field, label]) => {
    const before = change.before?.[field];
    const after = change.after?.[field];
    return typeof before === 'string' && typeof after === 'string' && before !== after
      ? [`${label}：${before} → ${after}`]
      : [];
  });
}
