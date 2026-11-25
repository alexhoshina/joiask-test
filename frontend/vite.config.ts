import { cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";

const app = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(app, "..");

export default defineConfig({
  root: app,
  build: { outDir: path.join(root, "dist"), emptyOutDir: true },
  resolve: {
    alias: {
      "@": path.join(app, "src"),
      "@joiask/content-markup": path.join(root, "shared/content-markup.ts"),
      "@joiask/default-custom-css": path.join(root, "shared/default-custom-css.ts"),
      "@joiask/custom-css-presets": path.join(root, "shared/custom-css-presets.ts"),
    },
  },
  plugins: [
    {
      name: "joiask-static-sites",
      apply: "build",
      applyToEnvironment: (environment) => environment.name === "client",
      async writeBundle() {
        for (const site of ["admin", "docs"]) {
          await cp(path.join(root, site, "out"), path.join(root, "dist/client", site), { recursive: true });
        }
      },
    },
    vinext({
      clientOutDir: path.join(root, "dist/client"),
      rscOutDir: path.join(root, "dist/server"),
      ssrOutDir: path.join(root, "dist/server/ssr"),
    }),
    cloudflare({
      configPath: path.join(root, "wrangler.jsonc"),
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
  ],
});
