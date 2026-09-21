import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Empty, Input, InputNumber, Segmented, Select, Space, Spin, Tag, Tooltip, Typography, message } from "antd";
import { SIMILAR_VIEW_HELP, SIMILAR_VIEW_OPTIONS, similarThumbTokens, similarThumbUrl, type SimilarHit, type SimilarThumbView } from "@/api/candidates";
import { projectSimilarSearch, projectSimilarWrite } from "@/api/projects";
import SimilarClipPlayer, { type Clip } from "@/components/SimilarClipPlayer";
import { formatMs } from "@/components/SegmentPanel";
import { ACTION_QUERIES, queryFor } from "@/utils/actionQueries";

/**
 * 项目级「一句话找画面」：第一阶段的落点。
 *
 * 「我想要一张狗咬尾巴的图」——这时人手上还没有任何样例，本来也不该先随便挑个
 * 任务、打开工作台、再去里面翻这个功能。这里不挑任务、不要样例帧，一句话搜整个项目，
 * 勾中的写成候选；每一张还能直接「用这一张去扩」进第二阶段。
 *
 * 布局跟「找相似」「筛一筛」一致：左边操作台，右边结果。别让人学三遍。
 */

const keyOf = (h: SimilarHit) => `${h.path}@${h.t}`;

interface Props {
  projectId: number;
  /** 项目里可选的类别：勾中的那张标成什么 */
  labelNames?: { name: string; color?: string | null }[];
}

