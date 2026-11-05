import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Checkbox, Collapse, Empty, Image, Select, Space, Spin, Table, Tabs, Tag, Tooltip, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { getMaterialPhotoToken, listMaterialPhotos, listPhotoRatings, materialPhotoUrl, type Album, type MaterialPhoto } from "@/api/material";
import SkinRatingBar, { SKIN_GRADES } from "@/components/SkinRatingBar";
import { useAuthStore } from "@/stores/authStore";
import { getSavedText, saveText } from "@/utils/persistedSize";

// 素材库相册只读浏览：按 日期目录 > 狗 折叠，缩略图网格，点开大图（antd Image 预览，
// 同一只狗同一天的照片可以左右翻）。皮肤评估页的「皮肤照片」用；牙齿识别页有自己带
// 检测结果的版本（Tooth.tsx）。

export default function PhotoGallery({ album, hint, filterDate, filterDog, rating }: {
  album: Album; hint?: string; filterDate?: string; filterDog?: string;
  /** 每只狗标题栏上挂评级条（S0 / S1 / S2 / 看不清），兽医 / 实习生看图评级用 */
  rating?: boolean;
}) {
  const { data: raw, isLoading, error } = useQuery({ queryKey: ["material-photos", album], queryFn: () => listMaterialPhotos(album) });
  const userId = useAuthStore((s) => s.userInfo?.id);
  const role = useAuthStore((s) => s.userInfo?.role);
  // 管理员看得到所有人的评级（后端也只给管理员返回别人的），用来对一致性、看实习生评得准不准
  const isAdmin = role === "admin" || role === "super_admin";
  const { data: ratings, refetch: refetchRatings } = useQuery({
    queryKey: ["photo-ratings", album], queryFn: () => listPhotoRatings(album), enabled: !!rating,
  });
  const ratingsOf = (folder: string, dogName: string) =>
    (ratings ?? []).filter((r) => r.folder === folder && r.dog_folder === dogName);
  // 我评过的 (日期目录, 狗)：一只狗一天的那十几张照片算「一次评估」，进度按次数算比按张数直观
  const mineDone = useMemo(
    () => new Set((ratings ?? []).filter((r) => r.user_id === userId).map((r) => `${r.folder}\u0000${r.dog_folder}`)),
    [ratings, userId]
  );
  const isMine = (folder: string, dogName: string) => mineDone.has(`${folder}\u0000${dogName}`);
  const [onlyTodo, setOnlyTodo] = useState(false);
  const [onlyDiff, setOnlyDiff] = useState(false);
  // 几个人评的档不一样（看不清不算）
  const isDiff = (folder: string, dogName: string) =>
    new Set(ratingsOf(folder, dogName).map((r) => r.grade).filter((g) => g !== "unsure")).size > 1;
  // 来源（视频问诊 / 雷喏斯达 / 博朗旺…）和狗：几个地方很多天混在一起没法看，先按来源分开。
  // 从外面带了日期/狗进来（每日跟踪表里点「N 张」）时不显示这两个筛选，只看那一格
  const pinned = !!(filterDate || filterDog);
  const sourceKey = `smart-label:photos-source:${album}`;
  const [source, setSourceState] = useState(() => getSavedText(sourceKey, "all"));
  const setSource = (k: string) => { setSourceState(k); saveText(sourceKey, k); setDog(undefined); };
  const [dog, setDog] = useState<string | undefined>(undefined);
  const sources = raw?.sources ?? [];
  // 记住的来源这次没扫到（比如那个狗场目录改名了）→ 回到全部，别停在空页上
  const curSource = source === "all" || sources.some((s) => s.source === source) ? source : "all";
  const inSource = useMemo(
    () => (raw?.folders ?? []).filter((f) => curSource === "all" || f.source === curSource),
    [raw, curSource]
  );
  const dogNames = useMemo(() => [...new Set(inSource.flatMap((f) => f.dogs.map((d) => d.name)))].sort(), [inSource]);
  const data = useMemo(() => {
    if (!raw) return raw;
    const wantDate = filterDate, wantDog = filterDog ?? (pinned ? undefined : dog);
    const base = pinned ? raw.folders : inSource;
    const folders = base
      // 按解析出来的日期比：狗场那几棵树的目录名开头是树名，按前 10 个字符比永远对不上
      .filter((f) => !wantDate || f.date === wantDate)
      .map((f) => ({ ...f, dogs: f.dogs.filter((d) => (!wantDog || d.name === wantDog) && !(onlyTodo && isMine(f.folder, d.name)) && !(onlyDiff && !isDiff(f.folder, d.name))) }))
      .filter((f) => f.dogs.length > 0);
    return { ...raw, folders };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, inSource, filterDate, filterDog, dog, pinned, onlyTodo, onlyDiff, mineDone, ratings]);
  // 管理员：当前来源里每个评级人评了多少、各档几次、跟别人不一致几次
  const raterStats = useMemo(() => {
    if (!isAdmin || !rating) return null;
    const groups = inSource.flatMap((f) => f.dogs.map((d) => ({ folder: f.folder, dog: d.name })));
    const inGroup = new Set(groups.map((g) => `${g.folder}\u0000${g.dog}`));
    const rs = (ratings ?? []).filter((r) => inGroup.has(`${r.folder}\u0000${r.dog_folder}`));
    const by = new Map<number, { user_id: number; name: string; role: string; n: number; grades: Record<string, number>; diff: number }>();
    for (const r of rs) {
      const u = by.get(r.user_id) ?? { user_id: r.user_id, name: r.user_name, role: r.user_role, n: 0, grades: {}, diff: 0 };
      u.n += 1;
      u.grades[r.grade] = (u.grades[r.grade] ?? 0) + 1;
      if (r.grade !== "unsure" && ratingsOf(r.folder, r.dog_folder).some((o) => o.user_id !== r.user_id && o.grade !== "unsure" && o.grade !== r.grade)) u.diff += 1;
      by.set(r.user_id, u);
    }
    let multi = 0, diff = 0;
    for (const g of groups) {
      if (new Set(ratingsOf(g.folder, g.dog).map((r) => r.user_id)).size >= 2) multi += 1;
      if (isDiff(g.folder, g.dog)) diff += 1;
    }
    return { total: groups.length, users: [...by.values()].sort((a, b) => b.n - a.n), multi, diff };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, rating, inSource, ratings]);
  // 每个来源：几次评估（日期×狗）、我评了几次、多少张
  const countOf = (src: string) => {
    let n = 0, done = 0, photos = 0;
    for (const f of raw?.folders ?? []) {
      if (src !== "all" && f.source !== src) continue;
      for (const d of f.dogs) {
        n += 1; photos += d.photos.length;
        if (isMine(f.folder, d.name)) done += 1;
      }
    }
    return { n, done, photos };
  };
  const tabLabel = (name: string, src: string) => {
    const c = countOf(src);
    return rating ? `${name} 我已评 ${c.done}/${c.n} 次` : `${name} ${c.n} 次 · ${c.photos} 张`;
  };
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ open: boolean; current: number }>({ open: false, current: 0 });

  // 带上狗名，弹窗标题里能看出翻到哪只狗了；顺序 = 页面上的顺序（日期 > 狗 > 文件名）
  const allPhotos = useMemo(
    () => (data?.folders ?? []).flatMap((f) => f.dogs.flatMap((d) => d.photos.map((p) => ({ ...p, dog: d.name, folder: f.folder })))),
    [data]
  );

  useEffect(() => {
    // 缩略图要带路径签名 token，8 个一组换，几百张几秒钟
    const missing = allPhotos.filter((p) => !urls[p.rel_path]).map((p) => p.rel_path);
    if (!missing.length) return;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < missing.length; i += 8) {
        const chunk = missing.slice(i, i + 8);
        const tokens = await Promise.all(chunk.map((p) => getMaterialPhotoToken(album, p).catch(() => null)));
        if (cancelled) return;
        const next: Record<string, string> = {};
        chunk.forEach((p, j) => { if (tokens[j]) next[p] = materialPhotoUrl(album, p, tokens[j]!.token); });
        setUrls((prev) => ({ ...prev, ...next }));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allPhotos, album]);
  if (error) {
    return <Alert type="error" showIcon message="照片目录读不到" description={`${(error as Error).message}。确认素材库 NAS 已挂到 /home/toky/alg_material 并在 docker-compose 里挂进了容器。`} />;
  }
  if (isLoading) return <Spin />;

  // 扫到了目录却没出照片的来源：把原因摆出来，不然人只会看到"这个狗场的数据不见了"
  const problems = sources.filter((s) => (curSource === "all" || s.source === curSource) && (s.photos === 0 || s.unclassified > 0));
  const problemAlert = !pinned && problems.length > 0 && (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 12 }}
      message="有照片没显示出来"
      description={
        <div>
          {problems.map((s) => (
            <div key={s.path} style={{ marginBottom: 4 }}>
              <b>{s.source}</b>（{s.path}）：显示 {s.photos} 张
              {s.unclassified > 0 && <>，另有 {s.unclassified} 张分不出是皮肤还是口腔，没放进来。例：{s.examples.map((e) => <code key={e} style={{ marginLeft: 4 }}>{e}</code>)}</>}
              {s.photos === 0 && s.unclassified === 0 && <>，一张都没扫到。目录要按「日期（含8位数字）/ 狗 / 品类 / 照片」放</>}
            </div>
          ))}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            狗场目录里，品类子目录名或照片文件名要带「皮肤 / 瘙痒」或「口腔 / 牙齿」，平台才知道放进哪个相册。
          </Typography.Text>
        </div>
      }
    />
  );
  const filters = !pinned && sources.length > 1 && (
    <>
      <Tabs
        size="small"
        activeKey={curSource}
        onChange={setSource}
        items={[
          { key: "all", label: tabLabel("全部", "all") },
          ...sources.map((s) => ({ key: s.source, label: tabLabel(s.source, s.source) })),
        ]}
      />
      <Space style={{ marginBottom: 12 }}>
        <Select
          allowClear
          showSearch
          size="small"
          style={{ width: 200 }}
          placeholder="全部狗"
          value={dog}
          onChange={setDog}
          options={dogNames.map((n) => ({ value: n, label: n }))}
        />
        {rating && (
          <Checkbox checked={onlyTodo} onChange={(e) => setOnlyTodo(e.target.checked)}>只看我还没评的</Checkbox>
        )}
        {rating && isAdmin && (
          <Checkbox checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)}>只看评得不一样的</Checkbox>
        )}
      </Space>
      {raterStats && (
        <div style={{ marginBottom: 12 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            评级情况（只有管理员看得到；兽医 / 实习生只看到自己的）：这里一共 {raterStats.total} 次评估，
            {raterStats.multi} 次有两人以上评过，其中 <Typography.Text type={raterStats.diff ? "warning" : "secondary"}>{raterStats.diff} 次评得不一样</Typography.Text>
          </Typography.Text>
          {raterStats.users.length > 0 && (
            <Table size="small" rowKey="user_id" pagination={false} style={{ marginTop: 6, maxWidth: 760 }} dataSource={raterStats.users}
              columns={[
                { title: "评级人", dataIndex: "name" },
                { title: "已评", render: (_: unknown, u) => `${u.n} / ${raterStats.total}` },
                ...SKIN_GRADES.map((g) => ({
                  title: g.label, align: "center" as const,
                  render: (_: unknown, u: { grades: Record<string, number> }) => u.grades[g.value] ?? 0,
                })),
                { title: <Tooltip title="同一只狗同一天，这个人评的档跟其他人至少一个不一样（看不清不算）">跟别人不一样</Tooltip>,
                  render: (_: unknown, u) => (u.diff ? <Typography.Text type="warning">{u.diff}</Typography.Text> : 0) },
              ]} />
          )}
        </div>
      )}
    </>
  );
  if (!data?.folders.length) return <div>{filters}{problemAlert}<Empty description="还没有照片" /></div>;

  // 缩略图只渲染（不带预览），预览统一由外层一个 PreviewGroup 接管，这样整页的图
  // 在放大状态下能一路左右翻，不用关掉再点下一张；工具栏里加两个明显的左右按钮
  const grid = (photos: MaterialPhoto[]) => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
      {photos.map((p) => {
        const idx = allPhotos.findIndex((x) => x.rel_path === p.rel_path);
        return (
          <div key={p.rel_path} style={{ width: 160, cursor: "pointer" }} onClick={() => urls[p.rel_path] && setPreview({ open: true, current: idx })}>
            <div style={{ width: 160, height: 120, background: "var(--sl-fill2)", borderRadius: 4, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
              {urls[p.rel_path] ? <img src={urls[p.rel_path]} alt={p.filename} style={{ maxWidth: 160, maxHeight: 120, objectFit: "contain" }} loading="lazy" /> : <Spin size="small" />}
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 11 }} ellipsis={{ tooltip: p.filename }}>{p.filename}</Typography.Text>
          </div>
        );
      })}
    </div>
  );

  return (
    <div>
      {filters}
      {problemAlert}
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        {hint ?? "照片来自素材库 NAS"} <code>{data.root}</code>，按「日期目录 / 狗」归类，只读；{(() => {
          const n = data.folders.reduce((k, f) => k + f.dogs.length, 0);
          return <>共 <b>{n}</b> 次评估（一只狗一天算一次，每次约 {n ? Math.round(allPhotos.length / n) : 0} 张），{allPhotos.length} 张。</>;
        })()}点图放大，工具栏左右按钮或键盘方向键翻上一张/下一张。
      </Typography.Paragraph>
      <Image.PreviewGroup
        items={allPhotos.map((p) => ({ src: urls[p.rel_path] ?? "", alt: `${p.folder} / ${p.dog} / ${p.filename}` }))}
        preview={{
          visible: preview.open,
          current: preview.current,
          onVisibleChange: (open: boolean) => setPreview((prev) => ({ ...prev, open })),
          onChange: (current: number) => setPreview((prev) => ({ ...prev, current })),
          // 路径放图片最上面（imageRender 里贴一条），工具栏只留"上一张 | 原生按钮 | 下一张"，两个翻页按钮挨着
          // 不能给 originalNode 外面套 div——会破坏 antd 给图片定的最大尺寸，图片撑满整屏；
          // 标签用 fixed 定位单独贴，跟图片布局无关
          imageRender: (originalNode, { current }) => (
            <>
              {originalNode}
              {allPhotos[current] && <ImageCaption text={`${allPhotos[current].folder} / ${allPhotos[current].dog} / ${allPhotos[current].filename}`} />}
            </>
          ),
          toolbarRender: (originalNode, info) => (
            <Space size={8}>
              <Button size="small" disabled={info.current <= 0} onClick={() => info.actions.onActive?.(-1)}>← 上一张</Button>
              {originalNode}
              <Button size="small" disabled={info.current >= info.total - 1} onClick={() => info.actions.onActive?.(1)}>下一张 →</Button>
            </Space>
          ),
        }}
      />
      <Collapse
        key={`${curSource}|${dog ?? ""}`}
        defaultActiveKey={[data.folders[0].folder]}
        items={data.folders.map((f) => ({
          key: f.folder,
          label: (
            <Space>
              <b>{f.folder}</b>
              {!f.ok && <Tag color="orange">未整理（目录名没有 -ok）</Tag>}
              <Typography.Text type="secondary">{f.dogs.map((d) => `${d.name} ${d.photos.length}`).join(" · ")}</Typography.Text>
              {rating && (() => {
                const done = f.dogs.filter((d) => ratingsOf(f.folder, d.name).some((r) => r.user_id === userId)).length;
                return <Tag color={done === f.dogs.length ? "success" : "processing"}>我已评 {done}/{f.dogs.length}</Tag>;
              })()}
              {rating && isAdmin && (() => {
                // 管理员：这一天每个人评了几只
                const cnt = new Map<string, number>();
                for (const r of ratings ?? []) {
                  if (r.folder === f.folder && r.user_id !== userId && f.dogs.some((d) => d.name === r.dog_folder)) cnt.set(r.user_name, (cnt.get(r.user_name) ?? 0) + 1);
                }
                const diff = f.dogs.filter((d) => isDiff(f.folder, d.name)).length;
                return (
                  <>
                    {[...cnt].map(([n, c]) => <Tag key={n} style={{ marginRight: 0 }}>{n} {c}/{f.dogs.length}</Tag>)}
                    {diff > 0 && <Tag color="warning" style={{ marginRight: 0 }}>{diff} 只评得不一样</Tag>}
                  </>
                );
              })()}
            </Space>
          ),
          children: (
            <Collapse
              size="small"
              defaultActiveKey={f.dogs.map((d) => d.name)}
              items={f.dogs.map((d) => {
                const rs = rating ? ratingsOf(f.folder, d.name) : [];
                return {
                  key: d.name,
                  label: <Space><b>{d.name}</b><Typography.Text type="secondary">{d.photos.length} 张</Typography.Text></Space>,
                  // 评级条挂在标题栏右边：看完这只狗的照片顺手点一档
                  extra: rating ? (
                    <SkinRatingBar folder={f.folder} dog={d.name} mine={rs.find((r) => r.user_id === userId)}
                      others={rs.filter((r) => r.user_id !== userId)} onChanged={() => refetchRatings()} />
                  ) : undefined,
                  children: grid(d.photos),
                };
              })}
            />
          ),
        }))}
      />
    </div>
  );
}


// 贴在预览图正上方的路径标签：不能给 antd 的 img 套容器（会破坏它的尺寸约束），
// 所以单独 fixed 定位，位置按实际渲染出来的图片边框算（缩放/旋转/换图都跟着走）
function ImageCaption({ text }: { text: string }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const img = document.querySelector<HTMLImageElement>(".ant-image-preview-img");
      if (img) {
        const r = img.getBoundingClientRect();
        setPos((prev) => {
          const next = { top: Math.max(8, r.top - 34), left: r.left + r.width / 2 };
          return prev && Math.abs(prev.top - next.top) < 1 && Math.abs(prev.left - next.left) < 1 ? prev : next;
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text]);
  if (!pos) return null;
  return (
    <div style={{ position: "fixed", top: pos.top, left: pos.left, transform: "translateX(-50%)", background: "rgba(0,0,0,0.6)", color: "#fff", padding: "4px 12px", borderRadius: 4, fontSize: 13, pointerEvents: "none", zIndex: 1, whiteSpace: "nowrap" }}>
      {text}
    </div>
  );
}
