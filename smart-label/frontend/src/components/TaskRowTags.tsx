import { Tag, Tooltip } from "antd";
import type { Task } from "@/types";
import { currentName, findLabel } from "@/utils/labelTree";
import { IMU_OTHER, imuOf } from "@/utils/imuOf";
import { SPOT_KIND, candTitle, type SpotKind } from "@/utils/candReason";

/**
 * 任务列表里一行的两种小标签，项目页和任务页共用。
 *
 * ImuTag：这一行是哪个设备 / 哪只狗。按设备筛选时上面那排按钮已经说明了，但看「全部」时
 * 几十行混在一起，一天里四只狗的时段长得一模一样，不写就分不清。
 *
 * CandKindTags：「疑似片段」里各类别各几条（疑似舔 2 / 疑似进食 1…）。原来只有一个总数，
 * 想知道某个任务里有没有吠叫 / 舔，得一个个点进工作台看。
 */

export function ImuTag({ task, sampleCode }: { task: Task; sampleCode: string | undefined | null }) {
  const imu = imuOf(sampleCode);
  // dog_label 形如「秃子（IMU14）」，有就用它（带狗名）；没有退回编号里的 imu
  const text = task.dog_label || (imu !== IMU_OTHER ? imu.toUpperCase() : null);
  if (!text) return null;
  return (
    <Tag color="purple" style={{ marginRight: 0 }}>
      {text}
    </Tag>
  );
}

export function CandKindTags({
  task,
  labels = [],
  onPick,
  only,
  specialOnly,
}: {
  task: Task;
  labels?: { display_name: string; color?: string | null }[];
  /** 点某一类：打开工作台，疑似片段面板只看这一类 */
  onPick?: (candName: string) => void;
  /** 只显示这几类（按疑似片段类别筛的时候，比如只看疑似饮水）；不传 = 全部 */
  only?: string[];
  /** 专项模式：只显示「专项·xx 待判」，别的疑似片段类别都不显示 */
  specialOnly?: boolean;
}) {
  const kinds = specialOnly ? [] : Object.entries(task.cand_labels ?? {}).filter(([name, v]) => v.n > 0 && (!only || only.includes(name)));
  if (!kinds.length && !(task.cand_spot_pending ?? 0) && !(task.cand_fill_pending ?? 0)) return null;
  // 还有待判的排前面，同样按条数多的在前
  kinds.sort(([, a], [, b]) => Number(b.pending > 0) - Number(a.pending > 0) || b.n - a.n);
  const spot = task.cand_spot_pending ?? 0;
  const spotWhat = (task.cand_spot_labels ?? []).join("/") || "抓挠";
  const fill = specialOnly ? 0 : task.cand_fill_pending ?? 0;
  return (
    <>
      {fill > 0 && (
        <Tooltip title={`这个任务里有 ${fill} 段「补标」疑似抓挠要判：模型在没人标过的时间里很有把握报了抓挠，抽查下来大约 3/4 是漏标的真抓挠。对着视频判：是抓挠就确认（起止可以先调），会写进标注；不是就排除或改成别的`}>
          <Tag color="geekblue" style={{ marginRight: 0, fontWeight: 600 }}>补标·抓挠 待判 {fill}</Tag>
        </Tooltip>
      )}
      {spot > 0 && (
        <Tooltip title={`这个任务里有 ${spot} 段「专项·${spotWhat}」要判（给模型调整用）：模型很有把握报了${spotWhat}、人工却没标。对着视频判：是漏标的就确认，其实是别的动作就改成别的，起止不对 / 几个动作混在一起 / 看不清就选对应的待定。判了就自动记下，不用认领、不用提交`}>
          <Tag color="red" style={{ marginRight: 0, fontWeight: 600 }}>专项·{spotWhat} 待判 {spot}</Tag>
        </Tooltip>
      )}
      {spot > 0 && (Object.keys(SPOT_KIND) as SpotKind[]).map((k) => {
        const n = task.cand_spot_kinds?.[k] ?? 0;
        return n ? (
          <Tooltip key={k} title={SPOT_KIND[k].tip}>
            <Tag color={SPOT_KIND[k].color} style={{ marginRight: 0 }}>{SPOT_KIND[k].short} {n}</Tag>
          </Tooltip>
        ) : null;
      })}
      {kinds.map(([name, v]) => {
        const shown = currentName(name);
        return (
          <Tooltip
            key={name}
            title={v.pending ? `${candTitle(shown)} ${v.n} 条，其中 ${v.pending} 条还没判断` : `${candTitle(shown)} ${v.n} 条，都判断过了`}
          >
            <Tag
              color={findLabel(labels, name)?.color || undefined}
              bordered
              style={{ marginRight: 0, borderStyle: "dashed", opacity: v.pending ? 1 : 0.6, cursor: onPick ? "pointer" : undefined }}
              onClick={onPick ? () => onPick(name) : undefined}
            >
              {candTitle(shown)} {v.n}
              {v.pending ? <span style={{ opacity: 0.75 }}>/{v.pending}待判</span> : null}
            </Tag>
          </Tooltip>
        );
      })}
    </>
  );
}