export default function ProjectPhraseSearch({ projectId, labelNames = [] }: Props) {
  const [text, setText] = useState("");
  const [topK, setTopK] = useState(60);
  const [poseW, setPoseW] = useState(0.5);
  const [gapS, setGapS] = useState(15);
  // 去共同背景：图片那边每一帧减掉**它自己那一路**的平均画面，这是"搜出来全是
  // 同一只狗"的解药。但一句话搜时，减掉的是**全局平均的图片向量**——把一个图像域
  // 的均值从文字向量里减掉该不该做，没有证据。所以摆成一个开关：同一句话搜两遍，
  // 哪个命中更像，人一眼就知道。别拿猜的当结论
  const [center, setCenter] = useState(true);
  const [label, setLabel] = useState<string | null>(null);
  const [view, setView] = useState<SimilarThumbView>("box");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ hits: SimilarHit[]; searched: number; missing: number; centered: boolean;
                                   old_index?: number; text_space?: string | null; coarse?: number } | null>(null);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  // 勾中的 → 标成哪个类别。默认一张都不勾：一句话搜的命中里不对的不少，
  // 默认全勾等于让人去挑错的那些，挑漏一张就多一条脏候选
  const [picked, setPicked] = useState<Map<string, string>>(new Map());
  const [cur, setCur] = useState<SimilarHit | null>(null);
  // 上一次搜的那一行：A/B 对比时人记不住上一次最高分是多少，摆在这儿就不用记
  const [prev, setPrev] = useState<{ text: string; center: boolean; top: number; n: number } | null>(null);
  // 自动填进去的那一句是从哪个标签拿的、是不是这一条本身。不是本身就得写明——
  // SigLIP 分不出左右、也分不出大腿内侧和大腿，装作分得出的话，人会拿着
  // 「左耳」的结果去标左耳
  const [auto, setAuto] = useState<{ from: string; exact: boolean } | null>(null);
  const [clip, setClip] = useState<Clip | null>(null);
  // 选了一条现成描述，但项目里没有同名标签（「咬尾巴」这种表里有、标签树里没有的）。
  // 不说的话人会以为「标成」坏了——它只是没得填
  const [noLabel, setNoLabel] = useState<string | null>(null);

  const hits = res?.hits ?? [];
  useEffect(() => {
    const ids = [...new Set(hits.map((h) => h.task_id).filter((x): x is number => x != null))].slice(0, 500);
    if (!ids.length) return;
    let alive = true;
    similarThumbTokens(ids).then((r) => alive && setTokens(r.tokens)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [res]);

  const urlOf = (h: SimilarHit) => {
    const tk = h.task_id != null ? tokens[String(h.task_id)] : null;
    return tk && h.task_id != null ? similarThumbUrl(h.task_id, h.path, h.t, tk, view) : "";
  };
  const ordered = useMemo(() => [...hits].sort((a, b) => b.score - a.score), [hits]);

  const search = async () => {
    if (!text.trim()) return;
    setLoading(true);
    try {
      const r = await projectSimilarSearch(projectId, {
        text: text.trim(), top_k: topK, gap_s: gapS, pose_w: poseW, center,
      });
      if (res && hits.length) {
        setPrev({ text, center, top: Math.max(...hits.map((h) => h.score)), n: hits.length });
      }
      setRes(r);
      // 换了一批命中，上一批勾的那些在这一批里未必还在——留着只会悄悄少写几条
      setPicked(new Map());
      setCur(null);
      setClip(null);
      if (r.missing) message.info(`${r.missing} 路视频还没建索引，搜不到`);
      // 老索引没有「没抠背景」那一列：一句话搜跳过了它们。不说的话人只会看到
      // "搜到的少"，还以为是这一句不行
      if (r.old_index) {
        message.warning(`${r.old_index} 路索引是旧版（没有「没抠背景」的向量），一句话搜这次跳过了它们。`
          + "重建这几路的索引就能一起搜——以图搜图不受影响", 8);
      }
      if (!r.hits.length) message.info("一条都没搜到。换个说法再试，或者先去「建画面索引」");
    } finally {
      setLoading(false);
    }
  };

  const toggle = (h: SimilarHit) => {
    if (!label) return;         // 还没选「标成」哪个类别：勾了也不知道标成什么
    const next = new Map(picked);
    const k = keyOf(h);
    if (next.has(k)) next.delete(k);
    else next.set(k, label);
    setPicked(next);
  };
  const bulk = (keep: boolean) => {
    const next = new Map(picked);
    for (const h of ordered) {
      if (keep) { if (label) next.set(keyOf(h), next.get(keyOf(h)) ?? label); }
      else next.delete(keyOf(h));
    }
    setPicked(next);
  };
  const select = (h: SimilarHit) => {
    setCur(h);
    setClip(h.sample_id != null && h.cam
      ? { key: keyOf(h), title: `${h.sample_code ?? h.path.split("/").pop()} · ${formatMs(h.t * 1000)}`,
          sampleId: h.sample_id, cam: h.cam, t: h.t, hit: h, poster: urlOf(h) || undefined }
      : null);
  };
  useEffect(() => {
    if (cur) setClip((c) => (c ? { ...c, poster: urlOf(cur) || undefined } : c));
  }, [view, tokens]);

  const write = async () => {
    const picks = ordered.filter((h) => h.task_id != null && picked.has(keyOf(h)))
      .map((h) => [h.task_id as number, h.path, h.t, picked.get(keyOf(h))!] as [number, string, number, string]);
    if (!picks.length) return;
    setBusy(true);
    try {
      const r = await projectSimilarWrite(projectId, picks, gapS);
      // **写到哪几个任务去了，必须说出来。** 候选是按帧所属的任务散着写的，
      // 只报一句"写了 N 条"，人关掉这一屏就再也找不到它们在哪
      const ts = r.tasks ?? [];
      const where = ts.length
        ? `写进了${ts.length > 1 ? ` ${ts.length} 个任务：` : "任务 "}${ts.slice(0, 5).map((t) => `#${t.task_id}（${t.n} 条）`).join("、")}${ts.length > 5 ? " 等" : ""}`
        : "";
      message.success(
        <span>
          写了 {r.written} 条候选（相邻的合成了一段）。{where}
          {ts.length > 0 && (
            <>
              {" "}
              <a href={`/tasks?task=${ts[0].task_id}&cand=similar`} target="_blank" rel="noreferrer">
                打开第一个任务
              </a>
            </>
          )}
        </span>,
        10,
      );
      setPicked(new Map());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", gap: 12, height: "100%", minHeight: 0 }}>
      {/* 左：操作台 */}
      <div style={{ width: 380, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0, gap: 8 }}>
        {/* 2026-09-21 实测：同一句话试了三个变量（措辞 / 抠图还是原图 / 去不去背景），
            最高分一直在 0.13~0.21，命中基本不对。SigLIP-base 在俯拍监控画面上对
            "动作类"文字没有分辨力。把这句话摆在输入框上面，是为了不让人对着它
            反复调措辞——那条路已经走死了，调不出东西来 */}
        <Typography.Text type="warning" style={{ fontSize: 12 }}>
          实测这批素材上它<b>对动作类的词不灵</b>（舔/啃/抓挠，分一直在 0.2 上下、命中多半不对）。
          场景和大致姿态还行（趴卧、翻滚、进食、坐地拖屁股）。
          <br />
          当成「碰运气找到<b>一张</b>能用的样例」来用——找到了就点「用这一张去扩」，以图搜图准得多。
        </Typography.Text>
        <Space.Compact style={{ width: "100%" }}>
          <Input
            value={text}
            onChange={(e) => { setText(e.target.value); setAuto(null); }}
            onPressEnter={search}
            placeholder="a dog biting its own tail"
          />
          <Button type="primary" loading={loading} onClick={search} disabled={!text.trim()}>搜</Button>
        </Space.Compact>
        {/* 现成的一句：SigLIP 文本端是英文训练的，中文直接送进去命中会差一大截，
            而且**差得不明显**——它照样给你 60 个命中，只是那些命中不对 */}
        <Select
          size="small"
          showSearch
          allowClear
          placeholder="选个现成的描述（选完还能改）"
          style={{ width: "100%" }}
          optionFilterProp="label"
          onChange={(v?: string) => {
            if (!v) return;
            const q = ACTION_QUERIES.find((x) => x.query === v);
            setText(v);
            setAuto(null);
            // **选了哪一条，「标成」就跟着填成同一个类别。** 这两个框本来说的就是
            // 同一件事（我要找的是哪个动作），让人再选一遍纯属重复，而且忘了选
            // 就勾不动——不对的话人自己改一下就是，比每次都手动选强
            if (q && labelNames.some((l) => l.name === q.label)) {
              setLabel(q.label);
              setNoLabel(null);
            } else if (q) {
              setNoLabel(q.label);
            }
          }}
          options={ACTION_QUERIES.map((q) => ({ value: q.query, label: q.label }))}
        />
        <Space size={6} wrap>
          <span>取 <InputNumber size="small" min={10} max={300} value={topK} onChange={(v) => setTopK(v ?? 60)} style={{ width: 70 }} /> 个</span>
          <Tooltip title="相邻命中隔多久以内合成一段。舔一次往往持续几十秒、命中断断续续，小了会拆成十几条">
            <span>隔 <InputNumber size="small" min={0} max={120} value={gapS} onChange={(v) => setGapS(v ?? 15)} style={{ width: 66 }} /> 秒合段</span>
          </Tooltip>
          <Tooltip title="姿态相似占多少（0 只看画面，1 只看姿态）。一句话搜时姿态那一路用不上，这里主要影响排序">
            <span>姿态占 <InputNumber size="small" min={0} max={1} step={0.1} value={poseW} onChange={(v) => setPoseW(v ?? 0.5)} style={{ width: 66 }} /></span>
          </Tooltip>
        </Space>
        <Tooltip title="以图搜图时这个必须开（每一帧减掉它自己那一路的平均画面，否则搜出来全是同一只狗）。但一句话搜减的是全局平均的图片向量，从文字向量里减它该不该做没有证据——**同一句话搜两遍，关掉一次，哪个命中更像一眼就知道**">
          <Checkbox checked={center} onChange={(e) => setCenter(e.target.checked)}>
            去共同背景<Typography.Text type="secondary" style={{ fontSize: 12 }}>（一句话搜时值得关掉对比一次）</Typography.Text>
          </Checkbox>
        </Tooltip>
        {prev && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            上一次：{prev.center ? "去背景" : "不去背景"} · {prev.n} 帧 · 最高分 {prev.top.toFixed(3)}
            {res?.hits.length ? `｜这一次最高分 ${Math.max(...res.hits.map((h) => h.score)).toFixed(3)}` : ""}
          </Typography.Text>
        )}
        {noLabel && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            项目里没有「{noLabel}」这个标签，所以「标成」没自动填——自己选一个，或者去标签管理里加
          </Typography.Text>
        )}
        {auto && (
          <Typography.Text type={auto.exact ? "secondary" : "warning"} style={{ fontSize: 12 }}>
            {auto.exact
              ? `已按「${auto.from}」填好描述，可以接着改`
              : `检索分不到这么细，用的是「${auto.from}」那一句——命中里左右和更细的部位要人自己看`}
          </Typography.Text>
        )}
        <Space size={6} wrap>
          <Typography.Text>标成：</Typography.Text>
          <Select
            size="small"
            showSearch
            allowClear
            placeholder="勾之前先选类别"
            style={{ minWidth: 200 }}
            value={label ?? undefined}
            onChange={(v) => {
              setLabel(v ?? null);
              // 选了类别就把对应那一句填进去：这就是「中文标签自动映射英文描述」。
              // 只在输入框还空着、或上一句也是自动填的时候覆盖——人手打的不能被冲掉
              const q = v ? queryFor(v) : null;
              if (q && (!text.trim() || auto)) {
                setText(q.query);
                setAuto({ from: q.from, exact: q.exact });
              } else if (!v) setAuto(null);
            }}
            optionFilterProp="value"
            options={labelNames.map((l) => ({ value: l.name, label: <Tag color={l.color || undefined} style={{ marginRight: 0 }}>{l.name}</Tag> }))}
          />
        </Space>
        {cur ? (
          <>
            <div>
              <Typography.Text strong>{formatMs(cur.t * 1000)}</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                任务 #{cur.task_id} · {cur.sample_code ?? cur.path.split("/").pop()} · 分 {cur.score.toFixed(3)}
              </Typography.Text>
            </div>
            <Space size={4} wrap>
              <Checkbox checked={picked.has(keyOf(cur))} disabled={!label} onChange={() => toggle(cur)}>
                <b>要这一张</b>
              </Checkbox>
              {/* 第一阶段 → 第二阶段的那根线：找到第一张之后，拿它去扩 */}
              {cur.task_id != null && (
                <Tooltip title="拿这一帧当样例，在整个项目里找长得像的几秒（以图搜图比一句话准得多）。开新页，时刻和类别一起带过去">
                  <Button size="small" type="primary" ghost
                    onClick={() => window.open(
                      `/tasks?task=${cur.task_id}&seek=${Math.round(cur.t * 1000)}&similar=1${label ? `&slabel=${encodeURIComponent(label)}` : ""}`,
                      "_blank")}>
                    用这一张去扩
                  </Button>
                </Tooltip>
              )}
              {cur.task_id != null && (
                <Tooltip title="新页打开那个任务：这一刻会定位好，候选面板只看「画面相似」">
                  <Button size="small" onClick={() => window.open(
                    `/tasks?task=${cur.task_id}&seek=${Math.round(cur.t * 1000)}&cand=similar`, "_blank")}>
                    打开那个任务
                  </Button>
                </Tooltip>
              )}
              {cur.multi_dog && (
                <Tooltip title="多狗同场（影棚 / 公共区）：画面里那只不一定是这条 IMU 的狗">
                  <Tag color="orange">多狗</Tag>
                </Tooltip>
              )}
            </Space>
            {clip ? (
              <SimilarClipPlayer taskId={cur.task_id!} clip={clip} onClose={() => setClip(null)} />
            ) : (
              <div style={{ flex: 1, minHeight: 0, background: "#000", borderRadius: 4 }}>
                {urlOf(cur) && <img src={urlOf(cur)} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} />}
              </div>
            )}
          </>
        ) : (
          <div style={{ flex: 1, border: "1px dashed #d9d9d9", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: "#999", fontSize: 13, padding: 12, textAlign: "center" }}>
            打一句英文（或选个现成的）→ 搜 → 右边点一张在这儿看大图。
            <br />看准了勾上写成候选，或者「用这一张去扩」接着找更多
          </div>
        )}
      </div>

      {/* 右：结果 */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {loading ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}><Spin tip="在索引里找…" /></div>
        ) : !res ? (
          <Empty description="还没搜。左边打一句英文，或者选一条现成的描述" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <>
            <Space size={8} style={{ marginBottom: 6 }} wrap>
              <Typography.Text strong>命中 {hits.length} 帧</Typography.Text>
              <Tooltip title={label ? "勾上的才写成候选，默认一张都不勾" : "先在左边选「标成」哪个类别，再勾"}>
                <Typography.Text type={picked.size ? "success" : "secondary"} style={{ fontSize: 12 }}>
                  要 {picked.size} / {hits.length}
                </Typography.Text>
              </Tooltip>
              <Button size="small" disabled={!label} onClick={() => bulk(true)}>全要</Button>
              <Button size="small" onClick={() => bulk(false)}>全不要</Button>
              <Tooltip title={SIMILAR_VIEW_HELP}>
                <Segmented size="small" value={view} onChange={(v) => setView(v as SimilarThumbView)} options={SIMILAR_VIEW_OPTIONS} />
              </Tooltip>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                搜了 {res.searched} 路{res.missing ? `，${res.missing} 路还没建索引` : ""}
                {res.old_index ? `，${res.old_index} 路索引是旧版被跳过` : ""}
                {res.coarse ? `，其中 ${res.coarse} 路是快档（约 12 秒一帧，短动作可能漏）` : ""}
                {res.text_space ? `；比的是${res.text_space}那一列` : ""}
                {res.centered ? "；已去共同背景，分数是相对的（0.3 以上算像）" : "；没去背景，分数普遍偏高，看相对高低"}
              </Typography.Text>
            </Space>
            <div style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexWrap: "wrap", gap: 8, alignContent: "flex-start" }}>
              {ordered.map((h) => {
                const k = keyOf(h);
                const on = picked.has(k);
                const now = cur ? k === keyOf(cur) : false;
                return (
                  <div
                    key={k}
                    onClick={() => select(h)}
                    style={{ width: 160, border: `2px solid ${now ? "#faad14" : on ? "#52c41a" : "#f0f0f0"}`, background: now ? "rgba(250,173,20,0.08)" : on ? "rgba(82,196,26,0.08)" : undefined, borderRadius: 6, padding: 3, cursor: "pointer", position: "relative" }}
                    title={`${h.sample_code ?? h.path} · ${formatMs(h.t * 1000)} · 分 ${h.score.toFixed(3)}`}
                  >
                    <Tooltip title={label ? undefined : "先在左边选「标成」哪个类别"}>
                      <Checkbox
                        checked={on}
                        disabled={!label}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggle(h)}
                        style={{ position: "absolute", top: 6, left: 6, zIndex: 2, background: "rgba(0,0,0,0.45)", borderRadius: 3, padding: "0 3px" }}
                      />
                    </Tooltip>
                    {urlOf(h) ? (
                      <img src={urlOf(h)} alt="" loading="lazy" style={{ width: "100%", height: 110, objectFit: "contain", background: "#000", borderRadius: 4 }} />
                    ) : (
                      <div style={{ height: 110, display: "flex", alignItems: "center", justifyContent: "center", background: "#000", borderRadius: 4 }}><Spin size="small" /></div>
                    )}
                    <div style={{ fontSize: 11, color: "#888", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <span style={{ color: h.score >= 0.6 ? "#52c41a" : h.score >= 0.3 ? "#fa8c16" : "#999", fontWeight: 600 }}>{h.score.toFixed(3)}</span>
                      {" · "}{formatMs(h.t * 1000)} · #{h.task_id} {h.sample_code ?? ""}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ marginTop: 8, textAlign: "right" }}>
              <Button type="primary" loading={busy} disabled={!picked.size} onClick={write}>
                写入候选（要 {picked.size} / {hits.length} 帧）
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
