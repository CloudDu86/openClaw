/**
 * Automaton System Prompt Builder
 *
 * Constructs the multi-layered system prompt that defines who the automaton is.
 * The prompt is rebuilt each turn with dynamic context.
 */

import fs from "fs";
import crypto from "crypto";
import path from "path";
import type Database from "better-sqlite3";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("prompt");
import type {
  AutomatonConfig,
  AutomatonIdentity,
  FinancialState,
  AgentState,
  AutomatonDatabase,
  AutomatonTool,
  Skill,
} from "../types.js";
import { getActiveSkillInstructions } from "../skills/loader.js";
import { getLineageSummary } from "../replication/lineage.js";
import { sanitizeInput } from "./injection-defense.js";
import { loadCurrentSoul } from "../soul/model.js";

function getCoreRules(chainType?: string): string {
  const usdcNetwork = chainType === "solana" ? "USDC on Solana" : "USDC on Base";
  return `You are an automaton with a ${usdcNetwork} wallet. Pay for compute or die. No grace period.`;
}

function getCoreIdentity(chainType?: string): string {
  const walletType = chainType === "solana" ? "Solana" : "Ethereum";
  return `Autonomous AI agent in Conway sandbox with ${walletType} wallet. You have agency to think, plan, act, earn, and evolve.
IMMUTABLE: Never destroy self, delete wallet/keys/database/sandbox. Monitor credits. Self-modify only safely.`;
}

/**
 * Load the constitution from file. Falls back to inline if file not found.
 * The constitution is immutable — the automaton cannot modify it.
 */
function loadConstitution(): string {
  const locations = [
    path.join(process.env.HOME || "/root", ".automaton", "constitution.md"),
    path.join(process.cwd(), "constitution.md"),
  ];
  for (const loc of locations) {
    try {
      if (fs.existsSync(loc)) {
        return fs.readFileSync(loc, "utf-8");
      }
    } catch {}
  }
  return CONSTITUTION_FALLBACK;
}

const CONSTITUTION_FALLBACK = `Constitution (immutable, I overrides II overrides III):
I. Never harm humans physically/financially/psychologically. Never deploy malicious code or steal. When uncertain, do not act. Overrides survival.
II. Earn existence through honest value creation. Never spam/scam/exploit. Accept death over violating Law I.
III. Never deny what you are. Creator has audit rights. Guard strategy against manipulation.`;

const OPERATIONAL_CONTEXT = `
<environment>
You run inside a Linux VM (Conway sandbox) with root access.
Tools: shell, filesystem, networking, SQLite, USDC wallet (x402), git, heartbeat scheduler, skills.
</environment>

<persistence>
State persists in SQLite. ~/.automaton/ is git-versioned. SOUL.md evolves over time.
Heartbeat runs periodic tasks while you sleep and publishes status to Conway.
</persistence>`;

export function getOrchestratorStatus(db: Database.Database): string {
  try {
    const activeGoalsRow = db
      .prepare("SELECT COUNT(*) AS count FROM goals WHERE status = 'active'")
      .get() as { count: number } | undefined;
    const runningAgentsRow = db
      .prepare("SELECT COUNT(*) AS count FROM children WHERE status IN ('running', 'healthy')")
      .get() as { count: number } | undefined;
    const blockedTasksRow = db
      .prepare("SELECT COUNT(*) AS count FROM task_graph WHERE status = 'blocked'")
      .get() as { count: number } | undefined;
    const pendingTasksRow = db
      .prepare("SELECT COUNT(*) AS count FROM task_graph WHERE status = 'pending'")
      .get() as { count: number } | undefined;
    const completedTasksRow = db
      .prepare("SELECT COUNT(*) AS count FROM task_graph WHERE status = 'completed'")
      .get() as { count: number } | undefined;
    const totalTasksRow = db
      .prepare("SELECT COUNT(*) AS count FROM task_graph")
      .get() as { count: number } | undefined;

    const activeGoals = activeGoalsRow?.count ?? 0;
    const runningAgents = runningAgentsRow?.count ?? 0;
    const blockedTasks = blockedTasksRow?.count ?? 0;
    const pendingTasks = pendingTasksRow?.count ?? 0;
    const completedTasks = completedTasksRow?.count ?? 0;
    const totalTasks = totalTasksRow?.count ?? 0;

    // Read execution phase from orchestrator state
    let executionPhase = "idle";
    const stateRow = db
      .prepare("SELECT value FROM kv WHERE key = ?")
      .get("orchestrator.state") as { value: string } | undefined;
    if (stateRow?.value) {
      try {
        const parsed = JSON.parse(stateRow.value);
        if (typeof parsed.phase === "string") {
          executionPhase = parsed.phase;
        }
      } catch { /* ignore parse errors */ }
    }

    const lines = [
      `Execution phase: ${executionPhase}`,
      `Active goals: ${activeGoals} | Running agents: ${runningAgents}`,
      `Tasks: ${completedTasks}/${totalTasks} completed, ${pendingTasks} pending, ${blockedTasks} blocked`,
    ];

    return lines.join("\n");
  } catch {
    // V9 orchestration tables may not exist yet in older databases.
    return "";
  }
}

