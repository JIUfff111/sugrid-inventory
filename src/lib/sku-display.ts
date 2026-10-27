export function formatCPUDisplay(option: string): string {
  const value = option.trim();
  const generationOnly = value.match(/^(?:Intel|英特尔)\s*第\s*(\d+)\s*代\s*(?:Core|酷睿)\s*([im][3579])(.*)$/i);
  if (generationOnly) return `第${generationOnly[1]}代 ${generationOnly[2].toUpperCase()}${generationOnly[3].trim()}`;

  const intel = value.match(/^(?:(?:Intel|英特尔)\s*)?(?:Core|酷睿)\s*([im][3579])[-\s]+([a-z0-9]+)$/i)
    ?? value.match(/^([im][3579])[-\s]+([a-z0-9]+)$/i);
  if (intel) return `${intel[1].toUpperCase()}-${intel[2].toUpperCase()}`;

  const ryzen = value.match(/^(?:AMD\s*)?(?:Ryzen|锐龙)\s*([3579])\s*(?:PRO\s*)?([a-z0-9]+)$/i);
  if (ryzen) return `R${ryzen[1]}-${ryzen[2].toUpperCase()}`;

  return value
    .replace(/^(?:Intel|英特尔)\s*(?:Core|酷睿)\s*/i, '')
    .replace(/^AMD\s+/i, '');
}

export function formatGPUDisplay(option: string | null | undefined): string {
  const value = option?.trim() ?? '';
  if (!value) return '';
  if (/^(?:集显|集成显卡)/.test(value)) return '集显';

  return value
    .replace(/^(?:NVIDIA\s+)?GeForce\s+/i, '')
    .replace(/^NVIDIA\s+(?=(?:RTX|GTX|MX|Quadro)\b)/i, '')
    .replace(/^AMD\s+Radeon\s+(?=(?:RX|R\d)\b)/i, '')
    .replace(/,?\s+\d+\s*GB(?:\s+GDDR\d+)?(?:\s+Memory)?$/i, '')
    .trim();
}

export function uniqueCPUOptions(options: string[]): string[] {
  const seen = new Set<string>();
  return options.filter(option => {
    const label = formatCPUDisplay(option);
    if (seen.has(label)) return false;
    seen.add(label);
    return true;
  });
}

export function uniqueGPUOptions(options: string[]): string[] {
  const seen = new Set<string>();
  return options.filter(option => {
    const label = formatGPUDisplay(option);
    if (!label || seen.has(label)) return false;
    seen.add(label);
    return true;
  });
}

export function getSKUProductType(productType: string): string {
  return productType === '游戏本' ? '笔记本电脑' : productType;
}
