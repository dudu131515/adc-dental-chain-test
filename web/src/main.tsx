import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StaffApp } from "./StaffApp";
import "./shared/theme.css";

const root = document.getElementById("root");
if (!root) throw new Error("ADC 网站入口缺失。");

const app = createRoot(root);
if (import.meta.env.VITE_ADC_STATIC_PREVIEW === "1") {
  void import("../demo/PagesDemo").then(({ PagesDemo }) => {
    app.render(<StrictMode><PagesDemo /></StrictMode>);
  });
} else {
  app.render(<StrictMode><StaffApp /></StrictMode>);
}
