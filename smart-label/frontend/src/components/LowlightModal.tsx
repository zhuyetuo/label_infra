import { useEffect, useRef, useState } from "react";
import { Alert, Button, Modal, Segmented, Slider, Spin, Typography } from "antd";
import { getLowlight, getLowlightSeq } from "@/api/samples";

/**
 * 夜视增强：把黑得看不见的那几秒捞出来看清楚。
 *
 * **三张并排，不是只给最好看的那一张。** 人要判断的不是"哪张好看"，而是
 * "这一路夜间到底有没有拍到东西"——只给增强后的那张，他没法区分
 * 「看清了」和「模型/拉伸编出来的」。
 */
export default function LowlightModal({
  sampleId, cams, startS, endS, label, onClose,
}: {
  sampleId: number | null;
  /** 这个样本有哪几路。**能切机位是关键**：黑的那一路增强出来的东西是真是假，
   *  只能拿同一时刻别的机位（尤其是看全场那一路，它本来就是亮的）对一眼 */
  cams: { value: string; label: string }[];
  /** 这一段的起止（秒）。整段循环播放用它，单帧那四张取中点 */
  startS: number;
  endS: number;
  label?: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<Awaited<ReturnType<typeof getLowlight>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [cam, setCam] = useState(cams[0]?.value ?? "cam1");
  const t = (startS + endS) / 2;
  // 整段增强后的帧串。**抓挠是动作，单帧判不出来**——四张静态图最多说清
  // "狗侧卧着"，说不清"它在不在抓"，所以这一段要能循环播放
  const [seq, setSeq] = useState<Awaited<ReturnType<typeof getLowlightSeq>> | null>(null);
  const [seqLoading, setSeqLoading] = useState(false);
  const [frameIdx, setFrameIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const timer = useRef<number | null>(null);
  // 模型那张默认不跑：实测对这批素材是在编（成块的橙绿紫），还要占一秒 GPU。
  // 留个按钮而不是删掉——换了权重或换了素材，人要能自己再验一次
  const [wantModel, setWantModel] = useState(false);

  // 换段/换机位就把上一段的帧丢掉，免得播着播着还是上一段的画面
  useEffect(() => { setSeq(null); setFrameIdx(0); }, [sampleId, cam, startS, endS]);

  useEffect(() => {
    if (timer.current != null) window.clearInterval(timer.current);
    const n = seq?.frames?.length ?? 0;
    if (!playing || n === 0) return;
    const ms = 1000 / ((seq?.fps ?? 10) * speed);
    timer.current = window.setInterval(() => setFrameIdx((i) => (i + 1) % n), ms);
    return () => { if (timer.current != null) window.clearInterval(timer.current); };
  }, [playing, speed, seq]);

  const loadSeq = () => {
    if (sampleId == null) return;
    setSeqLoading(true);
    setFrameIdx(0);
    getLowlightSeq(sampleId, { cam, start: startS, end: endS, fps: 10 })
      .then((r) => { setSeq(r); setPlaying(true); })
      .catch((e) => setSeq({ available: false, error: String(e) }))
      .finally(() => setSeqLoading(false));
  };
  // 换一段/换一个样本时回到第一路，免得停在上一次选的那一路上
  useEffect(() => { setCam(cams[0]?.value ?? "cam1"); }, [sampleId, t, cams]);
  useEffect(() => {
    if (sampleId == null) return;
    setData(null);
    setLoading(true);
    getLowlight(sampleId, { cam, t, window_s: 2, model: wantModel ? "retinexformer" : "" })
      .then(setData)
      .catch((e) => setData({ available: false, error: String(e) }))
      .finally(() => setLoading(false));
  }, [sampleId, cam, t, wantModel]);

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
      title={`夜视增强 · ${label ?? ""} ${startS.toFixed(1)}~${endS.toFixed(1)}s（${cam}）`}
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
          {/* 整段循环播放。**这才是能判断动作的那一块**：上面四张静态图
              最多说清"狗在不在、什么姿势"，说不清"它在不在抓" */}
          <div style={{ marginBottom: 16, padding: 12, border: "1px solid #303030", borderRadius: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
              <Typography.Text strong>整段循环播放（增强后）</Typography.Text>
              {!seq && (
                <Button size="small" type="primary" loading={seqLoading} onClick={loadSeq}>
                  {seqLoading ? "解帧中…" : `增强这 ${(endS - startS).toFixed(1)} 秒并循环播放`}
                </Button>
              )}
              {seq?.available && (
                <>
                  <Button size="small" onClick={() => setPlaying((p) => !p)}>
                    {playing ? "暂停" : "播放"}
                  </Button>
                  <Segmented
                    size="small"
                    value={speed}
                    onChange={(v) => setSpeed(Number(v))}
                    options={[{ label: "0.25x", value: 0.25 }, { label: "0.5x", value: 0.5 },
                              { label: "1x", value: 1 }, { label: "2x", value: 2 }]}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    第 {frameIdx + 1}/{seq.frames?.length ?? 0} 帧
                    {seq.info && ` · ${seq.info.smooth} 帧滑动平均，全段共用一套拉伸（放大 ${seq.info.gain}×）`}
                  </Typography.Text>
                </>
              )}
            </div>
            {seq?.available === false && <Alert type="error" showIcon message={seq.error} />}
            {seq?.available && seq.frames && seq.frames.length > 0 && (
              <>
                <img
                  src={`data:image/jpeg;base64,${seq.frames[frameIdx] ?? seq.frames[0]}`}
                  style={{ width: "100%", maxWidth: 900, display: "block", borderRadius: 4 }}
                />
                {/* 拖着逐帧看：动作就那么零点几秒，自动播容易一晃而过 */}
                <Slider
                  min={0}
                  max={seq.frames.length - 1}
                  value={frameIdx}
                  onChange={(v) => { setPlaying(false); setFrameIdx(v); }}
                  tooltip={{ formatter: (v) => `第 ${(v ?? 0) + 1} 帧` }}
                />
              </>
            )}
            {!seq && !seqLoading && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                抓挠是动作，静态图判不出来。这一段十来秒要解上百帧、每帧滑动平均再去色噪，要等一会儿——所以不自动跑，点了才算
              </Typography.Text>
            )}
          </div>

          {/* 必须并排。Space 会把每张图各自包一层 div，里面的 flex:1 到不了，
              结果四张叠成一列要往下滚——那就比不了了，人得同时看见才能判断 */}
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start", width: "100%" }}>
            {pic("原样", data.raw, "原片就是这样")}
            {pic("只拉伸", data.stretch, "不编造，噪声照样放大")}
            {pic("多帧堆栈", data.stacked, ki ? `${ki.frames} 帧平均，不编造` : undefined)}
            {pic(`模型（${data.model_weights || data.model_name || ""}）`, data.model, "模型补出来的，不能当证据")}
            {!wantModel && (
              <div style={{ flex: 1, minWidth: 260 }}>
                <Typography.Text type="secondary">模型增强</Typography.Text>
                <div style={{ marginTop: 8 }}>
                  <Button size="small" onClick={() => setWantModel(true)}>也跑一下模型</Button>
                </div>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 8 }}>
                  默认不跑。实测这批素材上 Retinexformer + SMID 是在编（成块的橙绿紫），比不用还看不清，每次还占一秒 GPU。
                  换了权重或换了素材想再验一次，点这里
                </Typography.Text>
              </div>
            )}
          </div>
          {data.model_error && (
            <Alert type="info" showIcon style={{ marginTop: 12 }} message="模型那张没出" description={data.model_error} />
          )}
        </>
      )}
    </Modal>
  );
}
