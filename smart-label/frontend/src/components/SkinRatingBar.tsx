import { useEffect, useState } from "react";
import { Button, Input, Radio, Space, Tag, Tooltip, Typography, message } from "antd";
import { QuestionCircleOutlined } from "@ant-design/icons";
import { putPhotoRating, type PhotoRating, type SkinGrade } from "@/api/material";

/** 档位跟产品的 S 档对齐（问卷 + IMU 算出来的 S0 / S1 / S2），照片评出来的能直接跟它对照 */
export const SKIN_GRADES: { value: SkinGrade; label: string; color: string; desc: string }[] = [
  { value: "S0", label: "S0 正常", color: "green",
    desc: "皮肤颜色正常（粉色 / 肤色），没有红斑、皮屑、抓痕、破溃；毛发完整、有光泽，没有秃毛" },
  { value: "S1", label: "S1 轻度", color: "gold",
    desc: "局部轻微发红或少量皮屑 / 抓痕；小范围（单处、硬币大小以内）毛发稀疏或秃毛；没有破溃、渗出、结痂" },
  { value: "S2", label: "S2 中重度", color: "red",
    desc: "大面积或多处红斑、色素沉着、皮肤增厚（像大象皮）；多处或大片秃毛；有破溃、结痂、渗出、明显异味——任一项明显就判 S2" },
  { value: "unsure", label: "看不清", color: "default",
    desc: "照片没拍到关键部位（耳后、腋下、腹部、爪子…）、太模糊或太暗，判断不了" },
];
const gradeMeta = (g: SkinGrade) => SKIN_GRADES.find((x) => x.value === g)!;

/** 档位说明：问号悬停就看到 */
export function SkinGradeHelp() {
  return (
    <Tooltip
      overlayStyle={{ maxWidth: 480 }}
      title={
        <div style={{ fontSize: 12, lineHeight: 1.7 }}>
          <b>看这只狗这一次的全部照片，按最严重的部位定档：</b>
          {SKIN_GRADES.map((g) => (
            <div key={g.value} style={{ marginTop: 6 }}>
              <Tag color={g.color}>{g.label}</Tag>
              {g.desc}
            </div>
          ))}
          <div style={{ marginTop: 6, opacity: 0.8 }}>拿不准在两档之间的，选重的那档，备注里写一句哪里拿不准。每个人各评各的，别人的评级会显示在旁边</div>
        </div>
      }
    >
      <QuestionCircleOutlined style={{ color: "#888", cursor: "help" }} />
    </Tooltip>
  );
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
    await putPhotoRating("skin", { folder, dog_folder: dog, grade, note: n || null });
    message.success({ content: grade ? `${dog}：${gradeMeta(grade).label}` : `${dog}：已撤销，算没评过`, key: "skin-rate", duration: 1 });
    onChanged();
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
      {mine && (
        <Tooltip title="还原成没评过（备注一起清掉），不算进跟踪表">
          <Button size="small" type="text" onClick={() => save(null, "")}>撤销</Button>
        </Tooltip>
      )}
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
