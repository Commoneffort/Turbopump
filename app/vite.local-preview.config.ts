// Serves the built page locally with the live site's API behind it (for checks before a publish).
import { defineConfig } from "vite";
export default defineConfig({ preview: { port: 4731, strictPort: true, proxy: { "/api": { target: "https://turbopumpx.vercel.app", changeOrigin: true } } } });
