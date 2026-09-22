import { useEffect, useState } from "react";
import { Alert, Modal, Segmented, Spin, Typography } from "antd";
import { getLowlight } from "@/api/samples";

/**
 * 夜视增强：把黑得看不见的那几秒捞出来看清楚。
 *
 * **三张并排，不是只给最好看的那一张。** 人要判断的不是"哪张好看"，而是
 * "这一路夜间到底有没有拍到东西"——只给增强后的那张，他没法区分
 * 「看清了」和「模型/拉伸编出来的」。
 */
export default function LowlightModal({
  sampleId, cams, t, label, onClose,
}: {
  sampleId: number | null;
  /** 这个样本有哪几路。**能切机位是关键**：黑的那一路增强出来的东西是真是假，
   *  只能拿同一时刻别的机位（尤其是看全场那一路，它本来就是亮的）对一眼 */
  cams: { value: string; label: string }[];
  t: number;
  label?: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<Awaited<ReturnType<typeof getLowlight>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [cam, setCam] = useState(cams[0]?.value ?? "cam1");
  // 换一段/换一个样本时回到第一路，免得停在上一次选的那一路上
  useEffect(() => { setCam(cams[0]?.value ?? "cam1"); }, [sampleId, t, cams]);
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
      {cams.length > 1 && (
        <div style={{ marginBottom: 12 }}>
          <Typography.Text type="secondary" style={{ marginRight: 8 }}>看哪一路：</Typography.Text>
          <Segmented value={cam} onChange={(v) => setCam(String(v))} options={cams} />
          <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
            切到本来就亮的那一路（看全场的公共区），对一眼同一时刻狗在不在、在干嘛——这是唯一不依赖算法的对照
          </Typography.Text>
        </div>
      )}
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
                : "「只拉伸」和「堆栈」都不编造像素；模型那张（如果有）是它补出来的，好看但不能当证据——拿同一时刻公共区那一路对一眼才算数。这两张接近灰度是故意的：这个亮度下色度通道全是噪声（放大后就是满屏紫麻点），压掉只去噪不动亮度，轮廓一点没少"
            }
          />
          {/* 必须并排。Space 会把每张图各自包一层 div，里面的 flex:1 到不了，
              结果四张叠成一列要往下滚——那就比不了了，人得同时看见才能判断 */}
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start", width: "100%" }}>
            {pic("原样", data.raw, "原片就是这样")}
            {pic("只拉伸", data.stretch, "不编造，噪声照样放大")}
            {pic("多帧堆栈", data.stacked, ki ? `${ki.frames} 帧平均，不编造` : undefined)}
            {pic(`模型（${data.model_name ?? ""}）`, data.model, "模型补出来的，不能当证据")}
          </div>
          {data.model_error && (
            <Alert type="info" showIcon style={{ marginTop: 12 }} message="模型那张没出" description={data.model_error} />
          )}
        </>
      )}
    </Modal>
  );
}
