import type { ReactNode } from "react";
import { Descriptions, Popover, Tag, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { listDogs, type Dog } from "@/api/dogs";
import { hasFeature, useAuthStore } from "@/stores/authStore";

const SKIN_COLOR: Record<string, string> = { 正常: "green", 轻度: "gold", 中度: "orange", 重度: "red" };

/** 按名字找狗：名字、别名、编号任一对上就算 */
export function findDog(dogs: Dog[] | undefined, name: string): Dog | undefined {
  if (!dogs || !name) return undefined;
  const hit = findOne(dogs, name);
  // 皮肤评估那边的名字是「品种-名字」，对不上再拿最后一段试
  return hit ?? (name.includes("-") ? findOne(dogs, name.split("-").slice(-1)[0]) : undefined);
}

function findOne(dogs: Dog[], name: string): Dog | undefined {
  const n = name.trim().toLowerCase();
  return (
    dogs.find((d) => (d.name ?? "").trim().toLowerCase() === n) ??
    dogs.find((d) => (d.aliases ?? "").split(/[,，、\s]+/).some((a) => a && a.toLowerCase() === n)) ??
    dogs.find((d) => d.dog_code.toLowerCase() === n)
  );
}

function DogCard({ dog }: { dog: Dog }) {
  const skin = (v: string | null) => (v ? <Tag color={SKIN_COLOR[v]}>{v}</Tag> : <Typography.Text type="secondary">未填</Typography.Text>);
  return (
    <div style={{ width: 340 }}>
      {/* 最要紧的放最上面：这只狗是带着什么皮肤问题进来的 */}
      <div style={{ marginBottom: 8 }}>
        <Typography.Text strong>入档时皮肤：</Typography.Text>
        {skin(dog.intake_skin_level)}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>（{dog.created_at.slice(0, 10)} 入档）</Typography.Text>
        <div style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>
          {dog.intake_skin_note || <Typography.Text type="secondary">没写说明，去「狗档案」补</Typography.Text>}
        </div>
      </div>
      <Descriptions size="small" column={2} colon={false} labelStyle={{ color: "#999" }}>
        <Descriptions.Item label="现在皮肤">{skin(dog.skin_level)}</Descriptions.Item>
        <Descriptions.Item label="编号">{dog.dog_code}</Descriptions.Item>
        <Descriptions.Item label="品种">{dog.breed || "—"}</Descriptions.Item>
        <Descriptions.Item label="体型">{dog.size ? `${dog.size}型` : "—"}</Descriptions.Item>
        <Descriptions.Item label="年龄">{dog.age_text || "—"}</Descriptions.Item>
        <Descriptions.Item label="机位">{dog.imu || "—"}</Descriptions.Item>
        <Descriptions.Item label="体重">{dog.latest_weight_kg != null ? `${dog.latest_weight_kg} kg` : "—"}</Descriptions.Item>
        <Descriptions.Item label="颈围">{dog.latest_neck_cm != null ? `${dog.latest_neck_cm} cm` : "—"}</Descriptions.Item>
        <Descriptions.Item label="场所" span={2}>{dog.site || "—"}</Descriptions.Item>
        {dog.remark && <Descriptions.Item label="备注" span={2}>{dog.remark}</Descriptions.Item>}
      </Descriptions>
    </div>
  );
}

/** 鼠标放到狗名上弹出档案（入档时皮肤情况放最上面）。没有狗档案权限、或找不到这只狗时就是原样的名字 */
export default function DogInfoPopover({ name, children }: { name: string; children?: ReactNode }) {
  const user = useAuthStore((s) => s.userInfo);
  const can = hasFeature(user, "dogs_view");
  const { data: dogs } = useQuery({ queryKey: ["dogs"], queryFn: listDogs, enabled: can, staleTime: 5 * 60_000 });
  const label = children ?? name;
  // 两个项圈合成的行、或者名字里带别的后缀，找不到就不弹
  const dog = can ? findDog(dogs, name) : undefined;
  if (!dog) return <>{label}</>;
  return (
    <Popover title={dog.name || dog.dog_code} content={<DogCard dog={dog} />} mouseEnterDelay={0.25}>
      <span style={{ cursor: "help", borderBottom: "1px dashed rgba(128,128,128,0.6)" }}>{label}</span>
    </Popover>
  );
}
