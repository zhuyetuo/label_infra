import { useMemo, useState } from "react";
import { Button, Dropdown, Empty, Modal, Select, Space, Tag, Tooltip, Typography, message } from "antd";
import { FlagFilled, FlagOutlined } from "@ant-design/icons";
import { putPhotoFlag, type Album, type FlagReason, type PhotoFlag } from "@/api/material";

/**
 * 单张照片的拍摄问题：在缩略图 / 放大图上标「模糊 / 太暗 / 没拍到皮肤…」，
 * 再按日期汇总成一段话，直接发给狗场老板：哪天哪只狗第几张怎么不行、下次拍注意什么。
 */

export const FLAG_REASONS: { value: FlagReason; short: string; tip: string }[] = [
  { value: "blurry", short: "模糊", tip: "对好焦再拍，手别抖；离皮肤 20–30cm" },
  { value: "dark", short: "太暗 / 过曝", tip: "在亮处或开灯拍，别逆光，别开闪光灯怼着拍" },
  { value: "no_skin", short: "没拍到皮肤", tip: "拨开毛露出皮肤再拍，耳后、腋下、肚子、爪缝都要单独拍" },
  { value: "blocked", short: "被挡住", tip: "手、项圈、东西别挡住要拍的地方" },
  { value: "far", short: "太远", tip: "拍整只狗一张就够，其余每个部位近拍，要能看清皮肤纹理" },
  { value: "other", short: "其他", tip: "" },
];
const reasonMeta = (r: string) => FLAG_REASONS.find((x) => x.value === r);

export const flagKey = (folder: string, dog: string, filename: string) => `${folder}\u0000${dog}\u0000${filename}`;

/** 「第 4 张」：文件名里带 (4) 的取这个数，没有就用文件名 */
export const photoNo = (filename: string) => {
  const m = filename.match(/\((\d+)\)\.[a-z]+$/i);
  return m ? `第 ${m[1]} 张` : filename;
};

/** 标记按钮：一个小旗，点开选原因；已标的显示红旗，可改可取消 */
export function FlagButton({ album, folder, dog, filename, flag, onChanged, size = "small" }: {
  album: Album; folder: string; dog: string; filename: string; flag?: PhotoFlag; onChanged: () => void; size?: "small" | "middle";
}) {
  const save = async (reason: FlagReason | null) => {
    await putPhotoFlag(album, { folder, dog_folder: dog, filename, reason });
    message.success({ content: reason ? `${photoNo(filename)}：标为「${reasonMeta(reason)?.short}」` : `${photoNo(filename)}：已取消标记`, key: "flag", duration: 1 });
    onChanged();
  };
  return (
    <Dropdown trigger={["click"]} menu={{
      items: [
        ...FLAG_REASONS.map((r) => ({ key: r.value, label: <span>{flag?.reason === r.value ? "✓ " : ""}{r.short}</span> })),
        ...(flag ? [{ type: "divider" as const }, { key: "__clear", label: <span style={{ color: "#999" }}>取消标记（拍得没问题）</span> }] : []),
      ],
      onClick: ({ key, domEvent }) => { domEvent.stopPropagation(); save(key === "__clear" ? null : (key as FlagReason)); },
    }}>
      <Tooltip title={flag ? `拍摄问题：${flag.reason_text}（${flag.user_name}）。点开改 / 取消` : "这张拍得不合格？点一下标出来（汇总给狗场）"}>
        <Button size={size} type={flag ? "primary" : "default"} danger={!!flag} onClick={(e) => e.stopPropagation()}
          icon={flag ? <FlagFilled /> : <FlagOutlined />}>{flag ? reasonMeta(flag.reason)?.short : undefined}</Button>
      </Tooltip>
    </Dropdown>
  );
}

