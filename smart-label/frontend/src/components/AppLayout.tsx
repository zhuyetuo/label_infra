import { getLabelFocus, getLabelReview } from "@/api/tasks";
import { SkinStandardDrawer, useStandardInset } from "@/components/SkinStandard";
import { useEffect } from "react";
import { Badge, Layout, Menu, Space, Tag, Tooltip, Typography } from "antd";
import { useThemeStore } from "@/stores/themeStore";
import { useQuery } from "@tanstack/react-query";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { getMe } from "@/api/auth";
import { hasFeature, useAuthStore } from "@/stores/authStore";
import { RoleTag } from "@/utils/taskStatus";
import { useReturnedSegments } from "@/hooks/useReturnedSegments";

const { Header, Content, Sider } = Layout;

/** 3736 → 3.7k：菜单栏窄，四位数放不下 */
const kfmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

const ALL_ITEMS = [
  { key: "/projects", label: "项目", roles: ["super_admin", "admin", "annotator", "reviewer"] },
  { key: "/tasks", label: "任务", roles: ["super_admin", "admin", "annotator", "reviewer"] },
  { key: "/reviews", label: "审核", roles: ["super_admin", "admin", "reviewer"] },
  // 片段审核在「审核」页里（第二个标签页）；标注员进不了审核页，单独给一个入口看退回给自己的片段
  { key: "/segment-review", label: "退回的片段", roles: ["annotator"] },
  // 样本和机位核对都是「这批数据长什么样」的管理操作，收在一个菜单下
  {
    key: "samples", label: "样本", roles: ["super_admin", "admin"],
    children: [
      { key: "/samples", label: "样本列表" },
      // 摄像头重插后文件名里的机位号可能对不上房间；看画面人工纠正这一场的对照
      { key: "/cam-check", label: "机位核对" },
    ],
  },
  // feature：不是这几个角色的账号，单独开了这项功能也能看到（账号管理里勾）
  { key: "/dogs", label: "狗档案", roles: ["super_admin", "admin"], feature: "dogs_view" },
  // 两个标签页：牙齿检测（要「牙齿识别」权限）+ 口腔实例分割（原「视觉标注」，标注员 / 审核员也能进）
  { key: "/tooth", label: "牙齿识别", roles: ["super_admin", "admin", "annotator", "reviewer"], feature: "tooth" },
  // 非管理员（兽医 / 实习生）进来只看到「皮肤照片」评级那一块
  { key: "/skin", label: "皮肤评估", roles: ["super_admin", "admin", "annotator", "reviewer"] },
  { key: "/daily-stats", label: "日常统计", roles: ["super_admin", "admin"] },
  { key: "/annotator-stats", label: "标注统计", roles: ["super_admin", "admin"] },
  { key: "/workforce", label: "人力管理", roles: ["super_admin", "admin"] },
  { key: "/training", label: "模型训练", roles: ["super_admin", "admin"] },
  // 测试集（不进训练）、配额表、模型见没见过、打分、多批交叉对比
  { key: "/model-test", label: "模型测试", roles: ["super_admin", "admin"] },
  // 宠物可穿戴的来时路、竞品拆解、我们抓挠识别的位置（静态内容）
  { key: "/label-definitions", label: "标签管理", roles: ["super_admin", "admin"] },
  { key: "/llm-providers", label: "模型服务", roles: ["super_admin", "admin"] },
  { key: "/users", label: "账号管理", roles: ["super_admin", "admin"] },
  // 用这台电脑的蓝牙直接连 IMU（自制项圈 / WitMotion）看波形、采样率、行为
  { key: "/device-debug", label: "设备调试", roles: ["super_admin", "admin"] },
  { key: "/system", label: "系统监控", roles: ["super_admin", "admin"] },
] as {
  key: string;
  label: string;
  roles: string[];
  feature?: string;
  children?: { key: string; label: string }[];
}[];

/** 右上角：明亮 / 暗黑 切换，记在本机 */
function ThemeSwitch() {
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);
  const dark = mode === "dark";
  return (
    <Tooltip title={dark ? "切换到明亮模式" : "切换到暗黑模式"}>
      <a style={{ color: "#fff", fontSize: 16, padding: "0 4px" }} onClick={() => setMode(dark ? "light" : "dark")}>
        {dark ? "☀" : "🌙"}
      </a>
    </Tooltip>
  );
}

