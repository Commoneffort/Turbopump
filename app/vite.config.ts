import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [react(), nodePolyfills({ include: ["buffer", "crypto", "stream", "util"] })],
  build: {
    rollupOptions: {
      output: {
        // The libraries change rarely and the page often: in files of their own a visitor who
        // has been here before downloads only the page's part after a new version.
        // (One file for all of them: split further, two of the files needed each other to start.)
        manualChunks: id => (id.includes("node_modules") ? "vendor" : undefined),
      },
    },
  },
});
