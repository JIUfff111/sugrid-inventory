/**
 * 销售渠道管理页面
 * 路径: /sales/channels
 */
'use client';

import { useState, useEffect } from 'react';
import { Plus, Search, Edit2, Trash2, TrendingUp } from 'lucide-react';
import ConfirmDialog from '@/components/ConfirmDialog';
import Toast, { ToastType } from '@/components/Toast';

interface SalesChannel {
  id: string;
  channelName: string;
  channelType?: string;
  contactInfo?: string;
  remark?: string;
  status: 'active' | 'inactive';
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

interface PaginatedResponse {
  items: SalesChannel[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export default function SalesChannelsPage() {
  const [channels, setChannels] = useState<SalesChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [search, setSearch] = useState('');
  const [showDrawer, setShowDrawer] = useState(false);
  const [editingChannel, setEditingChannel] = useState<SalesChannel | null>(null);
  
  // 对话框和提示状态
  const [deleteConfirm, setDeleteConfirm] = useState<{ show: boolean; channel: SalesChannel | null }>({
    show: false,
    channel: null
  });
  const [toast, setToast] = useState<{ show: boolean; type: ToastType; message: string }>({
    show: false,
    type: 'success',
    message: ''
  });

  // 加载渠道列表
  const loadChannels = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams({
        page: page.toString(),
        pageSize: pageSize.toString(),
        ...(search && { search })
      });
      
      const response = await fetch(`/api/sales-channels?${params}`);
      const result = await response.json();
      
      if (result.success) {
        const data = result.data as PaginatedResponse;
        setChannels(data.items);
        setTotal(data.total);
      }
    } catch (error) {
      console.error('加载销售渠道列表失败:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadChannels();
  }, [page, search]);

  // 新增渠道
  const handleAdd = () => {
    setEditingChannel(null);
    setShowDrawer(true);
  };

  // 编辑渠道
  const handleEdit = (channel: SalesChannel) => {
    setEditingChannel(channel);
    setShowDrawer(true);
  };

  // 删除渠道
  const handleDelete = async (channel: SalesChannel) => {
    setDeleteConfirm({ show: true, channel });
  };

  // 确认删除
  const confirmDelete = async () => {
    const channel = deleteConfirm.channel;
    if (!channel) return;
    
    try {
      const response = await fetch(`/api/sales-channels?id=${channel.id}`, {
        method: 'DELETE'
      });
      const result = await response.json();
      
      if (result.success) {
        setToast({ show: true, type: 'success', message: '渠道已删除' });
        loadChannels();
      } else {
        setToast({ show: true, type: 'error', message: result.error?.message || '删除失败' });
      }
    } catch (error) {
      console.error('删除销售渠道失败:', error);
      setToast({ show: true, type: 'error', message: '删除失败，请重试' });
    } finally {
      setDeleteConfirm({ show: false, channel: null });
    }
  };

  // 保存成功回调
  const handleSaveSuccess = () => {
    setShowDrawer(false);
    loadChannels();
  };

  return (
    <div className="max-w-[1400px] mx-auto">
      {/* 页面标题 */}
      <header className="mb-6">
        <h1 className="text-xl font-bold tracking-wide text-ink-deep mb-2">
          销售渠道管理
        </h1>
        <p className="text-[13px] text-ink-soft">
          管理销售平台渠道信息，用于销售出库时选择
        </p>
      </header>

      {/* 操作栏 */}
      <div className="glass p-4 mb-4 flex items-center justify-between">
        {/* 搜索框 */}
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-soft" />
          <input
            type="text"
            placeholder="搜索渠道名称..."
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
          新增渠道
        </button>
      </div>

      {/* 渠道列表 */}
      <div className="glass overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-ink-soft text-[13px]">
            加载中...
          </div>
        ) : channels.length === 0 ? (
          <div className="p-8 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary-alpha-12 mb-4">
              <TrendingUp className="w-8 h-8 text-primary" />
            </div>
            <p className="text-ink-soft text-[13px]">
              {search ? '未找到匹配的渠道' : '暂无销售渠道数据，点击右上角添加'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-paper/50 border-b border-line">
                <tr>
                  <th className="px-4 py-3 text-left text-[12px] font-semibold text-ink-deep">
                    渠道名称
                  </th>
                  <th className="px-4 py-3 text-left text-[12px] font-semibold text-ink-deep">
                    渠道类型
                  </th>
                  <th className="px-4 py-3 text-left text-[12px] font-semibold text-ink-deep">
                    联系信息
                  </th>
                  <th className="px-4 py-3 text-left text-[12px] font-semibold text-ink-deep">
                    使用次数
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
                {channels.map((channel) => (
                  <tr
                    key={channel.id}
                    className="hover:bg-white/40 transition-colors"
                  >
                    <td className="px-4 py-3 text-[13px] font-medium text-ink-deep">
                      {channel.channelName}
                    </td>
                    <td className="px-4 py-3 text-[13px] text-ink">
                      {channel.channelType || '-'}
                    </td>
                    <td className="px-4 py-3 text-[13px] text-ink max-w-xs truncate">
                      {channel.contactInfo || '-'}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1 text-[13px] text-ink-soft">
                        <TrendingUp className="w-3.5 h-3.5" />
                        {channel.usageCount}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center px-2 py-1 rounded-full text-[11px] font-medium ${
                          channel.status === 'active'
                            ? 'bg-success-soft text-success'
                            : 'bg-ink-soft/10 text-ink-soft'
                        }`}
                      >
                        {channel.status === 'active' ? '启用' : '停用'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[13px] text-ink-soft">
                      {new Date(channel.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => handleEdit(channel)}
                          className="p-2 hover:bg-white/60 rounded-lg transition-all ripple-hover"
                          title="编辑"
                        >
                          <Edit2 className="w-4 h-4 text-ink-soft hover:text-primary transition-colors" />
                        </button>
                        <button
                          onClick={() => handleDelete(channel)}
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
        <ChannelDrawer
          channel={editingChannel}
          onClose={() => setShowDrawer(false)}
          onSuccess={handleSaveSuccess}
          onError={(message) => setToast({ show: true, type: 'error', message })}
        />
      )}

      {/* 删除确认对话框 */}
      <ConfirmDialog
        isOpen={deleteConfirm.show}
        title="确认删除"
        message={
          deleteConfirm.channel?.usageCount && deleteConfirm.channel.usageCount > 0
            ? `该渠道已使用 ${deleteConfirm.channel.usageCount} 次，确定要删除「${deleteConfirm.channel.channelName}」吗？`
            : `确定要删除渠道「${deleteConfirm.channel?.channelName}」吗？`
        }
        confirmText="删除"
        cancelText="取消"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteConfirm({ show: false, channel: null })}
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
 * 渠道新增/编辑 Drawer 组件
 */
interface ChannelDrawerProps {
  channel: SalesChannel | null;
  onClose: () => void;
  onSuccess: () => void;
  onError: (message: string) => void;
}

function ChannelDrawer({ channel, onClose, onSuccess, onError }: ChannelDrawerProps) {
  const [formData, setFormData] = useState({
    channelName: channel?.channelName || '',
    channelType: channel?.channelType || '',
    contactInfo: channel?.contactInfo || '',
    remark: channel?.remark || '',
    status: channel?.status || 'active'
  });
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formData.channelName.trim()) {
      onError('请输入渠道名称');
      return;
    }
    
    try {
      setSaving(true);
      
      const url = '/api/sales-channels';
      const method = channel ? 'PUT' : 'POST';
      const body = channel 
        ? { id: channel.id, ...formData }
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
      console.error('保存销售渠道失败:', error);
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
            {channel ? '编辑销售渠道' : '新增销售渠道'}
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
            {/* 渠道名称 */}
            <div>
              <label className="block text-[13px] font-medium text-ink-deep mb-2">
                渠道名称 <span className="text-danger">*</span>
              </label>
              <input
                type="text"
                value={formData.channelName}
                onChange={(e) => setFormData({ ...formData, channelName: e.target.value })}
                placeholder="请输入渠道名称，如：京东、淘宝、线下门店"
                className="w-full px-4 py-2.5 bg-white border border-line rounded-lg text-[13px]
                         placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                         focus:ring-primary/20 focus:border-primary transition-all"
                required
              />
            </div>

            {/* 渠道类型 */}
            <div>
              <label className="block text-[13px] font-medium text-ink-deep mb-2">
                渠道类型
              </label>
              <input
                type="text"
                value={formData.channelType}
                onChange={(e) => setFormData({ ...formData, channelType: e.target.value })}
                placeholder="如：电商平台、线下渠道"
                className="w-full px-4 py-2.5 bg-white border border-line rounded-lg text-[13px]
                         placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 
                         focus:ring-primary/20 focus:border-primary transition-all"
              />
            </div>

            {/* 联系信息 */}
            <div>
              <label className="block text-[13px] font-medium text-ink-deep mb-2">
                联系信息
              </label>
              <input
                type="text"
                value={formData.contactInfo}
                onChange={(e) => setFormData({ ...formData, contactInfo: e.target.value })}
                placeholder="平台账号、店铺名称等"
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
