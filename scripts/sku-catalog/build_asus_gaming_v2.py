# -*- coding: utf-8 -*-
"""Merge the original ASUS gaming research with newly verified models and
structure the config combos / aliases / uncertain lists that were missing."""
import json
from pathlib import Path

BASE = Path(r"C:\Pro\Zcode\inventory_mvp\web\docs\sku-catalog\02-research")
src = json.loads((BASE / "asus-gaming.json").read_text(encoding="utf-8"))

models = src["models"]
for m in models:
    m["category"] = "游戏本"
    m["productType"] = "笔记本电脑"

CHECKED = "2026-10-26"

new_models = [
    {
        "modelKey": "笔记本电脑|ROG|幻14|2021",
        "productType": "笔记本电脑",
        "brand": "ROG",
        "model": "幻14",
        "displayName": "ROG 幻14 2021",
        "modelYear": 2021,
        "category": "游戏本",
        "cpuOptions": ["AMD 锐龙9 5900HS"],
        "ramOptions": ["16GB"],
        "gpuOptions": ["NVIDIA GeForce RTX 3060 6GB"],
        "storageOptions": ["512GB SSD", "1TB SSD"],
        "screenOptions": ["14英寸 2560x1440 120Hz IPS 100%DCI-P3"],
        "sourceUrl": "https://product.yesky.com/product/1155/1155626/param.shtml",
        "sourceTitle": "ROG 幻14 2021(R9 5900HS/16GB/512GB/RTX3060)参数 - 天极产品库",
        "checkedAt": CHECKED,
        "confidence": "high",
        "notes": "上市 2021-05（天极/PChome 产品库上市时间 2021-05-22）。16GB DDR4 3200MHz（8GB×2，板载 8GB + 1 插槽）、1.6kg、18.6mm、76Wh、100W PD 快充；首发价 10999 元（京东预约价 11999 元，6 月 1 日首发 10999 元，搜狐/电商报道）。同代另有幻14 经典版（无 LED 点阵）与幻14 星空版，配置相同、A 面不同，未单列。"
    },
    {
        "modelKey": "笔记本电脑|ROG|幻16|2022",
        "productType": "笔记本电脑",
        "brand": "ROG",
        "model": "幻16",
        "displayName": "ROG 幻16 2022",
        "modelYear": 2022,
        "category": "游戏本",
        "cpuOptions": ["Intel 酷睿i7 12700H", "Intel 酷睿i9 12900H"],
        "ramOptions": ["16GB", "32GB"],
        "gpuOptions": ["NVIDIA GeForce RTX 3060 6GB", "NVIDIA GeForce RTX 3080Ti 16GB"],
        "storageOptions": ["512GB SSD", "1TB SSD"],
        "screenOptions": ["16英寸 2560x1600 165Hz 500nits 100%DCI-P3 星云屏"],
        "sourceUrl": "https://www.ithome.com/0/602/253.htm",
        "sourceTitle": "首发 9999 元，ROG 幻 16 2022 款今晚开售：i7-12700H + RTX 3060，2K 165Hz 屏 - IT之家",
        "checkedAt": CHECKED,
        "confidence": "high",
        "notes": "2022-01-25 发布、2022-02-10 0 点开售（IT之家）。i7-12700H+RTX 3060（120W）+16GB DDR5-4800+512GB PCIe4.0 首发 9999 元（日常价 11499 元）；2022-03-15 追加 i9-12900H+RTX 3080Ti 16GB+32GB DDR5+1TB 版本，首发 22999 元（百度百科）。90Wh、100W PD、2.5G 网口、雷电4。"
    },
    {
        "modelKey": "笔记本电脑|ROG|幻14 Air|2024",
        "productType": "笔记本电脑",
        "brand": "ROG",
        "model": "幻14 Air",
        "displayName": "ROG 幻14 Air 2024",
        "modelYear": 2024,
        "category": "游戏本",
        "cpuOptions": ["AMD 锐龙9 8945HS"],
        "ramOptions": ["16GB", "32GB"],
        "gpuOptions": ["NVIDIA GeForce RTX 4050 6GB", "NVIDIA GeForce RTX 4060 8GB"],
        "storageOptions": ["1TB SSD"],
        "screenOptions": ["14英寸 2880x1800 120Hz OLED 0.2ms 500nits"],
        "sourceUrl": "https://rog.asus.com.cn/laptops/rog-zephyrus/rog-zephyrus-g14-2024/",
        "sourceTitle": "ROG 玩家国度 幻14 Air GA403 - ROG 官网产品页",
        "checkedAt": CHECKED,
        "confidence": "high",
        "notes": "2024-01 发布会发布、2024-02-27 开售（电脑报/网易）。R9 8945HS+RTX 4050 6GB+16GB+1TB 首发 10499 元；R9 8945HS+RTX 4060 8GB+32GB+1TB 首发 12499 元（铂月白/日蚀灰）。1.5kg、15.9mm、CNC 铝合金、光线矩阵 A 面；官方规格页标注 RTX 4060、2880×1800 120Hz OLED。定位「专业性能轻薄本」，按游戏本归类。"
    },
    {
        "modelKey": "笔记本电脑|ROG|幻16 Air|2024",
        "productType": "笔记本电脑",
        "brand": "ROG",
        "model": "幻16 Air",
        "displayName": "ROG 幻16 Air 2024",
        "modelYear": 2024,
        "category": "游戏本",
        "cpuOptions": ["Intel 酷睿 Ultra 9 185H"],
        "ramOptions": ["32GB"],
        "gpuOptions": ["NVIDIA GeForce RTX 4060 8GB", "NVIDIA GeForce RTX 4070 8GB"],
        "storageOptions": ["1TB SSD"],
        "screenOptions": ["16英寸 2560x1600 240Hz 100%DCI-P3 OLED 星云屏"],
        "sourceUrl": "https://www.163.com/dy/article/IRAB7H2T05118EDB.html",
        "sourceTitle": "ROG 幻 14/16 Air笔电开启预约抢购：专业性能轻薄本，首发10499元起 - 网易",
        "checkedAt": CHECKED,
        "confidence": "high",
        "notes": "2024-02 开售（网易/超能网）。Ultra 9 185H+RTX 4060 8GB+32GB+1TB 首发 13499 元；Ultra 9 185H+RTX 4070 8GB+32GB+1TB 首发 14999 元。1.85kg、14.9mm、90Wh、6 扬声器、杜比视界/全景声。"
    },
    {
        "modelKey": "笔记本电脑|ROG|冰刃7双屏|2023",
        "productType": "笔记本电脑",
        "brand": "ROG",
        "model": "冰刃7双屏",
        "displayName": "ROG 冰刃7双屏 2023",
        "modelYear": 2023,
        "category": "游戏本",
        "cpuOptions": ["AMD 锐龙9 7945HX"],
        "ramOptions": ["16GB", "32GB", "64GB"],
        "gpuOptions": ["NVIDIA GeForce RTX 4070 8GB", "NVIDIA GeForce RTX 4080 12GB", "NVIDIA GeForce RTX 4090 16GB"],
        "storageOptions": ["1TB SSD", "4TB SSD"],
        "screenOptions": ["16英寸 2560x1600 240Hz Mini LED 1100nits + 14.1英寸 3840x1100 副屏"],
        "sourceUrl": "https://news.qq.com/rain/a/20230313A03DM900",
        "sourceTitle": "ROG冰刃7双屏游戏本上架：配备240Hz Mini-LED屏，起售价29999元 - 腾讯新闻",
        "checkedAt": CHECKED,
        "confidence": "high",
        "notes": "2023-02 发布、2023-03-15 首发（腾讯新闻/ZOL）。R9 7945HX（16 核 32 线程）+RTX 4070/4080/4090，最高 64GB DDR5-4800 + 4TB PCIe4.0，起售价 29999 元；顶配 RTX 4090+64GB+4TB 首发 54999 元。主屏 16 英寸 2560×1600 240Hz Mini LED 1024 分区 1100nits，副屏 14.1 英寸 3840×1100 触控（支持触控笔）。2.5kg、90Wh、100W PD。"
    },
    {
        "modelKey": "笔记本电脑|ROG|魔霸新锐|2024",
        "productType": "笔记本电脑",
        "brand": "ROG",
        "model": "魔霸新锐",
        "displayName": "ROG 魔霸新锐 2024",
        "modelYear": 2024,
        "category": "游戏本",
        "cpuOptions": ["Intel 酷睿i9 13980HX"],
        "ramOptions": ["16GB"],
        "gpuOptions": ["NVIDIA GeForce RTX 4060 8GB"],
        "storageOptions": ["1TB SSD"],
        "screenOptions": ["16英寸 2560x1600 240Hz 500nits 100%DCI-P3 星云屏"],
        "sourceUrl": "https://www.ithome.com/0/743/090.htm",
        "sourceTitle": "10499 元，华硕 ROG 魔霸新锐 2024 游戏本上架：i9-13980HX + RTX 4060 - IT之家",
        "checkedAt": CHECKED,
        "confidence": "high",
        "notes": "2024-01-09 20:00 开售，首发到手价 10499 元（IT之家）。i9-13980HX（24 核 32 线程，CPU 单烤 135W）+RTX 4060 140W 满功耗+16GB DDR5+1TB PCIe4.0；整机 195W；预留内存插槽与 M.2，最高 64GB、支持 RAID 0。注意与「魔霸新锐 2023」（R9 7940HX 平台）区分，本行为 2024 款。"
    },
    {
        "modelKey": "笔记本电脑|ROG|魔霸6|2022",
        "productType": "笔记本电脑",
        "brand": "ROG",
        "model": "魔霸6",
        "displayName": "ROG 魔霸6 2022",
        "modelYear": 2022,
        "category": "游戏本",
        "cpuOptions": ["AMD 锐龙9 6900HX"],
        "ramOptions": ["16GB"],
        "gpuOptions": ["NVIDIA GeForce RTX 3060 6GB", "NVIDIA GeForce RTX 3070Ti 8GB"],
        "storageOptions": ["1TB SSD"],
        "screenOptions": ["15.6英寸 2560x1440 165Hz 3ms 100%DCI-P3"],
        "sourceUrl": "https://rog.asus.com.cn/laptops/rog-strix/rog-strix-g15-2022-series/spec",
        "sourceTitle": "ROG 魔霸6/魔霸新锐 (2022) 规格参数 - ROG 官网",
        "checkedAt": CHECKED,
        "confidence": "high",
        "notes": "2022-01-05 CES 发布、2022-02 开售（百度百科/ZOL）。R9 6900HX+RTX 3060 140W 版首发 11999 元；RTX 3070Ti 为 150W 满功耗。16GB DDR5-4800（单条，2×SO-DIMM，最高 64GB）、1TB PCIe4.0、90Wh、100W PD、Wi-Fi 6E+2.5G 网口。官网规格页含 G513RM/G513RW 多个 SKU 代码。"
    },
    {
        "modelKey": "笔记本电脑|ROG|枪神9|2025",
        "productType": "笔记本电脑",
        "brand": "ROG",
        "model": "枪神9",
        "displayName": "ROG 枪神9 2025",
        "modelYear": 2025,
        "category": "游戏本",
        "cpuOptions": ["Intel 酷睿 Ultra 9 275HX"],
        "ramOptions": ["16GB", "32GB", "64GB"],
        "gpuOptions": ["NVIDIA GeForce RTX 5080 16GB", "NVIDIA GeForce RTX 5090 24GB"],
        "storageOptions": ["1TB SSD", "2TB SSD"],
        "screenOptions": ["16英寸 2560x1600 240Hz 100%DCI-P3 Mini LED 1200nits"],
        "sourceUrl": "https://www.163.com/dy/article/JPB4DTQ00511CEBF.html",
        "sourceTitle": "ROG 枪神 9 / Plus 系列游戏本发布：最高可选酷睿 Ultra 9 275HX + RTX 5090 - 网易（转 IT之家）",
        "checkedAt": CHECKED,
        "confidence": "high",
        "notes": "2025-02-25 ROG 2025 发布会发布并开启预约（网易/IT之家）。枪神9 超竞版（16 英寸）：U9-275HX+RTX 5080+32GB+1TB 日常价 24999 元（国补 22999 元）；U9-275HX+RTX 5090+32GB+1TB 日常价 29999 元（国补 27999 元）。整机 250W（CPU 75W+GPU 175W）、90Wh、双雷电5、Wi-Fi 7。本行合并记录枪神9 与枪神9 超竞版两个销售名，notes 已注明差异，如需严格拆分请见待核实表。"
    },
    {
        "modelKey": "笔记本电脑|ROG|枪神9 Plus|2025",
        "productType": "笔记本电脑",
        "brand": "ROG",
        "model": "枪神9 Plus",
        "displayName": "ROG 枪神9 Plus 2025",
        "modelYear": 2025,
        "category": "游戏本",
        "cpuOptions": ["Intel 酷睿 Ultra 9 275HX"],
        "ramOptions": ["16GB", "32GB", "64GB"],
        "gpuOptions": ["NVIDIA GeForce RTX 5070Ti 12GB", "NVIDIA GeForce RTX 5080 16GB", "NVIDIA GeForce RTX 5090 24GB"],
        "storageOptions": ["1TB SSD", "2TB SSD"],
        "screenOptions": ["18英寸 2560x1600 240Hz 100%DCI-P3 500nits"],
        "sourceUrl": "https://www.163.com/dy/article/JPB4DTQ00511CEBF.html",
        "sourceTitle": "ROG 枪神 9 / Plus 系列游戏本发布：最高可选酷睿 Ultra 9 275HX + RTX 5090 - 网易（转 IT之家）",
        "checkedAt": CHECKED,
        "confidence": "high",
        "notes": "2025-02-25 发布（网易/IT之家）。枪神9 Plus（18 英寸）：U9-275HX+RTX 5080+16GB+1TB 日常价 21999 元（国补 19999 元）；Plus 超竞版：RTX 5080+32GB+1TB 25999 元（国补 23999 元）、RTX 5090+64GB+2TB 33999 元（国补 31999 元）；RTX 5070Ti 版本价格待公布。250W 整机、90Wh、双雷电5。"
    },
    {
        "modelKey": "笔记本电脑|华硕|天选Air|2024",
        "productType": "笔记本电脑",
        "brand": "华硕",
        "model": "天选Air",
        "displayName": "华硕 天选Air 2024",
        "modelYear": 2024,
        "category": "游戏本",
        "cpuOptions": ["AMD 锐龙7 8845H", "AMD 锐龙 AI 9 HX 370"],
        "ramOptions": ["16GB", "32GB"],
        "gpuOptions": ["NVIDIA GeForce RTX 4050 6GB", "NVIDIA GeForce RTX 4060 8GB"],
        "storageOptions": ["512GB SSD", "1TB SSD"],
        "screenOptions": ["14英寸 2560x1600 165Hz 400nits 100%sRGB"],
        "sourceUrl": "https://www.asus.com.cn/laptops/for-gaming/tuf-gaming/asus-tuf-gaming-a14-2024/techspec/",
        "sourceTitle": "华硕天选Air (2024) 规格参数 - 华硕官网",
        "checkedAt": CHECKED,
        "confidence": "high",
        "notes": "2024-07-22 发布、7 月开售（新华网/凤凰网）。天选家族首款 14 英寸：R7 8845H+RTX 4050+16GB+1TB 7299 元；R7 8845H+RTX 4060+16GB+1TB 7999 元；Ryzen AI 9 HX 370+RTX 4060+16GB+1TB 8999 元；HX 370+RTX 4060+32GB+1TB 9499 元。板载 LPDDR5X 7500（16GB 或 32GB，不可扩展）、1.46kg、16.9mm、73Wh、110W 整机释放。官网 techspec 含 FA401UU/UV/WV 三个型号代码。"
    }
]
models.extend(new_models)