/** 汇总：按日期目录挑，生成一段发给狗场的话（第几张什么问题 + 下次怎么拍） */
export function FlagSummary({ flags, urlOf }: { flags: PhotoFlag[]; urlOf: (f: PhotoFlag) => string | undefined }) {
  const folders = useMemo(() => [...new Set(flags.map((f) => f.folder))].sort().reverse(), [flags]);
  const [folder, setFolder] = useState<string | undefined>(folders[0]);
  const cur = flags.filter((f) => !folder || f.folder === folder);
  const byDog = useMemo(() => {
    const m = new Map<string, PhotoFlag[]>();
    for (const f of cur) m.set(f.dog_folder, [...(m.get(f.dog_folder) ?? []), f]);
    const num = (f: PhotoFlag) => Number(f.filename.match(/\((\d+)\)\.[a-z]+$/i)?.[1] ?? 1e9);
    return [...m].map(([d, fs]) => [d, fs.sort((x, y) => num(x) - num(y) || x.filename.localeCompare(y.filename))] as [string, PhotoFlag[]]);
  }, [cur]);
  const text = useMemo(() => {
    if (!cur.length) return "";
    const day = (folder ?? "").split("/").pop() ?? "";
    const lines = [`【皮肤照片拍摄反馈】${day}`, `这次有 ${cur.length} 张照片看不清皮肤情况，具体是：`];
    for (const [dog, fs] of byDog) {
      lines.push(`· ${dog}：${fs.map((f) => `${photoNo(f.filename)}${reasonMeta(f.reason)?.short ?? f.reason_text}${f.note ? `（${f.note}）` : ""}`).join("；")}`);
    }
    const used = [...new Set(cur.map((f) => f.reason))].map(reasonMeta).filter((r) => r && r.tip);
    if (used.length) {
      lines.push("", "下次拍的时候注意：");
      used.forEach((r, i) => lines.push(`${i + 1}. ${r!.short}：${r!.tip}`));
    }
    return lines.join("\n");
  }, [cur, byDog, folder]);
  if (!flags.length) return <Empty description="还没有标记过拍摄问题。在照片上点小旗标出来" />;
  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <span>哪一天：</span>
        <Select style={{ width: 360 }} value={folder} onChange={setFolder}
          options={folders.map((f) => ({ value: f, label: `${f}（${flags.filter((x) => x.folder === f).length} 张）` }))} />
      </Space>
      {byDog.map(([dog, fs]) => (
        <div key={dog} style={{ marginBottom: 12 }}>
          <b>{dog}</b> <Typography.Text type="secondary">{fs.length} 张</Typography.Text>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
            {fs.map((f) => (
              <div key={f.filename} style={{ width: 120 }}>
                <div style={{ width: 120, height: 90, borderRadius: 4, overflow: "hidden", border: "2px solid #ff4d4f", background: "var(--sl-fill2)" }}>
                  {urlOf(f) && <img src={urlOf(f)} alt={f.filename} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                </div>
                <div style={{ fontSize: 12 }}>{photoNo(f.filename)} <Tag color="red" style={{ marginRight: 0 }}>{reasonMeta(f.reason)?.short}</Tag></div>
              </div>
            ))}
          </div>
        </div>
      ))}
      <Typography.Title level={5} style={{ marginTop: 16 }}>发给狗场的话</Typography.Title>
      <Typography.Paragraph copyable={{ text, tooltips: ["复制，直接粘贴到微信", "已复制"] }}
        style={{ whiteSpace: "pre-wrap", background: "var(--sl-fill2)", padding: 12, borderRadius: 6, fontSize: 13 }}>
        {text}
      </Typography.Paragraph>
    </div>
  );
}

/** 打开汇总的按钮 + 弹窗 */
export function FlagSummaryButton({ flags, urlOf }: { flags: PhotoFlag[]; urlOf: (f: PhotoFlag) => string | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="small" danger={flags.length > 0} icon={<FlagOutlined />} onClick={() => setOpen(true)}>
        拍摄问题 {flags.length} 张 · 汇总给狗场
      </Button>
      <Modal open={open} onCancel={() => setOpen(false)} footer={null} width={900} title="拍摄问题汇总（发给狗场）" destroyOnClose>
        <FlagSummary flags={flags} urlOf={urlOf} />
      </Modal>
    </>
  );
}
