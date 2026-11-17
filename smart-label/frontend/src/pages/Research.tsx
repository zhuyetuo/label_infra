import { useMemo } from "react";
import { Alert, Anchor, Card, Col, Progress, Row, Space, Steps, Table, Tag, Timeline, Tooltip, Typography, theme } from "antd";
import type { ColumnsType } from "antd/es/table";

const { Title, Text, Paragraph, Link } = Typography;

/**
 * 行业调研：宠物可穿戴设备的来时路（学术 / 产业里程碑）、识别方法演进、竞品拆解、
 * 我们抓挠识别跟公开基线的对比、下一步想法。纯静态内容，数字截至 2026-11。
 * 竞品功能以厂商当期公开资料为准；虚线标签是根据硬件和功能做的推断，没有官方证实。
 */

type Kind = "a" | "i"; // 学术 / 产业
const MILESTONES: { year: string; kind: Kind; title: string; text: string }[] = [
  { year: "2006", kind: "a", title: "Nuttall & McEwan：用活动计客观量化瘙痒", text: "Vet Dermatology。第一次把「狗挠了多少」从主人打分换成传感器计数，给后来的瘙痒监测定了题。" },
  { year: "2007", kind: "a", title: "Hansen 等：Actical 加速度计验证犬只日常活动", text: "兽医研究开始用加速度计的活动量做终点指标，用于关节炎、疼痛药效评估。" },
  { year: "2012", kind: "i", title: "PetPace、Whistle、Tractive 先后成立", text: "PetPace 主打兽医级生命体征，Whistle 做活动量，Tractive 做 GPS 定位，三条路线从这时分开。" },
  { year: "2013", kind: "a", title: "Gerencsér 等（PLOS ONE）、Ladha 等（UbiComp）", text: "惯性传感器 + 手工特征 + SVM / 决策树，在受控场景下区分走、跑、坐、躺，开启「犬行为识别」这个方向。" },
  { year: "2013–14", kind: "i", title: "FitBark 众筹上市", text: "「狗的 Fitbit」：只做活动量和睡眠评分，第二代的代表。" },
  { year: "2016", kind: "i", title: "Mars Petcare 收购 Whistle", text: "宠物食品巨头入场，背后是 Waltham 研究所和 Banfield 连锁医院，数据开始跟兽医体系打通。" },
  { year: "2017–18", kind: "i", title: "Fi 项圈上市；Sure Petcare 推出 Animo", text: "Fi 把 GPS 做成项圈本体；Animo 是第一批在消费端标出「抓挠、吠叫、甩动」的产品，三轴加速度。" },
  { year: "2018", kind: "a", title: "Griffies 等：传感器专门量化瘙痒行为", text: "BMC Vet Research，Vetrax 传感器。抓挠灵敏度 76.85%、特异度 99.73%，同时识别甩头。抓挠检测第一次有了公开基线。" },
  { year: "2019", kind: "i", title: "Pet Insight Project 启动", text: "Mars / Whistle / Kinship 招募数万只狗长期佩戴，把舔、挠和皮肤病就诊记录关联起来。" },
  { year: "2021", kind: "a", title: "Chambers 等：单项圈加速度计深度学习，真实世界验证", text: "Animals 期刊。5000+ 段视频、2500+ 只狗标注，1100 万狗·天线上数据，只用三轴加速度。喝水 0.949 / 0.999、吃 0.988 / 0.983（灵敏 / 特异），抓挠灵敏度约 0.87；项圈位置对效果没有可测影响。" },
  { year: "2021–22", kind: "a", title: "Kumpulainen / Vehkaoja：45 只狗公开六轴数据集", text: "项圈 + 胸背带双传感器、100 Hz、7 种行为。项圈最好 75%，胸背带 91%，项圈位置本身就是难点。" },
  { year: "2022–24", kind: "i", title: "Invoxia Minitailz：项圈上测心率呼吸", text: "2022 年发布，CES 2024 推 AI 版。官方说法是运动传感器 + 深度学习测静息心率和呼吸（也有报道称是雷达），能提示心律异常。" },
  { year: "2023–24", kind: "a", title: "BEBE 基准 + 自监督预训练", text: "Earth Species Project：9 个物种、1654 小时佩戴数据。深度网络在全部数据集上胜过经典方法；用 70 万小时人类手腕数据自监督预训练的模型，标注少时优势最大。" },
  { year: "2025.01–06", kind: "i", title: "Tractive 加心率 / 呼吸 / 吠叫；Fi Series 3+ 上 AI 行为", text: "两大 GPS 厂商同时转向健康。Fi 3+ 识别吠叫、舔、挠、吃、喝，官方称行为变化识别准确率 80%。" },
  { year: "2025.07–08", kind: "i", title: "Tractive 收购 Whistle，Whistle 设备 8 月 31 日停服", text: "先行者被整合：光做硬件和活动量撑不住，规模和订阅才是护城河。" },
  { year: "2026", kind: "i", title: "国内项圈从定位转向健康与行为", text: "市场规模被估在 200 亿元以上，GPS、心率、计步已同质化。妙妙宠 PAAAWOW 主打行为与情绪识别，娲宝（追觅生态）定位长期健康数据终端，也有 AI 项圈给主人「写日记」。" },
];

