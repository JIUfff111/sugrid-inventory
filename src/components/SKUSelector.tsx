/**
 * SKU 选择器组件
 * 用于采购录入时快速选择机器配置
 */
'use client';

import { useState, useEffect } from 'react';
import { ChevronRight, Search, Check, Plus, TrendingUp, X } from 'lucide-react';
import { useWorkspaceDirty } from '@/components/WorkspaceContext';
import { formatCPUDisplay, formatGPUDisplay, formatScreenDisplay, getSKUProductType, uniqueCPUOptions, uniqueGPUOptions, uniqueScreenOptions } from '@/lib/sku-display';
import { canonicalSKUBrand } from '@/lib/sku-brand';
import { formatProductName } from '@/lib/product-name';

const STORAGE_OPTIONS = ['256GB', '512GB', '1TB', '1.5TB', '2TB'] as const;

export interface SKU {
  id: string;
  productType: string;
  brand: string;
  model: string;
  /** Model release year imported from the model workbooks. */
  modelYear?: string | number | null;
  year?: string | number | null;
  releaseYear?: string | number | null;
  cpuOptions: string[];
  ramOptions: string[];
  gpuOptions: string[];
  storageOptions: string[];
  screenOptions: string[];
  priceMin?: number;
  priceMax?: number;
}

export interface SelectedConfig {
  sku: SKU;
  cpu: string;
  ram: string;
  gpu: string;
  storage: string;
  screen: string;
  touchScreen?: boolean; // 可选：用户可以不选择
  sn?: string;
  purchasePrice?: number;
  skuRemark?: string; // SKU 补充信息
}

function getSKUYear(sku: Pick<SKU, 'model' | 'modelYear' | 'year' | 'releaseYear'>): string {
  const rawYear = sku.modelYear ?? sku.year ?? sku.releaseYear;
  if (rawYear === null || rawYear === undefined) return '';

  const normalized = String(rawYear).trim().replace(/\.0$/, '');
  if (!normalized || normalized === 'null' || normalized === 'undefined' || normalized.includes('不明')) {
    return '';
  }
  return normalized;
}

function getSKUDisplayName(sku: SKU): string {
  return formatProductName({ brand: canonicalSKUBrand(sku.brand), model: sku.model, year: getSKUYear(sku) });
}

function matchesSKUQuery(sku: SKU, value: string): boolean {
  const keyword = value.trim().toLocaleLowerCase();
  if (!keyword) return true;

  const modelKeyword = keyword.replace(/红米/g, 'redmi');

  const values = [
    getSKUDisplayName(sku),
    sku.brand,
    canonicalSKUBrand(sku.brand),
    sku.model,
    getSKUProductType(sku.productType),
    getSKUYear(sku),
    ...sku.cpuOptions,
    ...sku.cpuOptions.map(formatCPUDisplay),
    ...sku.ramOptions,
    ...sku.gpuOptions,
    ...sku.gpuOptions.map(formatGPUDisplay),
    ...sku.storageOptions,
    ...sku.screenOptions,
  ];
  return values.some(item => {
    const normalized = item.toLocaleLowerCase();
    return normalized.includes(keyword) || normalized.includes(modelKeyword);
  });
}

interface SKUSelectorProps {
  onSelect: (config: SelectedConfig, mode: 'close' | 'continue') => void;
  onBatchSelect: (config: SelectedConfig) => void; // 新增：批量录入回调
  onCancel: () => void;
  selectedMachineCount: number;
}

type Step = 'productType' | 'brand' | 'model' | 'config' | 'singleInput';

