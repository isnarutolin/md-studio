import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  // 5273 留给正式服务（scripts/serve.mjs），开发用 5274
  server: { port: 5274, open: true },
  build: { target: "es2022" },
});
