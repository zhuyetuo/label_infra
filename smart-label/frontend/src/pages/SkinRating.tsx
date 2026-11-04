import { Space, Typography } from "antd";
import PhotoGallery from "@/components/PhotoGallery";
import { SkinGradeHelp } from "@/components/SkinRatingBar";

/**
 * 皮肤评级：兽医 / 实习生看问诊照片，给每只狗那一次评 S0 / S1 / S2 / 看不清。
 * 跟「皮肤评估 → 皮肤照片」是同一个相册，这里单独一个入口给非管理员用（皮肤评估页只给管理员）。
 */
export default function SkinRating() {
  return (
    <div>
      <Space style={{ marginBottom: 12 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>皮肤评级</Typography.Title>
        <SkinGradeHelp />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          看完一只狗的全部照片，在它标题栏右边点一档；点已选的那档撤销。各评各的，别人的评级显示在旁边
        </Typography.Text>
      </Space>
      <PhotoGallery album="skin" rating hint="皮肤瘙痒问诊照片，来自素材库 NAS" />
    </div>
  );
}