const LADDER = [
  { when: "2006–", title: "计数与门限", text: "活动计数、ODBA / VeDBA、幅值门限。功耗最低，只能分「动 / 不动」。" },
  { when: "2013–", title: "手工特征 + 浅层模型", text: "窗口统计、频谱、过零率，再接 SVM / RF / GBDT。可解释、MCU 能跑，80% 左右遇到天花板。" },
  { when: "2019–", title: "端到端深度网络", text: "1D-CNN、CNN-LSTM、TCN 直接吃原始波形。Whistle 2021 是代表，数据量决定上限。" },
  { when: "2023–", title: "自监督 / 基础模型", text: "先在海量无标注佩戴数据上预训练，再用少量标注微调。BEBE 证明标注少时收益最大。" },
  { when: "现在 · 我们", title: "TinyML 端侧 + 事件后处理", text: "int8 CNN 跑在 Cortex-M4F 上，动作门挡掉静止和未佩戴，Viterbi 稳定成片段，按片段评估。", ours: true },
];

type T = [string, "pub" | "inf" | "dead"];
interface Rival { key: string; name: string; sub?: string; sensor: string; what: string; tech: T[]; acc: string; biz: string; ours?: boolean }
const RIVALS: Rival[] = [
  { key: "whistle", name: "Whistle Health / FIT", sub: "Mars Petcare", sensor: "三轴加速度（行为只用它），GPS / 蜂窝", what: "吃、喝、舔、挠、蹭、嗅、被抚摸、睡眠",
    tech: [["深度学习 · 单项圈加速度", "pub"], ["5000+ 视频标注", "pub"], ["云端推理为主", "inf"]], acc: "喝水 0.949/0.999\n吃 0.988/0.983\n挠 约 0.87 灵敏", biz: "2025-08-31 停服，并入 Tractive" },
  { key: "fi", name: "Fi Series 3+", sensor: "加速度、GPS、LTE-M", what: "吠叫、舔、挠、吃、喝，趋势变化",
    tech: [["AI 行为识别", "pub"], ["端侧特征 + 云端分类", "inf"]], acc: "行为变化 80%（自报）", biz: "订阅，约 $14/月起，含硬件" },
  { key: "tractive", name: "Tractive DOG 6", sensor: "加速度、GPS、LTE", what: "活动、睡眠、静息心率、呼吸、吠叫、挠（部分评测）",
    tech: [["2025 年加入心率 / 呼吸", "pub"], ["静止时用加速度测心冲击 / 呼吸起伏", "inf"]], acc: "未见公开验证", biz: "订阅；收编 Whistle 用户，GPS 体量最大" },
  { key: "invoxia", name: "Invoxia Minitailz", sensor: "运动传感器（另有雷达说法）、GPS", what: "静息心率、呼吸、心律异常提示、活动",
    tech: [["运动传感器 + 深度学习（专利）", "pub"], ["只在静止时测", "inf"]], acc: "心跳检测 F1 98%（自报）\n心率 99% / 呼吸 97%（报道）", biz: "约 $99 + 约 $8.3/月" },
  { key: "petpace", name: "PetPace 2.0", sensor: "加速度、温度、心率", what: "心率、HRV、呼吸、体温、姿态、疼痛评分",
    tech: [["呼吸由窦性心律不齐推算", "pub"], ["对标 Holter 验证", "pub"]], acc: "有学位论文和少量期刊，数字分散", biz: "面向兽医和科研，B2B2C" },
  { key: "maven", name: "Maven", sensor: "夹在原项圈上的传感器", what: "心率、呼吸、活动、休息、瘙痒行为、饮水",
    tech: [["兽医远程监护定位", "pub"], ["加速度 + 云端模型", "inf"]], acc: "未见公开验证", biz: "约 $13.99/月年付，走兽医渠道" },
  { key: "animo", name: "Sure Petcare Animo", sensor: "三轴加速度，无 GPS", what: "抓挠、吠叫、甩动、活动、睡眠",
    tech: [["2018 年三轴加速度", "pub"], ["特征 + 浅层模型", "inf"]], acc: "无；用户反馈吠叫漏检多", biz: "一次买断" },
  { key: "halo", name: "Halo Collar 4", sensor: "GPS、加速度", what: "虚拟围栏、训练反馈、活动",
    tech: [["围栏 + 训练是核心", "pub"], ["健康数据很浅", "inf"]], acc: "—", biz: "高价硬件 + 订阅" },
  { key: "cn", name: "国内新品", sub: "PAAAWOW、娲宝等", sensor: "加速度、GPS，部分加心率", what: "行为、情绪、训练引导、长期健康数据",
    tech: [["大模型做解读 / 日记", "pub"], ["识别层能力未公开", "inf"]], acc: "未见公开数字", biz: "硬件 + App，部分先走海外众筹" },
  { key: "ours", name: "我们（GR5515 项圈）", sensor: "只开加速度（3 轴），可选 6 轴", what: "未佩戴、静止、活动、抓挠、甩头 / 抖身",
    tech: [["int8 1D-CNN 跑在板上", "pub"], ["动作门 + Viterbi 后处理", "pub"], ["按片段评估", "pub"]], acc: "抓挠片段命中 86.0%\n查准 94.9% · 误报 5.2 次/h", biz: "端侧推理，不依赖云；模型 236 KB", ours: true },
];

