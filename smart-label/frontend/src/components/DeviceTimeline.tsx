import { Tooltip, Typography } from "antd";

/** 一只狗一天两个项圈轮换时，每个设备戴了多久、哪几段（后端 skin_daily_stats.devices） */
export interface DeviceWear {
  imu: string;
  worn_s: number;
  spans: [string, string][];
}

const COLORS = ["#1677ff", "#fa8c16", "#52c41a", "#eb2f96"];
const hm = (s: string) => s.slice(11, 16);

/**
 * 当天 0~24 点的一条小时间轴：每个设备戴着的时段一种颜色，空白 = 两个都没戴（或掉数据）。
 * 一眼看出几点换的项圈、有没有一段谁都没戴。
 */
export default function DeviceTimeline({ day, devices, width = 120 }: { day: string; devices: DeviceWear[]; width?: number }) {
  const t0 = new Date(`${day}T00:00:00`).getTime();
  const x = (ts: string) => Math.min(width, Math.max(0, ((new Date(ts.replace(" ", "T")).getTime() - t0) / 86_400_000) * width));
  const total = devices.reduce((a, d) => a + d.worn_s, 0);
  return (
    <Tooltip
      title={
        <div style={{ fontSize: 12 }}>
          {devices.map((d, i) => (
            <div key={d.imu}>
              <span style={{ color: COLORS[i % COLORS.length] }}>■</span> {d.imu} 戴了 {(d.worn_s / 3600).toFixed(1)} 小时
              {d.spans.length ? `：${d.spans.map(([a, b]) => `${hm(a)}–${hm(b)}`).join("、")}` : ""}
            </div>
          ))}
          <div style={{ opacity: 0.75, marginTop: 4 }}>
            两个项圈轮换：每分钟按两个设备「未佩戴」概率的相对高低定哪个戴着，充电座上那个的数据不算。
            合计 {(total / 3600).toFixed(1)} 小时{total < 20 * 3600 ? "，空白处两个都像没戴（或掉数据）" : ""}
          </div>
        </div>
      }
    >
      <div style={{ display: "inline-block", lineHeight: 1 }}>
        <svg width={width} height={8} style={{ display: "block", background: "rgba(128,128,128,.15)", borderRadius: 2 }}>
          {devices.flatMap((d, i) =>
            d.spans.map(([a, b], j) => (
              <rect key={`${d.imu}-${j}`} x={x(a)} y={0} width={Math.max(1, x(b) - x(a))} height={8} fill={COLORS[i % COLORS.length]} />
            )),
          )}
        </svg>
        <Typography.Text type="secondary" style={{ fontSize: 10 }}>
          {devices.map((d) => `${d.imu} ${(d.worn_s / 3600).toFixed(1)}h`).join(" · ")}
        </Typography.Text>
      </div>
    </Tooltip>
  );
}
