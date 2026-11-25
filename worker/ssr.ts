import renderer from "../frontend/worker-renderer";
import { siteConfigContext } from "../shared/site-config-context";
import { publicSiteConfig } from "./settings";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    let config: ReturnType<typeof publicSiteConfig> | undefined;
    return siteConfigContext.run(
      () => config ??= publicSiteConfig(env),
      () => renderer.fetch(request, env, ctx),
    );
  },
};
