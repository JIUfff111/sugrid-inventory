# -*- coding: utf-8 -*-
"""按 00-brief/sku-agent-handoff-standard.md v1.0 生成 ThinkPad R14 补充交付件。

输出：03-supplements/sku-catalog-thinkpad-r14-2026-11-04/
      README.md / sku-models.csv / sku-configurations.csv / sources.csv / review.csv
"""
import csv
import json
import os

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(BASE, "docs", "sku-catalog", "03-supplements", "sku-catalog-thinkpad-r14-2026-11-04")
DATE = "2026-11-04"

MODELS_HDR = ["changeType", "productType", "brand", "model", "year", "sourceBrand", "sourceModel",
              "sourceYearText", "cpuOptions", "ramOptions", "gpuOptions", "storageOptions",
              "screenOptions", "aliases", "sourceIds", "confidence", "notes"]
CONF_HDR = ["configurationId", "productType", "brand", "model", "year", "cpu", "ram", "gpu",
            "storage", "screen", "cpuRaw", "ramRaw", "gpuRaw", "storageRaw", "screenRaw",
            "sourceIds", "confidence", "notes"]
SRC_HDR = ["sourceId", "sourceUrl", "sourceTitle", "publisher", "sourceType", "checkedAt",
           "accessStatus", "fieldsCovered", "notes"]
REV_HDR = ["reviewId", "recordType", "sourceKey", "field", "observedValue", "issueType",
           "confidence", "importDecision", "reason", "followUp"]


def ja(v):
    return json.dumps(v, ensure_ascii=False)


models = [
    {
        "changeType": "new_model", "productType": "笔记本电脑", "brand": "ThinkPad",
        "model": "R14 Gen 2 (Intel)", "year": "2021",
        "sourceBrand": "联想", "sourceModel": "ThinkPad R14 GEN2 20TC-A01FCD / 20TC-A110CD / 20TC-A113CD",
        "sourceYearText": "上市时间 2021年（苏宁自营标注）",
        "cpuOptions": ja(["I5-1135G7"]), "ramOptions": ja(["8GB"]),
        "gpuOptions": ja(["集显", "MX350"]), "storageOptions": ja(["256GB SSD", "512GB SSD"]),
        "screenOptions": ja(["FHD"]),
        "aliases": ja(["ThinkPad R14 GEN2", "ThinkPad R14 Gen2 20TC", "ThinkPad R14 2021"]),
        "sourceIds": ja(["S002", "S003", "S004", "S007"]), "confidence": "medium",
        "notes": "苏宁自营 3 个 MTM SKU（i5-1135G7/8GB，集显或 MX350 2G 独显，256/512GB SSD，14 英寸 FHD 1920x1080）；联想服务手册（E14/R14/S3 Gen 2 平台）佐证型号与 14 英寸 FHD。MX350 独显仅见于 20TC-A110CD。零售来源为 medium 门槛，规格写法与内置口径一致。",
    },
]

configs = [
    {
        "configurationId": "CFG-0001", "productType": "笔记本电脑", "brand": "ThinkPad",
        "model": "R14 Gen 2 (Intel)", "year": "2021",
        "cpu": "I5-1135G7", "ram": "8GB", "gpu": "集显", "storage": "256GB SSD", "screen": "FHD",
        "cpuRaw": "i5-1135G7", "ramRaw": "8GB DDR4（1 个插槽，最大支持 16GB）",
        "gpuRaw": "Intel UHD Graphics 集成显卡", "storageRaw": "256GB 固态硬盘（M.2）",
        "screenRaw": "14英寸 1920x1080 FHD",
        "sourceIds": ja(["S002", "S004"]), "confidence": "medium",
        "notes": "20TC-A01FCD 与 20TC-A113CD 两个 MTM 同配置，合并一条；来源为苏宁自营规格表。",
    },
    {
        "configurationId": "CFG-0002", "productType": "笔记本电脑", "brand": "ThinkPad",
        "model": "R14 Gen 2 (Intel)", "year": "2021",
        "cpu": "I5-1135G7", "ram": "8GB", "gpu": "MX350", "storage": "512GB SSD", "screen": "FHD",
        "cpuRaw": "i5-1135G7", "ramRaw": "8G DDR4",
        "gpuRaw": "MX350 2GB 独立显卡", "storageRaw": "512GB SSD 固态硬盘（M.2）",
        "screenRaw": "14英寸 1920x1080 FHD 背光",
        "sourceIds": ja(["S003"]), "confidence": "medium",
        "notes": "20TC-A110CD，苏宁自营；页面同时写“硬盘转速 5400 转/分”与“固态硬盘”，以 M.2 SSD 为准（电商页瑕疵）。",
    },
]

