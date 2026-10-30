/**
 * 批量录入组件
 * 同型号同配置，表格方式录入多台机器
 */
'use client';

import { useState } from 'react';
import { Plus, Trash2, X, Check } from 'lucide-react';
import Toast from '@/components/Toast';
import { useWorkspaceDirty } from '@/components/WorkspaceContext';
import { formatProductName } from '@/lib/product-name';
import { formatCPUDisplay, formatGPUDisplay, formatScreenDisplay } from '@/lib/sku-display';

interface BatchInputProps {
  presetConfig?: {
    skuId?: string;
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
}

interface BatchRow {
  id: string;
  sn: string;
  purchasePrice: number;
  remark: string;
}

export default function BatchInput({ presetConfig, onConfirm, onCancel }: BatchInputProps) {
  // 通用配置 - 如果有预设配置则使用预设
  const [baseConfig, setBaseConfig] = useState({
    skuId: presetConfig?.skuId,
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
    if (!baseConfig.brand || !baseConfig.model || !baseConfig.cpu || 
        !baseConfig.ram || !baseConfig.storage) {
      setToast({ show: true, message: '请填写完整的通用配置' });
      return;
    }

    // 验证每行数据
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row.sn || !row.purchasePrice) {
        setToast({ show: true, message: '请填写所有机器的 SN 和价格' });
        return;
      }
      const sn = row.sn.trim();
      if (seen.has(sn)) {
        setToast({ show: true, message: `当前批次 SN [${sn}] 重复，请检查` });
        return;
      }
      seen.add(sn);
    }

    // 组装数据
    const machines = rows.map(row => ({
      ...baseConfig,
      sn: row.sn,
      purchasePrice: row.purchasePrice,
      remark: row.remark
    }));

    onConfirm(machines, mode);
    if (mode === 'continue') {
      setRows([{ id: `${Date.now()}-next`, sn: '', purchasePrice: 0, remark: '' }]);
      setToast({ show: true, message: `已添加 ${machines.length} 台机器，可继续录入` });
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
              <h2 className="text-lg font-semibold text-ink-deep">批量录入机器</h2>
              <p className="text-[13px] text-ink-soft mt-0.5">
                同型号同配置，批量录入多台机器
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
                  {presetConfig.gpu && (
                    <div>
                      <span className="text-ink-soft">显卡：</span>
                      <span className="font-medium text-ink-deep">{formatGPUDisplay(presetConfig.gpu)}</span>
                    </div>
                  )}
                  {presetConfig.screen && (
                    <div>
                      <span className="text-ink-soft">屏幕：</span>
                      <span className="font-medium text-ink-deep">{formatScreenDisplay(presetConfig.screen)}</span>
                    </div>
                  )}
                  <div>
                    <span className="text-ink-soft">触屏：</span>
                    <span className="font-medium text-ink-deep">{presetConfig.touchScreen === undefined ? '未选择' : presetConfig.touchScreen ? '是' : '否'}</span>
                  </div>
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
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => setBaseConfig({ ...baseConfig, productType: '笔记本电脑' })}
                      className={`px-4 py-2 rounded-lg text-[13px] font-medium transition-all
                                ${baseConfig.productType === '笔记本电脑'
                                  ? 'bg-primary text-white'
                                  : 'glass hover:bg-white/60'
                                }`}
                    >
                      笔记本电脑
                    </button>
                    <button
                      type="button"
                      onClick={() => setBaseConfig({ ...baseConfig, productType: '平板电脑' })}
                      className={`px-4 py-2 rounded-lg text-[13px] font-medium transition-all
                                ${baseConfig.productType === '平板电脑'
                                  ? 'bg-primary text-white'
                                  : 'glass hover:bg-white/60'
                                }`}
                    >
                      平板电脑
                    </button>
                  </div>
                </div>

                {/* 品牌、型号、CPU、内存 */}
                <div className="grid grid-cols-4 gap-3">
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
                  <div>
                    <label className="block text-[12px] font-medium text-ink-deep mb-1.5">
                      CPU <span className="text-danger">*</span>
                    </label>
                    <input
                      type="text"
                      value={baseConfig.cpu}
                      onChange={(e) => setBaseConfig({ ...baseConfig, cpu: e.target.value })}
                      placeholder="i5-1240P"
                      className="w-full px-3 py-2 bg-white/60 border border-line rounded-lg text-[13px]
                               placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                               focus:ring-primary/20 focus:border-primary transition-all"
                    />
                  </div>
                  <div>
                    <label className="block text-[12px] font-medium text-ink-deep mb-1.5">
                      内存 <span className="text-danger">*</span>
                    </label>
                    <input
                      type="text"
                      value={baseConfig.ram}
                      onChange={(e) => setBaseConfig({ ...baseConfig, ram: e.target.value })}
                      placeholder="16GB"
                      className="w-full px-3 py-2 bg-white/60 border border-line rounded-lg text-[13px]
                               placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                               focus:ring-primary/20 focus:border-primary transition-all"
                    />
                  </div>
                </div>

                {/* 显卡、硬盘、屏幕、触屏 */}
                <div className="grid grid-cols-4 gap-3">
                  <div>
                    <label className="block text-[12px] font-medium text-ink-deep mb-1.5">
                      显卡
                    </label>
                    <input
                      type="text"
                      value={baseConfig.gpu}
                      onChange={(e) => setBaseConfig({ ...baseConfig, gpu: e.target.value })}
                      placeholder="集显"
                      className="w-full px-3 py-2 bg-white/60 border border-line rounded-lg text-[13px]
                               placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                               focus:ring-primary/20 focus:border-primary transition-all"
                    />
                  </div>
                  <div>
                    <label className="block text-[12px] font-medium text-ink-deep mb-1.5">
                      硬盘 <span className="text-danger">*</span>
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
                  </div>
                  <div>
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
                  </div>
                  <div>
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
                  </div>
                </div>
              </div>
            </div>
            )}

            {/* 批量明细表格 */}
            <div className="glass p-5 rounded-xl">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-[15px] font-semibold text-ink-deep">
                  机器明细 ({rows.length} 台)
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
                        SN 序列号 <span className="text-danger">*</span>
                      </th>
                      <th className="px-3 py-2 text-left text-[12px] font-semibold text-ink-deep w-40">
                        <div className="flex items-center justify-between">
                          <span>采购价格 <span className="text-danger">*</span></span>
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
                          <input
                            type="text"
                            value={row.sn}
                            onChange={(e) => handleUpdateRow(row.id, 'sn', e.target.value)}
                            placeholder="请输入 SN"
                            className="w-full px-3 py-2 bg-white border border-line rounded-lg text-[13px]
                                     placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                                     focus:ring-primary/20 focus:border-primary transition-all"
                          />
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
              将批量添加 <span className="font-semibold text-ink">{rows.length}</span> 台机器
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

