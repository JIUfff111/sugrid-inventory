import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDefaultInventoryTablePreferences,
  getInventoryTableFrozenOffsets,
  legacyInventoryTablePreferenceStorageKey,
  INVENTORY_TABLE_COLUMN_DEFINITIONS,
  inventoryTablePreferenceStorageKey,
  migrateLegacyInventoryTablePreferences,
  normalizeInventoryTablePreferences,
  setInventoryTableColumnVisibility,
} from '../src/lib/inventory-table-preferences.ts';

test('defaults show the main inventory columns with neutral density and independent settings', () => {
  const defaults = createDefaultInventoryTablePreferences();
  assert.equal(defaults.density, 'normal');
  assert.equal(defaults.columns.length, INVENTORY_TABLE_COLUMN_DEFINITIONS.length);
  assert.equal(defaults.columns.filter((column) => column.visible).length, 8);
  assert.equal(defaults.columns.find((column) => column.key === 'source').visible, false);
  assert.equal(defaults.columns.find((column) => column.key === 'supplier').visible, false);
  assert.equal(defaults.columns.find((column) => column.key === 'purchaseNo').visible, false);
  assert.equal(defaults.columns.find((column) => column.key === 'warehouse').visible, true);
  assert.ok(defaults.columns.every((column) => column.freeze === 'none'));
  defaults.columns[0].width = 400;
  assert.notEqual(createDefaultInventoryTablePreferences().columns[0].width, 400);
});

test('normalization drops unknown and repeated keys, clamps widths, and caps frozen columns', () => {
  const defaults = createDefaultInventoryTablePreferences();
  const value = normalizeInventoryTablePreferences({
    density: 'compact',
    columns: [
      { key: 'serial', visible: false, width: 9999, freeze: 'left' },
      { key: 'machine', visible: true, width: 12, freeze: 'left' },
      { key: 'configuration', visible: true, width: 120, freeze: 'right' },
      { key: 'remarks', visible: true, width: 150, freeze: 'left' },
      { key: 'source', visible: true, width: 200, freeze: 'right' },
      { key: 'purchasePrice', visible: true, width: 120, freeze: 'left' },
      { key: 'status', visible: true, width: 160, freeze: 'right' },
      { key: 'machine', visible: false, width: 300, freeze: 'right' },
      { key: 'unknown', visible: true, width: 50, freeze: 'left' },
    ],
  });

  assert.equal(value.density, 'compact');
  assert.deepEqual(value.columns.slice(0, 2).map((column) => column.key), ['serial', 'machine']);
  assert.equal(value.columns[0].width, 600);
  assert.equal(value.columns[1].width, 75);
  assert.equal(value.columns.filter((column) => column.visible && column.freeze !== 'none').length, 4);
  assert.deepEqual(value.columns.slice(0, 6).map((column) => column.freeze), ['left', 'left', 'right', 'left', 'right', 'none']);
  assert.equal(value.columns.length, defaults.columns.length);
});

test('malformed or all-hidden settings recover to a valid visible default', () => {
  assert.equal(normalizeInventoryTablePreferences(null).columns[0].visible, true);
  const hidden = normalizeInventoryTablePreferences({
    columns: createDefaultInventoryTablePreferences().columns.map((column) => ({ ...column, visible: false })),
  });
  assert.equal(hidden.columns.filter((column) => column.visible).length, 1);
});

test('switching to detailed fields hides that group summary and vice versa', () => {
  const defaults = createDefaultInventoryTablePreferences();
  const detailView = setInventoryTableColumnVisibility(defaults, 'brand', true);
  assert.equal(detailView.columns.find((column) => column.key === 'brand').visible, true);
  assert.equal(detailView.columns.find((column) => column.key === 'machine').visible, false);
  const multiDetailView = setInventoryTableColumnVisibility(detailView, 'model', true);
  assert.equal(multiDetailView.columns.find((column) => column.key === 'brand').visible, true);
  assert.equal(multiDetailView.columns.find((column) => column.key === 'model').visible, true);
  const summaryView = setInventoryTableColumnVisibility(multiDetailView, 'machine', true);
  assert.equal(summaryView.columns.find((column) => column.key === 'machine').visible, true);
  assert.equal(summaryView.columns.find((column) => column.key === 'brand').visible, false);
  assert.equal(summaryView.columns.find((column) => column.key === 'model').visible, false);
});

test('frozen offsets include selection and action columns and adapt for viewers', () => {
  const preferences = createDefaultInventoryTablePreferences();
  preferences.columns.find((column) => column.key === 'machine').freeze = 'left';
  preferences.columns.find((column) => column.key === 'configuration').freeze = 'left';
  preferences.columns.find((column) => column.key === 'inbound').freeze = 'right';
  const withSelection = getInventoryTableFrozenOffsets(preferences.columns, { selectionWidth: 44, actionsWidth: 96 });
  const forViewer = getInventoryTableFrozenOffsets(preferences.columns, { selectionWidth: 0, actionsWidth: 96 });
  assert.equal(withSelection.machine.left, 44);
  assert.equal(withSelection.configuration.left, 224);
  assert.equal(withSelection.inbound.right, 96);
  assert.equal(forViewer.machine.left, 0);
  assert.equal(forViewer.configuration.left, 180);
});

test('settings are isolated by account in local storage', () => {
  assert.notEqual(inventoryTablePreferenceStorageKey('admin-1'), inventoryTablePreferenceStorageKey('manager-1'));
  assert.match(inventoryTablePreferenceStorageKey('admin-1'), /^inventory-table-preferences:v2:/);
  assert.match(legacyInventoryTablePreferenceStorageKey('admin-1'), /^inventory-table-preferences:v1:/);
});

test('migration applies the new defaults to untouched legacy settings and preserves custom layouts', () => {
  const legacyDefault = createDefaultInventoryTablePreferences();
  legacyDefault.columns.find((column) => column.key === 'source').visible = true;
  legacyDefault.columns.find((column) => column.key === 'warehouse').visible = false;

  const migratedDefault = migrateLegacyInventoryTablePreferences(legacyDefault);
  assert.equal(migratedDefault.columns.find((column) => column.key === 'source').visible, false);
  assert.equal(migratedDefault.columns.find((column) => column.key === 'warehouse').visible, true);

  const customized = structuredClone(legacyDefault);
  customized.density = 'compact';
  customized.columns.find((column) => column.key === 'brand').visible = true;
  const migratedCustom = migrateLegacyInventoryTablePreferences(customized);
  assert.deepEqual(migratedCustom, normalizeInventoryTablePreferences(customized));
});
