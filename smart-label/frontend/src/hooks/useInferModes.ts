import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { listEdgeModels } from "@/api/modelEval";
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
export function useInferModes() {
  const { data } = useQuery({
    queryKey: ["edge-models"],
    queryFn: listEdgeModels,
    // 端侧服务是选型阶段才起的，起没起会变。但也别太频繁——
    // 它只是个下拉的内容，不是实时数据
    staleTime: 30_000,
    retry: false,
  });

  const edgeModels = data?.models ?? [];

  const options = useMemo(() => {
    const online = {
      label: "线上模型（algo_service）",
      options: INFER_MODE_OPTIONS.map((o) => ({ ...o, title: INFER_MODE_HINT[o.value] })),
    };
    if (!edgeModels.length) {
      // 一个都没有时**不显示空的分组标题**——那会让人以为是加载失败。
      // 端侧服务是可选的，没有它这个下拉跟以前一模一样
      return [online];
    }
    return [
      online,
      {
        label: "端侧模型（跑的是烧进项圈的那份 C）",
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
          const geom = `${m.window} 点 @${m.hz}Hz`;
          return [
            {
              label: `${m.tag} · 稳定版 v2`,
              value: m.spec,
              title: `${geom}。${EDGE_MODE_HINT}`,
            },
            {
              label: `${m.tag} · 板上整条链`,
              value: m.spec_board ?? `${m.spec}@board`,
              title: `${geom}。${EDGE_BOARD_HINT}`,
            },
            {
              label: `${m.tag} · 板上原始`,
              value: m.spec_raw ?? `${m.spec}@raw`,
              title: `${geom}。${EDGE_RAW_HINT}`,
            },
          ];
        }),
      },
    ];
  }, [edgeModels]);

  return {
    options,
    /** 配了地址但连不上：下拉里那一组是空的，而人看不出为什么。
     *  "没开这个功能"和"开了但服务挂了"要分得开。 */
    edgeOffline: Boolean(data?.enabled) && edgeModels.length === 0,
    edgeEnabled: Boolean(data?.enabled),
  };
}
