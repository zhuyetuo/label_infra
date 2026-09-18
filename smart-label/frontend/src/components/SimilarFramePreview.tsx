import { useEffect, useState } from "react";
import { Spin, Tag, Typography } from "antd";
import { previewSimilarFrame, type SimilarPreview } from "@/api/candidates";
import "./SimilarFramePreview.css";

interface Props {
  taskId: number;
  /** 样例是第几秒那一帧 */
  tSec: number;
}

// 找相似之前给人看一眼样例：这一帧框到了哪几只狗、拿哪一块（实线框 + 虚线裁剪区）去搜。
// 以图搜图是"先框狗、再拿框里那块算向量"，框错了搜出来全是错的；看到框不对就换一帧。
export default function SimilarFramePreview({ taskId, tSec }: Props) {
  const [data, setData] = useState<SimilarPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    // 改秒数时稍等一下再取，别每敲一个数字就去解一帧
    const timer = window.setTimeout(async () => {
      try {
        const r = await previewSimilarFrame({ task_id: taskId, t_s: tSec });
        if (alive) setData(r);
      } catch (e) {
        if (alive) {
          setData(null);
          setError((e as { message?: string })?.message || "取不到这一帧");
        }
      } finally {
        if (alive) setLoading(false);
      }
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [taskId, tSec]);

  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

  return (
    <div className="sfp">
      <Spin spinning={loading}>
        <div className="sfp__frame">
          {data ? (
            <>
              <img src={`data:image/jpeg;base64,${data.jpeg}`} alt="样例帧" className="sfp__img" />
              {data.has_dog && (
                <div
                  className="sfp__crop"
                  style={{
                    left: pct(data.crop[0]),
                    top: pct(data.crop[1]),
                    width: pct(data.crop[2] - data.crop[0]),
                    height: pct(data.crop[3] - data.crop[1]),
                  }}
                  title="拿这一块去算向量、找相似（狗框四周留了边距）"
                />
              )}
              {data.boxes.map((b, i) => (
                <div
                  key={i}
                  className="sfp__box"
                  style={{ left: pct(b.bbox[0]), top: pct(b.bbox[1]), width: pct(b.bbox[2]), height: pct(b.bbox[3]) }}
                  title={`狗 ${Math.round(b.conf * 100)}%`}
                >
                  <span className="sfp__conf">{Math.round(b.conf * 100)}%</span>
                </div>
              ))}
            </>
          ) : (
            <div className="sfp__empty">{error ?? (loading ? "" : "没有画面")}</div>
          )}
        </div>
      </Spin>
      <div className="sfp__caption">
        {data ? (
          data.has_dog ? (
            <>
              <Tag color="green">框到 {data.boxes.length} 只狗</Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                实线是狗，虚线是拿去搜的那一块。框不对（框到别的东西、只框到半只）就把视频挪到别的一帧再点。
                {data.boxes.length > 1 ? "几只狗一起框会把并集一起拿去搜，尽量挑只有这一只的画面。" : ""}
              </Typography.Text>
            </>
          ) : (
            <>
              <Tag color="orange">这一帧没框到狗</Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                会拿整幅画面去搜，找出来的多半是"背景像"而不是"动作像"。换一帧狗看得清楚的再点。
              </Typography.Text>
            </>
          )
        ) : null}
      </div>
    </div>
  );
}