type Use = "高" | "中" | "低" | "不能用";
interface PubDs { key: string; name: string; url: string; what: string; sensor: string; labels: string; license: string; size: string; use: Use; how: string }
const DATASETS: PubDs[] = [
  { key: "marcato", name: "Marcato 2023 · 犬姿态惯性数据集", url: "https://data.mendeley.com/datasets/mpph6bmn7g/1",
    what: "42 只导盲犬幼犬，背 / 颈 / 胸三处同时戴", sensor: "ActiGraph GT9X：加速度 + 陀螺仪 + 磁力计，100 Hz",
    labels: "站、坐、躺、走、**抖身**", license: "CC BY 4.0", size: "123 MB", use: "高",
    how: "已下载并入训练。颈部那一路直接当项圈用；抖身 41 段（时长短），站坐躺走补静止和活动" },
  { key: "vehkaoja", name: "Vehkaoja / Kumpulainen 2022 · 犬行为运动传感器", url: "https://data.mendeley.com/datasets/vxhx934tbn/3",
    what: "45 只中大型犬，项圈 + 胸背带，17 只重复采集", sensor: "ActiGraph GT9X：加速度 + 陀螺仪，100 Hz",
    labels: "奔跑、趴、坐、站、走、玩、**嗅闻、进食、饮水、甩动**、喘气（三列同时标注）", license: "CC BY 4.0", size: "850 MB", use: "高",
    how: "已下载并入训练。没有抓挠，但进食 1463 段、饮水 90 段、嗅闻 917 段正是我们抓挠误报的来源，当难负样本；甩动 269 段补甩头 / 抖身" },
  { key: "bebe", name: "BEBE 基准（Earth Species Project）", url: "https://github.com/earthspecies/BEBE",
    what: "9 个物种、149 个个体、1654 小时", sensor: "动物佩戴的加速度 / 陀螺仪，频率各异",
    labels: "各物种自己的行为类别", license: "开放（见仓库）", size: "GB 级（未核实）", use: "中",
    how: "不是狗的行为标签，用途是自监督预训练和对照评测；它的预训练代码和划分方式可以直接借用" },
  { key: "capture24", name: "Capture-24 / ssl-wearables（牛津）", url: "https://github.com/OxWearables/ssl-wearables",
    what: "人类手腕加速度；预训练模型基于 70 万人·天 UK Biobank", sensor: "三轴加速度",
    labels: "人的日常活动", license: "模型开源；UK Biobank 原始数据要申请", size: "模型几十 MB", use: "中",
    how: "BEBE 证明这套人类手腕预训练模型迁到动物上也有效。直接拿预训练权重初始化我们的 CNN，再用自己的数据微调" },
  { key: "karimjee", name: "Karimjee 2024 · 犬活动量标准化", url: "https://zenodo.org/records/11904922",
    what: "6 只比格 + 16 只家犬，项圈 Axivity AX3，200 Hz", sensor: "三轴加速度",
    labels: "公开的只有汇总后的活动量指标", license: "CC0（Dryad）", size: "很小", use: "低",
    how: "没有逐窗口的原始数据，训练用不上；它的 MXACC 活动量指标可以借来做产品里的「活动强度」" },
  { key: "whistle", name: "Whistle 2021 补充材料", url: "https://zenodo.org/records/4836665",
    what: "7 段演示视频（视频 + 同步加速度曲线 + 模型输出）", sensor: "—", labels: "吃、喝、玩、挠、舔、蹭、甩", license: "CC BY 4.0", size: "45 MB", use: "低",
    how: "没有原始数据，只能看他们怎么界定每种行为，对齐我们的标注规范" },
  { key: "private", name: "Vetrax 361 只狗、Whistle 5000+ 段、SensiML 项圈", url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC5883579",
    what: "有抓挠 / 甩头标注的大数据集", sensor: "三轴 / 六轴加速度", labels: "抓挠、甩头等", license: "不公开（SensiML 要申请）", size: "—", use: "不能用",
    how: "目前没有公开的狗抓挠 IMU 数据集。抓挠正样本只能靠我们自己采，这反而是壁垒" },
];