export default function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { accessToken, userInfo, clearAuth, setUserInfo } = useAuthStore();

  // 账号信息登录时取一次就存下了；管理员后来给开了功能，不重新拿的话菜单不会变，
  // 人只能退出重登才看得到。切回这个页面时顺手刷一下
  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: getMe,
    enabled: !!accessToken,
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    if (me) setUserInfo(me);
  }, [me, setUserInfo]);

  const returned = useReturnedSegments();
  const standardInset = useStandardInset();
  // 左边「项目」上标抓挠还有多少没通过 / 没审（管理员、审核员看）
  const reviewer = userInfo?.role === "admin" || userInfo?.role === "super_admin" || userInfo?.role === "reviewer";
  // 我现在重点补什么（每人一个，项目页顶部切，只影响自己）：角标按它统计。默认抓挠
  const { data: focus } = useQuery({
    queryKey: ["label-focus"], queryFn: getLabelFocus,
    enabled: !!accessToken, refetchInterval: 60_000, staleTime: 30_000,
  });
  const focusLabels = (focus?.labels ?? ["抓挠"]).join(",");
  // 负例显示成「负例·舔」：一眼知道现在补的是负例、是哪一类
  const focusName = focus?.title ?? focus?.name ?? "抓挠";
  const { data: scratch } = useQuery({
    queryKey: ["label-review", focusLabels], queryFn: () => getLabelReview(focusLabels),
    enabled: !!accessToken && reviewer, refetchInterval: 60_000, staleTime: 20_000,
  });
  const scratchNotPassed = scratch ? scratch.total.n - scratch.total.approved : 0;
  // 这一类待判的疑似片段：负例大多还停在「疑似」，不数它的话角标看着像没活干
  const candPending = scratch?.cand_total ?? 0;

  if (!accessToken) return <Navigate to="/login" replace />;

  const items = ALL_ITEMS.filter(
    (i) => !userInfo || i.roles.includes(userInfo.role) || (i.feature && hasFeature(userInfo, i.feature)),
  );

  return (
    <Layout style={{ height: "100vh" }}>
      <Header style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Typography.Text strong style={{ color: "#fff", fontSize: 18 }}>
          smart-label
        </Typography.Text>
        <Space>
          <ThemeSwitch />
          {userInfo && <RoleTag role={userInfo.readOnly ? "viewer" : userInfo.role} />}
          <Typography.Text style={{ color: "#fff" }}>{userInfo?.display_name}</Typography.Text>
          <a
            style={{ color: "#fff" }}
            onClick={() => {
              clearAuth();
              navigate("/login");
            }}
          >
            退出
          </a>
        </Space>
      </Header>
      <Layout>
        <Sider width={180}>
          <Menu
            mode="inline"
            // 菜单项多时（视口矮）在侧边栏内部滚。不加的话菜单比视口高出的部分
            // 会撑出 #root 的隐形溢出，页面上任何 scrollIntoView 都会把整个布局顶上去
            style={{ height: "100%", overflowY: "auto" }}
            selectedKeys={[location.pathname]}
            // 默认收起来（点「样本」再展开）；人正停在这两个子页面里刷新时保持展开，
            // 不然当前高亮项藏在收起的菜单里，看不出来自己在哪
            defaultOpenKeys={["/samples", "/cam-check"].includes(location.pathname) ? ["samples"] : []}
            onClick={(e) => navigate(e.key)}
            items={items.map((i) => ({
              key: i.key,
              ...(i.children ? { children: i.children } : {}),
              // 退回给我的片段：红色数字，有多少条没改好
              label:
                i.key === "/projects" && scratch && (scratchNotPassed > 0 || candPending > 0) ? (
                  <Tooltip placement="right"
                    title={`重点：${focusName}｜红 片段未通过 ${scratchNotPassed}｜紫 疑似待判 ${candPending}`}>
                    {/* 菜单栏窄：数字超过 999 写成 3.7k，「项目」后面只放两个小数字，鼠标停上去看完整 */}
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, whiteSpace: "nowrap" }}>
                      {i.label}
                      {/* 菜单栏只有 180 宽：负例写成「负·饮水」，只放一个数——有待判的疑似片段（紫）就放它，
                          否则放片段未通过（红）。两个数、还没审几段都在悬停里 */}
                      <span style={{ fontSize: 10, color: "#ff4d4f", marginLeft: 2 }}>
                        {focus?.neg ? `负·${focus.name}` : focusName}
                      </span>
                      {/* 红 = 片段未通过，紫 = 待判的疑似片段；两个都放，内边距收窄才挤得下 */}
                      {scratchNotPassed > 0 && (
                        <span style={{ fontSize: 10, lineHeight: "15px", padding: "0 4px", borderRadius: 8, background: "#ff4d4f", color: "#fff" }}>{kfmt(scratchNotPassed)}</span>
                      )}
                      {candPending > 0 && (
                        <span style={{ fontSize: 10, lineHeight: "15px", padding: "0 4px", borderRadius: 8, background: "#722ed1", color: "#fff" }}>{kfmt(candPending)}</span>
                      )}
                    </span>
                  </Tooltip>
                ) : i.key === "/segment-review" && returned.total > 0 ? (
                  <Space size={6}>
                    {i.label}
                    <Badge count={returned.total} overflowCount={999} size="small" />
                  </Space>
                ) : (
                  i.label
                ),
            }))}
          />
        </Sider>
        {/* 评级标准在右边开着时，整个页面往左让，不被盖住 */}
        <Content style={{ padding: 24, overflow: "auto", marginRight: standardInset }}>
          <Outlet />
        </Content>
        <SkinStandardDrawer />
      </Layout>
    </Layout>
  );
}
