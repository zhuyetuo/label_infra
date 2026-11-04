import { useMemo, useState } from "react";
import { Alert, Button, Card, Col, Radio, Row, Space, Statistic, Table, Tag, Tooltip, Typography, message } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getSkinDataRange, mlActivate, mlModelStatus, mlTrainReal, skinDailyTracking,
  type MlScore, type TrackingRow,
} from "@/api/skin";
import { dogMetaText } from "@/components/DogMetaFilter";

/**
 * 准确率：拿兽医看照片评的档（S0 / S1 / S2）当标准答案，看三样东西各对多少——
 *   · PM 规则算的 S 档（有问卷用含问卷的，没有用不填问卷的）
 *   · ML 版模型 B 预测的 S 档
 *   · 每个实习生自己评的档（培训 / 考核用）
 * 兽医是谁：账号管理里勾了「兽医」的账号。几个兽医评得不一样时取重的那档。
 * 下面还能用这些兽医评级重训模型 B，交叉验证比 PM 准再启用。
 */
const GRADES = ["S0", "S1", "S2"];
const tierColor = (t?: string | null) => (t?.endsWith("2") ? "red" : t?.endsWith("1") ? "orange" : t ? "green" : undefined);

function score(pairs: [string, string | null | undefined][]) {
  const valid = pairs.filter(([, p]) => p && GRADES.includes(p)) as [string, string][];
  const ok = valid.filter(([g, p]) => g === p).length;
  // 偏轻 = 漏判（兽医判得更重），偏重 = 误报
  const lighter = valid.filter(([g, p]) => p < g).length;
  const heavier = valid.filter(([g, p]) => p > g).length;
  const conf: Record<string, Record<string, number>> = {};
  for (const [g, p] of valid) {
    conf[g] = conf[g] ?? {};
    conf[g][p] = (conf[g][p] ?? 0) + 1;
  }
  return { n: valid.length, acc: valid.length ? ok / valid.length : null, lighter, heavier, conf };
}

function Confusion({ conf, title }: { conf: Record<string, Record<string, number>>; title: string }) {
  return (
    <Table
      size="small" pagination={false} rowKey="g" style={{ marginTop: 8 }}
      title={() => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{title}（行 = 兽医，列 = 它判的）</Typography.Text>}
      dataSource={GRADES.map((g) => ({ g }))}
      columns={[
        { title: "", dataIndex: "g", render: (g: string) => <Tag color={tierColor(g)}>兽医 {g}</Tag> },
        ...GRADES.map((p) => ({
          title: p, align: "center" as const,
          render: (_: unknown, r: { g: string }) => {
            const v = conf[r.g]?.[p] ?? 0;
            return <span style={{ fontWeight: r.g === p ? 600 : undefined, opacity: v ? 1 : 0.35 }}>{v}</span>;
          },
        })),
      ]}
    />
  );
}