# ---------- config combos ----------
C = []

def combo(key, cpu, ram, gpu, storage, screen, url, title, price="", conf="high", note=""):
    C.append({
        "modelKey": key, "cpu": cpu, "ram": ram, "gpu": gpu, "storage": storage,
        "screen": screen, "sourceUrl": url, "sourceTitle": title,
        "confidence": conf, "notes": (price + ("；" if price and note else "") + note).strip("；")
    })

# 天选 2020
combo("笔记本电脑|华硕|天选|2020", "AMD 锐龙7 4800H", "8GB", "NVIDIA GeForce GTX 1660Ti 6GB", "512GB SSD",
      "15.6英寸 1920x1080 144Hz IPS", "https://nb.zol.com.cn/740/7403076.html",
      "华硕天选游戏本首发：6299 元起 - 中关村在线", "首发价 6299 元")
combo("笔记本电脑|华硕|天选|2020", "AMD 锐龙7 4800H", "8GB", "NVIDIA GeForce RTX 2060 6GB", "512GB SSD",
      "15.6英寸 1920x1080 144Hz IPS", "https://nb.zol.com.cn/740/7403076.html",
      "华硕天选游戏本首发：6299 元起 - 中关村在线", "首发价 6599 元")
# 天选2 2021
combo("笔记本电脑|华硕|天选2|2021", "AMD 锐龙9 5900HX", "16GB", "NVIDIA GeForce RTX 3070 8GB", "512GB SSD",
      "15.6英寸 2560x1440 165Hz 100%DCI-P3", "https://detail.zol.com.cn/notebook/index1384329.shtml",
      "华硕天选2(R9 5900HX/16GB/512GB/RTX3060/165Hz) - 中关村在线", "2021-08-05 开售，首发价 9999 元")
