/**
 * SKU 选择器组件
 * 用于采购录入时快速选择机器配置
 */
'use client';

import { useState, useEffect, type Dispatch, type SetStateAction } from 'react';
import Link from 'next/link';
import { ChevronRight, Search, Check, Plus, TrendingUp, X, Settings2 } from 'lucide-react';
import CustomSelect, { type SelectOption } from '@/components/CustomSelect';
import { useWorkspaceDirty } from '@/components/WorkspaceContext';
import { formatCPUDisplay, formatGPUDisplay, formatScreenDisplay, getSKUProductType, requiresComputerSpecs, SKU_PRODUCT_TYPES, uniqueCPUOptions, uniqueGPUOptions, uniqueScreenOptions } from '@/lib/sku-display';
import { canonicalSKUBrand } from '@/lib/sku-brand';
import { formatProductName } from '@/lib/product-name';
import { COMMON_RAM_OPTIONS, COMMON_STORAGE_OPTIONS } from '@/lib/hardware-options';

const STORAGE_OPTIONS = ['256GB', '512GB', '1TB', '1.5TB', '2TB'] as const;

export interface SKU {
  id: string;
  catalogSource?: 'builtin' | 'manual';
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
  catalogSource?: 'builtin' | 'manual';
  startInCustomMode?: boolean;
  onSelect: (config: SelectedConfig, mode: 'close' | 'continue') => void;
  onBatchSelect: (config: SelectedConfig) => void; // 新增：批量录入回调
  onCancel: () => void;
  selectedMachineCount: number;
}

type Step = 'productType' | 'brand' | 'model' | 'customIdentity' | 'config' | 'singleInput';

type SpecValueState = { presetValue: string; customValue: string; source: 'preset' | 'custom' };
type SpecValueSetter = Dispatch<SetStateAction<SpecValueState>>;

const emptySpecValue = (hasPresets = false): SpecValueState => ({ presetValue: '', customValue: '', source: hasPresets ? 'preset' : 'custom' });
const activeSpecValue = (state: SpecValueState) => state.source === 'custom' ? state.customValue : state.presetValue;

function SpecChoiceField({
  label,
  options,
  value,
  setValue,
  listId,
  placeholder,
  ariaLabel,
  required = false,
  optional = false,
  formatOption = item => item,
}: {
  label: string;
  options: string[];
  value: SpecValueState;
  setValue: SpecValueSetter;
  listId: string;
  placeholder: string;
  ariaLabel: string;
  required?: boolean;
  optional?: boolean;
  formatOption?: (item: string) => string;
}) {
  const activeValue = activeSpecValue(value);
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <label className="text-[12px] font-medium text-ink-deep">
          {label} {required && <span className="text-danger">*</span>}{optional && <span className="font-normal text-ink-soft">选填</span>}
        </label>
        <span className="text-[11px] text-ink-soft">当前：{value.source === 'custom' ? '自定义输入' : '预设选项'}</span>
      </div>
      {options.length > 0 && (
        <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {options.map(option => {
            const formatted = formatOption(option);
            const selected = value.source === 'preset' && formatOption(value.presetValue) === formatted;
            return (
              <button
                key={option}
                type="button"
                aria-pressed={selected}
                onClick={() => setValue(current => ({
                  ...current,
                  presetValue: selected ? '' : formatted,
                  source: 'preset',
                }))}
                className={`min-w-0 break-words rounded-lg border px-3 py-2 text-left text-[12px] font-medium transition-all active:scale-[0.99] ${selected ? 'border-primary bg-primary text-white shadow-sm' : 'border-line bg-white hover:border-primary/30 hover:bg-primary/5'}`}
              >
                {selected && <Check className="mr-1 inline h-3.5 w-3.5" />}{formatted}
              </button>
            );
          })}
        </div>
      )}
      <input
        type="text"
        list={options.length ? listId : undefined}
        value={value.customValue}
        onChange={event => setValue(current => ({ ...current, customValue: event.target.value, source: 'custom' }))}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="field"
      />
      {options.length > 0 && <datalist id={listId}>{options.map(option => <option key={option} value={formatOption(option)} />)}</datalist>}
      {value.source === 'preset' && value.customValue && (
        <button type="button" className="mt-1.5 text-[11px] font-medium text-primary hover:underline" onClick={() => setValue(current => ({ ...current, source: 'custom' }))}>
          使用已填写的自定义值
        </button>
      )}
      {value.source === 'custom' && value.presetValue && (
        <button type="button" className="mt-1.5 text-[11px] font-medium text-primary hover:underline" onClick={() => setValue(current => ({ ...current, source: 'preset' }))}>
          使用上次选择的预设值
        </button>
      )}
      <span className="sr-only" aria-live="polite">{activeValue}</span>
    </div>
  );
}

