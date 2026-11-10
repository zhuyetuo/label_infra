import { useState } from "react";
import { Button, Checkbox, Popover, Space, Spin, Tag, Tooltip, Typography, message } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listDogs } from "@/api/dogs";
import { pickSampleDog } from "@/api/samples";

/**
 * 工作台标题上的「🐕 狗名（IMU）」：管理员点开能换狗。
 *
 * 老数据当时这个 IMU 戴在哪只狗身上，要对着画面才知道（那会儿项圈在几只狗之间换着戴，
 * 按设备号猜的名字不一定对）。先只列影棚那几只——一个画面里同时有四只，最需要分清。
 * 一个项圈一天戴在同一只狗身上，默认同一天这个设备号的样本一起改。
 */
export default function DogPicker({ sampleId, label, canEdit, onChanged }: {
  sampleId: number;
  label: string | null | undefined;
  canEdit: boolean;
  onChanged: (label: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [sameDay, setSameDay] = useState(true);
  const [saving, setSaving] = useState<number | "none" | null>(null);
  const qc = useQueryClient();
  const { data: dogs, isLoading } = useQuery({ queryKey: ["dogs"], queryFn: listDogs, enabled: open && canEdit, staleTime: 60_000 });
  const studio = (dogs ?? []).filter((d) => (d.site ?? "").includes("影棚") && d.name);
  const current = (label ?? "").replace(/（.*）$/, "");

  const pick = async (dogId: number | null) => {
    setSaving(dogId ?? "none");
    try {
      const r = await pickSampleDog(sampleId, dogId, sameDay);
      onChanged(r.dog_label);
      // 同一天这个设备号的样本是一起改的：项目页 / 任务页列表里其它几段也要跟着换狗名，
      // 不然只有刚打开的这一段变了、其它段还是旧狗（列表是早先拉的，没人让它重拉）
      for (const key of [["tasks"], ["tasks-lite"], ["samples"], ["skin-tracking"]]) qc.invalidateQueries({ queryKey: key });
      message.success(`${dogId ? `改成 ${r.dog_label}` : "已清掉，按设备号猜"}（${r.updated} 份样本）`);
      setOpen(false);
    } catch (e) {
      message.error(`没改成：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(null);
    }
  };

  const tag = (
    <Tag color="purple" style={{ fontSize: 14, padding: "2px 10px", fontWeight: 600, cursor: canEdit ? "pointer" : undefined }}>
      🐕 {label ?? "不知道是哪只狗"}{canEdit ? " ▾" : ""}
    </Tag>
  );
  if (!canEdit) return label ? tag : null;
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="bottomLeft"
      title="这条 IMU 当时戴在哪只狗身上（对着画面看）"
      content={
        <div style={{ width: 300 }}>
          {isLoading ? <Spin /> : (
            <Space wrap>
              {studio.map((d) => (
                <Button key={d.id} size="small" type={d.name === current ? "primary" : "default"} loading={saving === d.id}
                  onClick={() => pick(d.id)}>
                  {d.name}{d.breed ? <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>{d.breed}</Typography.Text> : null}
                </Button>
              ))}
              {!studio.length && <Typography.Text type="secondary">狗档案里没有场所是影棚的狗</Typography.Text>}
            </Space>
          )}
          <div style={{ marginTop: 10 }}>
            <Checkbox checked={sameDay} onChange={(e) => setSameDay(e.target.checked)}>同一天这个设备号的样本一起改</Checkbox>
          </div>
          <div style={{ marginTop: 6 }}>
            <Tooltip title="不指定狗，回到按设备号 + 场地去狗档案里猜">
              <Button size="small" type="link" style={{ padding: 0 }} loading={saving === "none"} onClick={() => pick(null)}>
                清掉，按设备号猜
              </Button>
            </Tooltip>
          </div>
        </div>
      }
    >
      {tag}
    </Popover>
  );
}