combo("笔记本电脑|华硕|天选2|2021", "AMD 锐龙7 4800H", "16GB", "NVIDIA GeForce RTX 3050Ti 4GB", "512GB SSD",
      "15.6英寸 1920x1080 144Hz", "https://detail.zol.com.cn/series/16/37546_1.html",
      "华硕天选2 系列 - 中关村在线产品库", "2021-09 在售，参考价 6699 元")
# 天选5 Pro 2024
combo("笔记本电脑|华硕|天选5 Pro|2024", "Intel 酷睿i9 14900HX", "16GB", "NVIDIA GeForce RTX 4070 8GB", "1TB SSD",
      "16英寸 2560x1600 165Hz 400nits 100%sRGB", "https://detail.zol.com.cn/notebook/index1975420.shtml",
      "华硕天选5 Pro(i9 14900HX/16GB/1TB/RTX4070) - 中关村在线")
# 天选6 2025
combo("笔记本电脑|华硕|天选6|2025", "AMD 锐龙 AI 9 HX 370", "", "NVIDIA GeForce RTX 5070 8GB", "",
      "16英寸 2560x1600 165Hz 400nits 100%sRGB", "https://m.ithome.com/html/852566.htm",
      "华硕推出新款天选 6 游戏本：锐龙 AI 9 HX 370 + RTX 5070，10499 元 - IT之家",
      "首发价 10499 元、国补价 8499 元", note="来源未逐项标注内存与存储容量，故留空")
