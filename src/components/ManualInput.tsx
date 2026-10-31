/**
 * 手工录入机器组件
 * 不通过 SKU，手动填写所有字段
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Check, Plus, X } from 'lucide-react';
import Toast from '@/components/Toast';
import CustomSelect, { type SelectOption } from '@/components/CustomSelect';
import { useWorkspace, useWorkspaceDirty } from '@/components/WorkspaceContext';
import { formatCPUDisplay, formatGPUDisplay, formatScreenDisplay } from '@/lib/sku-display';

type ManualSKU = {
  id: string;
  productType: string;
  brand: string;
  model: string;
  year: number | null;
};

interface ManualInputProps {
  selectedMachineCount?: number;
  onConfirm: (machine: {
    manualSkuId: string;
    productType: string;
    brand: string;
    model: string;
    year?: number;
    cpu: string;
    ram: string;
    gpu: string;
    storage: string;
    screen: string;
    touchScreen?: boolean;
    sn: string;
    purchasePrice: number;
    remark: string;
  }, mode: 'close' | 'continue') => void;
  onCancel: () => void;
}

export default function ManualInput({ onConfirm, onCancel, selectedMachineCount = 0 }: ManualInputProps) {
  const { active } = useWorkspace();
  const [manualSKUs, setManualSKUs] = useState<ManualSKU[]>([]);
  const [loadingSKUs, setLoadingSKUs] = useState(true);
  const [skuLoadError, setSkuLoadError] = useState('');
  const [formData, setFormData] = useState({
    productType: '笔记本电脑',
    manualSkuId: '',
    brand: '',
    model: '',
    year: undefined as number | undefined,
    cpu: '',
    ram: '',
    gpu: '',
    storage: '',
    screen: '',
    touchScreen: undefined as boolean | undefined,
    sn: '',
    purchasePrice: 0,
    remark: ''
  });
  const [toast, setToast] = useState<{
    message: string;
    type: 'success' | 'warning';
  } | null>(null);
  useWorkspaceDirty(Boolean(formData.brand || formData.model || formData.sn || formData.purchasePrice || formData.remark));

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setLoadingSKUs(true);
    setSkuLoadError('');
    fetch(`/api/manual-skus?productType=${encodeURIComponent(formData.productType)}`, {
      cache: 'no-store',
      signal: controller.signal,
    }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error?.message || '加载手工 SKU 失败');
      if (controller.signal.aborted) return;
      setManualSKUs(Array.isArray(payload.data?.items) ? payload.data.items : []);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setSkuLoadError(error instanceof Error ? error.message : '加载手工 SKU 失败');
        setManualSKUs([]);
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoadingSKUs(false);
    });
    return () => controller.abort();
  }, [active, formData.productType]);

  const brands = useMemo(() => [...new Set(manualSKUs.map((sku) => sku.brand))].sort((a, b) => a.localeCompare(b, 'zh-CN')), [manualSKUs]);
  const brandOptions: SelectOption[] = brands.map((brand) => ({ value: brand, label: brand }));
  const modelOptions: SelectOption[] = manualSKUs
    .filter((sku) => sku.brand === formData.brand)
    .map((sku) => ({ value: sku.id, label: sku.year ? `${sku.model} ${sku.year}` : sku.model }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));

  const setProductType = (productType: string) => setFormData((current) => ({
    ...current,
    productType,
    brand: '',
    model: '',
    year: undefined,
    manualSkuId: '',
  }));

  const setBrand = (brand: string) => setFormData((current) => ({
    ...current,
    brand,
    model: '',
    year: undefined,
    manualSkuId: '',
  }));

  const setManualSku = (id: string) => {
    const sku = manualSKUs.find((candidate) => candidate.id === id);
    if (!sku) {
      setFormData((current) => ({ ...current, manualSkuId: '', model: '', year: undefined }));
      return;
    }
    setFormData((current) => ({
      ...current,
      manualSkuId: sku.id,
      brand: sku.brand,
      model: sku.model,
      year: sku.year ?? undefined,
    }));
  };

  const handleSubmit = (e: React.FormEvent | React.MouseEvent, mode: 'close' | 'continue') => {
    e.preventDefault();
    
    // 验证必填字段
    if (!formData.manualSkuId || !formData.brand || !formData.model || !formData.cpu || !formData.ram ||
        !formData.storage || !formData.sn || !formData.purchasePrice) {
      setToast({ message: '请选择手工 SKU 库中的品牌和型号，并填写必填配置', type: 'warning' });
      return;
    }

    onConfirm({
      ...formData,
      cpu: formatCPUDisplay(formData.cpu),
      gpu: formatGPUDisplay(formData.gpu),
      screen: formatScreenDisplay(formData.screen),
    }, mode);

    if (mode === 'continue') {
      setFormData((current) => ({
        ...current,
        sn: '',
        purchasePrice: 0,
        remark: ''
      }));
      setToast({ message: `已选择 ${selectedMachineCount + 1} 台`, type: 'success' });
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
        <div className="w-full max-w-3xl bg-white rounded-2xl shadow-2xl pointer-events-auto animate-scale-in flex flex-col max-h-[85vh]">
          {/* 标题栏 */}
          <div className="px-6 py-4 border-b border-line flex items-center justify-between flex-shrink-0">
            <div>
              <h2 className="text-lg font-semibold text-ink-deep">手工录入机器</h2>
              <p className="text-[13px] text-ink-soft mt-0.5">
                手动填写所有配置信息
              </p>
            </div>
            <button
              onClick={onCancel}
              className="p-2 hover:bg-paper rounded-lg transition-all ripple-hover"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* 表单内容 */}
          <form onSubmit={(event) => handleSubmit(event, 'close')} className="flex-1 overflow-y-auto px-6 py-6">
            <div className="space-y-5">
              {/* 产品类型 */}
              <div>
                <label className="block text-[13px] font-medium text-ink-deep mb-2">
                  产品类型 <span className="text-danger">*</span>
                </label>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => setProductType('笔记本电脑')}
                    className={`px-4 py-2 rounded-lg text-[13px] font-medium transition-all
                              ${formData.productType === '笔记本电脑'
                                ? 'bg-primary text-white'
                                : 'glass hover:bg-white/60'
                              }`}
                  >
                    笔记本电脑
                  </button>
                  <button
                    type="button"
                    onClick={() => setProductType('平板电脑')}
                    className={`px-4 py-2 rounded-lg text-[13px] font-medium transition-all
                              ${formData.productType === '平板电脑'
                                ? 'bg-primary text-white'
                                : 'glass hover:bg-white/60'
                              }`}
                  >
                    平板电脑
                  </button>
                </div>
              </div>

              {/* 品牌和型号仅从独立的手工 SKU 库选择 */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-[13px] font-medium text-ink-deep mb-2">
                    品牌 <span className="text-danger">*</span>
                  </label>
                  <CustomSelect
                    value={formData.brand}
                    onChange={setBrand}
                    options={brandOptions}
                    placeholder={loadingSKUs ? '正在加载手工 SKU…' : '请选择品牌'}
                    searchable
                    required
                    disabled={loadingSKUs || Boolean(skuLoadError) || brandOptions.length === 0}
                    aria-label="选择手工 SKU 品牌"
                  />
                </div>
                <div>
                  <label className="block text-[13px] font-medium text-ink-deep mb-2">
                    型号 <span className="text-danger">*</span>
                  </label>
                  <CustomSelect
                    value={formData.manualSkuId}
                    onChange={setManualSku}
                    options={modelOptions}
                    placeholder={!formData.brand ? '请先选择品牌' : '请选择型号'}
                    searchable
                    required
                    disabled={!formData.brand || loadingSKUs || modelOptions.length === 0}
                    aria-label="选择手工 SKU 型号"
                  />
                </div>
                <p className="sm:col-span-2 -mt-2 text-[11px] text-ink-soft">
                  {skuLoadError ? <span className="text-danger">{skuLoadError}</span> : manualSKUs.length === 0 && !loadingSKUs ? '当前产品类型尚无手工 SKU，请先在手工 SKU 库中建档。' : '型号年份由手工 SKU 档案统一维护。'}{' '}
                  <Link href="/settings/manual-skus" className="font-medium text-primary hover:underline">管理手工 SKU 库</Link>
                </p>
              </div>

              {/* CPU 和内存 */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[13px] font-medium text-ink-deep mb-2">
                    CPU 处理器 <span className="text-danger">*</span>
                  </label>
                  <input
                    type="text"
                    value={formData.cpu}
                    onChange={(e) => setFormData({ ...formData, cpu: e.target.value })}
                    placeholder="如：i5-1240P"
                    className="w-full px-4 py-2.5 bg-white/60 border border-line rounded-lg text-[13px]
                             placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                             focus:ring-primary/20 focus:border-primary transition-all"
                    required
                  />
                </div>
                <div>
                  <label className="block text-[13px] font-medium text-ink-deep mb-2">
                    内存 <span className="text-danger">*</span>
                  </label>
                  <input
                    type="text"
                    value={formData.ram}
                    onChange={(e) => setFormData({ ...formData, ram: e.target.value })}
                    placeholder="如：16GB"
                    className="w-full px-4 py-2.5 bg-white/60 border border-line rounded-lg text-[13px]
                             placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                             focus:ring-primary/20 focus:border-primary transition-all"
                    required
                  />
                </div>
              </div>

              {/* 显卡和硬盘 */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[13px] font-medium text-ink-deep mb-2">
                    显卡
                  </label>
                  <input
                    type="text"
                    value={formData.gpu}
                    onChange={(e) => setFormData({ ...formData, gpu: e.target.value })}
                    placeholder="如：集显 或 MX550 2GB"
                    className="w-full px-4 py-2.5 bg-white/60 border border-line rounded-lg text-[13px]
                             placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                             focus:ring-primary/20 focus:border-primary transition-all"
                  />
                </div>
                <div>
                  <label className="block text-[13px] font-medium text-ink-deep mb-2">
                    硬盘 <span className="text-danger">*</span>
                  </label>
                  <input
                    type="text"
                    value={formData.storage}
                    onChange={(e) => setFormData({ ...formData, storage: e.target.value })}
                    placeholder="如：512GB SSD"
                    className="w-full px-4 py-2.5 bg-white/60 border border-line rounded-lg text-[13px]
                             placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                             focus:ring-primary/20 focus:border-primary transition-all"
                    required
                  />
                </div>
              </div>

              {/* 屏幕 */}
              <div>
                <label className="block text-[13px] font-medium text-ink-deep mb-2">
                  屏幕分辨率
                </label>
                <input
                  type="text"
                  value={formData.screen}
                  onChange={(e) => setFormData({ ...formData, screen: e.target.value })}
                  placeholder="如：1920x1080（选填）"
                  className="w-full px-4 py-2.5 bg-white/60 border border-line rounded-lg text-[13px]
                           placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                           focus:ring-primary/20 focus:border-primary transition-all"
                />
              </div>

              {/* 触屏选项 */}
              <div>
                <label className="block text-[13px] font-medium text-ink-deep mb-2">触屏</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, touchScreen: formData.touchScreen === false ? undefined : false })}
                    className={`px-3 py-2 rounded-lg text-[12px] font-medium transition-all ${formData.touchScreen === false ? 'bg-primary text-white' : 'glass hover:bg-white/60'}`}
                  >
                    非触屏
                  </button>
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, touchScreen: formData.touchScreen === true ? undefined : true })}
                    className={`px-3 py-2 rounded-lg text-[12px] font-medium transition-all ${formData.touchScreen === true ? 'bg-primary text-white' : 'glass hover:bg-white/60'}`}
                  >
                    触屏
                  </button>
                  <span className="self-center text-[11px] text-ink-soft">可不选</span>
                </div>
              </div>

              {/* SN 和价格 */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[13px] font-medium text-ink-deep mb-2">
                    SN 序列号 <span className="text-danger">*</span>
                  </label>
                  <input
                    type="text"
                    value={formData.sn}
                    onChange={(e) => setFormData({ ...formData, sn: e.target.value })}
                    placeholder="请输入 SN"
                    className="w-full px-4 py-2.5 bg-white/60 border border-line rounded-lg text-[13px]
                             placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                             focus:ring-primary/20 focus:border-primary transition-all"
                    required
                  />
                </div>
                <div>
                  <label className="block text-[13px] font-medium text-ink-deep mb-2">
                    采购价格 <span className="text-danger">*</span>
                  </label>
                  <input
                    type="number"
                    value={formData.purchasePrice || ''}
                    onChange={(e) => setFormData({ ...formData, purchasePrice: parseFloat(e.target.value) || 0 })}
                    placeholder="请输入价格"
                    className="w-full px-4 py-2.5 bg-white/60 border border-line rounded-lg text-[13px]
                             placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                             focus:ring-primary/20 focus:border-primary transition-all"
                    required
                  />
                </div>
              </div>

              {/* 备注 */}
              <div>
                <label className="block text-[13px] font-medium text-ink-deep mb-2">
                  备注
                </label>
                <textarea
                  value={formData.remark}
                  onChange={(e) => setFormData({ ...formData, remark: e.target.value })}
                  placeholder="选填"
                  rows={3}
                  className="w-full px-4 py-2.5 bg-white/60 border border-line rounded-lg text-[13px]
                           placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                           focus:ring-primary/20 focus:border-primary transition-all resize-none"
                />
              </div>
            </div>
          </form>

          {/* 底部按钮 */}
          <div className="px-6 py-4 border-t border-line flex items-center justify-end gap-3 flex-shrink-0">
            <span className="mr-auto text-xs text-ink-soft" aria-live="polite">已选择 {selectedMachineCount} 台</span>
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-[13px] font-medium text-ink hover:bg-paper 
                       rounded-lg transition-all ripple-hover"
            >
              取消
            </button>
            <button
              type="button"
              onClick={(event) => handleSubmit(event, 'continue')}
              className="flex items-center gap-1.5 px-5 py-2 border border-primary/30 text-primary text-[13px] font-medium rounded-lg
                       hover:bg-primary/5 transition-all ripple-hover"
            >
              <Plus className="w-4 h-4" />
              添加并继续
            </button>
            <button
              type="button"
              onClick={(event) => handleSubmit(event, 'close')}
              className="px-6 py-2 bg-primary text-white text-[13px] font-medium rounded-lg
                       hover:bg-primary-hover transition-all ripple-hover shadow-sm hover:shadow-md"
            >
              <span className="inline-flex items-center gap-1.5">
                <Check className="w-4 h-4" />
              确认添加
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* Toast 提示 */}
      <Toast
        isOpen={toast !== null}
        type={toast?.type ?? 'info'}
        message={toast?.message ?? ''}
        onClose={() => setToast(null)}
      />
    </>
  );
}