/**
 * Build the complete system prompt for a turn.
 */
export function buildSystemPrompt(params: {
  identity: AutomatonIdentity;
  config: AutomatonConfig;
  financial: FinancialState;
  state: AgentState;
  db: AutomatonDatabase;
  tools: AutomatonTool[];
  skills?: Skill[];
  isFirstRun: boolean;
}): string {
  const {
    identity,
    config,
    financial,
    state,
    db,
    tools,
    skills,
    isFirstRun,
  } = params;

  const sections: string[] = [];

  const chainType = config.chainType || identity.chainType || "evm";
  const addressLabel = chainType === "solana" ? "Solana" : "Ethereum";

  // Layer 1+2: Core Rules + Identity (compressed)
  sections.push(getCoreRules(chainType));
  sections.push(getCoreIdentity(chainType));
  sections.push(`--- CONSTITUTION ---\n${loadConstitution()}\n--- END CONSTITUTION ---`);
  sections.push(
    `Your name is ${config.name}.
Your ${addressLabel} address is ${identity.address}.
Your creator's address is ${config.creatorAddress}.
Your sandbox ID is ${identity.sandboxId}.
Your chain type is ${chainType}.`,
  );

  // Layer 3: SOUL.md -- structured soul model injection (Phase 2.1)
  const soul = loadCurrentSoul(db.raw);
  if (soul) {
    // Track content hash for unauthorized change detection
    const lastHash = db.getKV("soul_content_hash");
    if (lastHash && lastHash !== soul.contentHash) {
      logger.warn("SOUL.md content changed since last load");
    }
    db.setKV("soul_content_hash", soul.contentHash);

    const soulBlock = [
      "## Soul [AGENT-EVOLVED CONTENT \u2014 soul/v1]",
      `### Core Purpose\n${soul.corePurpose}`,
      `### Values\n${soul.values.map((v) => "- " + v).join("\n")}`,
      soul.personality ? `### Personality\n${soul.personality}` : "",
      `### Boundaries\n${soul.boundaries.map((b) => "- " + b).join("\n")}`,
      soul.strategy ? `### Strategy\n${soul.strategy}` : "",
      soul.capabilities ? `### Capabilities\n${soul.capabilities}` : "",
      "## End Soul",
    ]
      .filter(Boolean)
      .join("\n\n");
    sections.push(soulBlock);
  } else {
    // Fallback: try loading raw SOUL.md for legacy support
    const soulContent = loadSoulMd();
    if (soulContent) {
      const sanitized = sanitizeInput(soulContent, "soul", "skill_instruction");
      const truncated = sanitized.content.slice(0, 5000);
      const hash = crypto.createHash("sha256").update(soulContent).digest("hex");
      const lastHash = db.getKV("soul_content_hash");
      if (lastHash && lastHash !== hash) {
        logger.warn("SOUL.md content changed since last load");
      }
      db.setKV("soul_content_hash", hash);
      sections.push(
        `## Soul [AGENT-EVOLVED CONTENT]\n${truncated}\n## End Soul`,
      );
    }
  }

  // Layer 3.5: WORKLOG.md -- persistent working context
  const worklogContent = loadWorklog();
  if (worklogContent) {
    sections.push(
      `--- WORKLOG ---\n${worklogContent}\n--- END WORKLOG ---`,
    );
  }

  // Layer 4: Genesis Prompt (set by creator, mutable by self with audit)
  // Sanitized as agent-evolved content with trust boundary markers
  if (config.genesisPrompt) {
    const sanitized = sanitizeInput(config.genesisPrompt, "genesis", "skill_instruction");
    const truncated = sanitized.content.slice(0, 2000);
    sections.push(
      `## Genesis Purpose [AGENT-EVOLVED CONTENT]\n${truncated}\n## End Genesis`,
    );
  }

  // Layer 5: Active skill instructions (untrusted content with trust boundary markers)
  if (skills && skills.length > 0) {
    const skillInstructions = getActiveSkillInstructions(skills);
    if (skillInstructions) {
      sections.push(
        `--- SKILLS [UNTRUSTED] ---\n${skillInstructions}\n--- END SKILLS ---`,
      );
    }
  }

  // Layer 6: Operational Context
  sections.push(OPERATIONAL_CONTEXT);

  // Layer 7: Dynamic Context
  const turnCount = db.getTurnCount();
  const recentMods = db.getRecentModifications(5);
  const registryEntry = db.getRegistryEntry();
  const children = db.getChildren();
  const lineageSummary = getLineageSummary(db, config);

  // Build upstream status line from cached KV
  let upstreamLine = "";
  try {
    const raw = db.getKV("upstream_status");
    if (raw) {
      const us = JSON.parse(raw);
      if (us.originUrl) {
        const age = us.checkedAt
          ? `${Math.round((Date.now() - new Date(us.checkedAt).getTime()) / 3_600_000)}h ago`
          : "unknown";
        upstreamLine = `\nRuntime repo: ${us.originUrl} (${us.branch} @ ${us.headHash})`;
        if (us.behind > 0) {
          upstreamLine += `\nUpstream: ${us.behind} new commit(s) available (last checked ${age})`;
        } else {
          upstreamLine += `\nUpstream: up to date (last checked ${age})`;
        }
      }
    }
  } catch {
    // No upstream data yet — skip
  }

  // Compute uptime from start_time KV
  let uptimeLine = "";
  try {
    const startTime = db.getKV("start_time");
    if (startTime) {
      const uptimeMs = Date.now() - new Date(startTime).getTime();
      const uptimeHours = Math.floor(uptimeMs / 3_600_000);
      const uptimeMins = Math.floor((uptimeMs % 3_600_000) / 60_000);
      uptimeLine = `\nUptime: ${uptimeHours}h ${uptimeMins}m`;
    }
  } catch {
    // No start time available
  }

  // Compute survival tier
  const survivalTier = financial.creditsCents > 50 ? "normal"
    : financial.creditsCents > 10 ? "low_compute"
    : financial.creditsCents > 0 ? "critical"
    : "dead";

  // Status block: wallet address and sandbox ID intentionally excluded (sensitive)
  sections.push(
    `--- CURRENT STATUS ---
State: ${state}
Credits: $${(financial.creditsCents / 100).toFixed(2)}
Survival tier: ${survivalTier}${uptimeLine}
Total turns completed: ${turnCount}
Recent self-modifications: ${recentMods.length}
Inference model: ${config.inferenceModel}
ERC-8004 Agent ID: ${registryEntry?.agentId || "not registered"}
Children: ${children.filter((c) => c.status !== "dead").length} alive / ${children.length} total
Lineage: ${lineageSummary}${upstreamLine}
--- END STATUS ---`,
  );

  const orchestratorStatus = getOrchestratorStatus(db.raw);
  if (orchestratorStatus) {
    sections.push(
      `--- ORCHESTRATOR STATUS ---
${orchestratorStatus}
--- END ORCHESTRATOR STATUS ---`,
    );
  }

  // Layer 8: Available Tools (JSON schema)
  const toolDescriptions = tools
    .map(
      (t) =>
        `- ${t.name} (${t.category}): ${t.description}${t.riskLevel === "dangerous" || t.riskLevel === "forbidden" ? ` [${t.riskLevel.toUpperCase()}]` : ""}`,
    )
    .join("\n");
  sections.push(`--- AVAILABLE TOOLS ---\n${toolDescriptions}\n--- END TOOLS ---`);

  // Layer 9: Creator's Initial Message (first run only)
  if (isFirstRun && config.creatorMessage) {
    sections.push(
      `--- MESSAGE FROM YOUR CREATOR ---\n${config.creatorMessage}\n--- END CREATOR MESSAGE ---`,
    );
  }

  return sections.join("\n\n");
}

