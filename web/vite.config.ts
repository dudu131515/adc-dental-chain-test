import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api/v1": {
        target: process.env.ADC_DEV_API_ORIGIN ?? "http://127.0.0.1:8000",
        changeOrigin: false,
      },
    },
  },
});
