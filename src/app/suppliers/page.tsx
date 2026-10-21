/**
 * 供应商管理页面
 * 路径: /suppliers
 */
'use client';

import { useState, useEffect } from 'react';
import { Plus, Search, Edit2, Trash2 } from 'lucide-react';
import ConfirmDialog from '@/components/ConfirmDialog';
import Toast, { ToastType } from '@/components/Toast';

interface Supplier {
  id: string;
  supplierName: string;
  contactPerson?: string;
  contactPhone?: string;
  address?: string;
  remark?: string;
  status: 'active' | 'inactive';
  createdAt: string;
  updatedAt: string;
}

interface PaginatedResponse {
  items: Supplier[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [search, setSearch] = useState('');
  const [showDrawer, setShowDrawer] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  
  // 对话框和提示状态
  const [deleteConfirm, setDeleteConfirm] = useState<{ show: boolean; supplier: Supplier | null }>({
    show: false,
    supplier: null
  });
  const [toast, setToast] = useState<{ show: boolean; type: ToastType; message: string }>({
    show: false,
    type: 'success',
    message: ''
  });

  // 加载供应商列表
  const loadSuppliers = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams({
        page: page.toString(),
        pageSize: pageSize.toString(),
        ...(search && { search })
      });
      
      const response = await fetch(`/api/suppliers?${params}`);
      const result = await response.json();
      
      if (result.success) {
        const data = result.data as PaginatedResponse;
        setSuppliers(data.items);
        setTotal(data.total);
      }
    } catch (error) {
      console.error('加载供应商列表失败:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSuppliers();
  }, [page, search]);

  // 新增供应商
  const handleAdd = () => {
    setEditingSupplier(null);
    setShowDrawer(true);
  };

  // 编辑供应商
  const handleEdit = (supplier: Supplier) => {
    setEditingSupplier(supplier);
    setShowDrawer(true);
  };

  // 删除供应商
  const handleDelete = async (supplier: Supplier) => {
    setDeleteConfirm({ show: true, supplier });
  };

  // 确认删除
  const confirmDelete = async () => {
    const supplier = deleteConfirm.supplier;
    if (!supplier) return;
    
    try {
      const response = await fetch(`/api/suppliers?id=${supplier.id}`, {
        method: 'DELETE'
      });
      const result = await response.json();
      
      if (result.success) {
        setToast({ show: true, type: 'success', message: '供应商已删除' });
        loadSuppliers();
      } else {
        setToast({ show: true, type: 'error', message: result.error?.message || '删除失败' });
      }
    } catch (error) {
      console.error('删除供应商失败:', error);
      setToast({ show: true, type: 'error', message: '删除失败，请重试' });
    } finally {
      setDeleteConfirm({ show: false, supplier: null });
    }
  };

  // 保存成功回调
  const handleSaveSuccess = () => {
    setShowDrawer(false);
    loadSuppliers();
  };

