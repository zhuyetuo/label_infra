import { useState } from "react";
import { Button, DatePicker, Empty, InputNumber, Input, Popconfirm, Space, Table, Typography, message } from "antd";
import dayjs from "dayjs";
import { useQuery } from "@tanstack/react-query";
import { addMeasurement, deleteMeasurement, listMeasurements, type DogMeasurement } from "@/api/dogs";

/**
 * 一只狗的体重/颈围记录。
 *
 * 为什么不做成档案上的一个字段：体重会变，而「什么时候几公斤」本身就是要看的
 * ——掉秤、长胖都跟皮肤状况有关系。一个字段只能存"现在多少"，改一次旧的就没了。
 * 所以按次记录，档案列表显示最新一条，这里能看全部变化。
 *
 * 颈围（项圈松紧、会不会磨到皮肤）同理，没量就留空，不强制。
 */
export default function DogMeasurements({ dogId }: { dogId: number }) {
  const { data, refetch, isLoading } = useQuery({
    queryKey: ["dog-measurements", dogId],
    queryFn: () => listMeasurements(dogId),
  });
  const [on, setOn] = useState(dayjs());
  const [weight, setWeight] = useState<number | null>(null);
  const [neck, setNeck] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (weight == null && neck == null) return message.warning("体重和颈围至少填一个");
    setBusy(true);
    try {
      await addMeasurement(dogId, {
        measured_on: on.format("YYYY-MM-DD"),
        weight_kg: weight,
        neck_cm: neck,
        note: note.trim() || undefined,
      });
      setWeight(null);
      setNeck(null);
      setNote("");
      refetch();
      message.success("已记录");
    } finally {
      setBusy(false);
    }
  };

  const rows = data ?? [];
  return (
    <div>
      <Space wrap style={{ marginBottom: 8 }}>
        {/* 量的那天，不是录入那天——补录以前的数据时这两个不是一回事 */}
        <DatePicker value={on} onChange={(v) => v && setOn(v)} allowClear={false} />
        <InputNumber addonBefore="体重" addonAfter="kg" min={0} max={120} step={0.1} value={weight} onChange={setWeight} />
        <InputNumber addonBefore="颈围" addonAfter="cm" min={0} max={120} step={0.5} value={neck} onChange={setNeck} />
        <Input placeholder="备注（可不填）" style={{ width: 160 }} value={note} onChange={(e) => setNote(e.target.value)} />
        <Button type="primary" loading={busy} onClick={submit}>
          记一笔
        </Button>
      </Space>
      {rows.length === 0 && !isLoading ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有记录" />
      ) : (
        <Table<DogMeasurement>
          size="small"
          rowKey="id"
          loading={isLoading}
          dataSource={rows}
          pagination={false}
          scroll={{ y: 240 }}
          columns={[
            { title: "日期", dataIndex: "measured_on", width: 120 },
            {
              title: "体重",
              width: 110,
              // 跟上一条比一比：掉秤/长胖比绝对值更值得注意
              render: (_, r, i) => {
                if (r.weight_kg == null) return <Typography.Text type="secondary">—</Typography.Text>;
                const prev = rows.slice(i + 1).find((x) => x.weight_kg != null)?.weight_kg;
                const d = prev != null ? r.weight_kg - prev : null;
                return (
                  <Space size={4}>
                    <span>{r.weight_kg} kg</span>
                    {d != null && Math.abs(d) >= 0.05 && (
                      <Typography.Text type={d > 0 ? "warning" : "danger"} style={{ fontSize: 12 }}>
                        {d > 0 ? "+" : ""}
                        {d.toFixed(1)}
                      </Typography.Text>
                    )}
                  </Space>
                );
              },
            },
            {
              title: "颈围",
              width: 90,
              render: (_, r) => (r.neck_cm == null ? <Typography.Text type="secondary">—</Typography.Text> : `${r.neck_cm} cm`),
            },
            { title: "备注", render: (_, r) => r.note || "-" },
            {
              title: "",
              width: 60,
              render: (_, r) => (
                <Popconfirm
                  title="删掉这条记录？"
                  onConfirm={async () => {
                    await deleteMeasurement(dogId, r.id);
                    refetch();
                  }}
                >
                  <Button size="small" type="link" danger>
                    删除
                  </Button>
                </Popconfirm>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}
