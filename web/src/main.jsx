import React from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import App from "./App.jsx";
import Home from "./pages/Home.jsx";
import Tasks from "./pages/Tasks.jsx";
import TaskChat from "./pages/TaskChat.jsx";
import Artifacts from "./pages/Artifacts.jsx";
import About from "./pages/About.jsx";
import "./style.css";

const router = createBrowserRouter(
  [
    {
      path: "/",
      element: <App />,
      children: [
        { index: true, element: <Home /> },
        { path: "about", element: <About /> },
        { path: "tasks", element: <Tasks /> },
        { path: "tasks/:taskId", element: <TaskChat /> },
        { path: "tasks/:taskId/c/:conversationId", element: <TaskChat /> },
        { path: "tasks/:taskId/artifacts", element: <Artifacts /> },
      ],
    },
  ],
  { basename: "/" }
);

createRoot(document.getElementById("root")).render(<RouterProvider router={router} />);
