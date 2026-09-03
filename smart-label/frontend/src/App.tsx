import { Navigate, Route, Routes } from "react-router-dom";
import AppLayout from "@/components/AppLayout";
import Login from "@/pages/Login";
import Tasks from "@/pages/Tasks";
import Reviews from "@/pages/Reviews";
import Samples from "@/pages/Samples";
import Labels from "@/pages/Labels";
import Projects from "@/pages/Projects";
import Users from "@/pages/Users";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<AppLayout />}>
        <Route path="/projects" element={<Projects />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/reviews" element={<Reviews />} />
        <Route path="/samples" element={<Samples />} />
        <Route path="/label-definitions" element={<Labels />} />
        {/* 标签模板并到「标签管理」页里做成一个 Tab 了，旧链接跳过去 */}
        <Route path="/label-templates" element={<Navigate to="/label-definitions" replace />} />
        <Route path="/users" element={<Users />} />
        <Route path="/" element={<Navigate to="/tasks" replace />} />
      </Route>
    </Routes>
  );
}
