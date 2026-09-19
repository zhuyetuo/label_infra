import { useEffect, useState } from "react";
import { Segmented, Spin, Tag, Tooltip, Typography } from "antd";
import { QuestionCircleOutlined } from "@ant-design/icons";
import { previewSimilarFrame, SIMILAR_VIEW_HELP, SIMILAR_VIEW_OPTIONS, similarThumbToken, similarThumbUrl, type SimilarPreview, type SimilarThumbView } from "@/api/candidates";
import "./SimilarFramePreview.css";

interface Props {
  taskId: number;
  /** 样例是第几秒那一帧 */
  tSec: number;
  /** 看哪种：整帧带框 / 抠图 / 原图那块 / 姿态骨架。跟下面命中缩略图共用一个开关 */
  view: SimilarThumbView;
  onViewChange: (v: SimilarThumbView) => void;
  /** 紧凑：大图限高（左右分栏时左栏要一屏放下），说明收进问号 */
  compact?: boolean;
}

/** 大图的边长：要看得清狗，比命中那排缩略图（320）大 */
const BIG_SIDE = 900;

// 找相似之前给人看一眼样例：这一帧框到了哪几只狗、拿哪一块（实线框 + 虚线裁剪区）去搜。
// 以图搜图是"先框狗、再拿框里那块算向量"，框错了搜出来全是错的；看到框不对就换一帧。
// 切到抠图 / 原图 / 姿态时，大图换成那一块（跟下面命中的小图同一种看法，才好并排比）。
export default function SimilarFramePreview({ taskId, tSec, view, onViewChange, compact }: Props) {
  const [data, setData] = useState<SimilarPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    similarThumbToken(taskId).then((r) => alive && setToken(r.token)).catch(() => alive && setToken(null));
    return () => {
      alive = false;
    };
  }, [taskId]);

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
  // 整帧：本地画框；其他三种：让视觉服务出那一块的大图（抠图 / 原图 / 骨架都在那边画）
  const cropView = view !== "box" && data?.has_dog && data.path && token;

  const help = data
    ? data.has_dog
      ? view === "box"
        ? "实线是狗，虚线是拿去搜的那一块。框不对（框到别的东西、只框到半只）就把视频挪到别的一帧再点。"
        : view === "mask"
          ? "这就是拿去算向量的那张：背景涂灰，只剩狗。狗抠得不全（少条腿、带着地砖）就换一帧。"
          : view === "pose"
            ? "关键点骨架：红点鼻子、橙点四爪。点位乱飞说明姿态那一路不可信，把「姿态占」调低。"
            : "狗框那一块的原图，跟抠图对照看抠掉了什么。"
      : "会拿整幅画面去搜，找出来的多半是\"背景像\"而不是\"动作像\"。换一帧狗看得清楚的再点。"
    : "";
  const multi = data && data.has_dog && data.boxes.length > 1 ? "几只狗一起框会把并集一起拿去搜，尽量挑只有这一只的画面。" : "";

  return (
    <div className={`sfp${compact ? " sfp--compact" : ""}`}>
      <Spin spinning={loading}>
        <div className="sfp__frame">
          {/* 框和裁剪区按百分比定位，要相对图本身，不是相对外框（紧凑模式下图比外框窄） */}
          <div className="sfp__stage">
          {data ? (
            cropView ? (
              <img
                key={`${view}@${data.t}`}
                src={similarThumbUrl(taskId, data.path!, data.t, token!, view, BIG_SIDE)}
                alt="样例那一块"
                className="sfp__img"
                style={{ objectFit: "contain", background: "#000" }}
              />
            ) : (
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
            )
          ) : (
            <div className="sfp__empty">{error ?? (loading ? "" : "没有画面")}</div>
          )}
          </div>
        </div>
      </Spin>
      <div className="sfp__caption">
        <Tooltip title={SIMILAR_VIEW_HELP}>
          <Segmented size="small" value={view} onChange={(v) => onViewChange(v as SimilarThumbView)} options={SIMILAR_VIEW_OPTIONS} style={{ marginRight: 8 }} />
        </Tooltip>
        {data ? (
          data.has_dog ? <Tag color="green">框到 {data.boxes.length} 只狗</Tag> : <Tag color="orange">这一帧没框到狗</Tag>
        ) : null}
        {data && compact ? (
          <Tooltip title={help + multi}>
            <QuestionCircleOutlined style={{ color: "#999" }} />
          </Tooltip>
        ) : data ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{help}{multi}</Typography.Text>
        ) : null}
      </div>
    </div>
  );
}
