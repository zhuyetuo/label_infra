import { useMemo } from "react";
import { Alert, Space, Table, Tag, Tooltip, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { listRoomPresence, type RoomPresenceRow } from "@/api/dailyStats";

const { Text } = Typography;

const fmtH = (sec: number) => {
  if (!sec) return "0";
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} 小时 ${m} 分` : `${m} 分`;
};

/**
 * 狗场单间的采集时长：按**摄像头**算，不按 IMU 算。
 *
 * 一只狗两个项圈轮换充电、而且两个同时录，按样本加时长就是双倍，哪天只戴一个又是单倍——
 * "总共采了多少小时"按 IMU 根本算不准。一间一狗一摄像头，一段画面不管配了几个 IMU 只算一次。
 * 「在单间里」用画面扫描（每 5 秒一点看有没有狗）的时间线算。
 */
export default function RoomPresenceTable({ dateFrom, dateTo }: { dateFrom: string; dateTo: string }) {
  const { data, isFetching } = useQuery({
    queryKey: ["room-presence", dateFrom, dateTo],
    queryFn: () => listRoomPresence({ date_from: dateFrom, date_to: dateTo }),
  });
  const rows = data ?? [];

  // 每个单间在这段日期里的累计：录了多久、扫了多久、有狗多久
  const totals = useMemo(() => {
    const m = new Map<string, { cam: string; dog: Set<string>; rec: number; scanned: number; present: number; unscanned: number; days: Set<string> }>();
    for (const r of rows) {
      const t = m.get(r.cam) ?? { cam: r.cam, dog: new Set(), rec: 0, scanned: 0, present: 0, unscanned: 0, days: new Set() };
      if (r.dog_name) t.dog.add(r.dog_name);
      t.rec += r.recorded_seconds;
      t.scanned += r.scanned_seconds;
      t.present += r.present_seconds;
      t.unscanned += r.n_unscanned;
      t.days.add(r.stat_date);
      m.set(r.cam, t);
    }
    return [...m.values()].sort((a, b) => a.cam.localeCompare(b.cam, undefined, { numeric: true }));
  }, [rows]);
  const grand = totals.reduce((a, t) => ({ rec: a.rec + t.rec, present: a.present + t.present, scanned: a.scanned + t.scanned }), { rec: 0, present: 0, scanned: 0 });
  const anyUnscanned = rows.some((r) => r.n_unscanned > 0);

  const pct = (present: number, scanned: number) => (scanned > 0 ? `${Math.round((present / scanned) * 100)}%` : "—");

  return (
    <Space direction="vertical" style={{ width: "100%" }} size={12}>
      <Alert
        type="info"
        showIcon
        message="按摄像头算，不按 IMU 算"
        description="一只狗两个项圈同时录，按样本加时长会翻倍。这里一间一路画面，同一段视频只算一次；「在单间里」是画面扫描（每 5 秒看一次有没有狗）里有狗的时间。只算狗场（一间一狗一摄像头），天花板公用机位不算。"
      />
      {anyUnscanned && (
        <Alert
          type="warning"
          showIcon
          message="有些段还没扫过画面，它们的时间只算进「录了多久」，不算进「在单间里」"
          description="去样本列表对这些天点「扫画面」，或者在模型服务页确认狗检测能用，扫完这里自动更新。"
        />
      )}
      <Table
        size="small"
        rowKey="cam"
        pagination={false}
        loading={isFetching}
        title={() => (
          <b>
            这段日期累计：录了 {fmtH(grand.rec)}，扫过 {fmtH(grand.scanned)}，画面里有狗 {fmtH(grand.present)}
            {grand.scanned > 0 ? `（占扫过的 ${pct(grand.present, grand.scanned)}）` : ""}
          </b>
        )}
        dataSource={totals}
        columns={[
          { title: "单间", dataIndex: "cam", width: 90, render: (c: string) => <Tag>{c.replace("cam", "")} 号（{c}）</Tag> },
          { title: "狗", width: 140, render: (_, t) => [...t.dog].join("、") || <Text type="secondary">未登记</Text> },
          { title: "有数据的天数", width: 110, render: (_, t) => t.days.size },
          { title: "录了多久", render: (_, t) => fmtH(t.rec) },
          {
            title: <Tooltip title="只按扫过画面的那些段算，没扫的段不算">扫过多久</Tooltip>,
            render: (_, t) => fmtH(t.scanned),
          },
          {
            title: <Tooltip title="扫过的段里，画面里有狗的时间。评估「这间到底采到了多少有狗的数据」看这个">在单间里</Tooltip>,
            render: (_, t) => (
              <span>
                <b>{fmtH(t.present)}</b>
                <Text type="secondary" style={{ marginLeft: 6, fontSize: 12 }}>{pct(t.present, t.scanned)}</Text>
              </span>
            ),
          },
          { title: "没扫的段", width: 90, render: (_, t) => (t.unscanned ? <Tag color="orange">{t.unscanned}</Tag> : "0") },
        ]}
      />
      <Table
        size="small"
        rowKey={(r) => `${r.stat_date}-${r.cam}`}
        loading={isFetching}
        dataSource={rows}
        pagination={{ pageSize: 50, showSizeChanger: true }}
        columns={[
          { title: "日期", dataIndex: "stat_date", width: 110, sorter: (a: RoomPresenceRow, b: RoomPresenceRow) => a.stat_date.localeCompare(b.stat_date) },
          { title: "单间", dataIndex: "cam", width: 80, sorter: (a: RoomPresenceRow, b: RoomPresenceRow) => a.cam.localeCompare(b.cam, undefined, { numeric: true }) },
          {
            title: "狗",
            width: 170,
            render: (_: unknown, r: RoomPresenceRow) => (
              <Space size={4}>
                <b>{r.dog_name || "未登记"}</b>
                <Text type="secondary" style={{ fontSize: 12 }}>{r.imus.join(" / ")}</Text>
              </Space>
            ),
          },
          { title: "段数", dataIndex: "n_videos", width: 70 },
          { title: "录了多久", render: (_: unknown, r: RoomPresenceRow) => fmtH(r.recorded_seconds) },
          { title: "扫过多久", render: (_: unknown, r: RoomPresenceRow) => fmtH(r.scanned_seconds) },
          {
            title: "在单间里",
            render: (_: unknown, r: RoomPresenceRow) => (
              <span>
                <b>{fmtH(r.present_seconds)}</b>
                <Text type="secondary" style={{ marginLeft: 6, fontSize: 12 }}>{pct(r.present_seconds, r.scanned_seconds)}</Text>
              </span>
            ),
          },
          {
            title: "没扫的段",
            width: 90,
            render: (_: unknown, r: RoomPresenceRow) => (r.n_unscanned ? <Tag color="orange">{r.n_unscanned}</Tag> : "0"),
          },
        ]}
      />
    </Space>
  );
}
