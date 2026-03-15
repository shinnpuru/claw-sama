import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
import type { PluginRuntime } from "openclaw/plugin-sdk";

const { setRuntime: setClawSamaRuntime, getRuntime: getClawSamaRuntime } =
  createPluginRuntimeStore<PluginRuntime>(
    "Claw Sama runtime not initialized - plugin not registered",
  );

export { getClawSamaRuntime, setClawSamaRuntime };
