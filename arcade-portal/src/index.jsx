import React from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "./index.css";
import App from "./App";
import Home from "./home";
import ControllerPage from "./controller";
import {AppDataProvider} from './store'

import { BrowserRouter, Routes, Route } from "react-router-dom";
const app = (
  <AppDataProvider>
    <BrowserRouter>
      <Routes>
        <Route path="/game/:id" element={<App />} />
        <Route path="/controller" element={<ControllerPage />} />
        <Route path="/controller/:code" element={<ControllerPage />} />
        <Route path="/" element={<Home />} />
      </Routes>
    </BrowserRouter>
  </AppDataProvider>
);
createRoot(document.getElementById("root")).render(app);
