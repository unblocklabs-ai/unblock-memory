import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerUnblockQmd } from "./src/plugin.js";
export default definePluginEntry({
    id: "unblock-qmd",
    name: "Unblock QMD Memory",
    description: "QMD-backed canonical memory search",
    kind: "memory",
    register: registerUnblockQmd,
});
