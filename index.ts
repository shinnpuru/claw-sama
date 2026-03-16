import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { createClawSamaPlugin, buildClawSamaSystemPrompt } from "./src/channel.js";
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
