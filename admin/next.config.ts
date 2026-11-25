import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import { copyFile, cp, rm } from "node:fs/promises";
import path from "node:path";

async function prepareEditorAssets() {
  const pkg = path.join(__dirname, "node_modules/monaco-editor");
  const target = path.join(__dirname, "public/monaco");
  await rm(target, { recursive: true, force: true });
  await cp(path.join(pkg, "min/vs"), path.join(target, "vs"), { recursive: true });
  for (const file of ["LICENSE", "ThirdPartyNotices.txt"]) {
    await copyFile(path.join(pkg, file), path.join(target, file));
  }
}

const nextConfig: NextConfig = {
  output: 'export',
  basePath: '/admin',
  trailingSlash: true,
  compiler: { runAfterProductionCompile: prepareEditorAssets },
  turbopack: {
    root: path.resolve(__dirname, '..'),
  },
};

export default async function config(phase: string) {
  if (phase === PHASE_DEVELOPMENT_SERVER) await prepareEditorAssets();
  return nextConfig;
}
