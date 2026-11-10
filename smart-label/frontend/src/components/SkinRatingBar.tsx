import { useEffect, useState } from "react";
import { Button, Input, Radio, Space, Tag, Tooltip, Typography, message } from "antd";
import { SkinStandardHelp } from "@/components/SkinStandard";
import { putPhotoRating, type PhotoRating, type SkinGrade } from "@/api/material";

/** 档位跟产品的 S 档对齐（问卷 + IMU 算出来的 S0 / S1 / S2），照片评出来的能直接跟它对照 */
export const SKIN_GRADES: { value: SkinGrade; label: string; color: string; desc: string }[] = [
  { value: "S0", label: "S0 正常", color: "green",
    desc: "皮肤完整、粉红 / 肉色；没有秃毛，毛发光亮。允许一点点轻微泛红、少量干皮屑" },
  { value: "S1", label: "S1 轻度", color: "gold",
    desc: "皮肤没破。成块皮屑、可擦掉的黑油脂、1–2 处小秃毛（≤2cm）、毛发油腻打结 / 小范围断裂；没有红旗" },
  { value: "S2", label: "S2 中重度", color: "red",
    desc: "红旗任一项：皮肤鲜红；糜烂 / 渗液 / 结痂 / 脓疱 / 丘疹 / 裂隙；成片秃毛或直径 >3cm；毛发大部分干枯断裂" },
  { value: "unsure", label: "看不清", color: "default",
    desc: "模糊、遮挡、太暗，或没拍到关键部位（耳后、腋下、腹部、爪子…），不猜" },
];
const gradeMeta = (g: SkinGrade) => SKIN_GRADES.find((x) => x.value === g)!;

/** 档位说明：问号点开看兽医版完整标准（带图），见 SkinStandard.tsx */
export function SkinGradeHelp() {
  return <SkinStandardHelp />;
}

/**
 * 一只狗（一个日期目录下的一个狗名目录）的评级条：我的评级（单选，点已选的那个撤销）+ 备注 + 别人的评级。
 * 放在折叠面板标题栏右边，点击不能冒泡去开关面板。
 */
export default function SkinRatingBar({
  folder, dog, mine, others, onChanged,
}: {
  folder: string;
  dog: string;
  mine?: PhotoRating;
  others: PhotoRating[];
  onChanged: () => void;
}) {
  const [note, setNote] = useState(mine?.note ?? "");
  useEffect(() => setNote(mine?.note ?? ""), [mine?.note]);
  const save = async (grade: SkinGrade | null, n = note) => {
    // 记下改之前的样子：提示条上点「撤回」就还原（点错档、误撤销都能回去）
    const prev = mine ? { grade: mine.grade, note: mine.note } : null;
    await putPhotoRating("skin", { folder, dog_folder: dog, grade, note: n || null });
    onChanged();
    const undo = async () => {
      message.destroy("skin-rate");
      await putPhotoRating("skin", { folder, dog_folder: dog, grade: prev?.grade ?? null, note: prev?.note ?? null });
      onChanged();
      message.success({ content: `${dog}：已撤回，还原成${prev ? `「${gradeMeta(prev.grade).label}」` : "没评过"}`, key: "skin-rate", duration: 2 });
    };
    message.success({
      key: "skin-rate", duration: 5,
      content: (
        <span>
          {grade ? `${dog}：${gradeMeta(grade).label}` : `${dog}：已撤回，算没评过`}
          <Button type="link" size="small" onClick={undo}>撤回</Button>
        </span>
      ),
    });
  };
  return (
    <Space size={6} wrap onClick={(e) => e.stopPropagation()}>
      <SkinGradeHelp />
      <Radio.Group size="small" value={mine?.grade} buttonStyle="solid" optionType="button">
        {SKIN_GRADES.map((g) => (
          <Tooltip key={g.value} title={g.desc}>
            <Radio.Button value={g.value} onClick={() => save(mine?.grade === g.value ? null : g.value)}>{g.label}</Radio.Button>
          </Tooltip>
        ))}
      </Radio.Group>
      {/* 点错了还原成「没评过」（备注一起清掉）。再点一下已选的那档也一样 */}
      {/* 一直显示：评错了点它还原成「没评过」（备注一起清掉）；还没评时是灰的 */}
      <Tooltip title={mine ? "评错了？还原成没评过（备注一起清掉），不算进跟踪表" : "还没评，评了之后点这里能撤回"}>
        <Button size="small" danger={!!mine} disabled={!mine} onClick={() => save(null, "")}>↶ 撤回</Button>
      </Tooltip>
      <Input
        size="small"
        placeholder="备注（哪里、什么样）"
        style={{ width: 200 }}
        value={note}
        disabled={!mine}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => mine && note !== (mine.note ?? "") && save(mine.grade, note)}
        onPressEnter={(e) => (e.target as HTMLInputElement).blur()}
      />
      {others.map((o) => (
        <Tooltip key={o.user_id} title={`${o.user_name}${o.updated_at ? ` · ${o.updated_at}` : ""}${o.note ? `：${o.note}` : ""}`}>
          <Tag color={gradeMeta(o.grade).color} style={{ marginRight: 0 }}>
            {o.user_name} {o.grade === "unsure" ? "看不清" : o.grade}
          </Tag>
        </Tooltip>
      ))}
      {mine && others.some((o) => o.grade !== mine.grade && o.grade !== "unsure" && mine.grade !== "unsure") && (
        <Typography.Text type="warning" style={{ fontSize: 12 }}>跟别人评的不一样</Typography.Text>
      )}
    </Space>
  );
}
