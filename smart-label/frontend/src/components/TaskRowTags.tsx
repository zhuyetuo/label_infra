import { Tag, Tooltip } from "antd";
import type { Task } from "@/types";
import { currentName, findLabel } from "@/utils/labelTree";
import { IMU_OTHER, imuOf } from "@/utils/imuOf";

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
}: {
  task: Task;
  labels?: { display_name: string; color?: string | null }[];
}) {
  const kinds = Object.entries(task.cand_labels ?? {}).filter(([, v]) => v.n > 0);
  if (!kinds.length) return null;
  // 还有待判的排前面，同样按条数多的在前
  kinds.sort(([, a], [, b]) => Number(b.pending > 0) - Number(a.pending > 0) || b.n - a.n);
  return (
    <>
      {kinds.map(([name, v]) => {
        const shown = currentName(name);
        return (
          <Tooltip
            key={name}
            title={v.pending ? `疑似${shown} ${v.n} 条，其中 ${v.pending} 条还没判断` : `疑似${shown} ${v.n} 条，都判断过了`}
          >
            <Tag
              color={findLabel(labels, name)?.color || undefined}
              bordered
              style={{ marginRight: 0, borderStyle: "dashed", opacity: v.pending ? 1 : 0.6 }}
            >
              疑似{shown} {v.n}
              {v.pending ? <span style={{ opacity: 0.75 }}>/{v.pending}待判</span> : null}
            </Tag>
          </Tooltip>
        );
      })}
    </>
  );
}