sources = [
    {"sourceId": "S001", "sourceUrl": "https://objects.icecat.biz/objects/mmo_96920206_1644316012_6195_5636.pdf",
     "sourceTitle": "Lenovo ThinkPad R14 Gen 2 (AMD) 官方规格表 PDF", "publisher": "联想（Icecat 数据池镜像）",
     "sourceType": "厂商规格页", "checkedAt": DATE, "accessStatus": "ok",
     "fieldsCovered": ja(["model", "cpu", "ram", "gpu", "storage", "screen"]),
     "notes": "联想官方 datasheet（Ryzen 5 5500U / Ryzen 7 5700U 版本），curl 200；托管于 Icecat 镜像，非 lenovo.com 原链。"},
    {"sourceId": "S002", "sourceUrl": "https://product.suning.com/0000000000/000000012368769733.html",
     "sourceTitle": "ThinkPad R14 Gen2 20TC-A01FCD（i5/8G/256SSD/14.0FHD）", "publisher": "苏宁易购联想自营旗舰店",
     "sourceType": "电商页面", "checkedAt": DATE, "accessStatus": "ok",
     "fieldsCovered": ja(["model", "cpu", "ram", "gpu", "storage", "screen", "year"]),
     "notes": "含 CCC 认证编号，制造商联想（北京）有限公司。"},
    {"sourceId": "S003", "sourceUrl": "https://product.suning.com/0000000000/000000012430063353.html",
     "sourceTitle": "ThinkPad R14 GEN2 20TC-A110CD（i5-1135G7 8G 512G MX350）", "publisher": "苏宁易购苏宁自营",
     "sourceType": "电商页面", "checkedAt": DATE, "accessStatus": "ok",
     "fieldsCovered": ja(["model", "cpu", "ram", "gpu", "storage", "screen", "year"]), "notes": ""},
    {"sourceId": "S004", "sourceUrl": "https://fe.suning.com/bigimages/12430063551.html",
     "sourceTitle": "ThinkPad R14 GEN2 20TC-A113CD（i5-1135G7 8G 256GSSD 指纹）", "publisher": "苏宁国际",
     "sourceType": "电商页面", "checkedAt": DATE, "accessStatus": "ok",
     "fieldsCovered": ja(["model", "cpu", "ram", "gpu", "storage", "screen", "year"]), "notes": "规格表为图片页详情。"},
    {"sourceId": "S005", "sourceUrl": "https://fe.suning.com/bigimages/12430063356.html",
     "sourceTitle": "ThinkPad R14 GEN4 21E5A0E7CD（i5-1235U 16G 512G MX550）", "publisher": "苏宁国际",
     "sourceType": "电商页面", "checkedAt": DATE, "accessStatus": "ok",
     "fieldsCovered": ja(["model", "cpu", "ram", "gpu", "storage", "screen", "year"]), "notes": ""},
    {"sourceId": "S006", "sourceUrl": "https://product.suning.com/0010360097/12433287452.html",
     "sourceTitle": "联想 ThinkPad R14 I5-1235U/8GB/512GB/MX550 2G/Win11+Office/2Y", "publisher": "苏宁易购第三方店铺",
     "sourceType": "电商页面", "checkedAt": DATE, "accessStatus": "unverified",
     "fieldsCovered": ja(["model", "cpu", "ram", "gpu", "storage", "screen", "year"]),
     "notes": "2026-11-04 复查为软 404：HTTP 200，但页面 errorCode=404、商品删除；不能作为独立佐证。"},
    {"sourceId": "S007", "sourceUrl": "https://www.easymanua.ls/lenovo/thinkpad-r14/manual?p=13",
     "sourceTitle": "Lenovo ThinkPad R14 硬件维护手册（E14/R14/S3 Gen 2 平台章节）", "publisher": "联想（easymanua.ls 手册镜像）",
     "sourceType": "服务手册", "checkedAt": DATE, "accessStatus": "ok",
     "fieldsCovered": ja(["model", "screen"]),
     "notes": "证实 R14 与 E14 Gen 2 同平台、14 英寸 1920x1080；镜像站点，非 support.lenovo.com 原链。"},
]

