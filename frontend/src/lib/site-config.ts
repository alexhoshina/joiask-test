import { cache } from "react";
import { DEFAULT_CUSTOM_CSS } from "@joiask/default-custom-css";
import { siteConfigContext, type PublicSiteConfig } from "../../../shared/site-config-context";

export const getSiteConfig = cache(async (): Promise<PublicSiteConfig> => {
  const load = siteConfigContext.getStore();
  if (!load) throw new Error("Site configuration requires a Worker request");
  const site = await load();
  return {
    ...site,
    site_name: site.site_name || "JoiAsk 提问箱",
    site_description: site.site_description || "JoiAsk 提问箱",
    logo_url: site.logo_url || "/favicon.png",
    favicon_url: site.favicon_url || "/favicon.png",
    custom_css: site.custom_css || DEFAULT_CUSTOM_CSS,
  };
});
