import { Navigate, Route, Routes } from "react-router-dom";
import AppLayout from "@/components/AppLayout";
import Login from "@/pages/Login";
import Tasks from "@/pages/Tasks";
import Reviews from "@/pages/Reviews";
import Samples from "@/pages/Samples";
import Labels from "@/pages/Labels";
import Users from "@/pages/Users";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<AppLayout />}>
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/reviews" element={<Reviews />} />
        <Route path="/samples" element={<Samples />} />
        <Route path="/label-definitions" element={<Labels />} />
        <Route path="/users" element={<Users />} />
        <Route path="/" element={<Navigate to="/tasks" replace />} />
      </Route>
    </Routes>
  );
}