# 枪神2 2018
combo("笔记本电脑|ROG|枪神2|2018", "Intel 酷睿i7 8750H", "16GB", "NVIDIA GeForce GTX 1070 8GB", "256GB+1TB 混合硬盘(SSD+HDD)",
      "15.6英寸 1920x1080 144Hz", "https://detail.zol.com.cn/tablepc/index1218113.shtml",
      "ROG 枪神2 GL504GS8750(16GB/256GB+1TB) - 中关村在线", "参考报价 14999 元")
# 枪神3 2019
combo("笔记本电脑|ROG|枪神3|2019", "Intel 酷睿i7 9750H", "16GB", "NVIDIA GeForce RTX 2060 6GB", "1TB SSD",
      "15.6英寸 1920x1080 240Hz 3ms", "https://nb.zol.com.cn/717/7170046.html",
      "ROG 枪神3 京东预售 - 中关村在线", "预售 16999 元")
combo("笔记本电脑|ROG|枪神3|2019", "Intel 酷睿i7 9750H", "16GB", "NVIDIA GeForce RTX 2070 8GB", "1TB SSD",
      "15.6英寸 1920x1080 240Hz 3ms", "https://nb.zol.com.cn/717/7170046.html",
      "ROG 枪神3 京东预售 - 中关村在线", "预售 18999 元")
# 魔霸3 2019
combo("笔记本电脑|ROG|魔霸3|2019", "Intel 酷睿i7 9750H", "16GB", "NVIDIA GeForce GTX 1660Ti 6GB", "512GB SSD",
      "15.6英寸 1920x1080 144Hz IPS", "https://detail.zol.com.cn/notebook/index1270668.shtml",
      "ROG 魔霸3(i7 9750H/16GB/512GB/RTX2060) - 中关村在线", "市场价 9999 元")
combo("笔记本电脑|ROG|魔霸3|2019", "Intel 酷睿i7 9750H", "16GB", "NVIDIA GeForce RTX 2060 6GB", "512GB SSD",
      "15.6英寸 1920x1080 144Hz IPS", "https://detail.zol.com.cn/notebook/index1270668.shtml",
      "ROG 魔霸3(i7 9750H/16GB/512GB/RTX2060) - 中关村在线", "参考报价 12999 元")
# 枪神4 2020
combo("笔记本电脑|ROG|枪神4|2020", "Intel 酷睿i7 10875H", "16GB", "NVIDIA GeForce RTX 2070 Super 8GB", "1TB SSD",
      "15.6英寸 1920x1080 300Hz 3ms 100%sRGB", "https://m.ithome.com/html/490187.htm",
      "ROG 枪神 4 游戏本发布：8 核 i7-10875H + 300Hz 屏 - IT之家", "2020-06-11 开卖，到手价不高于 16999 元")
# 枪神5 2021
combo("笔记本电脑|ROG|枪神5|2021", "AMD 锐龙9 5900HX", "32GB", "NVIDIA GeForce RTX 3070 8GB", "1TB SSD",
      "15.6英寸 1920x1080 300Hz 3ms 100%sRGB", "https://nb.zol.com.cn/761/7616990.html",
      "ROG 枪神5 首发 - 中关村在线", "首发价 16999 元")
# 魔霸5R 2021
combo("笔记本电脑|ROG|魔霸5R|2021", "AMD 锐龙9 5900HX", "16GB", "AMD Radeon RX 6800M 12GB", "512GB SSD",
      "15.6英寸 1920x1080 300Hz 3ms 100%sRGB", "https://nb.zol.com.cn/772/7727698.html",
      "190W性能核弹释放信仰之力 ROG魔霸5R真香抢购 - 中关村在线", "2021-07-15 首发 12999 元")
# 枪神6 2022
combo("笔记本电脑|ROG|枪神6|2022", "Intel 酷睿i9 12900H", "16GB", "NVIDIA GeForce RTX 3070Ti 8GB", "1TB SSD",
      "15.6英寸 2560x1440 240Hz 100%DCI-P3", "https://m.zol.com.cn/article/7864572.html",
      "ROG 枪神6 开卖 - 中关村在线", "2022-02-10 首发 14999 元")
