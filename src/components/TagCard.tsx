import { Barcode } from "./Barcode";
import { StatusPill } from "./StatusPill";

export type MachineStatus = "in_stock" | "on_way" | "sold" | "after_sale";

const STATUS_LABEL: Record<MachineStatus, { text: string; type: "ok" | "warn" | "danger" | "info" }> = {
  in_stock: { text: "在库", type: "ok" },
  on_way: { text: "在途", type: "warn" },
  sold: { text: "已售", type: "info" },
  after_sale: { text: "售后", type: "danger" },
};

export type Machine = {
  imei: string;
  brandModel: string;
  spec: string;          // 内存/颜色/成色
  grade: string;         // 质检描述
  price: number;
  source: string;        // 供应商/渠道
  date: string;
  status: MachineStatus;
};

/** 机器面单卡 —— 签名元素：每台机器长"标签"的样子 */
export function TagCard({ m }: { m: Machine }) {
  const st = STATUS_LABEL[m.status];
  return (
    <div className="tag-card p-5 pt-6 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="font-semibold text-[15px] leading-snug">{m.brandModel}</div>
        <StatusPill type={st.type}>{st.text}</StatusPill>
      </div>

      <div className="text-[13px] text-ink-soft leading-relaxed">
        <div>{m.spec}</div>
        <div>{m.grade}</div>
      </div>

      <div className="mt-auto pt-3 border-t border-dashed border-line">
        <Barcode value={m.imei} />
      </div>

      <div className="flex items-end justify-between">
        <div className="text-[12px] text-ink-soft leading-tight">
          <div>{m.source}</div>
          <div className="font-mono">{m.date}</div>
        </div>
        <div className="font-mono text-[19px] font-bold text-ink tracking-tight">
          ¥{m.price.toLocaleString()}
        </div>
      </div>
    </div>
  );
}