function sameSKUIdentity(left: SKU, right: SKU) {
  return getSKUProductType(left.productType) === getSKUProductType(right.productType) &&
    canonicalSKUBrand(left.brand).toLocaleLowerCase() === canonicalSKUBrand(right.brand).toLocaleLowerCase() &&
    left.model.trim().toLocaleLowerCase() === right.model.trim().toLocaleLowerCase() &&
    getSKUYear(left) === getSKUYear(right);
}

const productTypeOptions: SelectOption[] = SKU_PRODUCT_TYPES.map(value => ({ value, label: value }));

export default function SKUSelector({ catalogSource = 'builtin', startInCustomMode = false, onSelect, onBatchSelect, onCancel, selectedMachineCount }: SKUSelectorProps) {
  const isManualCatalog = catalogSource === 'manual';
  const [step, setStep] = useState<Step>(isManualCatalog && startInCustomMode ? 'customIdentity' : 'productType');
  const [selectedFromHome, setSelectedFromHome] = useState(false);
  const [selectedProductType, setSelectedProductType] = useState('');
  const [selectedBrand, setSelectedBrand] = useState('');
  const [selectedSKU, setSelectedSKU] = useState<SKU | null>(null);
  
  const [skus, setSkus] = useState<SKU[]>([]);
  const [identityCatalog, setIdentityCatalog] = useState<SKU[]>([]);
  const [identityLoading, setIdentityLoading] = useState(false);
  const [identityError, setIdentityError] = useState('');
  const [identityLoadAttempt, setIdentityLoadAttempt] = useState(0);
  const [identitySkuId, setIdentitySkuId] = useState('');
  const [identityBrandMode, setIdentityBrandMode] = useState<'catalog' | 'custom'>('catalog');
  const [customBrand, setCustomBrand] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [customYear, setCustomYear] = useState('');
  const [creatingManualSku, setCreatingManualSku] = useState(false);
  const [frequentModels, setFrequentModels] = useState<Array<{ skuId: string; count: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [search, setSearch] = useState('');
  
  // 配置选项
  const [cpuValue, setCpuValue] = useState<SpecValueState>(() => emptySpecValue());
  const [ramValue, setRamValue] = useState<SpecValueState>(() => emptySpecValue());
  const [gpuValue, setGpuValue] = useState<SpecValueState>(() => emptySpecValue());
  const [storageValue, setStorageValue] = useState<SpecValueState>(() => emptySpecValue(true));
  const [screenValue, setScreenValue] = useState<SpecValueState>(() => emptySpecValue());
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
        const frequentRequest = fetch(`/api/skus/frequent${isManualCatalog ? '?catalog=manual' : ''}`, { signal: controller.signal })
          .then(async (response) => {
            const result = await response.json() as {
              success?: boolean;
              data?: { items?: Array<{ skuId: string; count: number }> };
            };
            return response.ok && result.success && Array.isArray(result.data?.items) ? result.data.items : [];
          })
          .catch(() => [] as Array<{ skuId: string; count: number }>);
        const allSkus: SKU[] = [];
        if (isManualCatalog) {
          const response = await fetch('/api/manual-skus', { signal: controller.signal });
          const result = await response.json() as { success?: boolean; data?: { items?: SKU[] }; error?: { message?: string } };
          if (!response.ok || !result.success || !Array.isArray(result.data?.items)) throw new Error(result.error?.message || '加载手工 SKU 失败，请重试');
          allSkus.push(...result.data.items.map((sku) => ({ ...sku, catalogSource: 'manual' as const })));
        } else {
          let page = 1;
          while (true) {
            const response = await fetch(`/api/skus?page=${page}&pageSize=100`, { signal: controller.signal });
            const result = await response.json() as { success?: boolean; data?: { items?: SKU[]; totalPages?: number }; error?: { message?: string } };
            if (!response.ok || !result.success || !Array.isArray(result.data?.items)) throw new Error(result.error?.message || '加载 SKU 失败，请重试');
            const totalPages = result.data.totalPages;
            if (!Number.isInteger(totalPages) || totalPages === undefined || totalPages < 0) throw new Error('SKU 列表分页数据无效，请重试');
            allSkus.push(...result.data.items.map((sku) => ({ ...sku, catalogSource: 'builtin' as const })));
            if (page >= totalPages) break;
            page += 1;
          }
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
  }, [isManualCatalog, loadAttempt]);

  useEffect(() => {
    if (!isManualCatalog || step !== 'customIdentity' || identityBrandMode !== 'catalog' || identityCatalog.length > 0) return;
    const controller = new AbortController();
    const loadIdentityCatalog = async () => {
      setIdentityLoading(true);
      setIdentityError('');
      try {
        const allSkus: SKU[] = [];
        let page = 1;
        while (true) {
          const response = await fetch(`/api/skus?page=${page}&pageSize=100`, { signal: controller.signal });
          const result = await response.json() as { success?: boolean; data?: { items?: SKU[]; totalPages?: number }; error?: { message?: string } };
          if (!response.ok || !result.success || !Array.isArray(result.data?.items) || !Number.isInteger(result.data.totalPages)) {
            throw new Error(result.error?.message || '加载品牌和型号选项失败');
          }
          allSkus.push(...result.data.items.map(sku => ({ ...sku, catalogSource: 'builtin' as const })));
          if (page >= (result.data.totalPages || 0)) break;
          page += 1;
        }
        if (!controller.signal.aborted) setIdentityCatalog(allSkus);
      } catch (error) {
        if (!controller.signal.aborted) setIdentityError(error instanceof Error ? error.message : '加载品牌和型号选项失败');
      } finally {
        if (!controller.signal.aborted) setIdentityLoading(false);
      }
    };
    void loadIdentityCatalog();
    return () => controller.abort();
  }, [identityBrandMode, identityCatalog.length, identityLoadAttempt, isManualCatalog, step]);

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

  // 整机可选择“集显”；独立显卡商品只显示自己的显卡规格。
  const isGraphicsCard = selectedSKU?.productType === '显卡';
  const gpuOptions = selectedSKU
    ? uniqueGPUOptions(isGraphicsCard ? selectedSKU.gpuOptions : ['集显', ...selectedSKU.gpuOptions])
    : [];
  const cpuOptions = selectedSKU ? uniqueCPUOptions(selectedSKU.cpuOptions) : [];
  const ramOptions = selectedSKU ? [...new Set([...selectedSKU.ramOptions, ...COMMON_RAM_OPTIONS])] : [];
  const storageOptions = selectedSKU
    ? [...new Set(isManualCatalog ? [...selectedSKU.storageOptions, ...COMMON_STORAGE_OPTIONS] : STORAGE_OPTIONS)]
    : [];
  const screenOptions = selectedSKU ? uniqueScreenOptions(selectedSKU.screenOptions) : [];
  const identityBrands = [...new Set(identityCatalog
    .filter(sku => getSKUProductType(sku.productType) === selectedProductType)
    .map(sku => canonicalSKUBrand(sku.brand)))].sort((left, right) => left.localeCompare(right, 'zh-CN'));
  const identityModels = identityCatalog
    .filter(sku => getSKUProductType(sku.productType) === selectedProductType && canonicalSKUBrand(sku.brand) === selectedBrand)
    .filter((sku, index, all) => all.findIndex(candidate => sameSKUIdentity(candidate, sku)) === index)
    .filter(sku => !skus.some(manualSku => sameSKUIdentity(manualSku, sku)))
    .sort((left, right) => getSKUDisplayName(left).localeCompare(getSKUDisplayName(right), 'zh-CN'));
  const identityModelOptions: SelectOption[] = identityModels.map(sku => ({ value: sku.id, label: getSKUDisplayName(sku) }));

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
    setCpuValue(emptySpecValue(sku.cpuOptions.length > 0));
    setRamValue(emptySpecValue(sku.ramOptions.length > 0));
    setGpuValue(emptySpecValue(uniqueGPUOptions(sku.productType === '显卡' ? sku.gpuOptions : ['集显', ...sku.gpuOptions]).length > 0));
    setStorageValue(emptySpecValue(true));
    setScreenValue(emptySpecValue(uniqueScreenOptions(sku.screenOptions).length > 0));
    setSelectedTouchScreen(null); // 触屏也不默认选择
    setSingleSN('');
    setSinglePrice(0);
    setSkuRemark('');
    setStep('config');
  };

  const beginManualSKUCreation = () => {
    setSelectedBrand('');
    setIdentitySkuId('');
    setIdentityBrandMode('catalog');
    setCustomBrand('');
    setCustomModel('');
    setCustomYear('');
    setSearch('');
    setIdentityError('');
    setStep('customIdentity');
  };

  const createManualSKU = async () => {
    if (!SKU_PRODUCT_TYPES.some(type => type === selectedProductType)) {
      setIdentityError('请选择产品类型');
      return;
    }
    const source = identityCatalog.find(sku => sku.id === identitySkuId);
    const isCustomBrand = identityBrandMode === 'custom';
    if (creatingManualSku || (!isCustomBrand && !source)) return;
    if (!isCustomBrand && getSKUProductType(source!.productType) !== selectedProductType) {
      setIdentityError('型号与产品类型不一致，请重新选择型号');
      return;
    }
    const brand = isCustomBrand ? canonicalSKUBrand(customBrand.trim()) : canonicalSKUBrand(source!.brand);
    const model = isCustomBrand ? customModel.trim().replace(/\s+/g, ' ') : source!.model;
    const sourceYear = source ? getSKUYear(source) : '';
    const year = isCustomBrand ? (customYear.trim() ? Number(customYear) : null) : (sourceYear ? Number(sourceYear) : null);
    if (!brand || !model || brand.length > 80 || model.length > 160 ||
        (year !== null && (!Number.isInteger(year) || year < 1900 || year > 2100))) {
      setIdentityError('请填写有效的品牌、型号和年份');
      return;
    }
    const identity: SKU = source && !isCustomBrand ? source : {
      id: '', productType: selectedProductType, brand, model, year,
      cpuOptions: [], ramOptions: [], gpuOptions: [], storageOptions: [], screenOptions: [],
    };
    setCreatingManualSku(true);
    setIdentityError('');
    try {
      const response = await fetch('/api/manual-skus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productType: getSKUProductType(identity.productType),
          brand,
          model,
          year,
          cpuOptions: identity.cpuOptions,
          ramOptions: identity.ramOptions,
          gpuOptions: identity.gpuOptions,
          storageOptions: identity.storageOptions,
          screenOptions: identity.screenOptions,
        }),
      });
      const result = await response.json() as { success?: boolean; data?: { item?: SKU }; error?: { message?: string } };
      if (!response.ok || !result.success || !result.data?.item) {
        if (response.status === 409) {
          const existing = skus.find(sku => sameSKUIdentity(sku, identity));
          if (existing) {
            handleSelectModel(existing, true);
            return;
          }
        }
        throw new Error(result.error?.message || '新建手工 SKU 失败');
      }
      const created = { ...result.data.item, catalogSource: 'manual' as const };
      if (getSKUProductType(created.productType) !== selectedProductType) {
        throw new Error('创建结果的产品类型不一致，请到手工 SKU 库核对后重试');
      }
      setSkus(current => current.some(sku => sku.id === created.id) ? current : [...current, created]);
      handleSelectModel(created, true);
    } catch (error) {
      setIdentityError(error instanceof Error ? error.message : '新建手工 SKU 失败');
    } finally {
      setCreatingManualSku(false);
    }
  };

  const hasRequiredConfig = () => {
    if (!selectedSKU) return false;
    return Boolean(activeSpecValue(gpuValue).trim() && (!requiresComputerSpecs(selectedSKU.productType) || (
      activeSpecValue(cpuValue).trim() && activeSpecValue(ramValue).trim()
    )));
  };

  // 步骤 4：确认配置 - 单台录入（直接从配置页完成）
  const handleSingleConfirm = (mode: 'close' | 'continue') => {
    if (!selectedSKU || !hasRequiredConfig()) return;

    const normalizedSN = singleSN.trim();
    if (!normalizedSN || !Number.isFinite(singlePrice) || singlePrice <= 0) return;

    onSelect({
      sku: selectedSKU,
      cpu: isGraphicsCard ? '' : formatCPUDisplay(activeSpecValue(cpuValue)),
      ram: isGraphicsCard ? '' : activeSpecValue(ramValue),
      gpu: formatGPUDisplay(activeSpecValue(gpuValue)),
      storage: isGraphicsCard ? '' : activeSpecValue(storageValue),
      screen: isGraphicsCard ? '' : formatScreenDisplay(activeSpecValue(screenValue)),
      touchScreen: isGraphicsCard ? undefined : selectedTouchScreen ?? undefined, // 未选择时传 undefined
      sn: normalizedSN,
      purchasePrice: singlePrice,
      skuRemark: skuRemark.trim() || undefined // 补充信息
    }, mode);

    if (mode === 'continue') {
      setCpuValue(emptySpecValue(cpuOptions.length > 0));
      setRamValue(emptySpecValue(ramOptions.length > 0));
      setGpuValue(emptySpecValue(gpuOptions.length > 0));
      setStorageValue(emptySpecValue(storageOptions.length > 0));
      setScreenValue(emptySpecValue(screenOptions.length > 0));
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
      cpu: isGraphicsCard ? '' : formatCPUDisplay(activeSpecValue(cpuValue)),
      ram: isGraphicsCard ? '' : activeSpecValue(ramValue),
      gpu: formatGPUDisplay(activeSpecValue(gpuValue)),
      storage: isGraphicsCard ? '' : activeSpecValue(storageValue),
      screen: isGraphicsCard ? '' : formatScreenDisplay(activeSpecValue(screenValue)),
      touchScreen: isGraphicsCard ? undefined : selectedTouchScreen ?? undefined, // 未选择时传 undefined
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
    } else if (step === 'customIdentity') {
      setStep('productType');
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
              <h2 className="text-[15px] font-semibold text-ink-deep">{isManualCatalog ? '选择手工 SKU' : '选择机器 SKU'}</h2>
              <div className="flex items-center gap-2 mt-0.5 text-[12px] text-ink-soft">
                {isManualCatalog && <span className="rounded border border-line px-1.5 py-0.5">独立手工目录</span>}
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
                {step === 'customIdentity' && (
                  <>
                    <span>新建自定义 SKU</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                    <span>选择品牌和型号</span>
                  </>
                )}
                {step === 'config' && (
                  <>
                    <span>{selectedProductType}</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                    <span>{selectedSKU ? getSKUDisplayName(selectedSKU) : ''}</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                    <span>{isGraphicsCard ? '填写显卡信息' : '填写机器配置'}</span>
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
                    {isManualCatalog && (
                      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/15 bg-primary/[0.035] px-3 py-2.5">
                        <span className="text-[12px] text-ink-soft">品牌和型号按目录选择，机器配置可自定义。</span>
                        <button type="button" onClick={beginManualSKUCreation} className="btn-ghost inline-flex items-center gap-1.5 !py-1.5 text-primary">
                          <Plus className="h-4 w-4" />新建自定义 SKU
                        </button>
                      </div>
                    )}
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
                          {productTypes.length === 0 && isManualCatalog && <div className="rounded-lg border border-line bg-white/70 px-4 py-8 text-center text-sm text-ink-soft">手工 SKU 库还没有可用型号。<Link href="/settings/manual-skus" className="ml-1 font-medium text-primary hover:underline">去添加型号</Link></div>}
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

                {step === 'customIdentity' && isManualCatalog && (
                  <div className="space-y-4 animate-fade-in">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="text-[12px] text-ink-soft">新档案会保存到独立手工 SKU 库。可选择目录型号，也可自行填写品牌和型号。</p>
                      <Link href="/settings/manual-skus" className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] font-medium text-primary transition hover:bg-primary/8 hover:text-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30">
                        <Settings2 className="h-3.5 w-3.5" />管理手工 SKU 库
                      </Link>
                    </div>
                    <label className="block text-[12px] font-medium text-ink-deep">
                      产品类型 <span className="text-danger">*</span>
                      <span className="mt-1.5 block">
                        <CustomSelect
                          value={selectedProductType}
                          onChange={value => { setSelectedProductType(value); setSelectedBrand(''); setIdentitySkuId(''); setIdentityError(''); }}
                          options={productTypeOptions}
                          placeholder="请选择产品类型"
                          required
                          aria-label="自定义 SKU 产品类型"
                        />
                      </span>
                    </label>
                    <div className="space-y-2">
                      <span className="block text-[12px] font-medium text-ink-deep">品牌 <span className="text-danger">*</span></span>
                      <div className="flex flex-wrap gap-2" aria-label="品牌录入方式">
                        <button type="button" aria-pressed={identityBrandMode === 'catalog'} onClick={() => { setIdentityBrandMode('catalog'); setIdentityError(''); }} className={`rounded-lg border px-3 py-1.5 text-[12px] font-medium transition-all active:scale-[0.98] ${identityBrandMode === 'catalog' ? 'border-primary bg-primary/10 text-primary' : 'border-line bg-white text-ink-soft hover:border-primary/30'}`}>选择目录品牌</button>
                        <button type="button" aria-pressed={identityBrandMode === 'custom'} onClick={() => { setIdentityBrandMode('custom'); setIdentityError(''); }} className={`rounded-lg border px-3 py-1.5 text-[12px] font-medium transition-all active:scale-[0.98] ${identityBrandMode === 'custom' ? 'border-primary bg-primary/10 text-primary' : 'border-line bg-white text-ink-soft hover:border-primary/30'}`}>自定义品牌和型号</button>
                      </div>
                      {identityBrandMode === 'catalog' ? (
                        <CustomSelect
                          value={selectedBrand}
                          onChange={value => { setSelectedBrand(value); setIdentitySkuId(''); }}
                          options={identityBrands.map(value => ({ value, label: value }))}
                          placeholder={identityLoading ? '正在加载品牌…' : '请选择品牌'}
                          searchable
                          disabled={identityLoading || Boolean(identityError)}
                          aria-label="自定义 SKU 品牌"
                        />
                      ) : (
                        <input type="text" value={customBrand} onChange={event => { setCustomBrand(event.target.value); setIdentityError(''); }} maxLength={80} placeholder="输入品牌名称" aria-label="自定义品牌名称" className="field" />
                      )}
                    </div>
                    {identityBrandMode === 'catalog' ? (
                      <div className="space-y-1.5">
                        <span className="block text-[12px] font-medium text-ink-deep">型号 <span className="text-danger">*</span></span>
                        <CustomSelect
                          value={identitySkuId}
                          onChange={setIdentitySkuId}
                          options={identityModelOptions}
                          placeholder={!selectedBrand ? '请先选择品牌' : identityLoading ? '正在加载型号…' : identityModelOptions.length ? '请选择型号' : '该品牌的型号均已加入手工库'}
                          searchable
                          disabled={!selectedBrand || identityLoading || Boolean(identityError) || identityModelOptions.length === 0}
                          aria-label="自定义 SKU 型号"
                        />
                      </div>
                    ) : (
                      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
                        <label className="block text-[12px] font-medium text-ink-deep">型号 <span className="text-danger">*</span><input type="text" value={customModel} onChange={event => { setCustomModel(event.target.value); setIdentityError(''); }} maxLength={160} placeholder="输入型号" aria-label="自定义型号名称" className="field mt-1.5" /></label>
                        <label className="block text-[12px] font-medium text-ink-deep">年份 <span className="font-normal text-ink-soft">选填</span><input type="number" min={1900} max={2100} value={customYear} onChange={event => { setCustomYear(event.target.value); setIdentityError(''); }} placeholder="如 2025" aria-label="新型号年份" className="field mt-1.5" /></label>
                      </div>
                    )}
                    {identityBrandMode === 'catalog' && identityLoading && <p role="status" className="text-[12px] text-ink-soft">正在加载目录型号…</p>}
                    {identityError && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-[12px] text-danger">
                      <span>{identityError}</span>
                      <button type="button" className="btn-ghost !py-1" onClick={() => { setIdentityError(''); setIdentityLoadAttempt(attempt => attempt + 1); }}>重试</button>
                    </div>}
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
                                {sku.productType === '显卡' ? <span>显卡规格: {sku.gpuOptions.length ? `${uniqueGPUOptions(sku.gpuOptions).length} 选项` : '手动填写'}</span> : <><span>CPU: {uniqueCPUOptions(sku.cpuOptions).length} 选项</span>
                                <span>•</span>
                                <span>内存: {sku.ramOptions.length ? `${sku.ramOptions.length} 选项` : '手动填写'}</span>
                                <span>•</span>
                                <span>硬盘: {isManualCatalog ? `${sku.storageOptions.length} 选项` : `${STORAGE_OPTIONS.length} 常用值`}</span></>}
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

                {/* 配置选项 */}
              {step === 'config' && selectedSKU && (
                <div className="space-y-3">
                  {!isGraphicsCard && <>
                    <SpecChoiceField label="CPU 处理器" required options={cpuOptions} value={cpuValue} setValue={setCpuValue} listId="sku-cpu-options" placeholder="自定义输入 CPU，如：I5-10210U" ariaLabel="CPU 处理器，可选择预设或输入自定义值" formatOption={formatCPUDisplay} />
                    <SpecChoiceField label="内存" required options={ramOptions} value={ramValue} setValue={setRamValue} listId="sku-ram-options" placeholder="自定义输入内存，如：24GB" ariaLabel="内存，可选择预设或输入自定义值" />
                  </>}
                  <SpecChoiceField label={isGraphicsCard ? '显卡规格' : '显卡'} required options={gpuOptions} value={gpuValue} setValue={setGpuValue} listId="sku-gpu-options" placeholder="自定义输入显卡，如：RTX 4060" ariaLabel="显卡，可选择预设或输入自定义值" formatOption={formatGPUDisplay} />
                  {!isGraphicsCard && <>
                  <SpecChoiceField label="硬盘" optional options={storageOptions} value={storageValue} setValue={setStorageValue} listId="sku-storage-options" placeholder="自定义输入硬盘，如：2TB SSD；可留空" ariaLabel="硬盘，可选择预设或输入自定义值，选填" />
                  <SpecChoiceField label="屏幕分辨率" options={screenOptions} value={screenValue} setValue={setScreenValue} listId="sku-screen-options" placeholder="自定义输入屏幕规格，如：2.5K 或 1k" ariaLabel="屏幕分辨率，可选择预设或输入自定义值" formatOption={formatScreenDisplay} />

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

                  </>}

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
          
          {step === 'customIdentity' && isManualCatalog && (
            <button
              type="button"
              onClick={() => void createManualSKU()}
              disabled={creatingManualSku || !selectedProductType || (identityBrandMode === 'catalog' ? identityLoading || !identitySkuId : !customBrand.trim() || !customModel.trim())}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-[13px] font-medium text-white transition-all hover:bg-primary-hover active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />{creatingManualSku ? '正在创建…' : '创建并配置'}
            </button>
          )}
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

