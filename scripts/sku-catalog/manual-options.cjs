const { formatCPUDisplay, formatGPUDisplay, formatScreenDisplay } = require('./normalize-options.cjs');

const fields = ['cpuOptions', 'ramOptions', 'gpuOptions', 'storageOptions', 'screenOptions'];
const MAX_OPTIONS_PER_FIELD = 1000;
const defaultFormatters = {
  cpuOptions: formatCPUDisplay,
  ramOptions: value => value.replace(/^(\d+(?:\.\d+)?)\s*(GB)$/i, '$1$2').replace(/(gb)$/i, 'GB'),
  gpuOptions: formatGPUDisplay,
  storageOptions: value => value.replace(/(\d+(?:\.\d+)?)\s*(GB|TB)\b/gi, (_, size, unit) => `${size}${unit.toUpperCase()}`).replace(/\bssd\b/gi, 'SSD'),
  screenOptions: formatScreenDisplay,
};

function normalizeManualSKUOptions(input, formatters = defaultFormatters) {
  const result = {};
  for (const field of fields) {
    const raw = input[field] ?? [];
    if (!Array.isArray(raw) || raw.length > MAX_OPTIONS_PER_FIELD || raw.some(value => typeof value !== 'string')) {
      return { error: `${field} 必须是最多 ${MAX_OPTIONS_PER_FIELD} 项的文本列表` };
    }
    const options = [];
    const seen = new Set();
    for (const item of raw) {
      const value = formatters[field](item.trim());
      if (!value) continue;
      if (value.length > 160) return { error: `${field} 单项不能超过 160 个字符` };
      const key = value.toLocaleLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        options.push(value);
      }
    }
    result[field] = options;
  }
  return { value: result };
}

function parseManualSKUOptions(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function mergeManualSKUOptions(db, item, actorId, now, formatters = defaultFormatters) {
  if (!item.manualSkuId) return false;
  const row = db.prepare(`SELECT cpuOptions, ramOptions, gpuOptions, storageOptions, screenOptions, updatedBy
    FROM manual_skus WHERE id = ?`).get(item.manualSkuId);
  if (!row) throw new Error('关联的手工 SKU 不存在');

  const values = {
    cpuOptions: item.cpu,
    ramOptions: item.ram,
    gpuOptions: item.gpu,
    storageOptions: item.storage,
    screenOptions: item.screen,
  };
  const updates = [];
  const params = [];
  for (const field of fields) {
    const options = parseManualSKUOptions(row[field]);
    const value = formatters[field](String(values[field] ?? '').trim());
    if (value.length > 160 && actorId !== null) throw new Error(`${field} 单项不能超过 160 个字符`);
    if (value && value.length <= 160 && !options.some(option => formatters[field](option.trim()).toLocaleLowerCase() === value.toLocaleLowerCase())) {
      if (options.length >= MAX_OPTIONS_PER_FIELD) {
        if (actorId !== null) throw new Error(`${field} 配置选项已满，请先整理手工 SKU`);
        continue;
      }
      options.push(value);
      updates.push(`${field} = ?`);
      params.push(JSON.stringify(options));
    }
  }
  if (updates.length) {
    db.prepare(`UPDATE manual_skus SET ${updates.join(', ')}, updatedBy = ?, updatedAt = ? WHERE id = ?`)
      .run(...params, actorId ?? row.updatedBy, now, item.manualSkuId);
  }
  return updates.length > 0;
}

module.exports = { fields, normalizeManualSKUOptions, parseManualSKUOptions, mergeManualSKUOptions };
