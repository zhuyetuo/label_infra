import { useQuery } from "@tanstack/react-query";
import { segReturnedSummary } from "@/api/segReview";
import { useAuthStore } from "@/stores/authStore";

/**
 * 退回给我、还没改好的片段有多少（标注员）。左侧菜单「退回的片段」和项目列表上的红色数字
 * 用它——审核员退回了几十条，不用再私聊一个个通知。一分钟刷一次，切回页面也刷。
 * 不是标注员返回空：审核员 / 管理员按可见范围算的是全部人的，不是「退给我的」
 */
export function useReturnedSegments() {
  const role = useAuthStore((s) => s.userInfo?.role);
  const token = useAuthStore((s) => s.accessToken);
  const { data } = useQuery({
    queryKey: ["seg-returned-summary"],
    queryFn: segReturnedSummary,
    enabled: !!token && role === "annotator",
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  return { total: data?.total ?? 0, byProject: data?.by_project ?? {} };
}
