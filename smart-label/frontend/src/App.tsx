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
import Tooth from "@/pages/Tooth";
import Skin from "@/pages/Skin";
import Training from "@/pages/Training";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<AppLayout />}>
        <Route path="/projects" element={<Projects />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/reviews" element={<Reviews />} />
        <Route path="/samples" element={<Samples />} />
        <Route path="/dogs" element={<Dogs />} />
        <Route path="/label-definitions" element={<Labels />} />
        {/* 标签模板并到「标签管理」页里做成一个 Tab 了，旧链接跳过去 */}
        <Route path="/label-templates" element={<Navigate to="/label-definitions" replace />} />
        <Route path="/tooth" element={<Tooth />} />
        <Route path="/skin" element={<Skin />} />
        <Route path="/training" element={<Training />} />
        <Route path="/users" element={<Users />} />
        <Route path="/" element={<Navigate to="/tasks" replace />} />
      </Route>
    </Routes>
  );
}
