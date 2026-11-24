import { Navigate, Route, Routes } from "react-router-dom";
import AppLayout from "@/components/AppLayout";
import Login from "@/pages/Login";
import Tasks from "@/pages/Tasks";
import Reviews from "@/pages/Reviews";
import Samples from "@/pages/Samples";
import Dogs from "@/pages/Dogs";
import Labels from "@/pages/Labels";
import Projects from "@/pages/Projects";
import Users from "@/pages/Users";
import LlmProviders from "@/pages/LlmProviders";
import System from "@/pages/System";
import Tooth from "@/pages/Tooth";
import DailyStats from "@/pages/DailyStats";
import AnnotatorStats from "@/pages/AnnotatorStats";
import Workforce from "@/pages/Workforce";
import Skin from "@/pages/Skin";
import Vision from "@/pages/Vision";
import DeviceDebug from "@/pages/DeviceDebug";
import CamCheck from "@/pages/CamCheck";
import Training from "@/pages/Training";
import ModelTest from "@/pages/ModelTest";
import { SegmentReviewEntry } from "@/pages/SegmentReview";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<AppLayout />}>
        <Route path="/projects" element={<Projects />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/reviews" element={<Reviews />} />
        <Route path="/segment-review" element={<SegmentReviewEntry />} />
        <Route path="/samples" element={<Samples />} />
        <Route path="/dogs" element={<Dogs />} />
        <Route path="/label-definitions" element={<Labels />} />
        {/* 标签模板并到「标签管理」页里做成一个 Tab 了，旧链接跳过去 */}
        <Route path="/label-templates" element={<Navigate to="/label-definitions" replace />} />
        <Route path="/tooth" element={<Tooth />} />
        <Route path="/skin" element={<Skin />} />
        <Route path="/skin-rating" element={<Navigate to="/skin" replace />} />
        <Route path="/daily-stats" element={<DailyStats />} />
        <Route path="/annotator-stats" element={<AnnotatorStats />} />
        <Route path="/workforce" element={<Workforce />} />
        {/* 视觉标注挪进了「牙齿识别 → 口腔实例分割」；这个地址留着（带口腔 / 皮肤切换），菜单里不再列 */}
        <Route path="/vision" element={<Vision />} />
        <Route path="/cam-check" element={<CamCheck />} />
        <Route path="/device-debug" element={<DeviceDebug />} />
        <Route path="/training" element={<Training />} />
        <Route path="/model-test" element={<ModelTest />} />
        {/* 行业调研挪到了 GitHub Pages（市场与竞品）：老链接直接跳过去 */}
        <Route path="/research" element={<GoExternal to="https://zhuyetuo.github.io/imu_train/market.html" />} />
        <Route path="/users" element={<Users />} />
        <Route path="/llm-providers" element={<LlmProviders />} />
        <Route path="/system" element={<System />} />
        <Route path="/" element={<Navigate to="/tasks" replace />} />
      </Route>
    </Routes>
  );
}

function GoExternal({ to }: { to: string }) {
  window.location.replace(to);
  return null;
}
