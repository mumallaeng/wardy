import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const tlsCertificate = String(process.env.WARDY_UI_TLS_CERTIFICATE ?? "").trim();
const tlsPrivateKey = String(process.env.WARDY_UI_TLS_PRIVATE_KEY ?? "").trim();

export default defineConfig({
  define: {
    __WARDY_BUILD_ID__: JSON.stringify(String(Date.now())),
  },
  build: {
    rollupOptions: {
      input: {
        app: fileURLToPath(new URL("./apps/index.html", import.meta.url)),
        "service-worker": fileURLToPath(new URL("./apps/js/service-worker.ts", import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) => chunk.name === "service-worker"
          ? "service-worker.js"
          : "assets/[name]-[hash].js",
      },
    },
  },
  server: tlsCertificate && tlsPrivateKey
    ? {
        https: {
          cert: readFileSync(tlsCertificate),
          key: readFileSync(tlsPrivateKey),
        },
      }
    : undefined,
});