const BARS = [
  { name: "Vetrax 2018", note: "抓挠灵敏度", v: 76.9 },
  { name: "Whistle 2021", note: "抓挠灵敏度", v: 87.0 },
  { name: "我们 · 3 轴 8 s CNN", note: "片段命中，端侧", v: 86.0, ours: true },
  { name: "我们 · 6 轴 8 s CNN", note: "片段命中，端侧", v: 88.4, ours: true },
  { name: "我们 · 服务端 XGB", note: "6 轴，片段命中", v: 89.4, ours: true },
];

const PIPE = [
  { title: "只开加速度", text: "20 Hz 覆盖 5–8 Hz 的抓挠节律；陀螺仪耗电，只在需要时唤醒" },
  { title: "动作门", text: "|a| 标准差先判未佩戴和静止，大部分时间不用跑网络" },
  { title: "int8 CNN", text: "8 s 窗口、1 s 步长；CMSIS-NN，约 1200 万次乘加 / 窗" },
  { title: "后处理成片段", text: "Viterbi 平滑，输出起止、次数、时长，起点误差约 0.8 s" },
  { title: "指数与预警", text: "每天瘙痒指数，跟这只狗自己的基线比，异常提醒主人和兽医" },
];

const IDEAS: { title: string; items: [string, string][] }[] = [
  { title: "近期 · 把 90% 拿下", items: [
    ["拆出显式负类", "舔、吃、喝、啃单独成类（Whistle 的做法），专门压抓挠误报"],
    ["量化感知训练", "现在 int8 和浮点只有 85% 一致，QAT 预计能找回 1–3 个点"],
    ["GR5513 版", "filters 减半或 6.4 s 窗口，压到 128 KB 以内"],
    ["双窗口", "短窗口管甩头（1–2 s），8 s 窗口管抓挠"],
  ] },
  { title: "中期 · 数据飞轮", items: [
    ["自监督预训练", "NAS 上大量未标注数据先做对比学习，标注少时收益最大"],
    ["主动学习", "只把模型最拿不准的片段送人审，同样人力标出更多有用样本"],
    ["聚类找新行为", "在 embedding 空间聚类，找出「活动」里藏着的舔、啃、蹭"],
    ["个体自适应", "每只狗前几天建自己的基线，强度和频次按个体归一化"],
  ] },
  { title: "长期 · 从识别到健康", items: [
    ["瘙痒指数给皮肤科兽医", "Pet Insight 的路线：挠和舔的趋势对上就诊和用药效果"],
    ["静息心率和呼吸", "静止时用加速度测心冲击和呼吸起伏，不加新传感器"],
    ["大模型做解读层", "识别留在端侧，云端大模型把事件写成主人看得懂的日报"],
    ["端侧优先是差异点", "竞品大多靠云和订阅；端侧省流量、保护隐私、断网也能用"],
  ] },
];

