import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerUnblockMemory } from "./src/plugin.js";
export default definePluginEntry({
    id: "unblock-memory",
    name: "Unblock Memory",
    description: "Workspace-native memory search powered by QMD",
    kind: "memory",
    register: registerUnblockMemory,
});