export default function SKUSelector({ onSelect, onBatchSelect, onCancel, selectedMachineCount }: SKUSelectorProps) {
  const [step, setStep] = useState<Step>('productType');
  const [selectedFromHome, setSelectedFromHome] = useState(false);
  const [selectedProductType, setSelectedProductType] = useState('');
  const [selectedBrand, setSelectedBrand] = useState('');
  const [selectedSKU, setSelectedSKU] = useState<SKU | null>(null);
  
  const [skus, setSkus] = useState<SKU[]>([]);
  const [frequentModels, setFrequentModels] = useState<Array<{ skuId: string; count: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [search, setSearch] = useState('');
  
  // 配置选项
  const [selectedCpu, setSelectedCpu] = useState('');
  const [selectedRam, setSelectedRam] = useState('');
  const [selectedGpu, setSelectedGpu] = useState('');
  const [selectedStorage, setSelectedStorage] = useState('');
  const [selectedScreen, setSelectedScreen] = useState('');
  const [selectedTouchScreen, setSelectedTouchScreen] = useState<boolean | null>(null); // 改为 null，不默认选择
  
  // 单台录入的 SN/IMEI、价格和 SKU 补充信息
  const [singleSN, setSingleSN] = useState('');
  const [singlePrice, setSinglePrice] = useState<number>(0);
  const [skuRemark, setSkuRemark] = useState(''); // SKU 补充信息
  const [hasAddedMachine, setHasAddedMachine] = useState(false);
  useWorkspaceDirty(Boolean(selectedProductType || selectedSKU || singleSN || skuRemark));

  // 加载 SKU 列表
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');

    const loadSkus = async () => {
      try {
        const frequentRequest = fetch('/api/skus/frequent', { signal: controller.signal })
          .then(async (response) => {
            const result = await response.json() as {
              success?: boolean;
              data?: { items?: Array<{ skuId: string; count: number }> };
            };
            return response.ok && result.success && Array.isArray(result.data?.items) ? result.data.items : [];
          })
          .catch(() => [] as Array<{ skuId: string; count: number }>);
        const allSkus: SKU[] = [];
        let page = 1;

        while (true) {
          const response = await fetch(`/api/skus?page=${page}&pageSize=100`, {
            signal: controller.signal,
          });
          const result = await response.json() as {
            success?: boolean;
            data?: { items?: SKU[]; totalPages?: number };
            error?: { message?: string };
          };

          if (!response.ok || !result.success || !Array.isArray(result.data?.items)) {
            throw new Error(result.error?.message || '加载 SKU 失败，请重试');
          }

          const totalPages = result.data.totalPages;
          if (!Number.isInteger(totalPages) || totalPages === undefined || totalPages < 0) {
            throw new Error('SKU 列表分页数据无效，请重试');
          }

          allSkus.push(...result.data.items);
          if (page >= totalPages) break;
          page += 1;
        }

        const frequent = await frequentRequest;
        if (!controller.signal.aborted) {
          setSkus(allSkus);
          setFrequentModels(frequent);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error('加载 SKU 失败:', error);
          setLoadError(error instanceof Error ? error.message : '加载 SKU 失败，请重试');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    void loadSkus();

    return () => {
      controller.abort();
    };
  }, [loadAttempt]);

  const productTypes = Array.from(new Set(skus.map(s => getSKUProductType(s.productType))));

  // 获取品牌列表（根据已选产品类型）
  const brands = Array.from(
    new Set(
      skus
        .filter(s => !selectedProductType || getSKUProductType(s.productType) === selectedProductType)
        .map(s => canonicalSKUBrand(s.brand))
    )
  );
  const frequencyBySkuId = new Map(frequentModels.map(({ skuId, count }) => [skuId, count]));
  const sortByFrequency = (left: SKU, right: SKU) =>
    (frequencyBySkuId.get(right.id) || 0) - (frequencyBySkuId.get(left.id) || 0);

  // 获取型号列表（根据已选品牌）
  const models = skus.filter(
    s =>
      (!selectedProductType || getSKUProductType(s.productType) === selectedProductType) &&
      (!selectedBrand || canonicalSKUBrand(s.brand) === selectedBrand)
  ).sort(sortByFrequency);

  const globalSearchMatches = search.trim()
    ? skus.filter(sku => matchesSKUQuery(sku, search)).sort(sortByFrequency)
    : [];
  const frequentSkus = frequentModels
    .map(({ skuId, count }) => ({ sku: skus.find((item) => item.id === skuId), count }))
    .filter((item): item is { sku: SKU; count: number } => Boolean(item.sku));

  // 每个 SKU 都提供“集显”，并将其固定放在显卡选项首位。
  const gpuOptions = selectedSKU
    ? uniqueGPUOptions(['集显', ...selectedSKU.gpuOptions])
    : [];
  const cpuOptions = selectedSKU ? uniqueCPUOptions(selectedSKU.cpuOptions) : [];

  // 步骤 1：选择产品类型
  const handleSelectProductType = (type: string) => {
    setSelectedProductType(type);
    setSelectedBrand('');
    setSelectedSKU(null);
    setSearch('');
    setStep('brand');
  };

  // 步骤 2：选择品牌
  const handleSelectBrand = (brand: string) => {
    setSelectedBrand(brand);
    setSelectedSKU(null);
    setSearch('');
    setStep('model');
  };

  // 步骤 3：选择型号
  const handleSelectModel = (sku: SKU, fromHome = false) => {
    setSelectedFromHome(fromHome);
    setSelectedProductType(getSKUProductType(sku.productType));
    setSelectedBrand(canonicalSKUBrand(sku.brand));
    setSelectedSKU({ ...sku, brand: canonicalSKUBrand(sku.brand), productType: getSKUProductType(sku.productType) });
    // 不再默认选择，全部清空
    setSelectedCpu('');
    setSelectedRam('');
    setSelectedGpu('');
    setSelectedStorage('');
    setSelectedScreen('');
    setSelectedTouchScreen(null); // 触屏也不默认选择
    setSingleSN('');
    setSinglePrice(0);
    setSkuRemark('');
    setStep('config');
  };

  const hasRequiredConfig = () => {
    if (!selectedSKU) return false;

    return Boolean(
      selectedCpu.trim() &&
      selectedRam.trim() &&
      selectedStorage.trim() &&
      selectedGpu.trim()
    );
  };

  // 步骤 4：确认配置 - 单台录入（直接从配置页完成）
  const handleSingleConfirm = (mode: 'close' | 'continue') => {
    if (!selectedSKU || !hasRequiredConfig()) return;

    const normalizedSN = singleSN.trim();
    if (!normalizedSN || !Number.isFinite(singlePrice) || singlePrice <= 0) return;

    onSelect({
      sku: selectedSKU,
      cpu: formatCPUDisplay(selectedCpu),
      ram: selectedRam,
      gpu: formatGPUDisplay(selectedGpu),
      storage: selectedStorage,
      screen: formatScreenDisplay(selectedScreen),
      touchScreen: selectedTouchScreen ?? undefined, // 未选择时传 undefined
      sn: normalizedSN,
      purchasePrice: singlePrice,
      skuRemark: skuRemark.trim() || undefined // 补充信息
    }, mode);

    if (mode === 'continue') {
      setSelectedCpu('');
      setSelectedRam('');
      setSelectedGpu('');
      setSelectedStorage('');
      setSelectedScreen('');
      setSelectedTouchScreen(null);
      setSingleSN('');
      setSinglePrice(0);
      setSkuRemark('');
      setHasAddedMachine(true);
    }
  };

  // 步骤 4：确认配置 - 批量录入
  const handleBatchConfirm = () => {
    if (!selectedSKU || !hasRequiredConfig()) return;

    onBatchSelect({
      sku: selectedSKU,
      cpu: formatCPUDisplay(selectedCpu),
      ram: selectedRam,
      gpu: formatGPUDisplay(selectedGpu),
      storage: selectedStorage,
      screen: formatScreenDisplay(selectedScreen),
      touchScreen: selectedTouchScreen ?? undefined, // 未选择时传 undefined
      skuRemark: skuRemark.trim() || undefined // 补充信息
    });
  };

  // 返回上一步
  const handleBack = () => {
    if (step === 'brand') {
      setStep('productType');
      setSelectedBrand('');
    } else if (step === 'model') {
      setStep('brand');
      setSelectedSKU(null);
    } else if (step === 'config') {
      setStep(selectedFromHome ? 'productType' : 'model');
    }
  };

  return (
    <>
      {/* 遮罩层 */}
      <div
        className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40 animate-fade-in"
        onClick={onCancel}
      />

      {/* 居中 Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl pointer-events-auto animate-scale-in flex flex-col max-h-[calc(100vh-2rem)]">
          {/* 标题栏 */}
          <div className="px-5 py-3 border-b border-line flex items-center justify-between flex-shrink-0">
            <div>
              <h2 className="text-[15px] font-semibold text-ink-deep">选择机器 SKU</h2>
              <div className="flex items-center gap-2 mt-0.5 text-[12px] text-ink-soft">
                {step === 'productType' && '选择型号'}
                {step === 'brand' && (
                  <>
                    <span>{selectedProductType}</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                    <span>选择品牌</span>
                  </>
                )}
                {step === 'model' && (
                  <>
                    <span>{selectedProductType}</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                    <span>{selectedBrand}</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                    <span>选择型号</span>
                  </>
                )}
                {step === 'config' && (
                  <>
                    <span>{selectedProductType}</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                    <span>{selectedSKU ? getSKUDisplayName(selectedSKU) : ''}</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                    <span>填写机器配置</span>
                  </>
                )}
              </div>
            </div>
            <button
              onClick={onCancel}
              aria-label="关闭 SKU 选择器"
              className="p-2 hover:bg-paper rounded-lg transition-all ripple-hover"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* 内容区域 */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {loading ? (
              <div className="text-center py-12 text-ink-soft text-[13px]">加载中...</div>
            ) : loadError ? (
              <div className="text-center py-12 text-[13px]">
                <p className="text-danger mb-4">{loadError}</p>
                <button
                  onClick={() => setLoadAttempt(attempt => attempt + 1)}
                  className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-hover transition-all"
                >
                  重试
                </button>
              </div>
            ) : (
              <>
                {/* 步骤 1：产品类型 */}
                {step === 'productType' && (
                  <div>
                    {/* 搜索框 */}
                    <div className="sticky top-0 z-10 mb-4 bg-white/95 pb-2 pt-0 backdrop-blur-sm">
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-soft" />
                        <input
                          type="text"
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          placeholder="搜索品牌、型号或年份，例如 Redmi G 2021..."
                          className="w-full pl-10 pr-4 py-2.5 bg-white/60 border border-line rounded-lg text-[13px]
                                   placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                                   focus:ring-primary/20 focus:border-primary transition-all"
                        />
                      </div>
                    </div>
                    
                    {search.trim() ? (
                      <div className="space-y-3 animate-fade-in">
                        <p className="text-[12px] text-ink-soft">找到 {globalSearchMatches.length} 个型号</p>
                        {globalSearchMatches.map(sku => (
                          <button
                            key={sku.id}
                            onClick={() => handleSelectModel(sku, true)}
                            className="w-full glass p-4 rounded-xl text-left hover:bg-white/60 transition-all ripple-hover
                                     border-2 border-transparent hover:border-primary/20 animate-fade-in"
                          >
                            <div className="flex items-center justify-between gap-4">
                              <div>
                                <div className="text-[15px] font-semibold text-ink-deep mb-1">{getSKUDisplayName(sku)}</div>
                                <div className="text-[12px] text-ink-soft">{getSKUProductType(sku.productType)} · {canonicalSKUBrand(sku.brand)}</div>
                              </div>
                              <div className="flex shrink-0 items-center gap-2 text-[11px] text-ink-soft">
                                {frequencyBySkuId.has(sku.id) && <span>录入 {frequencyBySkuId.get(sku.id)} 台</span>}
                                <ChevronRight className="h-5 w-5" />
                              </div>
                            </div>
                          </button>
                        ))}
                        {globalSearchMatches.length === 0 && (
                          <p className="rounded-lg border border-line bg-white/60 px-4 py-6 text-center text-sm text-ink-soft">没有找到匹配型号</p>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-5">
                        {frequentSkus.length > 0 && (
                          <section className="animate-fade-in" aria-label="近三天常用型号">
                            <div className="mb-2 flex items-center justify-between gap-2">
                              <h3 className="flex items-center gap-2 text-[12px] font-semibold text-ink-deep">
                                <TrendingUp className="h-4 w-4 text-primary" />近三天常用型号
                              </h3>
                              <span className="text-[11px] text-ink-soft">{frequentSkus.length} 个型号</span>
                            </div>
                            <div className="max-h-52 overflow-y-auto overscroll-contain rounded-lg border border-line bg-white/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40" role="region" aria-label="近三天常用型号列表" tabIndex={0}>
                              {frequentSkus.map(({ sku, count }, index) => (
                                <button
                                  key={sku.id}
                                  type="button"
                                  onClick={() => handleSelectModel(sku, true)}
                                  className={`group flex w-full min-w-0 items-center gap-3 px-3 py-2.5 text-left transition-all hover:bg-primary/5 active:scale-[0.995] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 ${index > 0 ? 'border-t border-line/70' : ''}`}
                                >
                                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/8 text-[12px] font-semibold text-primary">{index + 1}</span>
                                  <span className="min-w-0 flex-1">
                                    <span className="block break-words text-[13px] font-medium text-ink-deep" title={getSKUDisplayName(sku)}>{getSKUDisplayName(sku)}</span>
                                    <span className="block text-[11px] text-ink-soft">{getSKUProductType(sku.productType)}</span>
                                  </span>
                                  <span className="shrink-0 text-[11px] text-ink-soft">录入 {count} 台</span>
                                  <ChevronRight className="h-4 w-4 shrink-0 text-ink-soft transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                                </button>
                              ))}
                            </div>
                          </section>
                        )}
                        <section aria-label="按品类浏览">
                          {frequentSkus.length > 0 && <h3 className="mb-2 text-[12px] font-semibold text-ink-deep">按品类浏览</h3>}
                          <div className="grid grid-cols-2 gap-3">
                            {productTypes.map(type => (
                              <button
                                key={type}
                                type="button"
                                onClick={() => handleSelectProductType(type)}
                                className="glass rounded-lg border border-line p-4 transition-all hover:border-primary/30 hover:bg-white/80 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                              >
                                <div className="text-center">
                                  <div className="mb-1 text-[15px] font-semibold text-ink-deep">{type}</div>
                                  <div className="text-[12px] text-ink-soft">
                                    {skus.filter(s => getSKUProductType(s.productType) === type).length} 个型号
                                  </div>
                                </div>
                              </button>
                            ))}
                          </div>
                        </section>
                      </div>
                    )}
                  </div>
                )}

                {/* 步骤 2：品牌 */}
                {step === 'brand' && (
                  <div>
                    {/* 搜索框 */}
                    <div className="mb-4">
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-soft" />
                        <input
                          type="text"
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          placeholder="搜索品牌..."
                          className="w-full pl-10 pr-4 py-2.5 bg-white/60 border border-line rounded-lg text-[13px]
                                   placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                                   focus:ring-primary/20 focus:border-primary transition-all"
                        />
                      </div>
                    </div>
                    
                    <div className="grid grid-cols-3 gap-3">
                      {brands
                        .filter(brand => !search || brand.toLowerCase().includes(search.toLowerCase()) || (brand === '小米' && /redmi|红米/i.test(search)))
                        .map(brand => (
                        <button
                          key={brand}
                          onClick={() => handleSelectBrand(brand)}
                          className="glass p-4 rounded-xl hover:bg-white/60 transition-all ripple-hover
                                   border-2 border-transparent hover:border-primary/20"
                        >
                          <div className="text-center">
                            <div className="text-[15px] font-semibold text-ink-deep mb-1">{brand}</div>
                            <div className="text-[13px] text-ink-soft">
                              {skus.filter(s => getSKUProductType(s.productType) === selectedProductType && canonicalSKUBrand(s.brand) === brand).length} 个型号
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* 步骤 3：型号 */}
                {step === 'model' && (
                  <div>
                    {/* 搜索框 */}
                    <div className="sticky top-0 z-10 mb-4 bg-white/95 pb-2 pt-0 backdrop-blur-sm">
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-soft" />
                        <input
                          type="text"
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          placeholder="搜索品牌、型号、年份、CPU、内存或硬盘..."
                          className="w-full pl-10 pr-4 py-2.5 bg-white/60 border border-line rounded-lg text-[13px]
                                   placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                                   focus:ring-primary/20 focus:border-primary transition-all"
                        />
                      </div>
                    </div>
                    
                    <div className="space-y-3">
                      {models
                        .filter(sku => matchesSKUQuery(sku, search))
                        .map(sku => (
                        <button
                          key={sku.id}
                          onClick={() => handleSelectModel(sku)}
                          className="w-full glass p-4 rounded-xl text-left hover:bg-white/60 transition-all ripple-hover
                                   border-2 border-transparent hover:border-primary/20"
                        >
                          <div className="flex items-center justify-between">
                            <div>
                              <div className="text-[15px] font-semibold text-ink-deep mb-2">{getSKUDisplayName(sku)}</div>
                              <div className="flex flex-wrap gap-2 text-[12px] text-ink-soft">
                                <span>CPU: {uniqueCPUOptions(sku.cpuOptions).length} 选项</span>
                                <span>•</span>
                                <span>内存: {sku.ramOptions.length ? `${sku.ramOptions.length} 选项` : '手动填写'}</span>
                                <span>•</span>
                                <span>硬盘: {STORAGE_OPTIONS.length} 选项</span>
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-2 text-[11px] text-ink-soft">
                              {frequencyBySkuId.has(sku.id) && <span>录入 {frequencyBySkuId.get(sku.id)} 台</span>}
                              <ChevronRight className="h-5 w-5" />
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

              {/* 步骤 4：配置选项 */}
              {step === 'config' && selectedSKU && (
                <div className="space-y-3">
                  {/* CPU */}
                  <div>
                    <label className="block text-[12px] font-medium text-ink-deep mb-2">
                      CPU 处理器 <span className="text-danger">*</span>
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      {cpuOptions.map(option => (
                        <button
                          key={option}
                          onClick={() => setSelectedCpu(selectedCpu === option ? '' : option)}
                          className={`px-3 py-2 rounded-lg text-[12px] font-medium transition-all ripple-hover
                                    ${selectedCpu === option
                                      ? 'bg-primary text-white shadow-sm'
                                      : 'glass hover:bg-white/60'
                                    }`}
                        >
                          {selectedCpu === option && <Check className="w-3.5 h-3.5 inline mr-1" />}
                          {formatCPUDisplay(option)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 内存 */}
                  <div>
                    <label className="block text-[12px] font-medium text-ink-deep mb-2">
                      内存 <span className="text-danger">*</span>
                    </label>
                    {selectedSKU.ramOptions.length > 0 ? (
                      <div className="grid grid-cols-3 gap-2">
                        {selectedSKU.ramOptions.map(option => (
                          <button
                            key={option}
                            onClick={() => setSelectedRam(selectedRam === option ? '' : option)}
                            className={`px-3 py-2 rounded-lg text-[12px] font-medium transition-all ripple-hover
                                      ${selectedRam === option
                                        ? 'bg-primary text-white shadow-sm'
                                        : 'glass hover:bg-white/60'
                                      }`}
                          >
                            {selectedRam === option && <Check className="w-3.5 h-3.5 inline mr-1" />}
                            {option}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <input
                        type="text"
                        value={selectedRam}
                        onChange={(event) => setSelectedRam(event.target.value)}
                        placeholder="请输入内存容量，如：16GB"
                        className="w-full px-3 py-2 bg-white/60 border border-line rounded-lg text-[12px]
                                 placeholder:text-ink-soft/50 focus:outline-none focus:ring-2
                                 focus:ring-primary/20 focus:border-primary transition-all"
                      />
                    )}
                  </div>

                  {/* 显卡 */}
                  {(
                    <div>
                      <label className="block text-[12px] font-medium text-ink-deep mb-2">
                        显卡 <span className="text-danger">*</span>
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        {gpuOptions.map(option => (
                          <button
                            key={option}
                            onClick={() => setSelectedGpu(selectedGpu === option ? '' : option)}
                            title={option}
                            className={`px-3 py-2 rounded-lg text-[12px] font-medium transition-all ripple-hover
                                      ${selectedGpu === option
                                        ? 'bg-primary text-white shadow-sm'
                                        : 'glass hover:bg-white/60'
                                      }`}
                          >
                            {selectedGpu === option && <Check className="w-3.5 h-3.5 inline mr-1" />}
                            {formatGPUDisplay(option)}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 硬盘 - 统一选项 */}
                  <div>
                    <label className="block text-[12px] font-medium text-ink-deep mb-2">
                      硬盘 <span className="text-danger">*</span>
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                      {STORAGE_OPTIONS.map(option => (
                        <button
                          key={option}
                          onClick={() => setSelectedStorage(selectedStorage === option ? '' : option)}
                          className={`px-3 py-2 rounded-lg text-[12px] font-medium transition-all ripple-hover
                                    ${selectedStorage === option
                                      ? 'bg-primary text-white shadow-sm'
                                      : 'glass hover:bg-white/60'
                                    }`}
                        >
                          {selectedStorage === option && <Check className="w-3.5 h-3.5 inline mr-1" />}
                          {option}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 屏幕 */}
                  <div>
                    <label className="block text-[12px] font-medium text-ink-deep mb-2">
                      屏幕分辨率
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      {uniqueScreenOptions(selectedSKU.screenOptions).map(option => (
                        <button
                          key={option}
                          onClick={() => setSelectedScreen(selectedScreen === option ? '' : option)}
                          className={`px-3 py-2 rounded-lg text-[12px] font-medium transition-all ripple-hover
                                    ${selectedScreen === option
                                      ? 'bg-primary text-white shadow-sm'
                                      : 'glass hover:bg-white/60'
                                    }`}
                        >
                          {selectedScreen === option && <Check className="w-3.5 h-3.5 inline mr-1" />}
                          {formatScreenDisplay(option)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 触屏选项 - 支持取消选择 */}
                  <div>
                    <label className="block text-[12px] font-medium text-ink-deep mb-2">
                      触屏
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => setSelectedTouchScreen(selectedTouchScreen === false ? null : false)}
                        className={`px-3 py-2 rounded-lg text-[12px] font-medium transition-all ripple-hover
                                  ${selectedTouchScreen === false
                                    ? 'bg-primary text-white shadow-sm'
                                    : 'glass hover:bg-white/60'
                                  }`}
                      >
                        {selectedTouchScreen === false && <Check className="w-3.5 h-3.5 inline mr-1" />}
                        非触屏
                      </button>
                      <button
                        onClick={() => setSelectedTouchScreen(selectedTouchScreen === true ? null : true)}
                        className={`px-3 py-2 rounded-lg text-[12px] font-medium transition-all ripple-hover
                                  ${selectedTouchScreen === true
                                    ? 'bg-primary text-white shadow-sm'
                                    : 'glass hover:bg-white/60'
                                  }`}
                      >
                        {selectedTouchScreen === true && <Check className="w-3.5 h-3.5 inline mr-1" />}
                        触屏
                      </button>
                    </div>
                  </div>

                  {/* SN/IMEI 和金额 */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[12px] font-medium text-ink-deep mb-2">
                        SN/IMEI <span className="text-danger">*</span>
                      </label>
                      <input
                        type="text"
                        value={singleSN}
                        onChange={(e) => setSingleSN(e.target.value)}
                        placeholder="请输入 SN 或 IMEI"
                        className="w-full px-3 py-2 bg-white/60 border border-line rounded-lg text-[12px]
                                 placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                                 focus:ring-primary/20 focus:border-primary transition-all"
                      />
                    </div>
                    <div>
                      <label className="block text-[12px] font-medium text-ink-deep mb-2">
                        采购金额 <span className="text-danger">*</span>
                      </label>
                      <input
                        type="number"
                        value={singlePrice || ''}
                        onChange={(e) => setSinglePrice(parseFloat(e.target.value) || 0)}
                        placeholder="请输入金额"
                        className="w-full px-3 py-2 bg-white/60 border border-line rounded-lg text-[12px]
                                 placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                                 focus:ring-primary/20 focus:border-primary transition-all"
                      />
                    </div>
                  </div>

                  {/* SKU 补充信息 */}
                  <div>
                    <label className="block text-[12px] font-medium text-ink-deep mb-2">
                      SKU 补充信息
                    </label>
                    <input
                      type="text"
                      value={skuRemark}
                      onChange={(e) => setSkuRemark(e.target.value)}
                      placeholder="选填，如：成色、特殊说明等"
                      className="w-full px-3 py-2 bg-white/60 border border-line rounded-lg text-[12px]
                               placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                               focus:ring-primary/20 focus:border-primary transition-all"
                    />
                  </div>

                </div>
              )}
            </>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="px-5 py-3 border-t border-line flex items-center justify-between">
          <button
            onClick={step === 'productType' ? onCancel : handleBack}
            className="px-4 py-2 text-[13px] font-medium text-ink hover:bg-paper 
                     rounded-lg transition-all ripple-hover"
          >
            {step === 'productType' ? '取消' : step === 'config' && selectedFromHome ? '切换型号' : '上一步'}
          </button>
          
          {step === 'config' && selectedSKU && (
            <div className="flex items-center gap-3">
              {hasAddedMachine && (
                <span className="mr-1 whitespace-nowrap text-[11px] font-medium text-success">
                  已选择 {selectedMachineCount} 台
                </span>
              )}
              <button
                onClick={handleBatchConfirm}
                disabled={
                  !hasRequiredConfig()
                }
                className="px-5 py-2 bg-white text-ink-deep border border-line text-[13px] font-medium rounded-lg
                         hover:bg-white/60 transition-all ripple-hover
                         disabled:opacity-50 disabled:cursor-not-allowed"
              >
                批量录入
              </button>
              <button
                onClick={() => handleSingleConfirm('continue')}
                disabled={
                  !hasRequiredConfig() ||
                  !singleSN.trim() ||
                  !Number.isFinite(singlePrice) ||
                  singlePrice <= 0
                }
                className="inline-flex items-center gap-1.5 px-5 py-2 border border-primary/30 text-primary text-[13px] font-medium rounded-lg
                         hover:bg-primary/5 transition-all ripple-hover
                         disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Plus className="h-4 w-4" />
                添加并继续
              </button>
              <button
                onClick={() => handleSingleConfirm('close')}
                disabled={
                  !hasRequiredConfig() ||
                  !singleSN.trim() ||
                  !Number.isFinite(singlePrice) ||
                  singlePrice <= 0
                }
                className="px-5 py-2 bg-primary text-white text-[13px] font-medium rounded-lg
                         hover:bg-primary-hover transition-all ripple-hover shadow-sm hover:shadow-md
                         disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span className="inline-flex items-center gap-1.5"><Check className="h-4 w-4" />确认添加</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
    </>
  );
}