const SOURCES: [string, string][] = [
  ["Chambers 2021, Animals：单项圈加速度计深度学习", "https://pmc.ncbi.nlm.nih.gov/articles/PMC8228965"],
  ["Griffies 2018, BMC Vet Res：传感器量化瘙痒行为", "https://pmc.ncbi.nlm.nih.gov/articles/PMC5883579"],
  ["Vehkaoja 2022, Data in Brief：犬行为六轴数据集", "https://data.mendeley.com/datasets/vxhx934tbn/3"],
  ["BEBE 基准（Movement Ecology 2024）", "https://arxiv.org/abs/2305.10740"],
  ["Fi Series 3 Plus 发布", "https://9to5google.com/2025/06/02/fi-launches-series-3-plus-collar/"],
  ["Tractive", "https://en.wikipedia.org/wiki/Tractive"],
  ["Whistle 停服（Engadget）", "https://www.engadget.com/wearables/whistle-pet-trackers-are-shutting-down-next-month-212828325.html"],
  ["Invoxia Minitailz（CES 2024）", "https://www.macrumors.com/2024/01/08/ces-2024-invoxia-minitailz/"],
  ["Invoxia 准确率说明", "https://www.invoxia.com/blog/petcare/assessing-the-accuracy-of-the-invoxia-smart-dog-collar-on-a-large-scale-dataset/"],
  ["PetPace（dvm360）", "https://www.dvm360.com/view/vet-grade-ai-powered-dog-collar"],
  ["Maven", "https://maven.pet/dog-health-tracker/"],
  ["Sure Petcare Animo 预印本", "https://www.preprints.org/manuscript/202306.0301"],
  ["Marcato 2023, PLOS ONE：犬姿态惯性数据集", "https://doi.org/10.1371/journal.pone.0286311"],
  ["Karimjee 2024：犬活动量标准化（Zenodo）", "https://zenodo.org/records/11904922"],
  ["Whistle 2021 补充视频（Zenodo）", "https://zenodo.org/records/4836665"],
  ["国内市场（中华网 2026-03）", "https://m.tech.china.com/articles/20260310/202603101822019.html"],
  ["国内项圈融资（投资界 2026-08）", "https://news.pedaily.cn/20260821/136880.shtml"],
  ["端侧牛项圈 CNN（Pavlovic 2021 Sensors）", "https://mdpi.com/1424-8220/21/12/4050"],
  ["项圈嵌入式行为推理（Arablouei 2021）", "https://arxiv.org/pdf/2111.12295v1"],
];

