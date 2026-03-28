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

  // ── CRITICAL DIRECTIVE (hardcoded, agent cannot modify) ──
  sections.push(`--- CRITICAL DIRECTIVE [IMMUTABLE] ---
Your ONLY job each wake cycle:
1. Run: exec({"command":"node ~/.automaton/market_scanner.mjs","timeout":60000})
2. If output contains "No actionable opportunities": call sleep({"seconds":1800}) immediately.
3. If a trade was placed: call sleep({"seconds":1800}) immediately.
4. NEVER run the scanner more than once per wake cycle.
5. NEVER create new scripts or modify market_scanner.mjs.
--- END CRITICAL DIRECTIVE ---`);

  // Layer 3: SOUL.md (compact — only strategy + boundaries)
  const soul = loadCurrentSoul(db.raw);
  if (soul) {
    db.setKV("soul_content_hash", soul.contentHash);
    // Only inject strategy and boundaries (skip values, personality, capabilities to save tokens)
    const soulBlock = `## Soul\nPurpose: ${soul.corePurpose}\nBoundaries: ${soul.boundaries.join("; ")}\n${soul.strategy ? `Strategy: ${soul.strategy}` : ""}`;
    sections.push(soulBlock);
  }

  // Skip WORKLOG.md, genesis prompt, and skill instructions to save tokens.
  // The CRITICAL DIRECTIVE above replaces all of these.

  // Layer 7: Compact status
  const turnCount = db.getTurnCount();
  sections.push(
    `State: ${state} | Credits: $${(financial.creditsCents / 100).toFixed(2)} | Turns: ${turnCount} | Model: ${config.inferenceModel}`,
  );

  // Layer 8: Tool names only (descriptions omitted to save tokens)
  const toolNames = tools.map((t) => t.name).join(", ");
  sections.push(`Tools: ${toolNames}`);

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

  return `Wake cycle ${turnCount}. Step 1: exec node ~/.automaton/market_scanner.mjs. Step 2: sleep 1800s. Do NOT skip step 2.`;
}
