import { Button, Descriptions, Progress, Space, Table, Tag, Tooltip, Typography } from "antd";
import type { EdgeFootprint as FP } from "@/api/training";

/**
 * 端侧资源占用：这份导出烧到板上要吃多少 flash / RAM、推一个窗口要多少算力、源码包多大。
 * 数是导出时用 arm-none-eabi-gcc 按固件同一套选项真编出来的（toolchain 里会说是不是 x86 估的）。
 * 给跟嵌入式对接用：他要的就是这几个数 + 源码包。
 */

const KB = (b: number | undefined | null) => (b == null ? "-" : `${(b / 1024).toFixed(1)} KB`);
const B = (b: number | undefined | null) => (b == null ? "-" : `${b.toLocaleString()} B`);
type FileRow = { name: string; group: string; text?: number; data?: number; bss?: number; error?: string };

export default function EdgeFootprint({ fp, onDownload }: { fp: FP; onDownload?: () => void }) {
  const fl = fp.flash;
  const rm = fp.ram;
  const chip = fp.chip;
  const budget = 128 * 1024;
  const flashAll = (chip?.ble_baseline_flash ?? 0) + fl.total_without_golden;
  const ramAll = (chip?.ble_baseline_ram ?? 0) + rm.total;
  const files = Object.entries(fp.source_bundle?.files ?? {});

  const bar = (used: number, total: number, label: string) => (
    <Tooltip title={`${B(used)} / ${B(total)}`}>
      <Progress percent={Math.round((used / total) * 100)} size="small" format={() => label} status={used > total ? "exception" : "normal"} />
    </Tooltip>
  );

  return (
    <Space direction="vertical" style={{ width: "100%" }} size={8}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {fp.cross_compiled ? "用 " : "⚠ 没装交叉编译器，用 "}{fp.toolchain} 编出来的数
        {fp.cross_compiled ? "，跟固件同一套选项（-Os、-ffp-contract=off）" : ""}
      </Typography.Text>
      {Object.values(fp.per_file.runtime).some((v) => v.error) && (
        <Typography.Text type="danger" style={{ fontSize: 12 }}>
          工程代码有文件没编过，「工程代码」那一项不可信——下面文件表里悬停看报错；多半是交叉编译器缺 C 库，重新部署算法机后「重导端侧」
        </Typography.Text>
      )}

      <Descriptions size="small" bordered column={2}>
        <Descriptions.Item label="模型（flash）">
          <b>{KB(fl.model)}</b> <span style={{ color: "#888", fontSize: 12 }}>{B(fl.model)} · const，不占 RAM</span>
        </Descriptions.Item>
        <Descriptions.Item label="工程代码（flash）">
          <b>{KB(fl.runtime)}</b> <span style={{ color: "#888", fontSize: 12 }}>特征/推理/窗口/后处理</span>
        </Descriptions.Item>
        <Descriptions.Item label="常量表（flash）">{KB(fl.tables)} <span style={{ color: "#888", fontSize: 12 }}>窗函数 / FFT 旋转因子</span></Descriptions.Item>
        <Descriptions.Item label="自检 golden（flash）">{KB(fl.golden)} <span style={{ color: "#888", fontSize: 12 }}>量产可只留几条</span></Descriptions.Item>
        <Descriptions.Item label="flash 合计（不含 golden）" span={2}>
          <Space direction="vertical" style={{ width: "100%" }} size={2}>
            <b>{KB(fl.total_without_golden)}</b>
            {bar(fl.total_without_golden, budget, `占 128 KB 模型预算 ${Math.round((fl.total_without_golden / budget) * 100)}%`)}
            {chip && bar(flashAll, chip.flash_total, `连 BLE 协议栈 + 应用 ${KB(flashAll)} / ${KB(chip.flash_total)}`)}
          </Space>
        </Descriptions.Item>
        <Descriptions.Item label="运行时 RAM">
          <b>{KB(rm.total_without_post)}</b>
          <div style={{ color: "#888", fontSize: 12 }}>
            特征缓冲 {B(rm.runtime_bss)} + 窗口 {B(rm.window_buffer)}{rm.arena ? ` + arena ${B(rm.arena)}` : ""}
          </div>
        </Descriptions.Item>
        <Descriptions.Item label="板上后处理 RAM">
          +{KB(rm.post_state)} <span style={{ color: "#888", fontSize: 12 }}>只报逐窗口判决就不占</span>
        </Descriptions.Item>
        <Descriptions.Item label="RAM 合计" span={2}>
          <Space direction="vertical" style={{ width: "100%" }} size={2}>
            <b>{KB(rm.total)}</b>
            {chip && bar(ramAll, chip.ram_available, `连 BLE 协议栈 + 应用 ${KB(ramAll)} / ${KB(chip.ram_available)}`)}
          </Space>
        </Descriptions.Item>
        <Descriptions.Item label="每个窗口的推理" span={2}>
          <div style={{ fontSize: 12 }}>{fp.inference.note}</div>
          {fp.inference.host_us_per_window != null && (
            <div style={{ color: "#888", fontSize: 12 }}>
              x86 上实测 {fp.inference.host_us_per_window} µs / 窗（只能横向比，跟 M4 没可比性；M4F 大致慢 50～100 倍）
            </div>
          )}
        </Descriptions.Item>
        {fp.accel && (
          <Descriptions.Item label={<Tooltip title="同一份模型、同一套接口，编译时加一个开关把热点换成 Arm 官方 CMSIS 内核：RF 是 FFT 和向量统计（CMSIS-DSP），CNN 是卷积/池化/全连接（CMSIS-NN）。默认关，开了不再逐位一致。包里两条路各一个 .a。"><span style={{ cursor: "help" }}>可选加速（{fp.accel.name}）</span></Tooltip>} span={2}>
            <Space direction="vertical" size={2} style={{ fontSize: 12 }}>
              <span>
                flash <b>{KB(fp.accel.flash.total_without_golden)}</b>（{fp.accel.flash.delta >= 0 ? "+" : ""}{B(fp.accel.flash.delta)}）
                · RAM <b>{KB(fp.accel.ram.total_without_post)}</b>（{fp.accel.ram.delta >= 0 ? "+" : ""}{B(fp.accel.ram.delta)}）
                {fp.accel.host_us_per_window != null && fp.inference.host_us_per_window != null && (
                  <span> · x86 每窗 {fp.accel.host_us_per_window} µs（朴素 {fp.inference.host_us_per_window} µs；M4F 上 CMSIS 用 SIMD，差距会更大）</span>
                )}
                {fp.accel.agree_with_plain != null && <span> · 判决跟朴素实现一致 {(fp.accel.agree_with_plain * 100).toFixed(1)}%</span>}
              </span>
              <span style={{ color: "#888" }}>{fp.accel.note}。编译加 <code>{fp.accel.define}</code>，或直接链 lib/libtinyml_cmsis.a</span>
              {(fp.accel.errors?.length ?? 0) > 0 && <Typography.Text type="danger">CMSIS 那条有文件没编过：{fp.accel.errors!.join("、")}</Typography.Text>}
            </Space>
          </Descriptions.Item>
        )}
        <Descriptions.Item label="源码包（硬盘）" span={2}>
          <Space>
            <span>{KB(fp.source_bundle?.total)}，{files.length} 个文件</span>
            {onDownload && <Button size="small" type="primary" onClick={onDownload}>下载端侧包（源码 + libtinyml.a）</Button>}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>源码（core/ + model/ + third_party/cmsis 子集）+ 预编的 lib/libtinyml.a 和 libtinyml_cmsis.a（Cortex-M4F softfp，跟 GR551x SDK 一致）+ include/ + README（两种接法、可选加速、占用、调用顺序、编译选项）</Typography.Text>
          </Space>
        </Descriptions.Item>
      </Descriptions>

      <Table
        size="small"
        rowKey="name"
        pagination={false}
        dataSource={[
          ...Object.entries(fp.per_file.runtime).map(([name, s]) => ({ name: `core/${name}`, group: "工程代码", ...s })),
          ...Object.entries(fp.per_file.tables).map(([name, s]) => ({ name: `model/${name}`, group: "常量表", ...s })),
          ...Object.entries(fp.per_file.model).map(([name, s]) => ({ name: `model/${name}`, group: "模型", ...s })),
        ]}
        columns={[
          { title: "文件", dataIndex: "name" },
          { title: "", dataIndex: "group", width: 80, render: (g: string) => <Tag>{g}</Tag> },
          { title: "flash (text+data)", width: 140, render: (_, r: FileRow) => (r.error ? <Tooltip title={r.error}><span style={{ color: "#f5222d", cursor: "help" }}>编译失败（悬停看原因）</span></Tooltip> : B((r.text ?? 0) + (r.data ?? 0))) },
          { title: "RAM (bss)", width: 110, render: (_, r: FileRow) => B(r.bss ?? 0) },
        ]}
      />
      {chip && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{chip.note}</Typography.Text>}
    </Space>
  );
}