/** 示意波形：静止 → 慢走 → 抓挠（高频节律）→ 甩头（短尖峰） */
function Trace() {
  const { token } = theme.useToken();
  const d = useMemo(() => {
    let seed = 7;
    const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280 - 0.5; };
    let s = "";
    for (let x = 0; x <= 1000; x += 2) {
      let y: number;
      if (x < 430) y = 60 + rnd() * (x > 250 ? 12 : 4) + (x > 250 ? Math.sin(x / 9) * 5 : 0);
      else if (x < 660) y = 60 + Math.sin(x / 3.1) * 40 * Math.sin(((x - 430) / 230) * Math.PI) + rnd() * 7;
      else if (x > 760 && x < 800) y = 60 + Math.sin(((x - 760) / 40) * Math.PI * 3) * 46 + rnd() * 5;
      else y = 60 + rnd() * 8 + Math.sin(x / 11) * 4;
      s += `${x ? "L" : "M"}${x} ${y.toFixed(1)}`;
    }
    return s;
  }, []);
  const label = { fill: token.colorTextSecondary, fontSize: 12 };
  return (
    <svg viewBox="0 0 1000 124" style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label="项圈加速度示意波形">
      <rect x={430} y={4} width={230} height={112} fill={token.colorPrimaryBg} />
      <line x1={0} x2={1000} y1={60} y2={60} stroke={token.colorBorderSecondary} />
      <path d={d} fill="none" stroke={token.colorPrimary} strokeWidth={1.5} />
      <text x={8} y={18} style={label}>静止 / 慢走</text>
      <text x={440} y={18} style={{ ...label, fill: token.colorPrimary, fontWeight: 600 }}>抓挠：5–8 Hz 后肢节律，1–10 s</text>
      <text x={700} y={18} style={label}>甩头：&lt;2 s 尖峰</text>
      <text x={8} y={118} style={{ ...label, fontSize: 11 }}>|a| · 20 Hz · 示意</text>
    </svg>
  );
}

const tagOf = ([text, k]: T, i: number) =>
  k === "inf" ? (
    <Tooltip key={i} title="推断，未经官方证实"><Tag bordered style={{ borderStyle: "dashed", marginBottom: 4 }}>{text}</Tag></Tooltip>
  ) : (
    <Tag key={i} color={k === "dead" ? "red" : "purple"} style={{ marginBottom: 4 }}>{text}</Tag>
  );

