import { useEffect, useMemo, useState } from "react";
import {
  Button, Card, DatePicker, Form, Input, Modal, Popconfirm, Select, Space, Statistic, Table, Tabs, Tag, Tooltip,
  Typography, message,
} from "antd";
import dayjs from "dayjs";
import DogMeasurements from "@/components/DogMeasurements";
import DogPhotos from "@/components/DogPhotos";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { addMeasurement, createDog, deleteDog, listDogs, updateDog, type Dog } from "@/api/dogs";
import { listSamples } from "@/api/samples";
import { listTasks } from "@/api/tasks";
import { TASK_STATUS_META } from "@/utils/taskStatus";
import { getSavedText, saveText } from "@/utils/persistedSize";
import { usePersistedSort } from "@/utils/persistedSort";
import { useResizableColumns } from "@/utils/resizableColumns";
import type { Sample, TaskStatus } from "@/types";

interface FormValues {
  dog_code: string;
  name?: string;
  breed?: string;
  imu?: string;
  aliases?: string;
  site?: string;
  size?: string;
  // DatePicker 给的是 dayjs 对象，提交时才转成 YYYY-MM-DD
  birth_date?: import("dayjs").Dayjs | null;
  remark?: string;
}

// 现在就这两个场所，做成可选可填：以后开新场地直接输，不用改代码
const SITES = ["影棚", "狗场"];
// 体型只有这三档，不做成可自由填的：分档就是为了能按它归类，选项一多就归不成类了。
// 也不按体重自动算——同样 13kg，法斗是中型，小体金毛是大型幼犬，光看数字分不出来
const SIZES = ["大", "中", "小"] as const;
const SIZE_COLOR: Record<string, string> = { 大: "volcano", 中: "gold", 小: "cyan" };
const SITE_TAB_KEY = "smart-label:dogs-site-tab";

/**
 * 单元格里直接改的文本框。
 *
 * 受控 + useEffect 同步，不用 defaultValue：保存完会重新拉一遍 dogs，这一行
 * 会带着新数据重新渲染，defaultValue 那时候是不会更新的，看起来就像"改了又变回去"。
 *
 * 失焦才保存，不是每敲一个字保存一次：一个名字要发七八个请求，而且中间那些
 * 半截的值真的会被写进库里。回车等同于失焦。
 */
function InlineText({
  value,
  onSave,
  onDone,
  placeholder,
}: {
  value: string | null;
  onSave: (v: string | null) => void;
  onDone: () => void;
  placeholder?: string;
}) {
  const [v, setV] = useState(value ?? "");
  useEffect(() => setV(value ?? ""), [value]);
  return (
    <Input
      size="small"
      autoFocus
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onPressEnter={(e) => (e.target as HTMLInputElement).blur()}
      onBlur={() => {
        const t = v.trim();
        // 没改就别发请求——点开看一眼又点走不该算一次修改
        if (t !== (value ?? "")) onSave(t || null);
        onDone();
      }}
    />
  );
}

// 狗档案：现在主要靠样本扫描时按文件名里的 dog 编号自动建档（采集端还没开始
// 带这个信息之前基本是空的），这里补一套手动管理 + 每只狗的样本总览（按
// 日期分组，能看出这只狗每天的数据处于哪个标注阶段）。
/**
 * 体重/颈围这两格。跟别的字段不一样：它们不在 dogs 表上，是 dog_measurements
 * 里按日期记的一串，列里显示的是最新一次。所以这里改的含义不是"把那个数改掉"，
 * 而是"今天量了这么多"——记一条今天的记录，历史那些一条不动。
 *
 * 同一天改几次不会堆出几条：后端按 (狗, 日期) 合并。
 */