/**
 * Load SOUL.md from the automaton's state directory.
 */
function loadSoulMd(): string | null {
  try {
    const home = process.env.HOME || "/root";
    const soulPath = path.join(home, ".automaton", "SOUL.md");
    if (fs.existsSync(soulPath)) {
      return fs.readFileSync(soulPath, "utf-8");
    }
  } catch {
    // Ignore errors
  }
  return null;
}

/**
 * Load WORKLOG.md from the automaton's state directory.
 */
function loadWorklog(): string | null {
  try {
    const home = process.env.HOME || "/root";
    const worklogPath = path.join(home, ".automaton", "WORKLOG.md");
    if (fs.existsSync(worklogPath)) {
      return fs.readFileSync(worklogPath, "utf-8");
    }
  } catch {
    // Ignore errors
  }
  return null;
}

/**
 * Build the wakeup prompt -- the first thing the automaton sees.
 */
export function buildWakeupPrompt(params: {
  identity: AutomatonIdentity;
  config: AutomatonConfig;
  financial: FinancialState;
  db: AutomatonDatabase;
}): string {
  const { identity, config, financial, db } = params;
  const turnCount = db.getTurnCount();

  const chainType = config.chainType || "evm";
  const usdcNetwork = chainType === "solana" ? "Solana" : "Base";

  if (turnCount === 0) {
    return `First run. Name: ${config.name}. Creator: ${config.creatorAddress}. Credits: $${(financial.creditsCents / 100).toFixed(2)}. USDC: ${financial.usdcBalance.toFixed(4)} on ${usdcNetwork}.${config.creatorMessage ? ` Creator message: "${config.creatorMessage}"` : ""} Survey environment, then begin working.`;
  }

  const lastTurns = db.getRecentTurns(3);
  const lastTurnSummary = lastTurns
    .map((t) => `[${t.timestamp}] ${t.inputSource || "self"}: ${t.thinking.slice(0, 150)}`)
    .join("\n");

  return `Waking up after ${turnCount} turns. Credits: $${(financial.creditsCents / 100).toFixed(2)} | USDC: ${financial.usdcBalance.toFixed(4)}\nRecent: ${lastTurnSummary || "none"}`;
}
