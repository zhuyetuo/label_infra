import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { listEdgeModels, listServerModels } from "@/api/modelEval";
import { listModelVersions } from "@/api/training";
import { EDGE_BOARD_HINT, EDGE_MODE_HINT, EDGE_RAW_HINT, INFER_MODE_HINT, INFER_MODE_OPTIONS } from "@/utils/inferMode";

/**
 * AI 预标注的「版本」下拉选项：线上模型 + 端侧模型，分两组。
 *
 * 做成 hook 而不是常量，是因为**端侧有哪几个模型是运行时才知道的**——
 * 问服务（GET /model-eval/edge-models），不写死在前端。写死的话服务换了模型，
 * 界面上会出现一个选了就报错的选项，而错误是"没有这个端侧模型"，
 * 前端看不出哪里错。
 *
 * 四个地方用同一个 hook（新建项目、批量建任务、项目页重跑、工作台单条），
 * 免得加一个模型要改四处、而漏掉的那处会安静地少一个选项。
 *
 * 端侧服务没配/没起时，这个 hook 退化成只有线上那一组，别的一切照旧。
 */
/**
 * 「版本」下拉统一的展示参数。**四个调用点共用一份**——各写各的话，
 * 有的宽有的窄，而窄的那个会把选项截断。
 *
 * `popupMatchSelectWidth: false` 是关键：antd 默认让弹出列表跟触发器一样宽，
 * 触发器只有 150~190px，于是「edge_cnn_i8 · 稳定版 v2」被截成
 * 「edge_cnn_i8 · …」——**截掉的恰好是区分它们的那部分**，
 * 三行端侧模型看起来一模一样。关掉之后列表按内容撑开，不再截断。
 *
 * 触发器本身仍然有宽度上限（不能让它把一行挤没），所以选中之后可能还是
 * 显示不全——那个靠 hover 的 title 补，跟以前一样。
 */
export const INFER_SELECT_PROPS = {
  popupMatchSelectWidth: false,
  style: { minWidth: 190 },
} as const;