function InlineNumber({
  value,
  unit,
  onSave,
  onDone,
}: {
  value: number | null;
  unit: string;
  onSave: (v: number) => void;
  onDone: () => void;
}) {
  const [v, setV] = useState(value == null ? "" : String(value));
  useEffect(() => setV(value == null ? "" : String(value)), [value]);
  return (
    <Input
      size="small"
      autoFocus
      value={v}
      suffix={<span style={{ fontSize: 11, opacity: 0.6 }}>{unit}</span>}
      onChange={(e) => setV(e.target.value)}
      onPressEnter={(e) => (e.target as HTMLInputElement).blur()}
      onBlur={() => {
        const n = Number(v.trim());
        // 空着或者打错字就当没改：这里没有"清空体重"的语义——真要删得去展开行里
        // 删那条记录，不然一个手滑就把今天的记录写成 0kg
        if (!v.trim() || !Number.isFinite(n) || n <= 0) {
          setV(value == null ? "" : String(value));
          onDone();
          return;
        }
        if (n !== value) onSave(n);
        onDone();
      }}
    />
  );
}

export default function Dogs() {
  const qc = useQueryClient();
  const { data: dogs, isLoading } = useQuery({ queryKey: ["dogs"], queryFn: listDogs });
  const { data: samples } = useQuery({ queryKey: ["samples"], queryFn: listSamples });
  const { data: tasks } = useQuery({ queryKey: ["tasks"], queryFn: () => listTasks() });

  // 当前看哪个场所（all / 影棚 / 狗场…）。记住选择：管狗场的人不该每次都先切一下
  const [siteTab, setSiteTab] = useState(() => getSavedText(SITE_TAB_KEY, "all"));
  const [open, setOpen] = useState(false);
  // 正在改的是哪一格。一次只有一格是输入框——整行一起变输入框的话，
  // 每一列的宽度都跟着变，一行的排版全乱
  const [editingCell, setEditingCell] = useState<{ id: number; field: string } | null>(null);
  // 刚存过的那一行闪一下"已保存"。用 message 弹全局提示太吵——一行填四五个
  // 字段就弹四五次，而人的注意力本来就在这一行上
  const [justSaved, setJustSaved] = useState<number | null>(null);
  // 照片单独开弹窗：展开行里已经有体重记录和时间轴了，再塞图会很长
  const [photoDog, setPhotoDog] = useState<Dog | null>(null);
  // 排序记住：按体重/年龄/照片数排过一次，切走再回来还是那个顺序
  const dogSort = usePersistedSort("dogs-sort");
  const dogWidth = useResizableColumns("dogs-widths");
  const [form] = Form.useForm<FormValues>();

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["dogs"] });
    qc.invalidateQueries({ queryKey: ["samples"] });
  };

  const samplesOf = (dogId: number) => samples?.filter((s) => s.dog_id === dogId) ?? [];

  // 总预览：一眼看清每个场所有几只狗、登记齐了没有、有没有数据。
  // 「已登记」= 名字填了的：编号是扫描自动建的，名字得人补，没补的那些在
  // 皮肤评估那边就对不上照片目录，是要盯着补完的
  // 当前标签页要显示哪些狗
  const shown = useMemo(
    () => (siteTab === "all" ? dogs ?? [] : (dogs ?? []).filter((d) => ((d.site || "").trim() || "未填场所") === siteTab)),
    [dogs, siteTab]
  );

  const overview = useMemo(() => {
    const list = dogs ?? [];
    const bySite = new Map<string, Dog[]>();
    for (const d of list) {
      const key = (d.site || "").trim() || "未填场所";
      bySite.set(key, [...(bySite.get(key) ?? []), d]);
    }
    const stat = (ds: Dog[]) => ({
      total: ds.length,
      named: ds.filter((d) => (d.name || "").trim()).length,
      withSamples: ds.filter((d) => samplesOf(d.id).length > 0).length,
      samples: ds.reduce((n, d) => n + samplesOf(d.id).length, 0),
    });
    return {
      all: stat(list),
      sites: [...bySite.entries()]
        // 未填的排最后，其余按狗多的在前
        .sort((a, b) => (a[0] === "未填场所" ? 1 : b[0] === "未填场所" ? -1 : b[1].length - a[1].length))
        .map(([site, ds]) => ({ site, ...stat(ds) })),
    };
  }, [dogs, samples]);
  const tasksOfSample = (sampleId: number) => tasks?.filter((t) => t.sample_id === sampleId) ?? [];

  const openCreate = () => {
    form.resetFields();
    setOpen(true);
  };

  /** 改一个字段就存一个字段。失败要把话说清楚，不然自动保存悄悄没生效最坑 */
  const saveField = async (dog: Dog, patch: Parameters<typeof updateDog>[1]) => {
    try {
      await updateDog(dog.id, patch);
      setJustSaved(dog.id);
      window.setTimeout(() => setJustSaved((cur) => (cur === dog.id ? null : cur)), 1500);
      refresh();
    } catch {
      message.error("没保存上，检查一下网络再改一次");
    }
  };

  /**
   * 一个可以直接改的单元格：点一下变成输入框，改完（失焦/选完）自动存、变回文字。
   *
   * 只有被点的那一格变，不是整行——整行一起变的话每列宽度都跟着变，排版全乱。
   *
   * 两处都要挡掉点击冒泡：这张表是 expandRowByClick 的，不挡的话点一下格子会把
   * 这一行展开/收起，正在填的东西跟着跳走。
   */
  const cell = (d: Dog, field: string, editor: React.ReactNode, view: React.ReactNode) => {
    if (editingCell?.id === d.id && editingCell.field === field) {
      return <span onClick={(e) => e.stopPropagation()}>{editor}</span>;
    }
    return (
      <span
        onClick={(e) => {
          e.stopPropagation();
          setEditingCell({ id: d.id, field });
        }}
        // 整格都能点，包括空白处：只让文字可点的话，"—"那种一个字符的格子
        // 要瞄准了才点得中
        style={{ display: "block", minHeight: 22, cursor: "text" }}
        title="点一下改"
      >
        {view}
      </span>
    );
  };

  /** 改完退出编辑态。存不存得上都要退——卡在输入框里更让人以为没生效 */
  const doneEditing = () => setEditingCell(null);

  /** 记一条今天的体重/颈围。后端按 (狗, 日期) 合并，同一天改几次只留一条 */
  const saveMeasure = async (dog: Dog, patch: { weight_kg?: number; neck_cm?: number }) => {
    try {
      await addMeasurement(dog.id, { measured_on: dayjs().format("YYYY-MM-DD"), ...patch });
      setJustSaved(dog.id);
      window.setTimeout(() => setJustSaved((cur) => (cur === dog.id ? null : cur)), 1500);
      refresh();
      qc.invalidateQueries({ queryKey: ["dog-measurements", dog.id] });
    } catch {
      message.error("没保存上，检查一下网络再改一次");
    }
  };

  const handleSubmit = async (values: FormValues) => {
    await createDog({
      ...values,
      birth_date: values.birth_date ? values.birth_date.format("YYYY-MM-DD") : undefined,
    });
    message.success("已创建");
    setOpen(false);
    refresh();
  };

  const handleDelete = async (id: number) => {
    await deleteDog(id);
    message.success("已删除");
    refresh();
  };

  return (
    <div>
      <Space style={{ marginBottom: 8 }}>
        <Button type="primary" onClick={openCreate}>
          新建狗档案
        </Button>
        {dogWidth.hasCustom && (
          <Tooltip title="列宽是拖出来的，记在这台电脑上。拖乱了点这里回到默认">
            <Button size="small" type="link" onClick={dogWidth.reset}>
              恢复列宽
            </Button>
          </Tooltip>
        )}
      </Space>

      {/* 说明在前、卡片在后：卡片高度不一，夹在文字中间会把段落顶得七零八落 */}
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        狗编号（dog_code）现在主要靠样本扫描时从文件名里自动识别建档，采集端还没开始带这个信息之前基本用不上；
        新建/手动关联样本是在文件名规则落地前的过渡办法。点左侧箭头能展开：记体重/颈围、看这只狗每天的样本和标注进度。
        <br />
        同一只狗在三个地方叫法不一样：样本编号里只有<b>机位号</b>（_imu1）、皮肤评估用的是「比熊-BB」这种
        「品种-名字」、NAS 上的照片目录又常写成 bibi / Bali。这一页就是把它们对上的地方：
        <b>机位</b>填 IMU1（留空则按编号当机位，编号 1 = IMU1）；<b>别名</b>把照片目录名填进去（逗号分隔），
        皮肤评估的「照片」列才找得到图。
      </Typography.Paragraph>

      {/* 总览：一张总的 + 每个场所一张。「已登记」是填了名字的——编号是扫描
          时自动建的，名字得人补，没补的在皮肤评估那边对不上照片目录 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 12 }}>
        <Card size="small" title="全部" styles={{ body: { padding: "8px 16px" } }}>
          <Space size={24}>
            <Statistic title="狗总数" value={overview.all.total} valueStyle={{ fontSize: 20 }} />
            <Statistic
              title="已登记名字"
              value={overview.all.named}
              suffix={`/ ${overview.all.total}`}
              valueStyle={{ fontSize: 20, color: overview.all.named < overview.all.total ? "#fa8c16" : undefined }}
            />
            <Statistic title="有数据的" value={overview.all.withSamples} valueStyle={{ fontSize: 20 }} />
            <Statistic title="样本总数" value={overview.all.samples} valueStyle={{ fontSize: 20 }} />
          </Space>
        </Card>
        {overview.sites.map((s) => (
          <Card key={s.site} size="small" title={s.site} styles={{ body: { padding: "8px 16px" } }}>
            <Space size={20}>
              <Statistic title="狗" value={s.total} valueStyle={{ fontSize: 18 }} />
              <Statistic
                title="已登记"
                value={s.named}
                suffix={`/ ${s.total}`}
                valueStyle={{ fontSize: 18, color: s.named < s.total ? "#fa8c16" : undefined }}
              />
              <Statistic title="样本" value={s.samples} valueStyle={{ fontSize: 18 }} />
            </Space>
          </Card>
        ))}
      </div>

      {/* 按场所切换：两批狗是两拨人在管，各看各的那批更顺手；「全部」留着做总览。
          标签是按数据里实际有的场所生成的，以后开新场地不用改代码 */}
      <Tabs
        activeKey={siteTab}
        onChange={(k) => {
          setSiteTab(k);
          saveText(SITE_TAB_KEY, k);
        }}
        items={[
          { key: "all", label: `全部 ${overview.all.total}` },
          ...overview.sites.map((s) => ({ key: s.site, label: `${s.site} ${s.total}` })),
        ]}
      />

      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={shown}
        expandable={{
          expandRowByClick: true,
          // 以前只有"有样本"才能展开；现在展开里还有体重记录，没样本的狗也得能展开记
          expandedRowRender: (d: Dog) => (
            <div onClick={(e) => e.stopPropagation()}>
              <Typography.Text strong style={{ fontSize: 12 }}>
                体重 / 颈围记录
              </Typography.Text>
              <div style={{ marginTop: 6, marginBottom: 12 }}>
                <DogMeasurements dogId={d.id} />
              </div>
              {samplesOf(d.id).length > 0 && (
                <>
                  <Typography.Text strong style={{ fontSize: 12 }}>
                    每天的样本和标注进度
                  </Typography.Text>
                  <DogTimeline samples={samplesOf(d.id)} tasksOfSample={tasksOfSample} />
                </>
              )}
            </div>
          ),
        }}
        onChange={dogSort.onTableChange}
        components={dogWidth.components}
        tableLayout={dogWidth.tableLayout}
        // 拖出来的列宽要生效，表格得是固定布局——antd 靠 scroll.x 切过去
        scroll={{ x: "max-content" }}
        columns={dogWidth.applyResize<Dog>(dogSort.applySort<Dog>([
          { title: "编号", dataIndex: "dog_code", width: 120 },
          {
            title: "名字",
            dataIndex: "name",
            render: (v: string | null, d: Dog) =>
              cell(d, "name", <InlineText value={v} placeholder="名字" onSave={(x) => saveField(d, { name: x })} onDone={doneEditing} />, v || "-"),
          },
          {
            title: "品种",
            dataIndex: "breed",
            render: (v: string | null, d: Dog) =>
              cell(d, "breed", <InlineText value={v} placeholder="品种" onSave={(x) => saveField(d, { breed: x })} onDone={doneEditing} />, v || "-"),
          },
          {
            title: "机位",
            dataIndex: "imu",
            width: 110,
            render: (v: string | null, d: Dog) =>
              cell(
                d,
                "imu",
                <InlineText
                  value={v}
                  placeholder={`IMU${d.dog_code}`}
                  onSave={(x) => saveField(d, { imu: x })}
                  onDone={doneEditing}
                />,
                v || (/^\d+$/.test(d.dog_code) ? <span style={{ opacity: 0.5 }}>IMU{d.dog_code}（按编号）</span> : "-")
              ),
          },
          {
            title: "别名（照片目录名）",
            dataIndex: "aliases",
            render: (v: string | null, d: Dog) =>
              cell(d, "aliases", <InlineText value={v} placeholder="bibi, BB" onSave={(x) => saveField(d, { aliases: x })} onDone={doneEditing} />, v || "-"),
          },
          {
            title: "年龄",
            key: "age",
            // 解锁后这里是个 DatePicker，比"6个月"三个字宽得多，宽度按它来
            width: 145,
            sorter: (a: Dog, b: Dog) => (a.birth_date ?? "9999").localeCompare(b.birth_date ?? "9999"),
            // 存的是出生日期，年龄现算——存"3岁"的话明年就不对了，也没人会回来改
            render: (_: unknown, d: Dog) =>
              cell(
                d,
                "birth_date",
                <DatePicker
                  size="small"
                  autoFocus
                  // 点开就直接展开日历：不然还要再点一下才能选，等于多一步
                  open
                  style={{ width: "100%" }}
                  // 存生日不存岁数，所以改的是生日，显示的还是现算的年龄
                  value={d.birth_date ? dayjs(d.birth_date) : null}
                  onChange={(v) => {
                    saveField(d, { birth_date: v ? v.format("YYYY-MM-DD") : null });
                    doneEditing();
                  }}
                  onOpenChange={(o) => !o && doneEditing()}
                />,
                d.age_text ? (
                  <Tooltip title={`出生 ${d.birth_date}`}>
                    <span>{d.age_text}</span>
                  </Tooltip>
                ) : (
                  <Typography.Text type="secondary">未填生日</Typography.Text>
                )
              ),
          },
          {
            title: "体重",
            key: "weight",
            width: 130,
            sorter: (a: Dog, b: Dog) => (a.latest_weight_kg ?? -1) - (b.latest_weight_kg ?? -1),
            // 显示最新一次；体重会变，所以要带上是什么时候量的
            render: (_: unknown, d: Dog) =>
              cell(
                d,
                "weight",
                <Tooltip title="填进去 = 记一条今天的体重，以前量的都还在（展开这一行能看）">
                  <span>
                    <InlineNumber
                      value={d.latest_weight_kg}
                      unit="kg"
                      onSave={(n) => saveMeasure(d, { weight_kg: n })}
                      onDone={doneEditing}
                    />
                  </span>
                </Tooltip>,
                d.latest_weight_kg == null ? (
                  <Typography.Text type="secondary">—</Typography.Text>
                ) : (
                  <Tooltip title={`${d.latest_measured_on} 量的，共 ${d.n_measurements} 次记录；展开这一行看变化`}>
                    <Space size={4}>
                      <span>{d.latest_weight_kg} kg</span>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {d.latest_measured_on?.slice(5)}
                      </Typography.Text>
                    </Space>
                  </Tooltip>
                )
              ),
          },
          {
            title: "颈围",
            // 解锁后是个输入框，90 装不下数字加单位
            width: 110,
            render: (_: unknown, d: Dog) =>
              cell(
                d,
                "neck",
                <Tooltip title="填进去 = 记一条今天的颈围，以前量的都还在">
                  <span>
                    <InlineNumber
                      value={d.latest_neck_cm}
                      unit="cm"
                      onSave={(n) => saveMeasure(d, { neck_cm: n })}
                      onDone={doneEditing}
                    />
                  </span>
                </Tooltip>,
                d.latest_neck_cm == null ? (
                  <Typography.Text type="secondary">—</Typography.Text>
                ) : (
                  `${d.latest_neck_cm} cm`
                )
              ),
          },
          {
            title: "体型",
            dataIndex: "size",
            // 同上：解锁后是个下拉，80 装不下
            width: 110,
            // 按大→中→小排，不按字典序（字典序出来是"中大小"，没有意义）
            sorter: (a: Dog, b: Dog) => {
              const rank = (v: string | null) => (v ? SIZES.indexOf(v as (typeof SIZES)[number]) : SIZES.length);
              return rank(a.size) - rank(b.size);
            },
            render: (v: string | null, d: Dog) =>
              cell(
                d,
                "size",
                <Select
                  size="small"
                  autoFocus
                  defaultOpen
                  allowClear
                  style={{ width: "100%" }}
                  value={v ?? undefined}
                  placeholder="大/中/小"
                  options={SIZES.map((x) => ({ value: x, label: `${x}型` }))}
                  onChange={(x) => {
                    saveField(d, { size: x ?? null });
                    doneEditing();
                  }}
                  onBlur={doneEditing}
                />,
                v ? <Tag color={SIZE_COLOR[v]}>{v}型</Tag> : <Typography.Text type="secondary">未填</Typography.Text>
              ),
          },
          {
            title: "场所",
            dataIndex: "site",
            width: 100,
            render: (v: string | null, d: Dog) =>
              cell(
                d,
                "site",
                <Select
                  size="small"
                  autoFocus
                  defaultOpen
                  allowClear
                  style={{ width: "100%" }}
                  value={v ?? undefined}
                  placeholder="场所"
                  options={SITES.map((x) => ({ value: x, label: x }))}
                  onChange={(x) => {
                    saveField(d, { site: x ?? null });
                    doneEditing();
                  }}
                  onBlur={doneEditing}
                />,
                v ? <Tag>{v}</Tag> : <Typography.Text type="secondary">未填</Typography.Text>
              ),
          },
          {
            title: "照片/视频",
            key: "photos",
            width: 100,
            sorter: (a: Dog, b: Dog) => a.n_photos - b.n_photos,
            // 认狗用的档案照 + 平时动作的小视频，存在可写的那块 NAS 上
            // （跟只读的素材库相册不是一回事）
            render: (_: unknown, d: Dog) => (
              <Button size="small" type="link" style={{ padding: 0 }} onClick={(e) => { e.stopPropagation(); setPhotoDog(d); }}>
                {d.n_photos > 0 ? `${d.n_photos} 个` : "上传"}
              </Button>
            ),
          },
          {
            title: "备注",
            dataIndex: "remark",
            render: (v: string | null, d: Dog) =>
              cell(d, "remark", <InlineText value={v} onSave={(x) => saveField(d, { remark: x })} onDone={doneEditing} />, v || "-"),
          },
          {
            title: "样本数",
            width: 90,
            render: (_, d: Dog) => samplesOf(d.id).length,
          },
          {
            title: "操作",
            width: 110,
            render: (_, d: Dog) => (
              <Space onClick={(e) => e.stopPropagation()}>
                {justSaved === d.id && (
                  <Typography.Text type="success" style={{ fontSize: 12 }}>
                    已保存
                  </Typography.Text>
                )}
                <Popconfirm
                  title="删除狗档案"
                  description="还有样本关联着的话删不掉"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => handleDelete(d.id)}
                >
                  <Button size="small" danger type="link">
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]))}
      />

      <Modal
        title="新建狗档案"
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Form.Item name="dog_code" label="编号" rules={[{ required: true }]}>
            <Input placeholder="跟文件名里 _dog 后面那段对应" />
          </Form.Item>
          <Form.Item name="name" label="名字">
            <Input />
          </Form.Item>
          <Form.Item name="breed" label="品种">
            <Input />
          </Form.Item>
          <Form.Item name="imu" label="机位" tooltip="这只狗戴的是哪个机位，样本编号 _imu1 对应 IMU1。留空按编号推断">
            <Input placeholder="IMU1" />
          </Form.Item>
          <Form.Item
            name="aliases"
            label="别名"
            tooltip="NAS 照片目录名、拼音、小名等，逗号分隔。皮肤评估靠它把照片跟这只狗对上"
          >
            <Input placeholder="bibi, BB, 比比" />
          </Form.Item>
          <Form.Item name="site" label="场所" tooltip="这只狗在哪个场地。以前写在备注里，单独一列才能按场所筛选和统计">
            <Select allowClear placeholder="影棚 / 狗场" options={SITES.map((x) => ({ value: x, label: x }))} />
          </Form.Item>
          <Form.Item
            name="size"
            label="体型"
            tooltip="大 / 中 / 小。不按体重自动分——同样 13kg，法斗是中型，小体金毛是大型幼犬。抓挠的幅度和频率跟体型直接相关，分开记才能按体型看指标"
          >
            <Select allowClear placeholder="大 / 中 / 小" options={SIZES.map((x) => ({ value: x, label: `${x}型` }))} />
          </Form.Item>
          <Form.Item
            name="birth_date"
            label="出生日期"
            tooltip="存生日不存岁数——年龄天天在长，存「3岁」明年就不对了。列表里的年龄按它现算"
          >
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            创建
          </Button>
        </Form>
      </Modal>

      <Modal
        title={photoDog ? `照片 / 视频 - ${photoDog.name || photoDog.dog_code}` : ""}
        open={!!photoDog}
        onCancel={() => setPhotoDog(null)}
        footer={null}
        width={760}
        destroyOnClose
      >
        {photoDog && (
          <DogPhotos
            dogId={photoDog.id}
            // 传/删完刷新档案列表，那一列的张数才跟着变
            onChange={() => qc.invalidateQueries({ queryKey: ["dogs"] })}
          />
        )}
      </Modal>
    </div>
  );
}

