export function formatCPUDisplay(option: string | null | undefined): string {
  const value = option?.trim()
    .replace(/\s*\((?:R|TM)\)\s*/gi, ' ')
    .replace(/\s*[（(][^）)]*[）)]/g, '')
    .trim() ?? '';
  if (!value) return '';
  const generationOnly = value.match(/^(?:Intel|英特尔)\s*第\s*(\d+)\s*代\s*(?:Core|酷睿)\s*([im][3579])(.*)$/i);
  if (generationOnly) return `第${generationOnly[1]}代 ${generationOnly[2].toUpperCase()}${generationOnly[3].trim()}`;

  const intel = value.match(/^(?:(?:Intel|英特尔)\s*)?(?:Core|酷睿)\s*([im][3579])[-\s]+([a-z0-9]+)$/i)
    ?? value.match(/^([im][3579])[-\s]+([a-z0-9]+)$/i);
  if (intel) return `${intel[1].toUpperCase()}-${intel[2].toUpperCase()}`;

  const ryzen = value.match(/^(?:AMD\s*)?(?:Ryzen|锐龙)\s*([3579])\s*(?:PRO\s*)?([a-z0-9]+)$/i);
  if (ryzen) return `R${ryzen[1]}-${ryzen[2].toUpperCase()}`;

  const ryzenAI = value.match(/^(?:AMD\s*)?(?:Ryzen|锐龙)\s*AI\s*(?:([35679])\s*)?(H[X]?\s*)?(?:PRO\s*)?([a-z0-9]+)$/i);
  if (ryzenAI) return `${ryzenAI[1] ? `R${ryzenAI[1]}` : 'R'} AI-${(ryzenAI[2] || '').trim().toUpperCase()}${ryzenAI[3].toUpperCase()}`;

  const ryzenH = value.match(/^(?:AMD\s*)?(?:Ryzen|锐龙)\s*([3579])\s*(H[X]?)\s*([a-z0-9]+)$/i);
  if (ryzenH) return `R${ryzenH[1]}-${ryzenH[2].toUpperCase()}${ryzenH[3].toUpperCase()}`;

  return value
    .replace(/^(?:(?:Intel|英特尔)\s*)?(?:Core|酷睿)\s+Ultra\s+/i, 'Ultra ')
    .replace(/^(?:Intel|英特尔)\s*(?:Core|酷睿)\s*/i, '')
    .replace(/^(?:Core|酷睿)\s+/i, '')
    .replace(/^AMD\s+/i, '');
}

export function formatGPUDisplay(option: string | null | undefined): string {
  const value = option?.trim()
    .replace(/\s*\((?:R|TM)\)\s*/gi, ' ')
    .replace(/^\s*(?:独立|外接)显卡\s*/i, '')
    .replace(/^魔方\s*/i, '')
    .replace(/[（）]/g, ' ')
    .trim() ?? '';
  if (!value) return '';
  if (/(?:集显|核显|集成显卡|integrated\s+(?:graphics|gpu)|qualcomm\s+adreno|adreno\s+\d+|mali\s+\w+|intel\s*(?:hd|uhd|iris(?:\s+xe)?)(?:\s+graphics)?|intel\s+graphics|intel\s+arc\s+graphics|(?:amd\s+)?(?:radeon\s+)?(?:r\d(?:\s+hd)?|rx\s+vega(?:\s+\d+)?)\s+graphics|(?:amd\s+)?radeon(?:\(tm\))?\s+graphics|(?:amd\s+)?radeon\s+(?:(?:vega\s*)?\d{1,4}m|vega\s*\d+)(?:\s+graphics)?\b)/i.test(value)) {
    return '集显';
  }

  return value
    .replace(/\s*(?:独立|外接)显卡\s*/gi, ' ')
    .replace(/\s+(?:笔记本电脑|笔记本|Laptop|Notebook|Mobile)\s*GPU\b/gi, '')
    .replace(/\s+(?:显卡|Graphics\s+Card)\b/gi, '')
    .replace(/^(?:NVIDIA\s+)?GeForce\s+/i, '')
    .replace(/^NVIDIA\s+(?=(?:RTX|GTX|MX|Quadro|Tesla|T\d+)\b)/i, '')
    .replace(/^AMD\s+(?=Radeon\b)/i, '')
    .replace(/^AMD\s+Exo\s+Pro\s+Radeon\s+/i, 'Radeon ')
    .replace(/^Radeon\s+(?=(?:RX|R\d)\b)/i, '')
    .replace(/\s+with\s+Max-Q\s+Design\b/gi, ' Max-Q')
    .replace(/\s+Generation\b/gi, '')
    .replace(/\s+(?:Blackwell|Ada)\b/gi, '')
    .replace(/[，,]+$/g, '')
    .replace(/\s*[，,]?\s*(?:with\s+)?\d+(?:\.\d+)?\s*GB(?:\s*(?:GDDR\d+X?|HBM\d?))?(?:\s+(?:Memory|VRAM|显存))?/gi, '')
    .replace(/\s+GPU\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/[（(]\s*[）)]/g, '')
    .trim();
}

export function formatScreenDisplay(option: string | null | undefined): string {
  const value = option?.trim() ?? '';
  if (!value) return '';

  const resolution = value.match(/(\d{3,4})\s*[x×]\s*(\d{3,4})/i);
  if (resolution) {
    const width = Number(resolution[1]);
    const height = Number(resolution[2]);
    if (width >= 3800) return '4K';
    if (width >= 3150) return '3.2K';
    if (width >= 3000) return '3K';
    if (width >= 2800) return '2.8K';
    if (width >= 2500) return '2.5K';
    if (width >= 2100) return '2K';
    if (width >= 1900) return height >= 1200 ? 'FHD+' : 'FHD';
    if (width >= 1280) return 'HD';
    return '规格待核实';
  }

  const namedResolution = value.match(/\b(4K|3\.2K|3K|2\.8K|2\.5K|2K|FHD\+|FHD|WQXGA|WUXGA|QHD\+|QHD|WQHD|UHD|HD)(?![a-z0-9+])/i);
  if (!namedResolution) return '规格待核实';
  const name = namedResolution[1].toUpperCase();
  if (name === 'UHD') return '4K';
  if (['WQXGA', 'QHD+', 'QHD', 'WQHD'].includes(name)) return '2.5K';
  if (name === 'WUXGA' || name === 'FHD+') return 'FHD+';
  return name;
}

export function uniqueScreenOptions(options: string[]): string[] {
  const seen = new Set<string>();
  return options.filter(option => {
    const label = formatScreenDisplay(option);
    if (seen.has(label)) return false;
    seen.add(label);
    return true;
  });
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