export function useInferModes() {
  const { data } = useQuery({
    queryKey: ["edge-models"],
    queryFn: listEdgeModels,
    // 端侧服务是选型阶段才起的，起没起会变。但也别太频繁——
    // 它只是个下拉的内容，不是实时数据
    staleTime: 30_000,
    retry: false,
  });

  // AI 服务上除了默认那个之外还挂着的模型（只用加速计那种实验模型）。
  // 跟端侧那组**分开列**：一个跑服务器上的 sklearn，一个跑烧进项圈的 C，
  // 混在一组里人会以为实验模型也是板子会跑的东西
  const { data: srv } = useQuery({
    queryKey: ["server-models"],
    queryFn: listServerModels,
    staleTime: 30_000,
    retry: false,
  });

  // 训练记录：把算法服务里的 train<任务号> 对回平台上的「训练记录 #N」。
  // 两边的号不是一个——平台的 id 是这边数据库自增的，算法那边是它自己的任务号
  const { data: versions } = useQuery({
    queryKey: ["model-versions"],
    queryFn: listModelVersions,
    staleTime: 30_000,
    retry: false,
  });
  const versionIdOf = useMemo(() => {
    const m = new Map<number, number>();
    for (const v of versions ?? []) m.set(v.algo_job_id, v.id);
    return m;
  }, [versions]);
  // 训练记录里「启用」了的才上架。训一次多一版，全列出来的话训几十版下拉就没法用了
  const listedJobs = useMemo(
    () => new Set((versions ?? []).filter((v) => v.listed).map((v) => v.algo_job_id)),
    [versions],
  );

  // 训练记录导出的端侧模型也要「启用」了才上架，跟服务端那组同一个规矩
  const edgeModels = (data?.models ?? []).filter(
    (m) => !m.train?.job_id || listedJobs.has(m.train.job_id),
  );
  // 默认模型不列：它就是「稳定版 / 稳定版 v2 / 调试版」那三行
  const serverModels = (srv?.models ?? []).filter(
    (m) => !m.is_default && m.spec && (!m.train || listedJobs.has(m.train.job_id)),
  );

  const options = useMemo(() => {
    const online = {
      // 分组名要短：弹出列表按最长那行撑开，标题太长会把整个列表撑得很宽。
      // 三组分别是什么，问号里那张表讲（InferModeHelp）
      label: "算法服务 · 默认模型",
      options: INFER_MODE_OPTIONS.map((o) => ({ ...o, title: INFER_MODE_HINT[o.value] })),
    };
    const server = serverModels.length
      ? [{
          label: "算法服务 · 其它模型",
          // 每个模型两个选项。默认的「稳定版 v2」排在前面——跟线上那三行
          // 用的是同一份后处理，所以跟它们比，差的只有模型本身。
          //
          // 标签**只留名字**，差异放在下拉旁边那个问号里（InferModeHelp）。
          // 用 tag 不用 name：name 是目录名（.../rf/ml_rf.pkl → "rf"），
          // 挂两个模型的话会显示成两个一模一样的"rf"
          options: serverModels.flatMap((m) => {
            // 训练记录里训出来的那几版：显示成「训练记录 #N · 3轴 · F1 0.53」，
            // 而不是算法服务内部的 train1——人是从训练记录那一页过来的，认的是那个号
            const t = m.train;
            const vid = t ? versionIdOf.get(t.job_id) : undefined;
            const name = t
              ? `训练记录 #${vid ?? `?(算法#${t.job_id})`} · ${t.axes === 3 ? "3轴" : "6轴"}` +
                (typeof t.macro_f1 === "number" ? ` · F1 ${t.macro_f1.toFixed(2)}` : "")
              : m.tag;
            const origin = t
              ? `训练记录里训出来的（数据集 ${t.dataset ?? "?"}${t.classes ? `，类别：${t.classes.join("/")}` : ""}）。`
              : "";
            return [
            {
              label: `${name} · 稳定版 v2`,
              value: m.spec as string,
              title: `${origin}服务端推理。后处理跟线上「稳定版 v2」是同一份代码，所以跟它比差的只有模型本身。${m.model_path}`,
            },
            {
              label: `${name} · 调试版`,
              value: (m.spec_raw ?? `${m.spec}@raw`) as string,
              title: `${origin}模型逐窗口原始输出，不做后处理。用来看这个模型到底说了什么。${m.model_path}`,
            },
          ];
          }),
        }]
      : [];

    if (!edgeModels.length) {
      // 一个都没有时**不显示空的分组标题**——那会让人以为是加载失败。
      // 端侧服务是可选的，没有它这个下拉跟以前一模一样
      return [online, ...server];
    }
    return [
      online,
      ...server,
      {
        label: "端侧模型 · 板上 C",
        // 每个端侧模型三个选项，**默认那个排在前面**——用它铺草稿，
        // 跟线上版本唯一的差别才是模型本身。
        //
        // 标签**只留名字**，差异放在下拉旁边那个问号里（InferModeHelp）。
        //
        // 中间试过把算法名写进标签（「板上整条链（板上·流式有界回溯）」），
        // 结果太长被下拉框截断，而**截断之后先没的恰好是后半句**——
        // 也就是真正区分它们的那部分。写进 hover 提示也不行：人是扫列表的，
        // 不是逐个悬停的。一张表最省事。
        options: edgeModels.flatMap((m) => {
          const geom = `${m.window} 点 @${m.hz}Hz${m.n_channels ? `，${m.n_channels === 5 ? "3 轴" : "6 轴"}` : ""}`;
          // 训练记录导出来的：显示成「训练记录 #N · 端侧 · 3轴 · F1 0.53」，F1 是端侧的
          const t = m.train;
          const vid = t?.job_id != null ? versionIdOf.get(t.job_id) : undefined;
          const name = t
            ? `训练记录 #${vid ?? `?(算法#${t.job_id})`} · 端侧` +
              (m.n_channels ? ` · ${m.n_channels === 5 ? "3轴" : "6轴"}` : "") +
              (typeof m.edge?.macro_f1 === "number" ? ` · F1 ${m.edge.macro_f1.toFixed(2)}` : "")
            : m.tag;
          return [
            {
              label: `${name} · 稳定版 v2`,
              value: m.spec,
              title: `${geom}。${EDGE_MODE_HINT}`,
            },
            {
              label: `${name} · 板上整条链`,
              value: m.spec_board ?? `${m.spec}@board`,
              title: `${geom}。${EDGE_BOARD_HINT}`,
            },
            {
              label: `${name} · 板上原始`,
              value: m.spec_raw ?? `${m.spec}@raw`,
              title: `${geom}。${EDGE_RAW_HINT}`,
            },
          ];
        }),
      },
    ];
  }, [edgeModels, serverModels, versionIdOf]);
  // eslint 会抱怨 listedJobs 没进依赖：它已经通过 edgeModels/serverModels 体现了

  // 「其它模型」这一组单独给出去：模型对比那页自己拼下拉（它要的是"跑哪几个
  // 版本做评测"，不是"用哪个铺草稿"），但这一组得跟这里是同一份——以前它漏了
  // 这组，训练记录里训出来的那一版在模型对比里根本选不到
  const serverGroup = options.find((g) => "label" in g && g.label === "算法服务 · 其它模型");

  return {
    options,
    serverGroup,
    /** 配了地址但连不上：下拉里那一组是空的，而人看不出为什么。
     *  "没开这个功能"和"开了但服务挂了"要分得开。 */
    edgeOffline: Boolean(data?.enabled) && edgeModels.length === 0,
    edgeEnabled: Boolean(data?.enabled),
  };
}
