import { Button, Empty, Popconfirm, Space, Table, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { deleteMeasurement, listMeasurements, type DogMeasurement } from "@/api/dogs";

/**
 * 一只狗的体重/颈围记录。
 *
 * 为什么不做成档案上的一个字段：体重会变，而「什么时候几公斤」本身就是要看的
 * ——掉秤、长胖都跟皮肤状况有关系。一个字段只能存"现在多少"，改一次旧的就没了。
 * 所以按次记录，档案列表显示最新一条，这里能看全部变化。
 *
 * 颈围（项圈松紧、会不会磨到皮肤）同理，没量就留空，不强制。
 *
 * 这里只看和删。「记一笔」的表单撤了——档案列表里那两格现在点一下就能直接填，
 * 填进去就是记一条今天的，同一件事没必要有两个入口。代价是补录以前某一天的
 * 数据没地方填了；真要补，先在列表里填上今天的，再回来把日期改掉的路子也没有，
 * 等真碰上再说，比留着一整块重复的表单划算。
 */
export default function DogMeasurements({ dogId }: { dogId: number }) {
  const { data, refetch, isLoading } = useQuery({
    queryKey: ["dog-measurements", dogId],
    queryFn: () => listMeasurements(dogId),
  });

  const rows = data ?? [];
  return (
    <div>
      {rows.length === 0 && !isLoading ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有记录（在上面表格的体重/颈围格子里直接填）" />
      ) : (
        <Table<DogMeasurement>
          size="small"
          rowKey="id"
          loading={isLoading}
          dataSource={rows}
          pagination={false}
          scroll={{ y: 240 }}
          columns={[
            { title: "日期", dataIndex: "measured_on", width: 120 },
            {
              title: "体重",
              width: 110,
              // 跟上一条比一比：掉秤/长胖比绝对值更值得注意
              render: (_, r, i) => {
                if (r.weight_kg == null) return <Typography.Text type="secondary">—</Typography.Text>;
                const prev = rows.slice(i + 1).find((x) => x.weight_kg != null)?.weight_kg;
                const d = prev != null ? r.weight_kg - prev : null;
                return (
                  <Space size={4}>
                    <span>{r.weight_kg} kg</span>
                    {d != null && Math.abs(d) >= 0.05 && (
                      <Typography.Text type={d > 0 ? "warning" : "danger"} style={{ fontSize: 12 }}>
                        {d > 0 ? "+" : ""}
                        {d.toFixed(1)}
                      </Typography.Text>
                    )}
                  </Space>
                );
              },
            },
            {
              title: "颈围",
              width: 90,
              render: (_, r) => (r.neck_cm == null ? <Typography.Text type="secondary">—</Typography.Text> : `${r.neck_cm} cm`),
            },
            { title: "备注", render: (_, r) => r.note || "-" },
            {
              title: "",
              width: 60,
              render: (_, r) => (
                <Popconfirm
                  title="删掉这条记录？"
                  onConfirm={async () => {
                    await deleteMeasurement(dogId, r.id);
                    refetch();
                  }}
                >
                  <Button size="small" type="link" danger>
                    删除
                  </Button>
                </Popconfirm>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}
