import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PagesDemo } from "./PagesDemo";
import "../src/shared/theme.css";
import "./pages-demo.css";

const root = document.getElementById("root");
if (!root) throw new Error("ADC 演示入口缺失。");
createRoot(root).render(<StrictMode><PagesDemo/></StrictMode>);
