import { AsyncLocalStorage } from "node:async_hooks";

export interface PublicSiteConfig {
  site_name: string;
  site_description: string;
  logo_url: string;
  favicon_url: string;
  custom_css: string;
  email_enabled: boolean;
}

// The RSC renderer and the Worker share this request-local configuration loader.
export const siteConfigContext = new AsyncLocalStorage<() => Promise<PublicSiteConfig>>();
