import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// ⚠️ GitHubリポジトリ名が "keiba-app" 以外の場合は、
// 下の base を "/リポジトリ名/" に書き換えてください。
export default defineConfig({
  plugins: [react()],
  base: "/keiba-app/",
});
