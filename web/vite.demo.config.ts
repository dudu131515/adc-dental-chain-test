import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  define: {"import.meta.env.VITE_ADC_STATIC_PREVIEW": JSON.stringify("1")},
  plugins: [{
    name: "adc-static-preview-boundary",
    apply: "build",
    transformIndexHtml: () => [{tag:"meta",attrs:{"http-equiv":"Content-Security-Policy",content:"connect-src 'none'"},injectTo:"head-prepend"}],
  }],
  build: { outDir: "demo/dist", emptyOutDir: true },
});