# 枪神7 2023
combo("笔记本电脑|ROG|枪神7|2023", "Intel 酷睿i9 13980HX", "16GB", "NVIDIA GeForce RTX 4060 8GB", "1TB SSD",
      "16英寸 2560x1600 240Hz 500nits", "https://www.ithome.com/0/674/929.htm",
      "ROG 枪神 7 系列上架 - IT之家", "首发价 10999 元")
combo("笔记本电脑|ROG|枪神7|2023", "Intel 酷睿i9 13980HX", "16GB", "NVIDIA GeForce RTX 4070 8GB", "1TB SSD",
      "16英寸 2560x1600 240Hz 500nits", "https://www.ithome.com/0/674/929.htm",
      "ROG 枪神 7 系列上架 - IT之家", "首发价 13999 元")
combo("笔记本电脑|ROG|枪神7|2023", "Intel 酷睿i9 13980HX", "32GB", "NVIDIA GeForce RTX 4080 12GB", "1TB SSD",
      "16英寸 2560x1600 240Hz 500nits", "https://detail.zol.com.cn/series/16/10736308_1.html",
      "ROG 枪神7 超竞版 - 中关村在线", "参考报价 17999 元", note="超竞版 G634 配置，175W 显卡")
combo("笔记本电脑|ROG|枪神7|2023", "Intel 酷睿i9 13980HX", "32GB", "NVIDIA GeForce RTX 4090 16GB", "1TB SSD",
      "16英寸 2560x1600 240Hz 500nits", "https://detail.zol.com.cn/series/16/10736308_1.html",
      "ROG 枪神7 超竞版 - 中关村在线", "参考报价 21999 元", note="超竞版 G634 配置，175W 显卡")
# 魔霸7 Plus 2023
combo("笔记本电脑|ROG|魔霸7 Plus|2023", "AMD 锐龙9 7845HX", "16GB", "NVIDIA GeForce RTX 4060 8GB", "1TB SSD",
      "17.3英寸 2560x1440 240Hz 300nits", "https://nb.zol.com.cn/813/8138399.html",
      "ROG 魔霸7 Plus 开售 - 中关村在线", "2023-03-15 首发 9999 元")
combo("笔记本电脑|ROG|魔霸7 Plus|2023", "AMD 锐龙9 7845HX", "16GB", "NVIDIA GeForce RTX 4070 8GB", "1TB SSD",
      "17.3英寸 2560x1440 240Hz 300nits", "https://nb.zol.com.cn/813/8138399.html",
      "ROG 魔霸7 Plus 开售 - 中关村在线", "2023-03-15 首发 11999 元")
# 枪神8 2024
combo("笔记本电脑|ROG|枪神8|2024", "Intel 酷睿i9 14900HX", "16GB", "NVIDIA GeForce RTX 4060 8GB", "1TB SSD",
      "16英寸 2560x1600 240Hz 500nits", "https://detail.zol.com.cn/notebook/index1977457.shtml",
      "ROG 枪神8(i9 14900HX/16GB/1TB/RTX4060) - 中关村在线", "上市 11499 元起，参考报价 11999 元")
combo("笔记本电脑|ROG|枪神8|2024", "Intel 酷睿i9 14900HX", "16GB", "NVIDIA GeForce RTX 4070 8GB", "1TB SSD",
      "16英寸 2560x1600 240Hz 500nits", "https://detail.zol.com.cn/notebook/index1977457.shtml",
      "ROG 枪神8(i9 14900HX/16GB/1TB/RTX4060) - 中关村在线", "参考报价 13999 元")
# 幻14 2021
combo("笔记本电脑|ROG|幻14|2021", "AMD 锐龙9 5900HS", "16GB", "NVIDIA GeForce RTX 3060 6GB", "512GB SSD",
      "14英寸 2560x1440 120Hz 100%DCI-P3", "https://www.sohu.com/a/466828065_223764",
      "11999元起！ROG幻14新品上架：R9 5900HS+RTX3060 - 搜狐", "京东预约价 11999 元，2021-06-01 首发 10999 元")
combo("笔记本电脑|ROG|幻14|2021", "AMD 锐龙9 5900HS", "16GB", "NVIDIA GeForce RTX 3060 6GB", "1TB SSD",
      "14英寸 2560x1440 120Hz 100%DCI-P3", "https://product.yesky.com/product/1155/1155624/",
      "ROG 幻14 2021(R9 5900HS/16GB/1TB/RTX3060) - 天极产品库", "参考报价 14499 元")
# 幻16 2022
combo("笔记本电脑|ROG|幻16|2022", "Intel 酷睿i7 12700H", "16GB", "NVIDIA GeForce RTX 3060 6GB", "512GB SSD",
      "16英寸 2560x1600 165Hz 500nits", "https://www.ithome.com/0/602/253.htm",
      "首发 9999 元，ROG 幻 16 2022 款今晚开售 - IT之家", "首发价 9999 元（日常价 11499 元）")
combo("笔记本电脑|ROG|幻16|2022", "Intel 酷睿i9 12900H", "32GB", "NVIDIA GeForce RTX 3080Ti 16GB", "1TB SSD",
      "16英寸 2560x1600 165Hz 500nits", "https://baike.baidu.com/item/rog%20%E5%B9%BB16/59980534",
      "ROG 幻16 - 百度百科", "2022-03-15 开售，首发价 22999 元")
# 幻14 Air 2024
combo("笔记本电脑|ROG|幻14 Air|2024", "AMD 锐龙9 8945HS", "16GB", "NVIDIA GeForce RTX 4050 6GB", "1TB SSD",
      "14英寸 2880x1800 120Hz OLED", "https://www.163.com/dy/article/IRAB7H2T05118EDB.html",
      "ROG 幻 14/16 Air笔电开启预约抢购 - 网易", "首发价 10499 元")