const pct = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`);

export default function SkinAccuracy() {
  const qc = useQueryClient();
  const [cPrefer, setCPrefer] = useState<"ai" | "human">("ai");
  const { data: range } = useQuery({ queryKey: ["skin-data-range"], queryFn: getSkinDataRange });
  const { data, isFetching } = useQuery({
    queryKey: ["skin-accuracy", range?.date_from, range?.date_to, cPrefer],
    queryFn: () => skinDailyTracking({ date_from: range!.date_from!, date_to: range!.date_to!, c_prefer: cPrefer }),
    enabled: !!range?.date_from && !!range?.date_to,
    refetchOnWindowFocus: false,
  });
  const { data: st } = useQuery({ queryKey: ["skin-ml-status"], queryFn: mlModelStatus, retry: false });

  const labeled = useMemo(() => (data?.rows ?? []).filter((r) => r.photo_grade_vet && GRADES.includes(r.photo_grade_vet)), [data]);
  const anyRated = (data?.rows ?? []).some((r) => r.photo_ratings?.length);
  const pmS = (r: TrackingRow) => (r.s_with_q ?? r.s_no_q)?.s_tier;
  const pm = useMemo(() => score(labeled.map((r) => [r.photo_grade_vet!, pmS(r)])), [labeled]);
  const ml = useMemo(() => score(labeled.map((r) => [r.photo_grade_vet!, r.ml?.s_tier])), [labeled]);
  // 每个非兽医评级人 vs 兽医
  const raters = useMemo(() => {
    const by = new Map<string, [string, string][]>();
    for (const r of labeled) {
      for (const x of r.photo_ratings ?? []) {
        if (x.is_vet || x.grade === "unsure") continue;
        by.set(x.user_name, [...(by.get(x.user_name) ?? []), [r.photo_grade_vet!, x.grade]]);
      }
    }
    return [...by].map(([name, pairs]) => ({ name, ...score(pairs) })).sort((a, b) => b.n - a.n);
  }, [labeled]);
  const wrong = labeled.filter((r) => pmS(r) !== r.photo_grade_vet || (r.ml?.s_tier && r.ml.s_tier !== r.photo_grade_vet));

  return (
    <div>
      <Space wrap style={{ marginBottom: 12 }}>
        <Radio.Group optionType="button" size="small" value={cPrefer} onChange={(e) => setCPrefer(e.target.value)}
          options={[{ value: "ai", label: "按 AI 版算的（线上口径）" }, { value: "human", label: "人工版优先" }]} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          标准答案 = 兽医看照片评的档（账号管理里勾了「兽医」的账号；几个兽医不一致取重的）。全部日期一起算。
        </Typography.Text>
      </Space>

      {!isFetching && !labeled.length && (
        <Alert type="info" showIcon style={{ marginBottom: 12 }}
          message="还没有兽医评过、而且能跟跟踪表对上的天"
          description={anyRated
            ? "已经有人评过级，但没有一个是兽医账号：去「账号管理」给两位兽医勾上「兽医（皮肤评级以他为准）」"
            : "先让兽医在「皮肤照片」里评级。照片要能对上跟踪表里的狗和日期（狗档案里的别名要跟照片目录名对得上）"} />
      )}

      {labeled.length > 0 && (
        <>
          <Row gutter={12}>
            <Col xs={24} md={8}>
              <Card size="small">
                <Statistic title="兽医评过的天" value={labeled.length}
                  suffix={<span style={{ fontSize: 12 }}>天 · {new Set(labeled.map((r) => r.dog_name)).size} 只狗</span>} />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {GRADES.map((g) => `${g} ${labeled.filter((r) => r.photo_grade_vet === g).length}`).join(" · ")}
                </Typography.Text>
              </Card>
            </Col>
            <Col xs={24} md={8}>
              <Card size="small">
                <Statistic title="PM 规则对上兽医" value={pct(pm.acc)} suffix={<span style={{ fontSize: 12 }}>{pm.n} 天</span>} />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>判轻了 {pm.lighter} 天 · 判重了 {pm.heavier} 天</Typography.Text>
                <Confusion conf={pm.conf} title="PM 规则" />
              </Card>
            </Col>
            <Col xs={24} md={8}>
              <Card size="small">
                <Statistic title={`ML 模型 B 对上兽医${st?.active === "real" ? "（兽医评级训练版）" : "（合成数据版）"}`}
                  value={pct(ml.acc)} suffix={<span style={{ fontSize: 12 }}>{ml.n} 天</span>} />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  判轻了 {ml.lighter} 天 · 判重了 {ml.heavier} 天
                  {ml.n < labeled.length && ` · ${labeled.length - ml.n} 天没出预测（数据不完整或还没「重新拉取」）`}
                </Typography.Text>
                <Confusion conf={ml.conf} title="ML 模型 B" />
                {st?.active === "real" && (
                  <Typography.Text type="warning" style={{ fontSize: 11 }}>
                    注意：这一版就是用这些天训练的，这里的数字偏乐观；看下面「重训」里的交叉验证数字更公平
                  </Typography.Text>
                )}
              </Card>
            </Col>
          </Row>

          <Card size="small" title="实习生 / 其他人跟兽医比" style={{ marginTop: 12 }}>
            {raters.length ? (
              <Table size="small" rowKey="name" pagination={false} dataSource={raters}
                columns={[
                  { title: "评级人", dataIndex: "name" },
                  { title: "跟兽医都评过的天", dataIndex: "n" },
                  { title: "一致", render: (_: unknown, r) => pct(r.acc) },
                  { title: "判轻了（漏判）", dataIndex: "lighter" },
                  { title: "判重了", dataIndex: "heavier" },
                ]} />
            ) : (
              <Typography.Text type="secondary">还没有非兽医的人跟兽医评过同一天</Typography.Text>
            )}
          </Card>

          <Card size="small" title={`对不上的天（${wrong.length}）`} style={{ marginTop: 12 }}>
            <Table size="small" rowKey={(r) => `${r.date}-${r.imu}`} dataSource={wrong} pagination={{ pageSize: 20, hideOnSinglePage: true }}
              scroll={{ x: "max-content" }}
              columns={[
                { title: "日期", dataIndex: "date", sorter: (a: TrackingRow, b: TrackingRow) => a.date.localeCompare(b.date), defaultSortOrder: "descend" as const },
                { title: "狗", render: (_: unknown, r: TrackingRow) => <div>{r.dog_name}<div style={{ fontSize: 11, color: "#888" }}>{dogMetaText(r)}</div></div> },
                { title: "兽医", render: (_: unknown, r: TrackingRow) => <Tag color={tierColor(r.photo_grade_vet)}>{r.photo_grade_vet}</Tag> },
                { title: "PM S", render: (_: unknown, r: TrackingRow) => <Tag color={tierColor(pmS(r))}>{pmS(r) ?? "—"}</Tag> },
                { title: "ML S", render: (_: unknown, r: TrackingRow) => <Tag color={tierColor(r.ml?.s_tier)}>{r.ml?.s_tier ?? "—"}</Tag> },
                { title: "C 值", render: (_: unknown, r: TrackingRow) => <span>{r.c_value ?? "—"} <Tag color={tierColor(r.c_tier)}>{r.c_tier}</Tag></span> },
                { title: "问卷", render: (_: unknown, r: TrackingRow) => (r.has_answers ? "有" : "—") },
                {
                  title: "各人评的", render: (_: unknown, r: TrackingRow) => (
                    <Space size={2} wrap>
                      {(r.photo_ratings ?? []).map((x, i) => (
                        <Tooltip key={i} title={x.note || undefined}>
                          <Tag color={x.is_vet ? tierColor(x.grade) : undefined}>{x.user_name}{x.is_vet ? "（兽医）" : ""} {x.grade === "unsure" ? "看不清" : x.grade}</Tag>
                        </Tooltip>
                      ))}
                    </Space>
                  ),
                },
              ]} />
          </Card>
        </>
      )}

      <RealRetrainCard cPrefer={cPrefer} hasLabels={labeled.length > 0} />
    </div>
  );
}


/** 用兽医评级重训模型 B：训练、看交叉验证、启用 / 切回。准确率页和 ML 版「模型与训练」都用 */
export function RealRetrainCard({ cPrefer, hasLabels }: { cPrefer: "ai" | "human"; hasLabels: boolean }) {
  const qc = useQueryClient();
  const { data: st, refetch: refetchSt } = useQuery({ queryKey: ["skin-ml-status"], queryFn: mlModelStatus, retry: false });
  const [training, setTraining] = useState(false);
  const [switching, setSwitching] = useState(false);
  const train = async () => {
    setTraining(true);
    try {
      const r = await mlTrainReal(cPrefer);
      if (!r.ok) message.warning(r.message ?? "没训练成");
      else message.success("训练完了，看下面的对比再决定要不要启用");
      refetchSt();
    } catch (e) {
      message.error(`训练失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTraining(false);
    }
  };
  const activate = async (which: "real" | "synthetic") => {
    setSwitching(true);
    try {
      const r = await mlActivate(which);
      message.success(which === "real" ? "已启用兽医评级训练的模型 B，ML 结果已全部重算" : "已切回合成数据版模型 B");
      r.warnings?.forEach((w) => message.warning(w));
      refetchSt();
      qc.invalidateQueries({ queryKey: ["skin-accuracy"] });
      qc.invalidateQueries({ queryKey: ["skin-ml-results"] });
      qc.invalidateQueries({ queryKey: ["skin-tracking"] });
    } catch (e) {
      message.error(`切换失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSwitching(false);
    }
  };

  const rep = st?.real_report;
  const repScore = (s?: MlScore) => (s && s.acc != null ? `${pct(s.acc)}（${s.n} 天）` : "—");

  return (
      <Card size="small" title="用兽医评级重训模型 B" style={{ marginTop: 12 }}
        extra={st && <Tag color={st.active === "real" ? "purple" : "default"}>现在用的：{st.active === "real" ? "兽医评级训练版" : "合成数据版"}</Tag>}>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          合成数据打底（权重低），兽医评级为主。按狗分组交叉验证：每次留几只狗当考题、用其余的训练，看它跟兽医对得上多少，
          同一批考题上也算 PM 规则和现在的合成版各对多少——<b>比 PM 准再启用</b>。至少要 {st?.min_real ?? 30} 天、3 只狗、2 种档位的兽医评级。
          训练不会自动启用；启用后库里所有天的 ML 结果按新模型重算。
        </Typography.Paragraph>
        <Space wrap>
          <Button type="primary" loading={training} onClick={train} disabled={!hasLabels}>
            {training ? "训练中（半分钟到几分钟）" : "用现在的兽医评级训练"}
          </Button>
          {st?.has_real && st.active !== "real" && (
            <Button loading={switching} onClick={() => activate("real")}>启用兽医评级训练版</Button>
          )}
          {st?.active === "real" && <Button loading={switching} onClick={() => activate("synthetic")}>切回合成数据版</Button>}
        </Space>
        {rep && (
          <div style={{ marginTop: 12 }}>
            <Typography.Text style={{ fontSize: 12 }}>
              上次训练 {rep.trained_at.replace("T", " ")}：{rep.n_days} 天 / {rep.n_dogs} 只狗（{Object.entries(rep.label_counts).map(([k, v]) => `${k} ${v}`).join(" · ")}），{rep.folds} 折交叉验证
            </Typography.Text>
            <Table size="small" pagination={false} rowKey="k" style={{ marginTop: 6, maxWidth: 560 }}
              dataSource={[
                { k: "兽医评级训练版（交叉验证）", s: rep.real },
                { k: "合成数据版（现成的）", s: rep.synthetic },
                { k: "PM 规则", s: rep.pm },
              ]}
              columns={[
                { title: "", dataIndex: "k" },
                { title: "跟兽医一致", render: (_: unknown, r) => repScore(r.s) },
              ]} />
            {rep.real.acc != null && rep.pm.acc != null && (
              <Typography.Text type={rep.real.acc > rep.pm.acc ? "success" : "warning"} style={{ fontSize: 12 }}>
                {rep.real.acc > rep.pm.acc ? "比 PM 规则准，可以启用" : "还没比 PM 规则准，先别启用，攒更多评级再训"}
              </Typography.Text>
            )}
          </div>
        )}
      </Card>
  );
}
