import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Alert, Card, Col, Flex, Grid, Progress, Row, Space, Table, Tag, Timeline, Tooltip, Typography, theme,
} from "antd";
import {
  AlertOutlined, ApartmentOutlined, ApiOutlined, AppstoreOutlined, ArrowRightOutlined, BarChartOutlined,
  BookOutlined, CompassOutlined, DashboardOutlined, DatabaseOutlined, FilterOutlined, HeartOutlined,
  HistoryOutlined, LineChartOutlined, NodeIndexOutlined, RocketOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";

const { Title, Text, Link } = Typography;

/**
 * 行业调研：宠物可穿戴的来时路、识别方法演进、竞品拆解、我们跟公开基线的对比、下一步。
 * 纯静态内容，数字截至 2026-11。排版原则：少字、多用图和卡片，一眼扫出重点。
 * 竞品功能以厂商当期公开资料为准；虚线标签是根据硬件和功能做的推断，没有官方证实。
 */

type Kind = "a" | "i"; // 学术 / 产业
const MILESTONES: { year: string; kind: Kind; title: string; text: string }[] = [
  { year: "2006", kind: "a", title: "瘙痒监测起点", text: "活动计首次把「狗挠了多少」变成客观计数" },
  { year: "2007", kind: "a", title: "加速度计入兽医", text: "活动量成为关节炎、药效评估的终点指标" },
  { year: "2012", kind: "i", title: "三条路线分野", text: "PetPace 重体征、Whistle 重活动、Tractive 重定位" },
  { year: "2013", kind: "a", title: "犬行为识别开启", text: "惯性 + 手工特征 + SVM，分出走跑坐躺" },
  { year: "2013–14", kind: "i", title: "FitBark 众筹", text: "「狗的 Fitbit」，只做活动量和睡眠" },
  { year: "2016", kind: "i", title: "Mars 收购 Whistle", text: "数据开始接通兽医体系" },
  { year: "2017–18", kind: "i", title: "Animo 上市", text: "首批消费级产品标出抓挠、吠叫、甩动" },
  { year: "2018", kind: "a", title: "首个公开基线", text: "Vetrax 抓挠灵敏度 76.9%、特异度 99.7%" },
  { year: "2019", kind: "i", title: "Pet Insight 启动", text: "数万只狗长期佩戴，行为关联就诊记录" },
  { year: "2021", kind: "a", title: "Whistle 深度学习", text: "5000+ 段视频、1100 万狗·天真实世界验证" },
  { year: "2021–22", kind: "a", title: "公开六轴数据集", text: "45 只狗 7 种行为：项圈 75%、胸背 91%" },
  { year: "2022–24", kind: "i", title: "Minitailz", text: "项圈上测静息心率与呼吸" },
  { year: "2023–24", kind: "a", title: "BEBE 基准", text: "自监督预训练胜出，标注少时收益最大" },
  { year: "2025", kind: "i", title: "GPS 厂转向健康", text: "Tractive、Fi 同步上心率和行为识别" },
  { year: "2025.07", kind: "i", title: "Whistle 停服", text: "被 Tractive 收购整合，先行者出局" },
  { year: "2026", kind: "i", title: "国内转向行为", text: "情绪识别、健康日记成新卖点" },
];

/** 三代产品：图标 + 一行代表厂商 + 一句话 */
const GENS = [
  { icon: CompassOutlined, title: "第一代 · 定位", who: "Tractive · 早期 Whistle · Fi", desc: "GPS + 蜂窝，丢了找得回", now: false },
  { icon: DashboardOutlined, title: "第二代 · 活动量", who: "FitBark · Whistle FIT", desc: "计步 / 睡眠 / 卡路里，学人类手环", now: false },
  { icon: HeartOutlined, title: "第三代 · 行为与生理", who: "Tractive 2025 · Invoxia · 国内新品", desc: "一颗加速度计读出抓挠、心率与异常", now: true },
];

const LADDER = [
  { when: "2006–", title: "计数与门限", text: "只分「动 / 不动」，功耗最低" },
  { when: "2013–", title: "手工特征 + 浅层", text: "SVM / RF，MCU 能跑，80% 天花板" },
  { when: "2019–", title: "端到端深度网络", text: "CNN 直接吃波形，数据量定上限" },
  { when: "2023–", title: "自监督预训练", text: "海量无标注先学，少量标注微调" },
  { when: "现在 · 我们", title: "TinyML + 事件后处理", text: "int8 端侧推理，Viterbi 稳定成片段", ours: true },
];

type T = [string, "pub" | "inf" | "dead"];
interface Rival { key: string; name: string; sub?: string; what: string; tech: T[]; acc: string; biz: string; ours?: boolean }
const RIVALS: Rival[] = [
  { key: "whistle", name: "Whistle", sub: "三轴 · Mars Petcare", what: "吃 / 喝 / 舔 / 挠 / 蹭 / 睡眠",
    tech: [["深度学习 · 单项圈", "pub"], ["云端推理为主", "inf"]], acc: "挠 ~0.87 灵敏\n吃 0.988 / 喝 0.949", biz: "2025-08 停服，并入 Tractive" },
  { key: "fi", name: "Fi Series 3+", sub: "加速度 + GPS", what: "吠叫 / 舔 / 挠 / 吃 / 喝",
    tech: [["AI 行为识别", "pub"], ["端侧特征 + 云端分类", "inf"]], acc: "行为变化 80%（自报）", biz: "订阅 ~$14/月" },
  { key: "tractive", name: "Tractive DOG 6", sub: "加速度 + GPS", what: "活动 / 睡眠 / 心率 / 呼吸",
    tech: [["2025 加心率呼吸", "pub"], ["静止时测心冲击", "inf"]], acc: "未见公开验证", biz: "订阅；收编 Whistle" },
  { key: "invoxia", name: "Invoxia Minitailz", sub: "运动传感器（另有雷达说法）", what: "静息心率 / 呼吸 / 心律异常",
    tech: [["运动传感器 + 深度学习", "pub"]], acc: "心率 99% / 呼吸 97%（报道）", biz: "$99 + $8.3/月" },
  { key: "petpace", name: "PetPace 2.0", sub: "加速度 + 温度 + 心率", what: "HRV / 呼吸 / 体温 / 疼痛评分",
    tech: [["对标 Holter 验证", "pub"]], acc: "数字分散、量少", biz: "面向兽医，B2B2C" },
  { key: "maven", name: "Maven", sub: "夹在原项圈上的传感器", what: "心率 / 呼吸 / 瘙痒 / 饮水",
    tech: [["兽医远程监护", "pub"], ["云端模型", "inf"]], acc: "未见公开验证", biz: "$13.99/月，兽医渠道" },
  { key: "animo", name: "Sure Petcare Animo", sub: "三轴，无 GPS", what: "抓挠 / 吠叫 / 甩动 / 睡眠",
    tech: [["特征 + 浅层模型", "inf"]], acc: "无；吠叫漏检多", biz: "一次买断" },
  { key: "halo", name: "Halo Collar 4", sub: "GPS + 加速度", what: "虚拟围栏 / 训练 / 活动",
    tech: [["围栏 + 训练是核心", "pub"], ["健康数据很浅", "inf"]], acc: "—", biz: "高价硬件 + 订阅" },
  { key: "cn", name: "国内新品", sub: "PAAAWOW · 娲宝等", what: "行为 / 情绪 / 训练引导",
    tech: [["大模型做解读", "pub"], ["识别层未公开", "inf"]], acc: "未见公开数字", biz: "硬件 + App，先出海众筹" },
  { key: "ours", name: "我们", sub: "GR5515 · 3/6 轴可选", what: "抓挠 / 甩头抖身 / 未佩戴 / 静止",
    tech: [["int8 CNN 端侧", "pub"], ["动作门 + Viterbi", "pub"], ["按片段评估", "pub"]], acc: "片段命中 86.0%\n查准 94.9% · 5.2 误报/h", biz: "端侧推理 · 模型 236 KB", ours: true },
];

type Use = "高" | "中" | "低" | "不能用";
interface PubDs { key: string; name: string; url: string; what: string; license: string; size: string; use: Use; how: string }
const USE_COLOR: Record<Use, string> = { 高: "green", 中: "blue", 低: "default", 不能用: "red" };
const DATASETS: PubDs[] = [
  { key: "marcato", name: "Marcato 2023", url: "https://data.mendeley.com/datasets/mpph6bmn7g/1",
    what: "42 只幼犬 · 颈/背/胸三处 · 抖身 41 段", license: "CC BY 4.0", size: "123 MB", use: "高",
    how: "已并入训练：颈部一路当项圈，补抖身和姿态" },
  { key: "vehkaoja", name: "Vehkaoja 2022", url: "https://data.mendeley.com/datasets/vxhx934tbn/3",
    what: "45 只犬 · 项圈+胸背 · 嗅 917 / 吃 1463 / 喝 90 段", license: "CC BY 4.0", size: "850 MB", use: "高",
    how: "已并入训练：嗅/吃/喝当难负样本，甩动补正样本" },
  { key: "bebe", name: "BEBE 基准", url: "https://github.com/earthspecies/BEBE",
    what: "9 物种 1654 h", license: "开放", size: "GB 级", use: "中",
    how: "自监督预训练和对照评测的基准" },
  { key: "capture24", name: "ssl-wearables", url: "https://github.com/OxWearables/ssl-wearables",
    what: "70 万人·天预训练模型（UK Biobank）", license: "模型开源", size: "几十 MB", use: "中",
    how: "人类手腕预训练权重，初始化我们的 CNN" },
  { key: "karimjee", name: "Karimjee 2024", url: "https://zenodo.org/records/11904922",
    what: "22 只犬 · 只公开汇总指标", license: "CC0", size: "很小", use: "低",
    how: "没有原始数据，借它的 MXACC 活动量指标" },
  { key: "whistle", name: "Whistle 2021 演示", url: "https://zenodo.org/records/4836665",
    what: "7 段视频 + 同步曲线 + 模型输出", license: "CC BY 4.0", size: "45 MB", use: "低",
    how: "看他们怎么界定行为，对齐标注规范" },
  { key: "private", name: "Vetrax / SensiML", url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC5883579",
    what: "361 只狗 / 5000+ 段 · 不公开", license: "需申请", size: "—", use: "不能用",
    how: "公开数据里没有狗抓挠 IMU——正样本只能自己采，这是壁垒" },
];

const BARS = [
  { name: "Vetrax 2018", note: "抓挠灵敏度", v: 76.9 },
  { name: "Whistle 2021", note: "抓挠灵敏度", v: 87.0 },
  { name: "我们 · 3 轴 8s CNN", note: "片段命中，端侧", v: 86.0, ours: true },
  { name: "我们 · 6 轴 8s CNN", note: "片段命中，端侧", v: 88.4, ours: true },
  { name: "我们 · 服务端 XGB", note: "6 轴，片段命中", v: 89.4, ours: true },
];

const PIPE = [
  { icon: DashboardOutlined, title: "只开加速度", text: "20 Hz 覆盖 5–8 Hz 抓挠节律" },
  { icon: FilterOutlined, title: "动作门", text: "静止 / 未佩戴不进网络" },
  { icon: ApiOutlined, title: "int8 CNN", text: "8 s 窗口 · CMSIS-NN 端侧" },
  { icon: NodeIndexOutlined, title: "后处理成片段", text: "Viterbi 平滑，起点误差 ~0.8 s" },
  { icon: AlertOutlined, title: "指数与预警", text: "跟自身基线比，异常提醒" },
];

type IdeaColor = "colorSuccess" | "colorPrimary" | "colorPurple";
const IDEAS: { title: string; color: IdeaColor; items: [string, string][] }[] = [
  { title: "近期 · 把 90% 拿下", color: "colorSuccess", items: [
    ["拆显式负类", "舔 / 吃 / 喝单独成类，压抓挠误报"],
    ["量化感知训练", "int8 与浮点只 85% 一致，QAT 找回 1–3 点"],
    ["GR5513 版", "filters 减半或 6.4 s 窗，压进 128 KB"],
    ["双窗口", "短窗管甩头，8 s 窗管抓挠"],
  ] },
  { title: "中期 · 数据飞轮", color: "colorPrimary", items: [
    ["自监督预训练", "NAS 无标注数据先做对比学习"],
    ["主动学习", "只把模型最拿不准的片段送人审"],
    ["聚类找新行为", "在 embedding 里找出藏着的舔、啃、蹭"],
    ["个体自适应", "每只狗前几天建自己的基线"],
  ] },
  { title: "长期 · 从识别到健康", color: "colorPurple", items: [
    ["瘙痒指数", "挠和舔的趋势对上就诊与用药效果"],
    ["静息心率呼吸", "静止时加速度测心冲击，不加传感器"],
    ["大模型解读", "云端把事件写成主人看得懂的日报"],
    ["端侧优先", "断网可用、省流量、护隐私——差异点"],
  ] },
];

const SOURCES: [string, string][] = [
  ["Chambers 2021, Animals", "https://pmc.ncbi.nlm.nih.gov/articles/PMC8228965"],
  ["Griffies 2018, BMC Vet Res", "https://pmc.ncbi.nlm.nih.gov/articles/PMC5883579"],
  ["Vehkaoja 2022, Data in Brief", "https://data.mendeley.com/datasets/vxhx934tbn/3"],
  ["BEBE 基准 2024", "https://arxiv.org/abs/2305.10740"],
  ["Fi Series 3 Plus 发布", "https://9to5google.com/2025/06/02/fi-launches-series-3-plus-collar/"],
  ["Tractive（Wiki）", "https://en.wikipedia.org/wiki/Tractive"],
  ["Whistle 停服（Engadget）", "https://www.engadget.com/wearables/whistle-pet-trackers-are-shutting-down-next-month-212828325.html"],
  ["Invoxia Minitailz（CES 2024）", "https://www.macrumors.com/2024/01/08/ces-2024-invoxia-minitailz/"],
  ["Invoxia 准确率说明", "https://www.invoxia.com/blog/petcare/assessing-the-accuracy-of-the-invoxia-smart-dog-collar-on-a-large-scale-dataset/"],
  ["PetPace（dvm360）", "https://www.dvm360.com/view/vet-grade-ai-powered-dog-collar"],
  ["Maven", "https://maven.pet/dog-health-tracker/"],
  ["Animo 预印本", "https://www.preprints.org/manuscript/202306.0301"],
  ["Marcato 2023, PLOS ONE", "https://doi.org/10.1371/journal.pone.0286311"],
  ["Karimjee 2024（Zenodo）", "https://zenodo.org/records/11904922"],
  ["Whistle 2021 演示（Zenodo）", "https://zenodo.org/records/4836665"],
  ["国内市场（中华网 2026-03）", "https://m.tech.china.com/articles/20260310/202603101822019.html"],
  ["国内项圈融资（投资界 2026-08）", "https://news.pedaily.cn/20260821/136880.shtml"],
  ["端侧牛项圈 CNN（Pavlovic 2021）", "https://mdpi.com/1424-8220/21/12/4050"],
  ["项圈嵌入式推理（Arablouei 2021）", "https://arxiv.org/pdf/2111.12295v1"],
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

const pre = { whiteSpace: "pre-line" as const };

/** 右侧目录的各节：跟下面各 Card 的 id 一一对应 */
const SECTIONS = [
  { id: "trend", label: "三代趋势" },
  { id: "history", label: "来时路" },
  { id: "ladder", label: "方法台阶" },
  { id: "rivals", label: "竞品拆解" },
  { id: "datasets", label: "公开数据集" },
  { id: "baseline", label: "基线对比" },
  { id: "pipeline", label: "完整链路" },
  { id: "next", label: "下一步" },
  { id: "sources", label: "参考资料" },
] as const;

/** 顶部一排数字摘要：还没开始读就知道这页讲了什么 */
const STATS: [string, string, string][] = [
  ["20", " 年", "从定位到行为"],
  ["3", " 代", "产品演进"],
  ["10", " 家", "竞品拆解"],
  ["86", "%", "抓挠片段命中 · 端侧"],
];

export default function Research() {
  const { token } = theme.useToken();
  const bp = Grid.useBreakpoint();
  const [active, setActive] = useState<string>(SECTIONS[0].id);

  // 目录高亮跟着滚动走。页面滚动发生在 Content 容器里（不是 window），要监听
  // 那个容器；不用 antd Anchor，它在这页上跟手动滚动互相打架
  useEffect(() => {
    const container = document.querySelector(".ant-layout-content");
    if (!container) return;
    const sync = () => {
      const cTop = container.getBoundingClientRect().top;
      let cur: string = SECTIONS[0].id;
      for (const s of SECTIONS) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top - cTop <= 120) cur = s.id;
      }
      // 滚到底时最后一节可能永远停不进阈值线（节太高、下面空间不够），直接点亮最后一项
      if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) {
        cur = SECTIONS[SECTIONS.length - 1].id;
      }
      setActive(cur);
    };
    container.addEventListener("scroll", sync, { passive: true });
    sync();
    return () => container.removeEventListener("scroll", sync);
  }, []);

  const jump = (id: string) => {
    setActive(id);
    // 只滚内容区这一个容器。scrollIntoView 会把 html/body/#root 这些 overflow:hidden
    // 的祖先也一起滚（历史上菜单比视口高 8px 时整个页面就被顶上去 8px），这里手动算位置
    const el = document.getElementById(id);
    const container = document.querySelector(".ant-layout-content");
    if (!el || !container) return;
    container.scrollTo({
      top: container.scrollTop + el.getBoundingClientRect().top - container.getBoundingClientRect().top,
      behavior: "smooth",
    });
  };

  const columns: ColumnsType<Rival> = [
    { title: "产品", dataIndex: "name", width: 150, fixed: "left",
      render: (v, r) => (<><Text strong>{v}</Text>{r.sub && <div><Text type="secondary" style={{ fontSize: 12 }}>{r.sub}</Text></div>}</>) },
    { title: "识别 / 指标", dataIndex: "what", width: 200 },
    { title: "技术做法", dataIndex: "tech", width: 230, render: (t: T[]) => t.map(tagOf) },
    { title: "公开精度", dataIndex: "acc", width: 160, render: (v) => <span style={pre}>{v}</span> },
    { title: "商业模式 / 状态", dataIndex: "biz", width: 170,
      render: (v: string, r) => r.key === "whistle" ? <><Tag color="red">已停服</Tag>{v}</> : v },
  ];

  const cardTitle = (icon: ReactNode, text: string, sub?: string) => (
    <Space size={8}>
      {icon}
      <span>{text}</span>
      {sub && <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>{sub}</Text>}
    </Space>
  );

  return (
    <Flex gap={16} align="flex-start">
      <Space direction="vertical" size={16} style={{ flex: 1, minWidth: 0 }}>
        <div>
          <Space align="baseline" wrap>
            <Title level={4} style={{ margin: 0 }}>行业调研 · 宠物可穿戴</Title>
            <Text type="secondary">数字截至 2026-11</Text>
          </Space>
          {/* 数字摘要条：四个数扫一眼就知道全页 */}
          <Flex gap={12} wrap="wrap" style={{ marginTop: 12 }}>
            {STATS.map(([v, unit, label]) => (
              <div key={label} style={{ flex: "1 1 140px", padding: "10px 16px", borderRadius: 8, background: token.colorFillQuaternary }}>
                <span style={{ fontSize: 26, fontWeight: 700, color: token.colorPrimary, fontVariantNumeric: "tabular-nums" }}>{v}</span>
                <span style={{ fontSize: 13, color: token.colorPrimary }}>{unit}</span>
                <div><Text type="secondary" style={{ fontSize: 12 }}>{label}</Text></div>
              </div>
            ))}
          </Flex>
        </div>

        <Card id="trend" size="small" title={cardTitle(<LineChartOutlined style={{ color: token.colorPrimary }} />, "三代趋势", "从「它在哪」到「它怎么了」")}>
          <Trace />
          <Flex align="stretch" wrap="wrap" gap={8} style={{ marginTop: 12 }}>
            {GENS.map((g, i) => (
              <Fragment key={g.title}>
                {i > 0 && <ArrowRightOutlined style={{ alignSelf: "center", color: token.colorTextQuaternary }} />}
                <Card
                  size="small"
                  style={{
                    flex: "1 1 220px",
                    ...(g.now ? { borderColor: token.colorPrimary, background: token.colorPrimaryBg } : {}),
                  }}
                >
                  <Space size={8}><g.icon style={{ color: g.now ? token.colorPrimary : token.colorTextSecondary, fontSize: 16 }} /><Text strong>{g.title}</Text></Space>
                  <div style={{ marginTop: 6 }}><Text type="secondary" style={{ fontSize: 12 }}>{g.who}</Text></div>
                  <Text type="secondary" style={{ fontSize: 12 }}>{g.desc}</Text>
                </Card>
              </Fragment>
            ))}
          </Flex>
        </Card>

        <Card id="history" size="small" title={cardTitle(<HistoryOutlined style={{ color: token.colorPrimary }} />, "来时路", "二十年 16 个里程碑")}
          extra={<Space size={4}><Tag color="purple">学术</Tag><Tag color="orange">产业</Tag></Space>}>
          {/* 两列左对齐时间线：年份就在事件旁边。alternate 模式在宽屏上会把年份甩到
              轴线另一侧，跟自己的事件隔几百像素，看着像配错了 */}
          <Row gutter={[24, 0]}>
            {[MILESTONES.slice(0, 8), MILESTONES.slice(8)].map((col, ci) => (
              <Col key={ci} xs={24} md={12}>
                <Timeline mode="left" style={{ marginTop: 8 }} items={col.map((m) => ({
                  color: m.kind === "a" ? token.colorPrimary : token.colorWarning,
                  label: <Text strong style={{ fontVariantNumeric: "tabular-nums", fontSize: 13 }}>{m.year}</Text>,
                  children: (
                    <div>
                      <Text strong style={{ fontSize: 13 }}>{m.title}</Text>
                      <div><Text type="secondary" style={{ fontSize: 12 }}>{m.text}</Text></div>
                    </div>
                  ),
                }))} />
              </Col>
            ))}
          </Row>
        </Card>

        <Card id="ladder" size="small" title={cardTitle(<ApartmentOutlined style={{ color: token.colorPrimary }} />, "方法台阶", "每一级都没淘汰上一级，量产通常混用")}>
          <Row gutter={[12, 12]}>
            {LADDER.map((l, i) => (
              <Col key={l.title} flex="1 1 170px">
                <Card size="small" style={{
                  marginTop: (LADDER.length - 1 - i) * 20,
                  ...(l.ours ? { borderColor: token.colorPrimary, background: token.colorPrimaryBg } : {}),
                }}>
                  <Text type="secondary" style={{ fontSize: 12, color: l.ours ? token.colorPrimary : undefined }}>{l.when}</Text>
                  <div><Text strong style={{ fontSize: 13 }}>{l.title}</Text></div>
                  <Text type="secondary" style={{ fontSize: 12 }}>{l.text}</Text>
                </Card>
              </Col>
            ))}
          </Row>
        </Card>

        <Card id="rivals" size="small" title={cardTitle(<AppstoreOutlined style={{ color: token.colorPrimary }} />, "竞品拆解")}
          extra={<Space size={4} wrap>
            <Text type="secondary" style={{ fontSize: 12 }}>自报口径不一，仅方向参考</Text>
            <Tag color="purple">公开</Tag><Tag bordered style={{ borderStyle: "dashed" }}>推断</Tag>
          </Space>}>
          <Table size="small" rowKey="key" pagination={false} columns={columns} dataSource={RIVALS} scroll={{ x: 910 }}
            onRow={(r) => (r.ours ? { style: { background: "var(--sl-hl-orange)" } } : {})} />
        </Card>

        <Card id="datasets" size="small" title={cardTitle(<DatabaseOutlined style={{ color: token.colorPrimary }} />, "公开数据集", "能下载补什么")}>
          <Text type="secondary" style={{ fontSize: 13 }}>
            公开数据里<Text strong>没有带抓挠标注的狗 IMU 数据</Text>：能补的是抖身正样本、嗅闻难负样本，加一套人类预训练权重；统一重采样 20 Hz、换方向无关通道。
          </Text>
          <Alert type="success" showIcon style={{ marginTop: 10, marginBottom: 12 }}
            message="已并入训练（11-17 五折）：6 轴抓挠命中 88.4% → 91.8%，3 轴 86.0% → 87.3%，甩头 / 抖身 F1 约翻倍" />
          <Row gutter={[12, 12]}>
            {DATASETS.map((d) => (
              <Col key={d.key} xs={24} md={12}>
                <Card size="small" style={{ height: "100%" }}
                  title={<Link href={d.url} target="_blank" rel="noopener noreferrer">{d.name}</Link>}
                  extra={<Tag color={USE_COLOR[d.use]}>{d.use}</Tag>}>
                  <Text type="secondary" style={{ fontSize: 12 }}>{d.what}</Text>
                  <div style={{ margin: "6px 0" }}>
                    <Space size={4} wrap>
                      <Tag bordered={false}>{d.license}</Tag>
                      <Tag bordered={false}>{d.size}</Tag>
                    </Space>
                  </div>
                  <Text style={{ fontSize: 13 }}>{d.how}</Text>
                </Card>
              </Col>
            ))}
          </Row>
        </Card>

        <Row id="baseline" gutter={[16, 16]}>
          <Col xs={24} lg={12}>
            <Card size="small" style={{ height: "100%" }}
              title={cardTitle(<BarChartOutlined style={{ color: token.colorPrimary }} />, "基线对比", "抓挠识别")}>
              <Text type="secondary" style={{ fontSize: 12 }}>口径不同不能直接比：竞品报灵敏度；我们是片段命中（五折、按天 × 项圈分组），目标 90%。</Text>
              <Space direction="vertical" style={{ width: "100%", marginTop: 12 }} size={10}>
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
              <Alert type="info" showIcon message="最值得学：拆显式负类"
                description="Whistle 把舔、吃、喝单独成类训练，不全塞进「活动」。我们的抓挠误报主要来自这些行为被判成挠——这是提查准最直接的办法。" />
              <Alert type="warning" showIcon message="瓶颈在数据，不在模型"
                description="45 只狗的数据项圈比胸背低 16 个点，Whistle 几千只狗却说项圈位置无影响——差别是数据量。换结构收益已小，要靠更多更干净的标注。" />
            </Space>
          </Col>
        </Row>

        <Card id="pipeline" size="small" title={cardTitle(<NodeIndexOutlined style={{ color: token.colorPrimary }} />, "完整链路", "一条第三代项圈")}>
          <Flex align="flex-start" wrap="wrap" gap={8} style={{ marginTop: 4 }}>
            {PIPE.map((p, i) => (
              <Fragment key={p.title}>
                {i > 0 && <ArrowRightOutlined style={{ color: token.colorTextQuaternary, marginTop: 34 }} />}
                <div style={{ flex: "1 1 150px", textAlign: "center", padding: "10px 6px", borderRadius: 8, border: `1px solid ${token.colorBorderSecondary}` }}>
                  <div style={{ width: 36, height: 36, borderRadius: 18, background: token.colorPrimaryBg, display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 6 }}>
                    <p.icon style={{ color: token.colorPrimary, fontSize: 18 }} />
                  </div>
                  <div><Text strong style={{ fontSize: 13 }}>{p.title}</Text></div>
                  <Text type="secondary" style={{ fontSize: 12 }}>{p.text}</Text>
                </div>
              </Fragment>
            ))}
          </Flex>
        </Card>

        <Card id="next" size="small" title={cardTitle(<RocketOutlined style={{ color: token.colorPrimary }} />, "下一步", "近中远期")}>
          <Row gutter={[24, 16]}>
            {IDEAS.map((g) => (
              <Col key={g.title} xs={24} md={8}>
                <Title level={5} style={{ marginTop: 0 }}>{g.title}</Title>
                <Space direction="vertical" size={10}>
                  {g.items.map(([t, d]) => (
                    <Flex key={t} gap={8} align="flex-start">
                      <span style={{ width: 6, height: 6, borderRadius: 3, background: token[g.color as "colorSuccess"], marginTop: 7, flex: "0 0 auto" }} />
                      <div>
                        <Text strong style={{ fontSize: 13 }}>{t}</Text>
                        <div><Text type="secondary" style={{ fontSize: 12 }}>{d}</Text></div>
                      </div>
                    </Flex>
                  ))}
                </Space>
              </Col>
            ))}
          </Row>
        </Card>

        <Card id="sources" size="small" title={cardTitle(<BookOutlined style={{ color: token.colorPrimary }} />, "参考资料")}>
          <Flex wrap="wrap" gap={8}>
            {SOURCES.map(([t, u]) => (
              <Link key={u} href={u} target="_blank" rel="noopener noreferrer"
                style={{ fontSize: 12, padding: "2px 8px", border: `1px solid ${token.colorBorderSecondary}`, borderRadius: 4 }}>
                {t}
              </Link>
            ))}
          </Flex>
          <Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 12 }}>
            我们的数字来自 pool_20261116_all 五折交叉验证（2026-11-17）；竞品功能以当期公开资料为准，可能已有更新。
          </Text>
        </Card>
      </Space>

      {/* 右侧目录：吸在可视区不动，点哪节跳哪节，滚到哪节亮哪节；窄屏放不下就隐藏 */}
      {bp.lg && (
        <nav style={{ position: "sticky", top: 0, width: 112, flex: "0 0 112px", userSelect: "none" }}>
          <div style={{ fontWeight: 600, fontSize: 13, padding: "2px 0 8px 12px" }}>目录</div>
          {SECTIONS.map((s) => (
            <div
              key={s.id}
              onClick={() => jump(s.id)}
              style={{
                padding: "6px 0 6px 12px",
                fontSize: 13,
                cursor: "pointer",
                borderLeft: `2px solid ${active === s.id ? token.colorPrimary : "transparent"}`,
                color: active === s.id ? token.colorPrimary : token.colorTextSecondary,
                fontWeight: active === s.id ? 600 : 400,
              }}
            >
              {s.label}
            </div>
          ))}
        </nav>
      )}
    </Flex>
  );
}
