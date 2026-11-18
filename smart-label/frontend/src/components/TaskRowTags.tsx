import { Tag, Tooltip } from "antd";
import type { Task } from "@/types";
import { currentName, findLabel } from "@/utils/labelTree";
import { IMU_OTHER, imuOf } from "@/utils/imuOf";
import { candTitle } from "@/utils/candReason";

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
}: {
  task: Task;
  labels?: { display_name: string; color?: string | null }[];
  /** 点某一类：打开工作台，疑似片段面板只看这一类 */
  onPick?: (candName: string) => void;
  /** 只显示这几类（按疑似片段类别筛的时候，比如只看疑似饮水）；不传 = 全部 */
  only?: string[];
}) {
  const kinds = Object.entries(task.cand_labels ?? {}).filter(([name, v]) => v.n > 0 && (!only || only.includes(name)));
  if (!kinds.length) return null;
  // 还有待判的排前面，同样按条数多的在前
  kinds.sort(([, a], [, b]) => Number(b.pending > 0) - Number(a.pending > 0) || b.n - a.n);
  const spot = task.cand_spot_pending ?? 0;
  return (
    <>
      {spot > 0 && (
        <Tooltip title={`这个任务里有 ${spot} 段「抽查」：新模型报了、人工没标，请对着视频判是不是真的。打开后疑似片段面板默认只显示这几段`}>
          <Tag color="red" style={{ marginRight: 0, fontWeight: 600 }}>抽查 待判 {spot}</Tag>
        </Tooltip>
      )}
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
