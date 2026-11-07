/**
 * 批量录入组件
 * 同型号同配置，表格方式录入多台机器
 */
'use client';

import { useState } from 'react';
import { Plus, Trash2, X, Check, Shuffle } from 'lucide-react';
import Toast from '@/components/Toast';
import { useWorkspaceDirty } from '@/components/WorkspaceContext';
import { formatProductName } from '@/lib/product-name';
import { formatCPUDisplay, formatGPUDisplay, formatScreenDisplay, requiresComputerSpecs, SKU_PRODUCT_TYPES } from '@/lib/sku-display';
import { generateInternalSN } from '@/lib/internal-sn';

interface BatchInputProps {
  presetConfig?: {
    skuId?: string;
    manualSkuId?: string;
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
    skuRemark?: string;
  };
  onConfirm: (machines: Array<{
    skuId?: string;
    manualSkuId?: string;
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
    skuRemark?: string;
    sn: string;
    purchasePrice: number;
    remark: string;
  }>, mode: 'close' | 'continue') => void;
  onCancel: () => void;
  existingSNs: string[];
}

interface BatchRow {
  id: string;
  sn: string;
  purchasePrice: number;
  remark: string;
}

export default function BatchInput({ presetConfig, onConfirm, onCancel, existingSNs }: BatchInputProps) {
  // 通用配置 - 如果有预设配置则使用预设
  const [baseConfig, setBaseConfig] = useState({
    skuId: presetConfig?.skuId,
    manualSkuId: presetConfig?.manualSkuId,
    productType: presetConfig?.productType || '笔记本电脑',
    brand: presetConfig?.brand || '',
    model: presetConfig?.model || '',
    year: presetConfig?.year,
    cpu: presetConfig?.cpu || '',
    ram: presetConfig?.ram || '',
    gpu: presetConfig?.gpu || '',
    storage: presetConfig?.storage || '',
    screen: presetConfig?.screen || '',
    touchScreen: presetConfig?.touchScreen,
    skuRemark: presetConfig?.skuRemark || ''
  });

  // 批量行数据
  const [rows, setRows] = useState<BatchRow[]>([
    { id: '1', sn: '', purchasePrice: 0, remark: '' }
  ]);
  useWorkspaceDirty(Boolean(baseConfig.brand || baseConfig.model || rows.some(row => row.sn || row.purchasePrice || row.remark)));
  
  // Toast 状态
  const [toast, setToast] = useState<{ show: boolean; message: string }>({
    show: false,
    message: ''
  });
  const computerSpecsRequired = requiresComputerSpecs(baseConfig.productType);
  const isGraphicsCard = baseConfig.productType === '显卡';

  // 添加一行
  const handleAddRow = () => {
    setRows([...rows, { id: Date.now().toString(), sn: '', purchasePrice: 0, remark: '' }]);
  };

  // 删除一行
  const handleRemoveRow = (id: string) => {
    if (rows.length === 1) {
      setToast({ show: true, message: '至少保留一行' });
      return;
    }
    setRows(rows.filter(row => row.id !== id));
  };

  // 更新行数据
  const handleUpdateRow = <K extends keyof BatchRow>(id: string, field: K, value: BatchRow[K]) => {
    setRows(rows.map(row => 
      row.id === id ? { ...row, [field]: value } : row
    ));
  };

  const handleGenerateRowSN = (id: string) => {
    if (rows.find(row => row.id === id)?.sn.trim()) return;
    try {
      const sn = generateInternalSN([...existingSNs, ...rows.map(row => row.sn)]);
      handleUpdateRow(id, 'sn', sn);
    } catch (error) {
      setToast({ show: true, message: error instanceof Error ? error.message : '生成内部 SN 失败，请重试' });
    }
  };

  const handleGenerateMissingSNs = () => {
    const reserved = [...existingSNs, ...rows.map(row => row.sn)];
    try {
      const nextRows = rows.map(row => {
        if (row.sn.trim()) return row;
        const sn = generateInternalSN(reserved);
        reserved.push(sn);
        return { ...row, sn };
      });
      setRows(nextRows);
    } catch (error) {
      setToast({ show: true, message: error instanceof Error ? error.message : '生成内部 SN 失败，请重试' });
    }
  };

  // 应用到全部
  const handleApplyToAll = (field: 'purchasePrice' | 'remark') => {
    if (rows.length === 0) return;
    
    const firstRowValue = rows[0][field];
    setRows(rows.map(row => ({
      ...row,
      [field]: firstRowValue
    })));
  };

  // 确认提交；继续录入时仅清空机器明细，保留当前通用配置。
  const handleSubmit = (mode: 'close' | 'continue') => {
    // 验证通用配置
    if (!baseConfig.brand || !baseConfig.model ||
        (computerSpecsRequired && (!baseConfig.cpu || !baseConfig.ram)) ||
        (isGraphicsCard && !baseConfig.gpu.trim())) {
      setToast({ show: true, message: '请填写完整的通用配置' });
      return;
    }

    // 验证每行数据
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row.sn.trim() || !Number.isFinite(row.purchasePrice) || row.purchasePrice < 0 || (!isGraphicsCard && row.purchasePrice === 0)) {
        setToast({ show: true, message: isGraphicsCard ? '请填写所有显卡的 SN；价格可留空或填 0' : '请填写所有机器的 SN 和价格' });
        return;
      }
      const sn = row.sn.trim();
      if (seen.has(sn.toUpperCase())) {
        setToast({ show: true, message: `当前批次 SN [${sn}] 重复，请检查` });
        return;
      }
      seen.add(sn.toUpperCase());
    }

    // 组装数据
    const machines = rows.map(row => ({
      ...baseConfig,
      ...(isGraphicsCard ? { cpu: '', ram: '', storage: '', screen: '', touchScreen: undefined } : {}),
      sn: row.sn.trim(),
      purchasePrice: row.purchasePrice,
      remark: row.remark
    }));

    onConfirm(machines, mode);
    if (mode === 'continue') {
      setRows([{ id: `${Date.now()}-next`, sn: '', purchasePrice: 0, remark: '' }]);
      setToast({ show: true, message: `已添加 ${machines.length} ${isGraphicsCard ? '张显卡' : '台机器'}，可继续录入` });
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
        <div className="w-full max-w-5xl bg-white rounded-2xl shadow-2xl pointer-events-auto animate-scale-in flex flex-col max-h-[90vh]">
          {/* 标题栏 */}
          <div className="px-6 py-4 border-b border-line flex items-center justify-between flex-shrink-0">
            <div>
              <h2 className="text-lg font-semibold text-ink-deep">{isGraphicsCard ? '批量录入显卡' : '批量录入机器'}</h2>
              <p className="text-[13px] text-ink-soft mt-0.5">
                {isGraphicsCard ? '同型号同规格，批量录入多张显卡' : '同型号同配置，批量录入多台机器'}
              </p>
            </div>
            <button
              onClick={onCancel}
              className="p-2 hover:bg-paper rounded-lg transition-all ripple-hover"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* 内容区域 */}
          <div className="flex-1 overflow-y-auto px-6 py-6">
            {/* 通用配置 */}
            {presetConfig ? (
              // 有预设配置：显示配置信息（只读）
              <div className="glass p-5 rounded-xl mb-5 bg-primary/5 border border-primary/20">
                <h3 className="text-[15px] font-semibold text-ink-deep mb-3 flex items-center gap-2">
                  <Check className="w-4 h-4 text-primary" />
                  已选配置
                </h3>
                <div className="grid grid-cols-4 gap-3 text-[13px]">
                  <div>
                    <span className="text-ink-soft">品牌型号：</span>
                    <span className="font-medium text-ink-deep">{formatProductName(presetConfig)}</span>
                  </div>
                  {presetConfig.productType !== '显卡' && <>
                    <div>
                      <span className="text-ink-soft">CPU：</span>
                      <span className="font-medium text-ink-deep">{formatCPUDisplay(presetConfig.cpu)}</span>
                    </div>
                    <div>
                      <span className="text-ink-soft">内存：</span>
                      <span className="font-medium text-ink-deep">{presetConfig.ram}</span>
                    </div>
                    <div>
                      <span className="text-ink-soft">硬盘：</span>
                      <span className="font-medium text-ink-deep">{presetConfig.storage}</span>
                    </div>
                  </>}
                  {presetConfig.gpu && (
                    <div>
                      <span className="text-ink-soft">{isGraphicsCard ? '显卡规格：' : '显卡：'}</span>
                      <span className="font-medium text-ink-deep">{formatGPUDisplay(presetConfig.gpu)}</span>
                    </div>
                  )}
                  {presetConfig.productType !== '显卡' && presetConfig.screen && (
                    <div>
                      <span className="text-ink-soft">屏幕：</span>
                      <span className="font-medium text-ink-deep">{formatScreenDisplay(presetConfig.screen)}</span>
                    </div>
                  )}
                  {presetConfig.productType !== '显卡' && <div>
                    <span className="text-ink-soft">触屏：</span>
                    <span className="font-medium text-ink-deep">{presetConfig.touchScreen === undefined ? '未选择' : presetConfig.touchScreen ? '是' : '否'}</span>
                  </div>}
                </div>
              </div>
            ) : (
              // 无预设配置：显示配置表单
            <div className="glass p-5 rounded-xl mb-5">
              <h3 className="text-[15px] font-semibold text-ink-deep mb-4">通用配置</h3>
              
              <div className="space-y-4">
                {/* 产品类型 */}
                <div>
                  <label className="block text-[13px] font-medium text-ink-deep mb-2">
                    产品类型
                  </label>
                  <div className="flex flex-wrap gap-3">
                    {SKU_PRODUCT_TYPES.map((productType) => (
                      <button
                        key={productType}
                        type="button"
                        onClick={() => setBaseConfig({ ...baseConfig, productType })}
                        className={`px-4 py-2 rounded-lg text-[13px] font-medium transition-all
                                  ${baseConfig.productType === productType ? 'bg-primary text-white' : 'glass hover:bg-white/60'}`}
                      >
                        {productType}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 品牌、型号及适用配置 */}
                <div className={`grid gap-3 ${isGraphicsCard ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-4'}`}>
                  <div>
                    <label className="block text-[12px] font-medium text-ink-deep mb-1.5">
                      品牌 <span className="text-danger">*</span>
                    </label>
                    <input
                      type="text"
                      value={baseConfig.brand}
                      onChange={(e) => setBaseConfig({ ...baseConfig, brand: e.target.value })}
                      placeholder="ThinkPad"
                      className="w-full px-3 py-2 bg-white/60 border border-line rounded-lg text-[13px]
                               placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                               focus:ring-primary/20 focus:border-primary transition-all"
                    />
                  </div>
                  <div>
                    <label className="block text-[12px] font-medium text-ink-deep mb-1.5">
                      型号 <span className="text-danger">*</span>
                    </label>
                    <input
                      type="text"
                      value={baseConfig.model}
                      onChange={(e) => setBaseConfig({ ...baseConfig, model: e.target.value })}
                      placeholder="T14 Gen3"
                      className="w-full px-3 py-2 bg-white/60 border border-line rounded-lg text-[13px]
                               placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                               focus:ring-primary/20 focus:border-primary transition-all"
                    />
                  </div>
                  <div>
                    <label className="block text-[12px] font-medium text-ink-deep mb-1.5">型号年份</label>
                    <input
                      type="number"
                      min="1980"
                      max="2100"
                      value={baseConfig.year || ''}
                      onChange={(e) => setBaseConfig({ ...baseConfig, year: e.target.value ? Number(e.target.value) : undefined })}
                      placeholder="如：2020（可选）"
                      className="w-full px-3 py-2 bg-white/60 border border-line rounded-lg text-[13px]
                               placeholder:text-ink-soft/50 focus:outline-none focus:ring-2
                               focus:ring-primary/20 focus:border-primary transition-all"
                    />
                  </div>
                  {!isGraphicsCard && <div>
                    <label className="block text-[12px] font-medium text-ink-deep mb-1.5">
                      CPU {computerSpecsRequired && <span className="text-danger">*</span>}
                    </label>
                    <input
                      type="text"
                      value={baseConfig.cpu}
                      required={computerSpecsRequired}
                      onChange={(e) => setBaseConfig({ ...baseConfig, cpu: e.target.value })}
                      placeholder="i5-1240P"
                      className="w-full px-3 py-2 bg-white/60 border border-line rounded-lg text-[13px]
                               placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                               focus:ring-primary/20 focus:border-primary transition-all"
                    />
                  </div>}
                  {!isGraphicsCard && <div>
                    <label className="block text-[12px] font-medium text-ink-deep mb-1.5">
                      内存 {computerSpecsRequired && <span className="text-danger">*</span>}
                    </label>
                    <input
                      type="text"
                      value={baseConfig.ram}
                      required={computerSpecsRequired}
                      onChange={(e) => setBaseConfig({ ...baseConfig, ram: e.target.value })}
                      placeholder="16GB"
                      className="w-full px-3 py-2 bg-white/60 border border-line rounded-lg text-[13px]
                               placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                               focus:ring-primary/20 focus:border-primary transition-all"
                    />
                  </div>}
                </div>

                {/* 显卡及整机适用配置 */}
                <div className={`grid gap-3 ${isGraphicsCard ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-4'}`}>
                  <div>
                    <label className="block text-[12px] font-medium text-ink-deep mb-1.5">
                      {isGraphicsCard ? '显卡型号' : '显卡'} {isGraphicsCard && <span className="text-danger">*</span>}
                    </label>
                    <input
                      type="text"
                      value={baseConfig.gpu}
                      onChange={(e) => setBaseConfig({ ...baseConfig, gpu: e.target.value })}
                      placeholder={isGraphicsCard ? '如：RTX 4060' : '集显'}
                      className="w-full px-3 py-2 bg-white/60 border border-line rounded-lg text-[13px]
                               placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                               focus:ring-primary/20 focus:border-primary transition-all"
                    />
                  </div>
                  {!isGraphicsCard && <div>
                    <label className="block text-[12px] font-medium text-ink-deep mb-1.5">
                      硬盘 <span className="font-normal text-ink-soft">选填</span>
                    </label>
                    <input
                      type="text"
                      value={baseConfig.storage}
                      onChange={(e) => setBaseConfig({ ...baseConfig, storage: e.target.value })}
                      placeholder="512GB SSD"
                      className="w-full px-3 py-2 bg-white/60 border border-line rounded-lg text-[13px]
                               placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                               focus:ring-primary/20 focus:border-primary transition-all"
                    />
                  </div>}
                  {!isGraphicsCard && <div>
                    <label className="block text-[12px] font-medium text-ink-deep mb-1.5">
                      屏幕
                    </label>
                    <input
                      type="text"
                      value={baseConfig.screen}
                      onChange={(e) => setBaseConfig({ ...baseConfig, screen: e.target.value })}
                      placeholder="1920x1080"
                      className="w-full px-3 py-2 bg-white/60 border border-line rounded-lg text-[13px]
                               placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                               focus:ring-primary/20 focus:border-primary transition-all"
                    />
                  </div>}
                  {!isGraphicsCard && <div>
                    <label className="block text-[12px] font-medium text-ink-deep mb-1.5">
                      触屏
                    </label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setBaseConfig({ ...baseConfig, touchScreen: baseConfig.touchScreen === false ? undefined : false })}
                        className={`flex-1 px-3 py-2 rounded-lg text-[12px] font-medium transition-all
                                  ${baseConfig.touchScreen === false
                                    ? 'bg-primary text-white'
                                    : 'glass hover:bg-white/60'
                                  }`}
                      >
                        非触屏
                      </button>
                      <button
                        type="button"
                        onClick={() => setBaseConfig({ ...baseConfig, touchScreen: baseConfig.touchScreen === true ? undefined : true })}
                        className={`flex-1 px-3 py-2 rounded-lg text-[12px] font-medium transition-all
                                  ${baseConfig.touchScreen === true
                                    ? 'bg-primary text-white'
                                    : 'glass hover:bg-white/60'
                                  }`}
                      >
                        触屏
                      </button>
                    </div>
                    <p className="mt-1 text-[11px] text-ink-soft">不选择时保留为空</p>
                  </div>}
                </div>
              </div>
            </div>
            )}

            {/* 批量明细表格 */}
            <div className="glass p-5 rounded-xl">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-[15px] font-semibold text-ink-deep">
                  {isGraphicsCard ? '显卡明细' : '机器明细'} ({rows.length} {isGraphicsCard ? '张' : '台'})
                </h3>
                <button
                  onClick={handleAddRow}
                  className="flex items-center gap-2 px-3 py-1.5 bg-primary text-white rounded-lg 
                           text-[13px] font-medium hover:bg-primary-hover transition-all ripple-hover
                           shadow-sm"
                >
                  <Plus className="w-4 h-4" />
                  添加一行
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-paper/50 border-b border-line">
                    <tr>
                      <th className="px-3 py-2 text-left text-[12px] font-semibold text-ink-deep w-12">
                        序号
                      </th>
                      <th className="px-3 py-2 text-left text-[12px] font-semibold text-ink-deep">
                        <div className="flex items-center justify-between gap-2">
                          <span>SN 序列号 <span className="text-danger">*</span></span>
                          <button type="button" onClick={handleGenerateMissingSNs} disabled={rows.every(row => row.sn.trim())} className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-primary transition-transform hover:scale-[1.03] disabled:cursor-not-allowed disabled:opacity-40" title="只为未填写 SN 的行生成内部编号">
                            <Shuffle className="h-3.5 w-3.5" />为空行生成
                          </button>
                        </div>
                      </th>
                      <th className="px-3 py-2 text-left text-[12px] font-semibold text-ink-deep w-40">
                        <div className="flex items-center justify-between">
                          <span>采购价格 {isGraphicsCard ? <span className="text-ink-soft">（选填，留空按 0 元）</span> : <span className="text-danger">*</span>}</span>
                          {rows.length > 1 && (
                            <button
                              type="button"
                              onClick={() => handleApplyToAll('purchasePrice')}
                              className="ml-2 px-2 py-0.5 text-[11px] bg-primary/10 text-primary rounded 
                                       hover:bg-primary/20 transition-all"
                              title="将第一行的价格应用到所有行"
                            >
                              应用到全部
                            </button>
                          )}
                        </div>
                      </th>
                      <th className="px-3 py-2 text-left text-[12px] font-semibold text-ink-deep">
                        <div className="flex items-center justify-between">
                          <span>备注</span>
                          {rows.length > 1 && (
                            <button
                              type="button"
                              onClick={() => handleApplyToAll('remark')}
                              className="ml-2 px-2 py-0.5 text-[11px] bg-primary/10 text-primary rounded 
                                       hover:bg-primary/20 transition-all"
                              title="将第一行的备注应用到所有行"
                            >
                              应用到全部
                            </button>
                          )}
                        </div>
                      </th>
                      <th className="px-3 py-2 text-center text-[12px] font-semibold text-ink-deep w-16">
                        操作
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/50">
                    {rows.map((row, index) => (
                      <tr key={row.id} className="hover:bg-white/40 transition-colors">
                        <td className="px-3 py-2 text-[13px] text-ink-soft">
                          {index + 1}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex min-w-48 items-center gap-2">
                            <input
                              type="text"
                              value={row.sn}
                              onChange={(e) => handleUpdateRow(row.id, 'sn', e.target.value)}
                              placeholder="请输入 SN"
                              className="w-full px-3 py-2 bg-white border border-line rounded-lg text-[13px]
                                       placeholder:text-ink-soft/50 focus:outline-none focus:ring-2
                                       focus:ring-primary/20 focus:border-primary transition-all"
                            />
                            <button type="button" aria-label={`为第 ${index + 1} 行生成内部 SN`} title={row.sn.trim() ? '清空已填写的 SN 后再生成' : '生成内部 SN'} onClick={() => handleGenerateRowSN(row.id)} disabled={Boolean(row.sn.trim())} className="shrink-0 rounded-lg border border-line bg-white p-2 text-primary transition-transform hover:scale-[1.03] disabled:cursor-not-allowed disabled:opacity-40"><Shuffle className="h-4 w-4" /></button>
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="number"
                            value={row.purchasePrice || ''}
                            onChange={(e) => handleUpdateRow(row.id, 'purchasePrice', parseFloat(e.target.value) || 0)}
                            placeholder="价格"
                            className="w-full px-3 py-2 bg-white border border-line rounded-lg text-[13px]
                                     placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                                     focus:ring-primary/20 focus:border-primary transition-all"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="text"
                            value={row.remark}
                            onChange={(e) => handleUpdateRow(row.id, 'remark', e.target.value)}
                            placeholder="选填"
                            className="w-full px-3 py-2 bg-white border border-line rounded-lg text-[13px]
                                     placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                                     focus:ring-primary/20 focus:border-primary transition-all"
                          />
                        </td>
                        <td className="px-3 py-2 text-center">
                          <button
                            onClick={() => handleRemoveRow(row.id)}
                            className="p-1.5 hover:bg-danger/10 rounded-lg transition-all text-danger"
                            title="删除"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* 底部按钮 */}
          <div className="px-6 py-4 border-t border-line flex items-center justify-between flex-shrink-0">
            <div className="text-[13px] text-ink-soft">
              将批量添加 <span className="font-semibold text-ink">{rows.length}</span> {isGraphicsCard ? '张显卡' : '台机器'}
            </div>
            <div className="flex items-center gap-3">
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
                onClick={() => handleSubmit('continue')}
                className="inline-flex items-center gap-1.5 px-4 py-2 border border-primary/30 bg-primary/8 text-primary text-[13px] font-medium rounded-lg hover:bg-primary/15 transition-all ripple-hover"
              >
                <Plus className="w-4 h-4" />
                添加并继续
              </button>
              <button
                type="button"
                onClick={() => handleSubmit('close')}
                className="inline-flex items-center gap-1.5 px-5 py-2 bg-primary text-white text-[13px] font-medium rounded-lg hover:bg-primary-hover transition-all ripple-hover shadow-sm hover:shadow-md"
              >
                <Check className="w-4 h-4" />
                确认添加
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Toast 提示 */}
      <Toast
        isOpen={toast.show}
        type="warning"
        message={toast.message}
        onClose={() => setToast({ show: false, message: '' })}
      />
    </>
  );
}