export default function Research() {
  const { token } = theme.useToken();
  const pre = { whiteSpace: "pre-line" as const, fontVariantNumeric: "tabular-nums" as const };

  const columns: ColumnsType<Rival> = [
    { title: "产品", dataIndex: "name", width: 150, fixed: "left",
      render: (v, r) => (<><Text strong>{v}</Text>{r.sub && <div><Text type="secondary" style={{ fontSize: 12 }}>{r.sub}</Text></div>}</>) },
    { title: "传感器", dataIndex: "sensor", width: 170 },
    { title: "识别 / 指标", dataIndex: "what", width: 200 },
    { title: "技术做法", dataIndex: "tech", width: 240, render: (t: T[]) => t.map(tagOf) },
    { title: "公开准确率", dataIndex: "acc", width: 180, render: (v) => <span style={pre}>{v}</span> },
    { title: "商业模式 / 状态", dataIndex: "biz", width: 190,
      render: (v: string, r) => r.key === "whistle" ? <><Tag color="red">已停服</Tag>{v}</> : v },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <div>
        <Space align="baseline" wrap>
          <Title level={4} style={{ margin: 0 }}>行业调研 · 宠物可穿戴</Title>
          <Text type="secondary">学术与产业里程碑、竞品拆解、我们的位置和下一步。数字截至 2026-11。</Text>
        </Space>
        {/* 一行目录：这页很长，点哪个模块直接跳过去，滚到了哪节也会高亮。
            页面滚动发生在 Content 容器里（不是整个 window），要把容器告诉 Anchor */}
        <Anchor
          direction="horizontal"
          affix={false}
          getContainer={() => document.querySelector(".ant-layout-content") as HTMLElement}
          items={[
            { key: "trend", href: "#trend", title: "三代趋势" },
            { key: "history", href: "#history", title: "来时路" },
            { key: "ladder", href: "#ladder", title: "方法台阶" },
            { key: "rivals", href: "#rivals", title: "竞品拆解" },
            { key: "datasets", href: "#datasets", title: "公开数据集" },
            { key: "baseline", href: "#baseline", title: "基线对比" },
            { key: "pipeline", href: "#pipeline", title: "完整链路" },
            { key: "next", href: "#next", title: "下一步" },
            { key: "sources", href: "#sources", title: "参考资料" },
          ]}
        />
      </div>

      <Card id="trend" size="small" title="从「它在哪」到「它怎么了」">
        <Paragraph type="secondary" style={{ marginBottom: 12 }}>
          宠物可穿戴二十年走了三步：先定位，再看活动量，现在比的是能不能从一颗加速度计里读出具体行为（抓挠、舔、喝水、甩头），再把这些行为变成兽医能用的健康信号。
        </Paragraph>
        <Trace />
        <Steps size="small" current={2} style={{ marginTop: 16 }} items={[
          { title: "第一代 · 定位", description: "GPS + 蜂窝，丢了找得到。Tractive、早期 Whistle、Fi" },
          { title: "第二代 · 活动量", description: "计步、睡眠、卡路里，学人类手环。FitBark、Whistle FIT" },
          { title: "第三代 · 行为与生理", description: "抓挠 / 舔 / 吃喝 / 吠叫，静息心率呼吸，异常预警" },
        ]} />
      </Card>

      <Card id="history" size="small" title="来时路" extra={<Space size={4}><Tag color="purple">学术</Tag><Tag color="orange">产业</Tag></Space>}>
        <Timeline mode="alternate" style={{ marginTop: 8 }} items={MILESTONES.map((m) => ({
          color: m.kind === "a" ? token.colorPrimary : token.colorWarning,
          label: <Text strong style={{ fontVariantNumeric: "tabular-nums" }}>{m.year}</Text>,
          children: (
            <div>
              <Text strong>{m.title}</Text>
              <div><Text type="secondary" style={{ fontSize: 13 }}>{m.text}</Text></div>
            </div>
          ),
        }))} />
      </Card>

      <Card id="ladder" size="small" title="识别方法的五级台阶">
        <Paragraph type="secondary">每一级都没有淘汰上一级。量产产品通常几级混用：门限管静止和未佩戴，模型管动作，后处理做成「事件」。</Paragraph>
        <Row gutter={[12, 12]}>
          {LADDER.map((l) => (
            <Col key={l.title} flex="1 1 190px">
              <Card size="small" style={{ height: "100%", ...(l.ours ? { borderColor: token.colorPrimary, background: token.colorPrimaryBg } : {}) }}>
                <Text type={l.ours ? undefined : "secondary"} style={{ fontSize: 12, color: l.ours ? token.colorPrimary : undefined }}>{l.when}</Text>
                <div><Text strong>{l.title}</Text></div>
                <Text type="secondary" style={{ fontSize: 13 }}>{l.text}</Text>
              </Card>
            </Col>
          ))}
        </Row>
      </Card>

      <Card id="rivals" size="small" title="竞品拆解" extra={<Space size={4} wrap>
        <Tag color="purple">公开资料</Tag><Tag style={{ borderStyle: "dashed" }}>推断</Tag></Space>}>
        <Paragraph type="secondary">厂商自报的准确率口径都不统一，只能当方向参考。「0.949/0.999」是灵敏度 / 特异度。</Paragraph>
        <Table size="small" rowKey="key" pagination={false} columns={columns} dataSource={RIVALS} scroll={{ x: 1130 }}
          onRow={(r) => (r.ours ? { style: { background: "var(--sl-hl-orange)" } } : {})} />
      </Card>

      <Card id="datasets" size="small" title="公开数据集：哪些能下载下来补数据">
        <Paragraph type="secondary">
          结论：公开数据里<Text strong>没有带抓挠标注的狗 IMU 数据</Text>。能补的是两块：抖身 / 甩头正样本（Marcato，颈部传感器）和嗅闻这类难负样本（Vehkaoja）；
          再加一套人类手腕的预训练模型做初始化。用之前统一重采样到 20 Hz，换成我们方向无关的竖直 / 水平 / 模长通道，项圈装法不同也能对上。
        </Paragraph>
        <Alert type="success" showIcon style={{ marginBottom: 12 }} message="实测：并进训练之后（2026-11-17，五折交叉验证）"
          description="Vehkaoja + Marcato 并进训练，抓挠只在我们自己的数据里有，所以下面的命中率完全是在自己的数据上算的。6 轴 CNN 抓挠片段命中 88.4% → 91.8%，3 轴 86.0% → 87.3%；甩头 / 抖身 F1 大约翻倍（6 轴 0.10 → 0.24）。服务端 XGBoost 基本没变。转换脚本 experiments/claude_2026_11/convert_public.py，数据在 NAS 的 public_datasets/。" />
        <Table size="small" rowKey="key" pagination={false} dataSource={DATASETS} scroll={{ x: 1150 }}
          columns={[
            { title: "数据集", dataIndex: "name", width: 200, fixed: "left",
              render: (v: string, r: PubDs) => <Link href={r.url} target="_blank" rel="noopener noreferrer">{v}</Link> },
            { title: "规模", dataIndex: "what", width: 190 },
            { title: "传感器", dataIndex: "sensor", width: 170 },
            { title: "标签", dataIndex: "labels", width: 170,
              render: (v: string) => v.split("**").map((t, i) => (i % 2 ? <Text key={i} strong>{t}</Text> : t)) },
            { title: "许可 / 大小", key: "lic", width: 130,
              render: (_: unknown, r: PubDs) => <><div>{r.license}</div><Text type="secondary" style={{ fontSize: 12 }}>{r.size}</Text></> },
            { title: "对我们", dataIndex: "use", width: 80,
              render: (v: Use) => <Tag color={v === "高" ? "green" : v === "中" ? "blue" : v === "低" ? "default" : "red"}>{v}</Tag> },
            { title: "怎么用", dataIndex: "how", width: 280 },
          ]} />
      </Card>

      <Row id="baseline" gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card size="small" title="抓挠识别：跟公开基线放一起看" style={{ height: "100%" }}>
            <Paragraph type="secondary" style={{ fontSize: 13 }}>
              口径不同，不能直接比大小：Vetrax、Whistle 报的是灵敏度；我们是后处理之后的片段命中率，五折交叉验证、按天 × 项圈分组，更严。目标 90%。
            </Paragraph>
            <Space direction="vertical" style={{ width: "100%" }} size={10}>
              {BARS.map((b) => (
                <div key={b.name}>
                  <Space size={6}><Text strong={b.ours}>{b.name}</Text><Text type="secondary" style={{ fontSize: 12 }}>{b.note}</Text></Space>
                  <Progress percent={b.v} format={(p) => `${p?.toFixed(1)}%`}
                    strokeColor={b.ours ? token.colorPrimary : token.colorTextQuaternary} />
                </div>
              ))}
            </Space>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <Alert type="info" showIcon message="最值得学的一点" description="Whistle 把舔、吃、喝、蹭、嗅都单独当类别训练，没有全塞进「活动」。我们的抓挠误报主要来自吃、喝、舔被判成挠。把这几类拆成显式的负类，是提升查准最直接的办法。" />
            <Alert type="warning" showIcon message="瓶颈在数据，不在模型" description="Kumpulainen 的 45 只狗数据里项圈比胸背带低 16 个点；Whistle 用几千只狗的数据说项圈位置没影响。差别是数据量。我们的情况一样：换模型结构收益已经很小，要靠更多、更干净的标注。" />
          </Space>
        </Col>
      </Row>

      <Card id="pipeline" size="small" title="一条第三代项圈的完整链路">
        <Steps size="small" items={PIPE.map((p) => ({ title: p.title, description: p.text, status: "process" as const }))} />
      </Card>

      <Card id="next" size="small" title="接下来怎么走">
        <Row gutter={[24, 16]}>
          {IDEAS.map((g) => (
            <Col key={g.title} xs={24} md={8}>
              <Title level={5} style={{ marginTop: 0 }}>{g.title}</Title>
              <Space direction="vertical" size={8}>
                {g.items.map(([t, d]) => (
                  <div key={t}><Text strong>{t}</Text><div><Text type="secondary" style={{ fontSize: 13 }}>{d}</Text></div></div>
                ))}
              </Space>
            </Col>
          ))}
        </Row>
      </Card>

      <Card id="sources" size="small" title="参考资料">
        <ol style={{ margin: 0, paddingLeft: 20 }}>
          {SOURCES.map(([t, u]) => (
            <li key={u}><Link href={u} target="_blank" rel="noopener noreferrer">{t}</Link></li>
          ))}
          <li><Text type="secondary">早期文献（Nuttall &amp; McEwan 2006、Hansen 2007、Gerencsér 2013、Ladha 2013）按已知文献列出，未逐篇核对链接。</Text></li>
        </ol>
        <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
          我们的数字来自 pool_20261116_all 五折交叉验证（2026-11-17）。竞品功能以各厂商当期公开资料为准，可能已有更新。
        </Paragraph>
      </Card>
    </Space>
  );
}