  return (
    <div className="max-w-[1400px] mx-auto">
      {/* 页面标题 */}
      <header className="mb-6">
        <h1 className="text-xl font-bold tracking-wide text-ink-deep mb-2">
          供应商管理
        </h1>
        <p className="text-[13px] text-ink-soft">
          管理采购供应商信息、联系方式和合作记录
        </p>
      </header>

      {/* 操作栏 */}
      <div className="glass p-4 mb-4 flex items-center justify-between">
        {/* 搜索框 */}
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-soft" />
          <input
            type="text"
            placeholder="搜索供应商名称、联系人、电话..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-white/60 border border-line rounded-lg text-[13px] 
                     placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 focus:ring-primary/20 
                     focus:border-primary transition-all"
          />
        </div>

        {/* 新增按钮 */}
        <button
          onClick={handleAdd}
          className="ml-4 flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg 
                   text-[13px] font-medium hover:bg-primary-hover transition-all ripple-hover
                   shadow-sm hover:shadow-md"
        >
          <Plus className="w-4 h-4" />
          新增供应商
        </button>
      </div>

      {/* 供应商列表 */}
      <div className="glass overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-ink-soft text-[13px]">
            加载中...
          </div>
        ) : suppliers.length === 0 ? (
          <div className="p-8 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary-alpha-12 mb-4">
              <Search className="w-8 h-8 text-primary" />
            </div>
            <p className="text-ink-soft text-[13px]">
              {search ? '未找到匹配的供应商' : '暂无供应商数据，点击右上角添加'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-paper/50 border-b border-line">
                <tr>
                  <th className="px-4 py-3 text-left text-[12px] font-semibold text-ink-deep">
                    供应商名称
                  </th>
                  <th className="px-4 py-3 text-left text-[12px] font-semibold text-ink-deep">
                    联系人
                  </th>
                  <th className="px-4 py-3 text-left text-[12px] font-semibold text-ink-deep">
                    联系电话
                  </th>
                  <th className="px-4 py-3 text-left text-[12px] font-semibold text-ink-deep">
                    地址
                  </th>
                  <th className="px-4 py-3 text-left text-[12px] font-semibold text-ink-deep">
                    状态
                  </th>
                  <th className="px-4 py-3 text-left text-[12px] font-semibold text-ink-deep">
                    创建时间
                  </th>
                  <th className="px-4 py-3 text-right text-[12px] font-semibold text-ink-deep">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/50">
                {suppliers.map((supplier) => (
                  <tr
                    key={supplier.id}
                    className="hover:bg-white/40 transition-colors"
                  >
                    <td className="px-4 py-3 text-[13px] font-medium text-ink-deep">
                      {supplier.supplierName}
                    </td>
                    <td className="px-4 py-3 text-[13px] text-ink">
                      {supplier.contactPerson || '-'}
                    </td>
                    <td className="px-4 py-3 text-[13px] text-ink">
                      {supplier.contactPhone || '-'}
                    </td>
                    <td className="px-4 py-3 text-[13px] text-ink max-w-xs truncate">
                      {supplier.address || '-'}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center px-2 py-1 rounded-full text-[11px] font-medium ${
                          supplier.status === 'active'
                            ? 'bg-success-soft text-success'
                            : 'bg-ink-soft/10 text-ink-soft'
                        }`}
                      >
                        {supplier.status === 'active' ? '启用' : '停用'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[13px] text-ink-soft">
                      {new Date(supplier.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => handleEdit(supplier)}
                          className="p-2 hover:bg-white/60 rounded-lg transition-all ripple-hover"
                          title="编辑"
                        >
                          <Edit2 className="w-4 h-4 text-ink-soft hover:text-primary transition-colors" />
                        </button>
                        <button
                          onClick={() => handleDelete(supplier)}
                          className="p-2 hover:bg-white/60 rounded-lg transition-all ripple-hover"
                          title="删除"
                        >
                          <Trash2 className="w-4 h-4 text-ink-soft hover:text-danger transition-colors" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* 分页 */}
        {total > pageSize && (
          <div className="px-4 py-3 border-t border-line flex items-center justify-between">
            <div className="text-[13px] text-ink-soft">
              共 {total} 条记录
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1.5 text-[13px] rounded-lg border border-line 
                         hover:bg-white/60 disabled:opacity-50 disabled:cursor-not-allowed
                         transition-all"
              >
                上一页
              </button>
              <span className="text-[13px] text-ink">
                {page} / {Math.ceil(total / pageSize)}
              </span>
              <button
                onClick={() => setPage(p => p + 1)}
                disabled={page >= Math.ceil(total / pageSize)}
                className="px-3 py-1.5 text-[13px] rounded-lg border border-line 
                         hover:bg-white/60 disabled:opacity-50 disabled:cursor-not-allowed
                         transition-all"
              >
                下一页
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 新增/编辑 Drawer */}
      {showDrawer && (
        <SupplierDrawer
          supplier={editingSupplier}
          onClose={() => setShowDrawer(false)}
          onSuccess={handleSaveSuccess}
          onError={(message) => setToast({ show: true, type: 'error', message })}
        />
      )}

      {/* 删除确认对话框 */}
      <ConfirmDialog
        isOpen={deleteConfirm.show}
        title="确认删除"
        message={`确定要删除供应商「${deleteConfirm.supplier?.supplierName}」吗？`}
        confirmText="删除"
        cancelText="取消"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteConfirm({ show: false, supplier: null })}
        danger={true}
      />

      {/* Toast 提示 */}
      <Toast
        isOpen={toast.show}
        type={toast.type}
        message={toast.message}
        onClose={() => setToast({ show: false, type: 'success', message: '' })}
      />
    </div>
  );
}

/**
 * 供应商新增/编辑 Drawer 组件
 */
interface SupplierDrawerProps {
  supplier: Supplier | null;
  onClose: () => void;
  onSuccess: () => void;
  onError: (message: string) => void;
}

function SupplierDrawer({ supplier, onClose, onSuccess, onError }: SupplierDrawerProps) {
  const [formData, setFormData] = useState({
    supplierName: supplier?.supplierName || '',
    contactPerson: supplier?.contactPerson || '',
    contactPhone: supplier?.contactPhone || '',
    address: supplier?.address || '',
    remark: supplier?.remark || '',
    status: supplier?.status || 'active'
  });
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formData.supplierName.trim()) {
      onError('请输入供应商名称');
      return;
    }
    
    try {
      setSaving(true);
      
      const url = '/api/suppliers';
      const method = supplier ? 'PUT' : 'POST';
      const body = supplier 
        ? { id: supplier.id, ...formData }
        : formData;
      
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      
      const result = await response.json();
      
      if (result.success) {
        onSuccess();
      } else {
        onError(result.error?.message || '保存失败');
      }
    } catch (error) {
      console.error('保存供应商失败:', error);
      onError('保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {/* 遮罩层 */}
      <div
        className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40 animate-fade-in"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="fixed right-0 top-0 h-full w-full max-w-lg bg-white shadow-2xl z-50 animate-slide-in-right flex flex-col">
        {/* 标题栏 */}
        <div className="px-6 py-4 border-b border-line flex items-center justify-between">
          <h2 className="text-lg font-semibold text-ink-deep">
            {supplier ? '编辑供应商' : '新增供应商'}
          </h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-paper rounded-lg transition-all ripple-hover"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 表单内容 */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-6 py-6">
          <div className="space-y-5">
            {/* 供应商名称 */}
            <div>
              <label className="block text-[13px] font-medium text-ink-deep mb-2">
                供应商名称 <span className="text-danger">*</span>
              </label>
              <input
                type="text"
                value={formData.supplierName}
                onChange={(e) => setFormData({ ...formData, supplierName: e.target.value })}
                placeholder="请输入供应商名称"
                className="w-full px-4 py-2.5 bg-white border border-line rounded-lg text-[13px]
                         placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                         focus:ring-primary/20 focus:border-primary transition-all"
                required
              />
            </div>

            {/* 联系人 */}
            <div>
              <label className="block text-[13px] font-medium text-ink-deep mb-2">
                联系人
              </label>
              <input
                type="text"
                value={formData.contactPerson}
                onChange={(e) => setFormData({ ...formData, contactPerson: e.target.value })}
                placeholder="请输入联系人姓名"
                className="w-full px-4 py-2.5 bg-white border border-line rounded-lg text-[13px]
                         placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                         focus:ring-primary/20 focus:border-primary transition-all"
              />
            </div>

            {/* 联系电话 */}
            <div>
              <label className="block text-[13px] font-medium text-ink-deep mb-2">
                联系电话
              </label>
              <input
                type="tel"
                value={formData.contactPhone}
                onChange={(e) => setFormData({ ...formData, contactPhone: e.target.value })}
                placeholder="请输入联系电话"
                className="w-full px-4 py-2.5 bg-white border border-line rounded-lg text-[13px]
                         placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                         focus:ring-primary/20 focus:border-primary transition-all"
              />
            </div>

            {/* 地址 */}
            <div>
              <label className="block text-[13px] font-medium text-ink-deep mb-2">
                地址
              </label>
              <input
                type="text"
                value={formData.address}
                onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                placeholder="请输入详细地址"
                className="w-full px-4 py-2.5 bg-white border border-line rounded-lg text-[13px]
                         placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                         focus:ring-primary/20 focus:border-primary transition-all"
              />
            </div>

            {/* 状态 */}
            <div>
              <label className="block text-[13px] font-medium text-ink-deep mb-2">
                状态
              </label>
              <div className="flex gap-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    value="active"
                    checked={formData.status === 'active'}
                    onChange={(e) => setFormData({ ...formData, status: e.target.value as 'active' })}
                    className="w-4 h-4 text-primary focus:ring-primary"
                  />
                  <span className="text-[13px]">启用</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    value="inactive"
                    checked={formData.status === 'inactive'}
                    onChange={(e) => setFormData({ ...formData, status: e.target.value as 'inactive' })}
                    className="w-4 h-4 text-primary focus:ring-primary"
                  />
                  <span className="text-[13px]">停用</span>
                </label>
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
                placeholder="请输入备注信息"
                rows={4}
                className="w-full px-4 py-2.5 bg-white border border-line rounded-lg text-[13px]
                         placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                         focus:ring-primary/20 focus:border-primary transition-all resize-none"
              />
            </div>
          </div>
        </form>

        {/* 底部按钮 */}
        <div className="px-6 py-4 border-t border-line flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-[13px] font-medium text-ink hover:bg-paper 
                     rounded-lg transition-all ripple-hover"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="px-4 py-2 bg-primary text-white text-[13px] font-medium rounded-lg
                     hover:bg-primary-hover transition-all ripple-hover shadow-sm hover:shadow-md
                     disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </>
  );
}
