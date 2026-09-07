import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Collapse, Empty, Image, Modal, Progress, Radio, Slider, Space, Spin, Table, Tag, Tooltip, Typography, message } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  detectToothPhotos,
  getToothPhotoToken,
  getToothStatus,
  listToothPhotos,
  toothPhotoUrl,
  type ToothDetectItem,
  type ToothPhoto,
} from "@/api/tooth";

// 牙齿识别：素材库 NAS 上 口腔验证/{日期}/{狗}/ 的口腔照片，按目录浏览缩略图，
// 一键跑 YOLO（imu_train/label_service 的 tooth_health 模型），每张图角标显示检出
// 类别/置信度，点开看带框图。照片只读，检测结果落库。

type Filter = "all" | "detected" | "undetected" | "abnormal";

const confColor = (c: number) => (c >= 0.8 ? "green" : c >= 0.6 ? "orange" : "red");

export default function Tooth() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["tooth-photos"], queryFn: listToothPhotos });
  const { data: status } = useQuery({ queryKey: ["tooth-status"], queryFn: getToothStatus });
  const refresh = () => qc.invalidateQueries({ queryKey: ["tooth-photos"] });

  const [filter, setFilter] = useState<Filter>("all");
  // 置信度阈值：0 = 模型给出的全部检出都返回（看模型到底看到了什么），默认 0；
  // 批量检测和单张检测都用这个值，结果里记着当时用的阈值
  const [conf, setConf] = useState(0);
  // 缩略图 URL 要带路径签名 token，逐张换太多请求——一次换一批，缓存在这里
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<{ done: number; total: number } | null>(null);
  const [viewing, setViewing] = useState<{ photo: ToothPhoto; annotated?: string | null; loading: boolean } | null>(null);

  const allPhotos = useMemo(() => (data?.folders ?? []).flatMap((f) => f.dogs.flatMap((d) => d.photos)), [data]);

  useEffect(() => {
    // 只给还没有 URL 的换 token；并发 8 个一组，几百张图几秒钟
    const missing = allPhotos.filter((p) => !urls[p.rel_path]).map((p) => p.rel_path);
    if (!missing.length) return;
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = {};
      for (let i = 0; i < missing.length; i += 8) {
        const chunk = missing.slice(i, i + 8);
        const tokens = await Promise.all(chunk.map((p) => getToothPhotoToken(p).catch(() => null)));
        chunk.forEach((p, j) => {
          if (tokens[j]) next[p] = toothPhotoUrl(p, tokens[j]!.token);
        });
        if (cancelled) return;
        setUrls((prev) => ({ ...prev, ...next }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allPhotos]);

  const matches = (p: ToothPhoto) => {
    if (filter === "detected") return p.result != null;
    if (filter === "undetected") return p.result == null;
    if (filter === "abnormal") return (p.result?.n_detections ?? 0) > 0;
    return true;
  };

  const counts = useMemo(() => {
    const detected = allPhotos.filter((p) => p.result).length;
    const abnormal = allPhotos.filter((p) => (p.result?.n_detections ?? 0) > 0).length;
    return { total: allPhotos.length, detected, undetected: allPhotos.length - detected, abnormal };
  }, [allPhotos]);

  const runDetect = async (paths: string[], label: string) => {
    if (!paths.length) {
      message.info("没有要检测的照片");
      return;
    }
    if (status && !status.available) {
      message.error(`AI 服务没有牙齿模型：${status.error ?? "未配置权重"}`);
      return;
    }
    setRunning({ done: 0, total: paths.length });
    let okN = 0;
    const errors: string[] = [];
    try {
      // 每批 20 张，跑完一批刷一次进度；后端逐张落库，中途关页面已跑完的不丢
      for (let i = 0; i < paths.length; i += 20) {
        const chunk = paths.slice(i, i + 20);
        const res = await detectToothPhotos(chunk, { conf, with_image: false });
        res.forEach((r) => (r.ok ? okN++ : errors.push(`${r.rel_path}: ${r.error}`)));
        setRunning({ done: Math.min(i + chunk.length, paths.length), total: paths.length });
      }
      message.success(`${label}：检测完成 ${okN} 张${errors.length ? `，失败 ${errors.length} 张` : ""}`);
      if (errors.length) console.warn(errors);
    } finally {
      setRunning(null);
      refresh();
    }
  };

  const openPhoto = async (photo: ToothPhoto) => {
    setViewing({ photo, loading: true });
    // 有结果就重新跑一次拿带框图（YOLO 单张很快），没结果就不自动跑，让用户点按钮
    if (photo.result) {
      try {
        const [r] = await detectToothPhotos([photo.rel_path], { conf, with_image: true });
        setViewing({ photo: { ...photo, result: r.result ?? photo.result }, annotated: r.annotated_jpeg_b64, loading: false });
        return;
      } catch {
        /* 拿不到带框图就只看原图 */
      }
    }
    setViewing({ photo, loading: false });
  };

  const detectViewing = async () => {
    if (!viewing) return;
    setViewing({ ...viewing, loading: true });
    try {
      const [r] = await detectToothPhotos([viewing.photo.rel_path], { conf, with_image: true });
      if (!r.ok) throw new Error(r.error);
      setViewing({ photo: { ...viewing.photo, result: r.result ?? null }, annotated: r.annotated_jpeg_b64, loading: false });
      refresh();
    } catch (e) {
      message.error(`检测失败：${(e as Error).message}`);
      setViewing({ ...viewing, loading: false });
    }
  };

  const badge = (p: ToothPhoto) => {
    if (!p.result) return <Tag>未检测</Tag>;
    if (!p.result.n_detections) return <Tag color="default">无检出</Tag>;
    return (
      <Tag color={confColor(p.result.top_conf ?? 0)}>
        {p.result.top_class} {((p.result.top_conf ?? 0) * 100).toFixed(0)}%{p.result.n_detections > 1 ? ` +${p.result.n_detections - 1}` : ""}
      </Tag>
    );
  };

  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        message="口腔照片目录读不到"
        description={`${(error as Error).message}。确认素材库 NAS 已挂到 ${data?.root ?? "/home/toky/alg_material"} 并在 docker-compose 里挂进了容器。`}
      />
    );
  }

  return (
    <div>
      <Space wrap style={{ marginBottom: 8 }}>
        <Button type="primary" onClick={() => runDetect(allPhotos.filter((p) => !p.result).map((p) => p.rel_path), "全部未检测")} disabled={!!running || !counts.undetected}>
          检测全部未检测（{counts.undetected}）
        </Button>
        <Button onClick={() => runDetect(allPhotos.map((p) => p.rel_path), "全部重新检测")} disabled={!!running || !counts.total}>
          全部重新检测
        </Button>
        <Button onClick={refresh}>刷新目录</Button>
        <Radio.Group
          size="small"
          optionType="button"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          options={[
            { label: `全部 ${counts.total}`, value: "all" },
            { label: `有检出 ${counts.abnormal}`, value: "abnormal" },
            { label: `已检测 ${counts.detected}`, value: "detected" },
            { label: `未检测 ${counts.undetected}`, value: "undetected" },
          ]}
        />
        {status && !status.available && (
          <Tag color="red">AI 服务没有牙齿模型：{status.error ?? "未配置 TOOTH_WEIGHTS"}</Tag>
        )}
      </Space>
      <Space style={{ marginBottom: 8 }}>
        <Typography.Text>置信度阈值</Typography.Text>
        <Slider min={0} max={0.95} step={0.05} value={conf} onChange={setConf} style={{ width: 240 }} tooltip={{ formatter: (v) => `${((v ?? 0) * 100).toFixed(0)}%` }} />
        <Tag>{(conf * 100).toFixed(0)}%{conf === 0 ? "（全部检出都显示）" : ""}</Tag>
      </Space>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        照片来自素材库 NAS 的 <code>{data?.root ?? "口腔验证/"}</code>，按「日期目录 / 狗」归类，只读不改。检测走 imu_train 的牙齿 YOLO 模型，结果落库，角标显示置信度最高的类别；点图看带框图。
      </Typography.Paragraph>
      {running && (
        <Progress percent={Math.round((running.done / running.total) * 100)} format={() => `检测 ${running.done}/${running.total}`} status="active" style={{ marginBottom: 8 }} />
      )}

      {isLoading ? (
        <Spin />
      ) : !data?.folders.length ? (
        <Empty description="口腔验证/ 下还没有照片" />
      ) : (
        <Collapse
          defaultActiveKey={[data.folders[0].folder]}
          items={data.folders.map((f) => {
            const photosInFolder = f.dogs.flatMap((d) => d.photos.filter(matches));
            return {
              key: f.folder,
              label: (
                <Space>
                  <b>{f.folder}</b>
                  {!f.ok && <Tag color="orange">未整理（目录名没有 -ok）</Tag>}
                  <Typography.Text type="secondary">{f.dogs.map((d) => `${d.name} ${d.photos.filter(matches).length}`).join(" · ")}</Typography.Text>
                  <Button
                    size="small"
                    type="link"
                    disabled={!!running}
                    onClick={(e) => {
                      e.stopPropagation();
                      runDetect(f.dogs.flatMap((d) => d.photos.filter((p) => !p.result).map((p) => p.rel_path)), f.folder);
                    }}
                  >
                    检测这天未检测的
                  </Button>
                </Space>
              ),
              children: !photosInFolder.length ? (
                <Typography.Text type="secondary">没有符合筛选的照片</Typography.Text>
              ) : (
                <Collapse
                  size="small"
                  defaultActiveKey={f.dogs.map((d) => d.name)}
                  items={f.dogs
                    .filter((d) => d.photos.some(matches))
                    .map((d) => ({
                      key: d.name,
                      label: (
                        <Space>
                          <b>{d.name}</b>
                          <Typography.Text type="secondary">{d.photos.filter(matches).length} 张</Typography.Text>
                          <Button
                            size="small"
                            type="link"
                            disabled={!!running}
                            onClick={(e) => {
                              e.stopPropagation();
                              runDetect(d.photos.map((p) => p.rel_path), `${f.folder}/${d.name}`);
                            }}
                          >
                            检测这只狗的全部
                          </Button>
                        </Space>
                      ),
                      children: (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                          {d.photos.filter(matches).map((p) => (
                            <div key={p.rel_path} style={{ width: 180, cursor: "pointer" }} onClick={() => openPhoto(p)}>
                              <div style={{ width: 180, height: 135, background: "#f0f0f0", borderRadius: 4, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                {urls[p.rel_path] ? (
                                  <img src={urls[p.rel_path]} alt={p.filename} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} loading="lazy" />
                                ) : (
                                  <Spin size="small" />
                                )}
                              </div>
                              <div style={{ marginTop: 4, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                {badge(p)}
                                <Tooltip title={p.filename}>
                                  <Typography.Text type="secondary" style={{ fontSize: 11, maxWidth: 80 }} ellipsis>
                                    {p.filename}
                                  </Typography.Text>
                                </Tooltip>
                              </div>
                            </div>
                          ))}
                        </div>
                      ),
                    }))}
                />
              ),
            };
          })}
        />
      )}

      <Modal
        open={viewing != null}
        onCancel={() => setViewing(null)}
        footer={null}
        width={960}
        title={viewing ? `${viewing.photo.rel_path}` : ""}
        destroyOnClose
      >
        {viewing && (
          <Spin spinning={viewing.loading}>
            <Space direction="vertical" style={{ width: "100%" }}>
              <Space wrap>
                <Button type="primary" onClick={detectViewing} disabled={viewing.loading}>
                  {viewing.photo.result ? "重新检测" : "检测这张"}
                </Button>
                <Typography.Text type="secondary">阈值 {(conf * 100).toFixed(0)}%</Typography.Text>
                <Slider min={0} max={0.95} step={0.05} value={conf} onChange={setConf} style={{ width: 160 }} />
                {viewing.photo.result && (
                  <Typography.Text type="secondary">
                    上次检测 {viewing.photo.result.detected_at?.replace("T", " ").slice(0, 19)} · 阈值 {viewing.photo.result.model_conf}
                  </Typography.Text>
                )}
              </Space>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 300 }}>
                  <Typography.Text strong>{viewing.annotated ? "检测结果（带框）" : "原图"}</Typography.Text>
                  <Image
                    src={viewing.annotated ? `data:image/jpeg;base64,${viewing.annotated}` : urls[viewing.photo.rel_path]}
                    style={{ maxHeight: 520, objectFit: "contain" }}
                  />
                </div>
                <div style={{ width: 300 }}>
                  <Typography.Text strong>检出（{viewing.photo.result?.n_detections ?? 0}）</Typography.Text>
                  {viewing.photo.result ? (
                    <Table
                      size="small"
                      rowKey={(_, i) => String(i)}
                      pagination={false}
                      dataSource={viewing.photo.result.detections}
                      columns={[
                        { title: "类别", dataIndex: "class_name" },
                        { title: "置信度", dataIndex: "confidence", render: (c: number) => <Tag color={confColor(c)}>{(c * 100).toFixed(0)}%</Tag> },
                        { title: "框 (x1,y1,x2,y2)", dataIndex: "box", render: (b: number[]) => b.map((v) => Math.round(v)).join(",") },
                      ]}
                    />
                  ) : (
                    <Typography.Text type="secondary">还没检测过</Typography.Text>
                  )}
                </div>
              </div>
            </Space>
          </Spin>
        )}
      </Modal>
    </div>
  );
}
