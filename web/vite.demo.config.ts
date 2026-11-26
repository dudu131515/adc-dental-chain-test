import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./demo", import.meta.url)),
  base: "./",
  define: {"import.meta.env.VITE_ADC_STATIC_PREVIEW": JSON.stringify("1")},
  plugins: [{
    name: "adc-static-preview-boundary",
    apply: "build",
    transformIndexHtml: () => [{tag:"meta",attrs:{"http-equiv":"Content-Security-Policy",content:"connect-src 'none'"},injectTo:"head-prepend"}],
  }],
  build: { outDir: "dist", emptyOutDir: true },
});