combo("笔记本电脑|ROG|幻14 Air|2024", "AMD 锐龙9 8945HS", "32GB", "NVIDIA GeForce RTX 4060 8GB", "1TB SSD",
      "14英寸 2880x1800 120Hz OLED", "https://www.163.com/dy/article/IRAB7H2T05118EDB.html",
      "ROG 幻 14/16 Air笔电开启预约抢购 - 网易", "首发价 12499 元")
# 幻16 Air 2024
combo("笔记本电脑|ROG|幻16 Air|2024", "Intel 酷睿 Ultra 9 185H", "32GB", "NVIDIA GeForce RTX 4060 8GB", "1TB SSD",
      "16英寸 2560x1600 240Hz OLED", "https://www.163.com/dy/article/IRAB7H2T05118EDB.html",
      "ROG 幻 14/16 Air笔电开启预约抢购 - 网易", "首发价 13499 元")
combo("笔记本电脑|ROG|幻16 Air|2024", "Intel 酷睿 Ultra 9 185H", "32GB", "NVIDIA GeForce RTX 4070 8GB", "1TB SSD",
      "16英寸 2560x1600 240Hz OLED", "https://www.163.com/dy/article/IRAB7H2T05118EDB.html",
      "ROG 幻 14/16 Air笔电开启预约抢购 - 网易", "首发价 14999 元")
# 冰刃7双屏 2023
combo("笔记本电脑|ROG|冰刃7双屏|2023", "AMD 锐龙9 7945HX", "32GB", "NVIDIA GeForce RTX 4080 12GB", "1TB SSD",
      "16英寸 2560x1600 240Hz Mini LED + 14.1英寸 3840x1100", "https://news.qq.com/rain/a/20230313A03DM900",
      "ROG冰刃7双屏游戏本上架 - 腾讯新闻", "起售价 29999 元（2023-03-15 首发）")
combo("笔记本电脑|ROG|冰刃7双屏|2023", "AMD 锐龙9 7945HX", "64GB", "NVIDIA GeForce RTX 4090 16GB", "4TB SSD",
      "16英寸 2560x1600 240Hz Mini LED + 14.1英寸 3840x1100", "https://news.qq.com/rain/a/20230313A04HYH00",
      "CPU、显卡、内存全都满配 ROG冰刃7双屏游戏本54999元首发 - 腾讯新闻", "首发价 54999 元")
# 魔霸新锐 2024
combo("笔记本电脑|ROG|魔霸新锐|2024", "Intel 酷睿i9 13980HX", "16GB", "NVIDIA GeForce RTX 4060 8GB", "1TB SSD",
      "16英寸 2560x1600 240Hz 500nits", "https://www.ithome.com/0/743/090.htm",
      "10499 元，华硕 ROG 魔霸新锐 2024 游戏本上架 - IT之家", "首发到手价 10499 元")
# 魔霸6 2022
combo("笔记本电脑|ROG|魔霸6|2022", "AMD 锐龙9 6900HX", "16GB", "NVIDIA GeForce RTX 3060 6GB", "1TB SSD",
      "15.6英寸 2560x1440 165Hz 100%DCI-P3", "https://baike.baidu.com/item/rog%E9%AD%94%E9%9C%B86/59804629",
      "ROG魔霸6 - 百度百科", "首发价 11999 元（RTX 3060 140W）")
combo("笔记本电脑|ROG|魔霸6|2022", "AMD 锐龙9 6900HX", "16GB", "NVIDIA GeForce RTX 3070Ti 8GB", "1TB SSD",
      "15.6英寸 2560x1440 165Hz 100%DCI-P3", "https://rog.asus.com.cn/laptops/rog-strix/rog-strix-g15-2022-series/spec",
      "ROG 魔霸6/魔霸新锐 (2022) 规格参数 - ROG 官网", note="官网规格页 G513RW 配置，150W RTX 3070Ti")
# 枪神9 2025
combo("笔记本电脑|ROG|枪神9|2025", "Intel 酷睿 Ultra 9 275HX", "32GB", "NVIDIA GeForce RTX 5080 16GB", "1TB SSD",
      "16英寸 2560x1600 240Hz Mini LED 1200nits", "https://www.163.com/dy/article/JPB4DTQ00511CEBF.html",
      "ROG 枪神 9 / Plus 系列游戏本发布 - 网易", "日常价 24999 元，国补价 22999 元")
combo("笔记本电脑|ROG|枪神9|2025", "Intel 酷睿 Ultra 9 275HX", "32GB", "NVIDIA GeForce RTX 5090 24GB", "1TB SSD",
      "16英寸 2560x1600 240Hz Mini LED 1200nits", "https://www.163.com/dy/article/JPB4DTQ00511CEBF.html",
      "ROG 枪神 9 / Plus 系列游戏本发布 - 网易", "日常价 29999 元，国补价 27999 元")
# 枪神9 Plus 2025
combo("笔记本电脑|ROG|枪神9 Plus|2025", "Intel 酷睿 Ultra 9 275HX", "16GB", "NVIDIA GeForce RTX 5080 16GB", "1TB SSD",
      "18英寸 2560x1600 240Hz 500nits", "https://www.163.com/dy/article/JPB4DTQ00511CEBF.html",
      "ROG 枪神 9 / Plus 系列游戏本发布 - 网易", "日常价 21999 元，国补价 19999 元")
combo("笔记本电脑|ROG|枪神9 Plus|2025", "Intel 酷睿 Ultra 9 275HX", "64GB", "NVIDIA GeForce RTX 5090 24GB", "2TB SSD",
      "18英寸 2560x1600 240Hz 500nits", "https://www.163.com/dy/article/JPB4DTQ00511CEBF.html",
      "ROG 枪神 9 / Plus 系列游戏本发布 - 网易", "日常价 34999 元，国补价 31999 元", note="枪神9 Plus 超竞版")
