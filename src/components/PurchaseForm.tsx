"use client";

import { useState } from "react";
import { ORDERS } from "@/lib/mock";
import CustomSelect from "@/components/CustomSelect";

interface PurchaseFormProps {
  onSubmit?: () => void;
  onCancel?: () => void;
}

/**
 * 新增采购单表单组件
 * 支持关联已有订单、录入机器明细
 */
export default function PurchaseForm({ onSubmit, onCancel }: PurchaseFormProps) {
  const incompleteOrders = ORDERS.filter((o) => o.isComplete === false);
  const [paymentAccount, setPaymentAccount] = useState("");

  return (
    <div className="space-y-6">
      {/* 关联已有订单 */}
      {incompleteOrders.length > 0 && (
        <section>
          <h3 className="text-[15px] font-semibold mb-3">关联已有订单</h3>
          <div className="glass p-4 space-y-2.5">
            {incompleteOrders.map((order) => (
              <label
                key={order.no}
                className="flex items-center gap-3 p-3 rounded-lg hover:bg-primary-alpha-08 cursor-pointer transition-colors group"
              >
                <input type="radio" name="linkedOrder" className="w-4 h-4 accent-primary cursor-pointer" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-[13px] font-medium text-primary">{order.no}</span>
                    <span className="text-[13px] text-ink-soft">{order.supplier}</span>
                  </div>
                  <div className="text-[12px] text-ink-soft">
                    已录入 {order.inQty}/{order.qty} 台 · {order.time.split(" ")[0]}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </section>
      )}

      {/* 采购单信息 */}
      <section>
        <h3 className="text-[15px] font-semibold mb-3">采购单信息</h3>
        <div className="glass p-5 grid grid-cols-1 md:grid-cols-3 gap-4">
          <label className="block">
            <span className="text-[13px] text-ink-soft">
              供应商 <b className="text-danger">*</b>
            </span>
            <input className="field mt-1.5" placeholder="请选择供应商（可搜索）" />
          </label>
          <label className="block">
            <span className="text-[13px] text-ink-soft">
              付款账户 <b className="text-danger">*</b>
            </span>
            <div className="mt-1.5">
              <CustomSelect
                placeholder="请选择账户"
                value={paymentAccount}
                onChange={setPaymentAccount}
                options={[
                  { value: "default", label: "系统默认账户" },
                  { value: "prepay", label: "采购预付账户" },
                ]}
              />
            </div>
          </label>
          <label className="block">
            <span className="text-[13px] text-ink-soft">采购人</span>
            <input className="field mt-1.5" defaultValue="管理员" />
          </label>
          <label className="block">
            <span className="text-[13px] text-ink-soft">
              采购时间 <b className="text-danger">*</b>
            </span>
            <input className="field mt-1.5" defaultValue="2026-10-09 12:10" />
          </label>
          <label className="block md:col-span-3">
            <span className="text-[13px] text-ink-soft">备注</span>
            <input className="field mt-1.5" placeholder="选填" />
          </label>
        </div>
      </section>

      {/* 机器明细 */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[15px] font-semibold">机器明细（2 台）</h3>
          <div className="flex gap-2">
            <button className="btn-ghost text-[13px] px-3 py-1.5">扫码录入</button>
            <button className="btn-ghost text-[13px] px-3 py-1.5">导入表格</button>
            <button className="btn-ghost text-[13px] px-3 py-1.5">批量调价</button>
          </div>
        </div>

        <div className="glass-strong overflow-hidden">
          <table className="data-table w-full text-[13px]">
            <thead>
              <tr>
                <th className="!text-left !pl-5">IMEI / 序列号</th>
                <th className="!text-left">品牌</th>
                <th className="!text-left">型号</th>
                <th className="!text-left">内存</th>
                <th className="!text-left">颜色</th>
                <th className="!text-left">成色</th>
                <th className="!text-right">采购价</th>
                <th className="!text-center !w-20"></th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="!pl-5 font-mono text-[12.5px]">868231062363405</td>
                <td>联想</td>
                <td>ThinkPad T480</td>
                <td>8G+256G</td>
                <td>黑色</td>
                <td>准新机</td>
                <td className="text-right font-mono font-medium">¥3,240</td>
                <td className="text-center">
                  <button className="text-danger hover:underline text-[13px]">删除</button>
                </td>
              </tr>
              <tr>
                <td className="!pl-5 font-mono text-[12.5px]">356789104512338</td>
                <td>苹果</td>
                <td>MacBook Air 2020</td>
                <td>8G+256G</td>
                <td>深空灰</td>
                <td>国行 M1</td>
                <td className="text-right font-mono font-medium">¥4,688</td>
                <td className="text-center">
                  <button className="text-danger hover:underline text-[13px]">删除</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <button className="mt-4 w-full py-3 rounded-lg border-2 border-dashed border-line-strong hover:border-primary hover:bg-primary-alpha-08 transition-colors text-[13px] text-ink-soft hover:text-primary font-medium">
          ＋ 手动添加一台机器
        </button>
      </section>

      {/* 底部操作栏 */}
      <div className="flex items-center justify-between pt-4 border-t border-line">
        <div className="text-[13px] text-ink-soft">已添加 2 台</div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-[12px] text-ink-soft mb-0.5">采购总价</div>
            <div className="text-lg font-bold font-mono text-primary">¥7,928</div>
          </div>
          <div className="flex gap-2.5">
            <button onClick={onCancel} className="btn-ghost px-6">
              取消
            </button>
            <button onClick={onSubmit} className="btn-primary px-6">
              确认并生成采购单
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
