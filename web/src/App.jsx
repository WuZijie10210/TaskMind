import { Outlet } from "react-router-dom";
import Sidebar from "./components/Sidebar.jsx";

export default function App() {
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