# 天选Air 2024
combo("笔记本电脑|华硕|天选Air|2024", "AMD 锐龙7 8845H", "16GB", "NVIDIA GeForce RTX 4050 6GB", "1TB SSD",
      "14英寸 2560x1600 165Hz 400nits", "https://www.163.com/dy/article/J7PB233005118EDB.html",
      "华硕发布天选Air 2024笔记本 - 网易", "首发价 7299 元")
combo("笔记本电脑|华硕|天选Air|2024", "AMD 锐龙7 8845H", "16GB", "NVIDIA GeForce RTX 4060 8GB", "1TB SSD",
      "14英寸 2560x1600 165Hz 400nits", "https://www.163.com/dy/article/J7PB233005118EDB.html",
      "华硕发布天选Air 2024笔记本 - 网易", "首发价 7999 元")
combo("笔记本电脑|华硕|天选Air|2024", "AMD 锐龙 AI 9 HX 370", "16GB", "NVIDIA GeForce RTX 4060 8GB", "1TB SSD",
      "14英寸 2560x1600 165Hz 400nits", "https://www.163.com/dy/article/J7PB233005118EDB.html",
      "华硕发布天选Air 2024笔记本 - 网易", "首发价 8999 元")
combo("笔记本电脑|华硕|天选Air|2024", "AMD 锐龙 AI 9 HX 370", "32GB", "NVIDIA GeForce RTX 4060 8GB", "1TB SSD",
      "14英寸 2560x1600 165Hz 400nits", "https://www.163.com/dy/article/J7PB233005118EDB.html",
      "华硕发布天选Air 2024笔记本 - 网易", "首发价 9499 元")

# ---------- aliases ----------
A = []

def alias(key, name, typ, note=""):
    A.append({"alias": name, "modelKey": key, "aliasType": typ, "note": note})

alias("笔记本电脑|华硕|天选|2020", "华硕天选", "常见搜索写法")
alias("笔记本电脑|华硕|天选|2020", "天选FA506", "型号代码", "FA506IU/FA506IV 等子型号")
alias("笔记本电脑|华硕|天选|2020", "TUF Gaming F15/A15", "英文名", "海外同代系列名")
alias("笔记本电脑|华硕|天选2|2021", "华硕天选2", "常见搜索写法")
alias("笔记本电脑|华硕|天选3|2022", "华硕天选3", "常见搜索写法")
alias("笔记本电脑|华硕|天选4|2023", "华硕天选4", "常见搜索写法")
alias("笔记本电脑|华硕|天选5|2024", "华硕天选5", "常见搜索写法")
alias("笔记本电脑|华硕|天选5 Pro|2024", "天选5Pro", "无空格简称")
alias("笔记本电脑|华硕|天选6|2025", "华硕天选6", "常见搜索写法")
alias("笔记本电脑|华硕|天选7|2026", "华硕天选7", "常见搜索写法")
alias("笔记本电脑|华硕|天选7 Pro|2026", "天选7Pro", "无空格简称")
alias("笔记本电脑|华硕|天选7 Pro Max|2026", "天选7 ProMax", "无空格简称")
alias("笔记本电脑|华硕|天选Air|2024", "华硕天选Air", "常见搜索写法")
alias("笔记本电脑|华硕|天选Air|2024", "TUF Gaming A14", "英文名", "2024 款 14 英寸")
alias("笔记本电脑|ROG|枪神2|2018", "ROG枪神2", "常见搜索写法")
alias("笔记本电脑|ROG|枪神2|2018", "STRIX SCAR II", "英文名")
alias("笔记本电脑|ROG|枪神3|2019", "ROG枪神3", "常见搜索写法")
alias("笔记本电脑|ROG|枪神4|2020", "ROG枪神4", "常见搜索写法")
alias("笔记本电脑|ROG|枪神5|2021", "ROG枪神5", "常见搜索写法")
alias("笔记本电脑|ROG|枪神6|2022", "ROG枪神6", "常见搜索写法")
alias("笔记本电脑|ROG|枪神7|2023", "ROG枪神7", "常见搜索写法")
alias("笔记本电脑|ROG|枪神7|2023", "枪神7 超竞版", "销售名称", "G634，RTX4080/4090 175W 版本")
alias("笔记本电脑|ROG|枪神8|2024", "ROG枪神8", "常见搜索写法")
alias("笔记本电脑|ROG|枪神9|2025", "ROG枪神9", "常见搜索写法")
alias("笔记本电脑|ROG|枪神9|2025", "枪神9 超竞版", "销售名称", "16 英寸光显矩阵版")
alias("笔记本电脑|ROG|枪神9 Plus|2025", "枪神9Plus", "无空格简称")
alias("笔记本电脑|ROG|魔霸3|2019", "ROG魔霸3", "常见搜索写法")
alias("笔记本电脑|ROG|魔霸5R|2021", "魔霸5R", "常见搜索写法", "ROG×AMD 双 A 平台")
alias("笔记本电脑|ROG|魔霸6|2022", "ROG魔霸6", "常见搜索写法")
alias("笔记本电脑|ROG|魔霸7 Plus|2023", "魔霸7Plus", "无空格简称")
alias("笔记本电脑|ROG|魔霸新锐|2024", "ROG魔霸新锐", "常见搜索写法")
alias("笔记本电脑|ROG|魔霸新锐|2024", "魔霸新锐2024", "年份写法")
alias("笔记本电脑|ROG|幻14|2021", "ROG幻14", "常见搜索写法")
alias("笔记本电脑|ROG|幻14|2021", "Zephyrus G14", "英文名")
alias("笔记本电脑|ROG|幻16|2022", "ROG幻16", "常见搜索写法")
alias("笔记本电脑|ROG|幻16|2022", "Zephyrus G16", "英文名")
alias("笔记本电脑|ROG|幻14 Air|2024", "幻14Air", "无空格简称")
alias("笔记本电脑|ROG|幻14 Air|2024", "Zephyrus G14 Air", "英文名")
alias("笔记本电脑|ROG|幻16 Air|2024", "幻16Air", "无空格简称")
alias("笔记本电脑|ROG|冰刃7双屏|2023", "ROG冰刃7", "常见搜索写法")
alias("笔记本电脑|ROG|冰刃7双屏|2023", "Zephyrus Duo 16", "英文名")

