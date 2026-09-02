import { useEffect } from "react";
import { Select, Space, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { listProjects } from "@/api/projects";

interface Props {
  value: number | null;
  onChange: (id: number | null) => void;
  /** 是否允许"全部项目"（任务列表允许，新建任务这种必须选具体项目的不允许） */
  allowAll?: boolean;
}

// 任务/标签都按项目分，页面顶上统一用这个选项目。
// 第一次进来还没选的话，自动选中第一个启用的项目，省得看到空列表以为没数据。
export default function ProjectPicker({ value, onChange, allowAll }: Props) {
  const { data } = useQuery({ queryKey: ["projects"], queryFn: listProjects });

  useEffect(() => {
    if (!data?.length) return;
    // 记住的项目可能已经被删了，这种情况要退回到第一个可用项目
    if (value != null && data.some((p) => p.id === value)) return;
    if (value == null && allowAll) return;
    const first = data.find((p) => p.is_active) ?? data[0];
    if (first) onChange(first.id);
  }, [data, value, allowAll, onChange]);

  return (
    <Space>
      <Typography.Text type="secondary">项目：</Typography.Text>
      <Select
        style={{ minWidth: 220 }}
        value={value ?? undefined}
        onChange={(v) => onChange(v ?? null)}
        placeholder={allowAll ? "全部项目" : "选择项目"}
        allowClear={allowAll}
        options={data?.map((p) => ({
          value: p.id,
          label: p.is_active ? p.name : `${p.name}（已停用）`,
        }))}
        showSearch
        optionFilterProp="label"
      />
    </Space>
  );
}
