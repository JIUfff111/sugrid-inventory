export function splitMachineScanTokens(value: string) {
  return value
    .replace(/^\uFEFF/, '')
    .split(/[,，\t\r\n]+/)
    .map(token => token.trim())
    .filter(Boolean);
}

export function parseMachineSNCsv(source: string) {
  const text = source.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell.length === 0) quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  if (quoted) throw new Error('CSV 文件中有未闭合的引号');
  if (cell.length || row.length) { row.push(cell); rows.push(row); }

  const nonEmpty = rows.filter(values => values.some(value => value.trim()));
  if (!nonEmpty.length) throw new Error('文件中没有 SN 数据');
  const header = nonEmpty[0][0]?.trim().toLocaleLowerCase();
  if (!['sn', '机器sn', 'sn/imei', '序列号'].includes(header)) throw new Error('模板首列应为 SN，建议先下载标准模板再填写');
  const serials = nonEmpty.slice(1).map(values => values[0]?.trim() || '').filter(Boolean);
  if (!serials.length) throw new Error('模板中没有填写 SN');
  if (serials.length > 100) throw new Error('一次最多导入 100 台机器');

  const seen = new Set<string>();
  const unique: string[] = [];
  const duplicates: string[] = [];
  for (const serial of serials) {
    const key = serial.toLocaleLowerCase();
    if (seen.has(key)) duplicates.push(serial);
    else { seen.add(key); unique.push(serial); }
  }
  return { serials: unique, duplicates };
}