# ---------- uncertain ----------
U = [
    {"model": "2016-2017 ROG 国行早期型号（GFX/GL502/GL702 等）",
     "issue": "未检索到国行「枪神/魔霸」命名与 2016-2017 上市年份的可访问一手来源，仅有海外型号资料。",
     "suggestion": "如确需 2016-2017 游戏本，请以华硕中国官网存档页或当年国行发布会报道核实命名后再收录。",
     "sourceUrl": ""},
    {"model": "天选3 Plus / 天选3 Air",
     "issue": "2022-02 与天选3 同场发布，但未找到独立可访问规格页，配置与天选3 高度重叠。",
     "suggestion": "以华硕官网 FA507/FA517 系列 techspec 核实后单独收录；暂不并入天选3。",
     "sourceUrl": "https://detail.zol.com.cn/series/16/37546_1.html"},
    {"model": "天选4 Plus / 天选4R",
     "issue": "天选4 的衍生型号（17.3 英寸 360Hz；R7 7735H+RX7600S），仅有媒体报价 9499/7499 元，缺独立规格页。",
     "suggestion": "补充官网 techspec 或京东自营 SKU 页后单独收录，不要与天选4 合并。",
     "sourceUrl": "https://wap.zol.com.cn/1467/1466071/index.html"},
    {"model": "天选6 Pro",
     "issue": "i7-14650HX/Ultra 9 275HX + RTX5060/5070 版本，未找到独立规格页，仅出现在媒体汇总中。",
     "suggestion": "以华硕官网 2025 款 techspec 核实后收录。",
     "sourceUrl": "https://m.ithome.com/html/852566.htm"},
    {"model": "枪神4 Plus / 枪神6 Plus / 枪神8 Plus / 枪神8 超竞版",
     "issue": "与标准版同年发布的大屏或高配变体，配置和价格散见于媒体，缺独立可访问规格页；本目录仅在标准版 notes 中记录，未单列。",
     "suggestion": "如采购需要 17.3/18 英寸版本，请按官网规格页单独建档。",
     "sourceUrl": ""},
    {"model": "魔霸5R Plus / 魔霸7 Plus 超能版",
     "issue": "同上：衍生高配版本，媒体价 13999 元/未标价，缺独立规格页。",
     "suggestion": "补充官网规格页后单独收录。",
     "sourceUrl": ""},
    {"model": "魔霸新锐 2023",
     "issue": "2023 款为 R9 7940HX 平台，与 2024 款（i9-13980HX）为不同机型；本次仅收录 2024 款，2023 款缺可靠规格页。",
     "suggestion": "以 ROG 官网 2023 款规格页核实后补录，注意不要与 2024 款合并。",
     "sourceUrl": ""},
    {"model": "枪神7 Plus",
     "issue": "18 英寸版本，媒体价 12499/14999 元，但未找到独立规格页；与枪神7 同代不同尺寸。",
     "suggestion": "如需 18 英寸，按官网 G834 规格页单独建档。",
     "sourceUrl": "https://www.ithome.com/0/674/929.htm"},
    {"model": "幻16 2023 / 幻14 2023 / 幻13 系列",
     "issue": "2023 款幻系列（含星空版、翻转版）未在本轮检索到稳定规格页，暂未收录。",
     "suggestion": "以 ROG 官网 2023 款产品页核实后补录；2023 与 2024 款模具不同，不要合并。",
     "sourceUrl": ""},
    {"model": "枪神9 与枪神9 超竞版 的 SKU 边界",
     "issue": "媒体与电商常把 16 英寸的枪神9 与枪神9 超竞版混用；两者 A 面光显矩阵与部分配置不同。本目录合并为「枪神9」并在 notes 说明。",
     "suggestion": "导入前确认采购实物是否为超竞版；如需严格区分，请拆分并补充各自规格页。",
     "sourceUrl": "https://www.163.com/dy/article/JPB4DTQ00511CEBF.html"}
]

scope = src["scope"]
scope["researchDate"] = "2026-10-23（首轮）/ 2026-10-26（补齐）"
scope["checkedAt"] = CHECKED
scope["modelCount"] = len(models)
scope["configComboCount"] = len(C)
scope["notes"] = ("同一型号不同屏幕/配色/平台变体在 notes 说明；配置组合仅收录来源证明确实销售过的搭配，未做笛卡尔积；"
                  "2016/2017 及证据不足型号见 uncertain。2026-10-26 补齐幻14/幻16/幻Air/冰刃7双屏/魔霸6/魔霸新锐/枪神9 系列，"
                  "并把首轮写在 notes 中的配置组合结构化。")

out = {"scope": scope, "models": models, "configCombos": C, "aliases": A, "uncertain": U}
(BASE / "asus-gaming-v2.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

keys = {m["modelKey"] for m in models}
bad = [c["modelKey"] for c in C if c["modelKey"] not in keys] + [a["modelKey"] for a in A if a["modelKey"] not in keys]
print("models", len(models), "combos", len(C), "aliases", len(A), "uncertain", len(U))
print("dangling keys:", bad)
print("dup modelKeys:", len(models) - len(keys))
