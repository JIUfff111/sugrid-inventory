const shared = require('../../scripts/sku-catalog/manual-options.cjs') as {
  fields: readonly ManualSKUOptionField[];
  normalizeManualSKUOptions: (input: Record<string, unknown>) => { value?: ManualSKUOptions; error?: string };
  parseManualSKUOptions: (value: string | null | undefined) => string[];
  mergeManualSKUOptions: (
    db: import('better-sqlite3').Database,
    item: ManualSKUConfiguration,
    actorId: string | null,
    now: string,
  ) => boolean;
};

export const MANUAL_SKU_OPTION_FIELDS = shared.fields;

export type ManualSKUOptionField = 'cpuOptions' | 'ramOptions' | 'gpuOptions' | 'storageOptions' | 'screenOptions';
export type ManualSKUOptions = Record<ManualSKUOptionField, string[]>;
export type ManualSKUConfiguration = {
  manualSkuId: string | null;
  cpu: string;
  ram: string;
  gpu: string | null;
  storage: string;
  screen: string;
};

export function normalizeManualSKUOptions(input: Record<string, unknown>) {
  return shared.normalizeManualSKUOptions(input);
}

export const parseManualSKUOptions = shared.parseManualSKUOptions;

export function mergeManualSKUOptions(db: import('better-sqlite3').Database, item: ManualSKUConfiguration, actorId: string, now: string) {
  return shared.mergeManualSKUOptions(db, item, actorId, now);
}