reviews = [
    {"reviewId": "R001", "recordType": "model", "sourceKey": "ThinkPad R14 Gen 3", "field": "model/year",
     "observedValue": "AMD Ryzen 5000 (Zen 3)，仅维基类条目记载 2021 年 4 月中国上市", "issueType": "insufficient_source",
     "confidence": "low", "importDecision": "needs_review",
     "reason": "仅检到拼写异常的维基类网址，未作为来源保存；未找到可核实的中国官网、电商或厂商规格页，未建型号。",
     "followUp": "查联想中国官网商城历史页、ZOL ThinkPad R14 Gen 3 系列页或电商自营 SKU 后补录。"},
    {"reviewId": "R002", "recordType": "model", "sourceKey": "ThinkPad R14 Gen 5", "field": "model",
     "observedValue": "基于 E14 Gen 5 平台，仅维基类条目提及", "issueType": "insufficient_source",
     "confidence": "low", "importDecision": "needs_review",
     "reason": "无中国销售证据与规格页；未建型号。", "followUp": "确认 R14 Gen 5 是否在中国上市及在售 SKU。"},
    {"reviewId": "R003", "recordType": "configuration", "sourceKey": "R14 Gen 2 (AMD)", "field": "ram",
     "observedValue": "12GB（4GB 板载 + 8GB SO-DIMM DDR4-3200，官方规格表 Max Memory 条目）", "issueType": "out_of_scope",
     "confidence": "high", "importDecision": "exclude",
     "reason": "官方支持 12GB 组合，但内置内存选项限 8/16/24/32GB；按标准保留原文于来源表，不写入选项。",
     "followUp": "如需支持 12GB 需项目侧扩内存选项后重新交付。"},
    {"reviewId": "R004", "recordType": "model", "sourceKey": "R14 Gen 2 (AMD)", "field": "year/configurations",
     "observedValue": "官方规格表证实型号及 R5-5500U/R7-5700U 等规格；2021 年仅由同系列 Intel 版推断，且没有 AMD 在售 MTM 配置", "issueType": "missing_evidence",
     "confidence": "low", "importDecision": "needs_review",
     "reason": "型号年份不能按同系列推断，且具体在售组合无可靠来源；保留研究证据，不进入可导入型号与配置 CSV。",
     "followUp": "查联想官网商城历史页/京东自营 ThinkPad R14 锐龙版 SKU，取得 AMD 版机型年份和实际配置证据。"},
    {"reviewId": "R005", "recordType": "series", "sourceKey": "ThinkPad R14", "field": "model",
     "observedValue": "是否存在 Gen 1 / 无 Gen 后缀首代（2020）未确认", "issueType": "insufficient_source",
     "confidence": "low", "importDecision": "needs_review",
     "reason": "检索到的世代表从 Gen 2 起与 E14 Gen 2 平台对应，首代存在性证据不足；未建型号。",
     "followUp": "查联想中国 2020-2021 年发布新闻稿与电商存档。"},
    {"reviewId": "R006", "recordType": "model", "sourceKey": "R14 Gen 4", "field": "source",
     "observedValue": "S005 苏宁商品页可核实 21E5A0E7CD / I5-1235U / 16GB / 512GB SSD / MX550 / FHD / 2022；原第二来源 S006 是软 404",
     "issueType": "insufficient_source", "confidence": "low", "importDecision": "needs_review",
     "reason": "目前只有一条可核实的零售来源，未达到 medium 所需的独立第二来源；本批不导入 Gen 4。",
     "followUp": "查联想官方资料或另一家可靠零售/评测来源，核实型号身份、年份及实际配置。"},
    {"reviewId": "R007", "recordType": "configuration", "sourceKey": "R14 Gen 4 / 8GB", "field": "source",
     "observedValue": "S006 原称 8GB / MX550 / 512GB SSD，但现为商品删除页面",
     "issueType": "missing_evidence", "confidence": "low", "importDecision": "needs_review",
     "reason": "8GB 配置失去可核实来源，不加入配置 CSV 或内置选项。",
     "followUp": "查可访问的原始零售页或联想 MTM 规格表。"},
]


def write_csv(path, hdr, rows):
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=hdr)
        w.writeheader()
        w.writerows(rows)


def main():
    os.makedirs(OUT, exist_ok=True)
    write_csv(os.path.join(OUT, "sku-models.csv"), MODELS_HDR, models)
    write_csv(os.path.join(OUT, "sku-configurations.csv"), CONF_HDR, configs)
    write_csv(os.path.join(OUT, "sources.csv"), SRC_HDR, sources)
    write_csv(os.path.join(OUT, "review.csv"), REV_HDR, reviews)
    print("models", len(models), "configs", len(configs), "sources", len(sources), "review", len(reviews))


if __name__ == "__main__":
    main()