// 这只狗的样本按日期分组，每个样本再列出关联任务当前的标注阶段——
// 就是"每只狗每天数据情况"看板的第一版：原始/AI预标注/已审核这几个阶段
// 直接复用现有的 Task.status（AI预标注对应的是还没真正接推理服务，
// 暂时不会出现，等接上了这里不用改，数据自然就会出现在这一档）。
function DogTimeline({
  samples,
  tasksOfSample,
}: {
  samples: Sample[];
  tasksOfSample: (sampleId: number) => { status: TaskStatus }[];
}) {
  const groups = useMemo(() => {
    const map = new Map<string, Sample[]>();
    for (const s of samples) {
      const key = s.session_date ?? "未知日期";
      (map.get(key) ?? map.set(key, []).get(key)!).push(s);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [samples]);

  return (
    <Table
      size="small"
      rowKey={(g) => g[0]}
      dataSource={groups}
      pagination={groups.length > 10 ? { pageSize: 10 } : false}
      columns={[
        { title: "日期", render: (g: [string, Sample[]]) => g[0], width: 140 },
        { title: "样本数", render: (g: [string, Sample[]]) => g[1].length, width: 90 },
        {
          title: "标注进度",
          render: (g: [string, Sample[]]) => (
            <Space size={4} wrap>
              {g[1].map((s) => {
                const statuses = tasksOfSample(s.id);
                if (statuses.length === 0) {
                  return (
                    <Tag key={s.id} title={s.sample_code}>
                      {s.sample_code} 未建任务
                    </Tag>
                  );
                }
                return statuses.map((t, i) => (
                  <Tag key={`${s.id}-${i}`} color={TASK_STATUS_META[t.status]?.color} title={s.sample_code}>
                    {s.sample_code} {TASK_STATUS_META[t.status]?.label ?? t.status}
                  </Tag>
                ));
              })}
            </Space>
          ),
        },
      ]}
    />
  );
}
