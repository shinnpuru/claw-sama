import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { createClawSamaPlugin, buildClawSamaSystemPrompt, routeHandlers, CLAW_SAMA_ROUTES } from "./src/channel.js";
import { setClawSamaRuntime } from "./src/runtime.js";
import { launchTauri, stopTauri } from "./src/tauri-launcher.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const _extDir = typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(_extDir, "app");

const plugin = {
  id: "claw-sama",
  name: "Claw Sama",
  description: "Display agent messages on a VRM avatar with emotion expressions",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    setClawSamaRuntime(api.runtime);
    api.registerChannel({ plugin: createClawSamaPlugin() });

    // Register all HTTP routes via api.registerHttpRoute (writes to gateway-visible registry).
    // Each route proxies to the handler populated by startAccount in channel.ts.
    for (const spec of CLAW_SAMA_ROUTES) {
      api.registerHttpRoute({
        path: spec.path,
        auth: "plugin",
        match: spec.match,
        handler: (req, res) => {
          // Find the matching handler from routeHandlers map
          let handler = routeHandlers.get(spec.path);
          if (!handler && spec.match === "prefix") {
            // For prefix routes, the key is the base path
            handler = routeHandlers.get(spec.path);
          }
          if (handler) {
            return handler(req, res);
          }
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "channel not started" }));
        },
      });
    }

    // Inject system prompt for VRM avatar awareness
    api.on("before_prompt_build", () => {
      return { appendSystemContext: buildClawSamaSystemPrompt() };
    });

    // Launch Tauri desktop app when gateway starts
    api.on("gateway_start", () => {
      launchTauri(appDir, {
        info: (msg) => api.logger.info(msg),
        warn: (msg) => api.logger.warn(msg),
      });
    });

    api.on("gateway_stop", () => {
      stopTauri({ info: (msg) => api.logger.info(msg) });
    });

    api.logger.info("Claw Sama plugin registered (channel mode)");
  },
};

export default plugin;
