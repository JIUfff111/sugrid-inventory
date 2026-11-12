export const INVENTORY_STATUS_PREFERENCE_KEY = 'inventory-status-pins:v1';
export const MAX_PINNED_INVENTORY_STATUSES = 4;

export interface PinnedStatusDefinition {
  id: string;
  isActive: boolean | number;
}

export function inventoryStatusPreferenceStorageKey(userId: string) {
  return `${INVENTORY_STATUS_PREFERENCE_KEY}:${encodeURIComponent(userId)}`;
}

function activeStatusIds(definitions: PinnedStatusDefinition[]) {
  return new Set(definitions.filter(item => item.isActive === true || item.isActive === 1).map(item => item.id));
}

export function defaultPinnedInventoryStatusIds(definitions: PinnedStatusDefinition[]) {
  return [...activeStatusIds(definitions)].slice(0, MAX_PINNED_INVENTORY_STATUSES);
}

export function normalizePinnedInventoryStatusIds(value: unknown, definitions: PinnedStatusDefinition[]) {
  const validIds = activeStatusIds(definitions);
  if (!Array.isArray(value)) return defaultPinnedInventoryStatusIds(definitions);

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !validIds.has(item) || seen.has(item)) continue;
    seen.add(item);
    normalized.push(item);
    if (normalized.length >= MAX_PINNED_INVENTORY_STATUSES) break;
  }
  return normalized;
}

export function readPinnedInventoryStatusIds(stored: string | null, definitions: PinnedStatusDefinition[]) {
  if (stored === null) return defaultPinnedInventoryStatusIds(definitions);
  try {
    return normalizePinnedInventoryStatusIds(JSON.parse(stored), definitions);
  } catch {
    return defaultPinnedInventoryStatusIds(definitions);
  }
}
