import { useEffect, useState } from "react";
import { Alert, Modal, Space, Spin, Typography } from "antd";
import { getLowlight } from "@/api/samples";

/**
 * 夜视增强：把黑得看不见的那几秒捞出来看清楚。
 *
 * **三张并排，不是只给最好看的那一张。** 人要判断的不是"哪张好看"，而是
 * "这一路夜间到底有没有拍到东西"——只给增强后的那张，他没法区分
 * 「看清了」和「模型/拉伸编出来的」。
 */
export default function LowlightModal({
  sampleId, cam, t, label, onClose,
}: {
  sampleId: number | null;
  cam: string;
  t: number;
  label?: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<Awaited<ReturnType<typeof getLowlight>> | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (sampleId == null) return;
    setData(null);
    setLoading(true);
    getLowlight(sampleId, { cam, t, window_s: 2 })
      .then(setData)
      .catch((e) => setData({ available: false, error: String(e) }))
      .finally(() => setLoading(false));
  }, [sampleId, cam, t]);

  const pic = (title: string, b64?: string, note?: string) =>
    b64 ? (
      <div style={{ flex: 1, minWidth: 260 }}>
        <Typography.Text strong>{title}</Typography.Text>
        {note && (
          <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 6 }}>
            {note}
          </Typography.Text>
        )}
        <img src={`data:image/jpeg;base64,${b64}`} style={{ width: "100%", display: "block", marginTop: 4 }} />
      </div>
    ) : null;

  const si = data?.stretch_info;
  const ki = data?.stack_info;
  return (
    <Modal
      title={`夜视增强 · ${label ?? ""} ${t.toFixed(1)}s（${cam}）`}
      open={sampleId != null}
      onCancel={onClose}
      footer={null}
      width="90vw"
    >
      {loading && <Spin tip="解帧、对齐、堆栈中…" />}
      {data?.available === false && <Alert type="error" showIcon message={data.error} />}
      {data?.available && (
        <>
          <Alert
            type={ki && ki.gain >= 11 ? "warning" : "info"}
            showIcon
            style={{ marginBottom: 12 }}
            message={
              si && ki
                ? `原片只用到 ${si.lo}~${si.hi} 这 ${Math.round(si.hi - si.lo)} 级；堆栈平均了 ${ki.frames} 帧（信噪比约 ×${ki.snr_gain}），最后放大 ${ki.gain}×`
                : "已处理"
            }
            description={
              ki && ki.gain >= 11
                ? "放大已经顶到上限，再拉就是把噪声放成雪花。堆栈那张要是也看不出东西，说明这一路夜间根本没拍到——该去补红外补光，不是接着调算法"
                : "「只拉伸」和「堆栈」都不编造像素；模型那张（如果有）是它补出来的，好看但不能当证据——拿同一时刻公共区那一路对一眼才算数"
            }
          />
          <Space align="start" style={{ width: "100%" }} wrap>
            {pic("原样", data.raw, "原片就是这样")}
            {pic("只拉伸", data.stretch, "不编造，噪声照样放大")}
            {pic("多帧堆栈", data.stacked, ki ? `${ki.frames} 帧平均，不编造` : undefined)}
            {pic(`模型（${data.model_name ?? ""}）`, data.model, "模型补出来的，不能当证据")}
          </Space>
          {data.model_error && (
            <Alert type="info" showIcon style={{ marginTop: 12 }} message="模型那张没出" description={data.model_error} />
          )}
        </>
      )}
    </Modal>
  );
}
