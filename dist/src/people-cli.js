import { join } from "node:path";
import { resolveAgentDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { PeopleStores } from "./people-store.js";
import { codexPeopleRefinementRunner, refinePeople, } from "./people-refinement.js";
export function registerPeopleCli(api, config, runner = codexPeopleRefinementRunner) {
    api.registerCli(({ program, config: openClawConfig }) => {
        const root = program.command("unblock-memory").description("Unblock Memory administration");
        const people = root.command("people").description("Maintain the agent-local people store");
        people
            .command("refine")
            .description("Refine stale enabled people with Codex")
            .requiredOption("--agent <id>", "Agent id")
            .action(async (options) => {
            const agentId = options.agent.trim();
            if (!agentId)
                throw new Error("--agent must be a non-empty string");
            if (!config.enabled)
                throw new Error("PeopleSQL is disabled");
            const stores = new PeopleStores({
                maxOpenTodos: config.todos.maxOpen,
                maxBlurbChars: config.whisperer.maxChars,
            });
            try {
                const summary = await refinePeople({
                    store: stores.get(agentId),
                    agentId,
                    agentDatabasePath: join(resolveAgentDir(openClawConfig, agentId), "openclaw-agent.sqlite"),
                    candidateLimit: config.refinement.maxPeoplePerRun,
                    includeSessionEvidence: config.evidenceCorpora.includes("sessions"),
                    maxBlurbChars: config.whisperer.maxChars,
                    runner,
                });
                process.stdout.write(`${JSON.stringify(summary)}\n`);
            }
            finally {
                stores.closeAll();
            }
        });
    }, {
        descriptors: [
            {
                name: "unblock-memory",
                description: "Unblock Memory administration",
                hasSubcommands: true,
            },
        ],
    });
}
