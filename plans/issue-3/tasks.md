# Implementation Plan

**Project**: agent-orchestrator-redesign
**Generated**: 2026-03-26
**Issue**: that0n3guy/agent-orchestrator#3

## Technical Context & Standards

*Detected Stack & Patterns*
- **Architecture**: TypeScript monorepo (pnpm workspaces) — core, cli, web, plugins
- **Framework**: Next.js 15 (web), Commander.js (cli)
- **Styling**: CSS modules (web dashboard)
- **State**: React hooks + SSE for real-time (web)
- **Runtime**: tmux sessions, git worktrees
- **Config**: Zod-validated YAML (`config.ts`, `types.ts`)
- **Key interfaces**: `Session`, `SessionSpawnConfig`, `SessionManager`, `ProjectConfig`, `SessionMetadata`
- **Current roles**: Only `orchestrator` and `worker` (via `metadata.role`)
- **Session naming**: `{prefix}-{N}` (sequential numbering)
- **Dashboard columns**: `working | pending | review | respond | merge` (in `Dashboard.tsx`)

> **For Claude:** REQUIRED SUB-SKILL: Use ao-implement to execute this plan task-by-task.
> After all tasks complete, use ao-verify to audit implementation against PRD.

---

## Phase 1: Core Type System — Agent Types & Issue Teams

The foundation everything else builds on. Changes to `types.ts` and `config.ts`.

- [ ] **Add `AgentType` union type to `types.ts`**
  Task ID: phase-1-types-01
  > **Implementation**: Edit `packages/core/src/types.ts`
  > **Details**: Add `export type AgentType = "orchestrator" | "planner" | "builder" | "tester" | "claude-reviewer" | "codex-reviewer";` near the top with the other type aliases. Add `export type AgentLifecycle = "persistent" | "ephemeral";`

- [ ] **Add `agentType` and `lifecycle` fields to `Session` interface**
  Task ID: phase-1-types-02
  > **Implementation**: Edit `packages/core/src/types.ts`, `Session` interface (~line 131)
  > **Details**: Add `agentType: AgentType;` and `lifecycle: AgentLifecycle;` fields. Update `isOrchestratorSession()` to check `session.agentType === "orchestrator"` instead of string matching on role/id suffix.

- [ ] **Add `agentType` and `lifecycle` to `SessionMetadata`**
  Task ID: phase-1-types-03
  > **Implementation**: Edit `packages/core/src/types.ts`, `SessionMetadata` interface (~line 1142)
  > **Details**: Add `agentType?: AgentType;` and `lifecycle?: AgentLifecycle;` to SessionMetadata. Remove the old `role?: string` field. Replace entirely with `agentType`.

- [ ] **Add `IssueTeam` interface**
  Task ID: phase-1-types-04
  > **Implementation**: Edit `packages/core/src/types.ts`
  > **Details**: Add:
  > ```typescript
  > export interface IssueTeam {
  >   issueId: string;
  >   projectId: string;
  >   worktreePath: string;
  >   branch: string;
  >   sessions: Map<AgentType, SessionId>;
  >   phase: "planning" | "building" | "testing" | "reviewing" | "merge-ready" | "done";
  >   createdAt: Date;
  > }
  > ```

- [ ] **Add `agentTypes` config to `ProjectConfig`**
  Task ID: phase-1-types-05
  > **Implementation**: Edit `packages/core/src/types.ts`, `ProjectConfig` interface (~line 935)
  > **Details**: Add:
  > ```typescript
  > agentTypes?: {
  >   planner?: RoleAgentConfig & { skills?: string[]; lifecycle?: AgentLifecycle };
  >   builder?: RoleAgentConfig & { skills?: string[]; setupCommand?: string };
  >   tester?: RoleAgentConfig & { setupCommand?: string };
  >   "claude-reviewer"?: RoleAgentConfig & { lifecycle?: AgentLifecycle };
  >   "codex-reviewer"?: RoleAgentConfig & { lifecycle?: AgentLifecycle };
  > };
  > ```

- [ ] **Add `groups` config to `OrchestratorConfig`**
  Task ID: phase-1-types-06
  > **Implementation**: Edit `packages/core/src/types.ts`, add `GroupConfig` interface. Edit `OrchestratorConfig` (~line 881).
  > **Details**: Add:
  > ```typescript
  > export interface GroupConfig {
  >   name: string;
  >   tracker?: TrackerConfig;
  >   projects: string[];
  > }
  > ```
  > Add `groups?: Record<string, GroupConfig>;` to `OrchestratorConfig`.

- [ ] **Update Zod schemas in `config.ts` for new types**
  Task ID: phase-1-config-01
  > **Implementation**: Edit `packages/core/src/config.ts`
  > **Details**: Add Zod schemas for `AgentType`, `AgentLifecycle`, `agentTypes` in ProjectConfigSchema, and `groups` in OrchestratorConfigSchema. `agentTypes` and `groups` are required top-level config. Old config format without these is invalid.

- [ ] **Update `SessionSpawnConfig` to accept `agentType`**
  Task ID: phase-1-types-07
  > **Implementation**: Edit `packages/core/src/types.ts`, `SessionSpawnConfig` interface (~line 183)
  > **Details**: Add `agentType?: AgentType;` and `worktreePath?: string;` (to allow spawning into an existing worktree). Add `lifecycle?: AgentLifecycle;`.

---

## Phase 2: Session Manager — Spawn by Agent Type

Modify session-manager.ts to handle agent types and shared worktrees.

- [ ] **Update session ID generation for agent-type naming**
  Task ID: phase-2-session-01
  > **Implementation**: Edit `packages/core/src/session-manager.ts`
  > **Details**: Currently generates IDs like `{prefix}-{N}`. When `agentType` is set in SpawnConfig, generate `{prefix}-{role}-{issueN}` instead (e.g., `sm-build-7`, `sa-test-4`). Remove old sequential numbering (`{prefix}-{N}`). All sessions use `{prefix}-{role}-{issue}` format.

- [ ] **Support spawning into existing worktree**
  Task ID: phase-2-session-02
  > **Implementation**: Edit `packages/core/src/session-manager.ts`, the `spawn()` method
  > **Details**: When `worktreePath` is provided in SpawnConfig, skip worktree creation and use the existing path. This allows builder/tester/reviewer to share the planner's worktree. Validate the worktree exists before spawning.

- [ ] **Add `getIssueTeam()` method to SessionManager**
  Task ID: phase-2-session-03
  > **Implementation**: Edit `packages/core/src/session-manager.ts` and `types.ts` SessionManager interface
  > **Details**: Add `getIssueTeam(issueId: string, projectId: string): Promise<IssueTeam | null>`. Scans active sessions to build an IssueTeam object by matching issueId and grouping by agentType. Returns null if no sessions exist for that issue.

- [ ] **Add `spawnTeamMember()` convenience method**
  Task ID: phase-2-session-04
  > **Implementation**: Edit `packages/core/src/session-manager.ts`
  > **Details**: Add `spawnTeamMember(issueId: string, projectId: string, agentType: AgentType): Promise<Session>`. Looks up the existing issue team, reuses the worktree path, and spawns a new session with the correct agent type and naming. If no team exists yet (first spawn), creates the worktree.

- [ ] **Set `agentType` and `lifecycle` in metadata on spawn**
  Task ID: phase-2-session-05
  > **Implementation**: Edit `packages/core/src/session-manager.ts`, metadata writing section
  > **Details**: When spawning, write `agentType` and `lifecycle` to session metadata file. Read them back when loading sessions. Map from new fields to the Session interface.

---

## Phase 3: CLI Commands — Typed Spawning

Update CLI commands to support agent types.

- [ ] **Add `--type` flag to `ao spawn`**
  Task ID: phase-3-cli-01
  > **Implementation**: Edit `packages/cli/src/commands/spawn.ts`
  > **Details**: Add `.option("--type <type>", "Agent type: planner, builder, tester")` to the spawn command. Pass through to `SessionSpawnConfig.agentType`. `--type` is required. No default — the user must specify what kind of agent to spawn.

- [ ] **Add `ao team` command group**
  Task ID: phase-3-cli-02
  > **Implementation**: Create `packages/cli/src/commands/team.ts`
  > **Details**: New command group:
  > - `ao team ls [issue]` — list team members for an issue
  > - `ao team spawn <issue> <type>` — spawn a specific agent type into the issue team
  > - `ao team kill <issue> [type]` — kill specific team member or all
  > Register in the CLI's main command registration.

- [ ] **Update `ao status` to show agent types**
  Task ID: phase-3-cli-03
  > **Implementation**: Edit `packages/cli/src/commands/status.ts`
  > **Details**: Show agent type next to session ID in the status table. Group sessions by issue when an issue team exists. Show team composition.

---

## Phase 4: Event System

Extend hooks and lifecycle to support agent events.

- [ ] **Define event types**
  Task ID: phase-4-events-01
  > **Implementation**: Edit `packages/core/src/types.ts`
  > **Details**: Add:
  > ```typescript
  > export type AgentEvent =
  >   | { type: "building-complete"; sessionId: string; issueId: string }
  >   | { type: "code-pushed"; sessionId: string; issueId: string; branch: string }
  >   | { type: "tests-passed"; sessionId: string; issueId: string }
  >   | { type: "tests-failed"; sessionId: string; issueId: string; failures: string }
  >   | { type: "review-posted"; sessionId: string; issueId: string; prNumber: string }
  >   | { type: "pr-created"; sessionId: string; issueId: string; prUrl: string };
  > ```

- [ ] **Add event emission to metadata updater hook**
  Task ID: phase-4-events-02
  > **Implementation**: Edit `packages/plugins/agent-claude-code/src/index.ts`, the `METADATA_UPDATER_SCRIPT`
  > **Details**: Extend the bash hook script to detect additional patterns:
  > - `git push` when all tasks are `[x]` → write `event=building-complete` to metadata
  > - `php artisan test` / `npm test` with exit code → write `event=tests-passed` or `event=tests-failed`
  > - `gh pr comment` with review content → write `event=review-posted`
  > Events are written to the session metadata file as key-value pairs.

- [ ] **Add event consumption to lifecycle manager**
  Task ID: phase-4-events-03
  > **Implementation**: Edit `packages/core/src/lifecycle-manager.ts`
  > **Details**: During the polling cycle, check for `event=` keys in session metadata. When an event is found:
  > - `building-complete` → if tester exists in team, send "run tests" message via `ao send`
  > - `tests-passed` → spawn ephemeral claude-reviewer and codex-reviewer
  > - `tests-failed` → send failure output to builder via `ao send`
  > - `review-posted` → notify orchestrator/human
  > Clear the event key after processing.

---

## Phase 5: Dashboard — Card Redesign

Update the web dashboard to show issue teams.

- [ ] **Add agent type data to dashboard API**
  Task ID: phase-5-web-01
  > **Implementation**: Edit `packages/web/src/app/api/sessions/route.ts` and `packages/web/src/lib/serialize.ts`
  > **Details**: Include `agentType`, `lifecycle`, and `issueId` in the serialized session data sent to the frontend. Group sessions by issueId into teams.

- [ ] **Add `IssueCard` component**
  Task ID: phase-5-web-02
  > **Implementation**: Create `packages/web/src/components/IssueCard.tsx`
  > **Details**: New card component that represents an issue (not a session). Shows:
  > - Issue number + title + repo badge
  > - Current phase (planning, building, merge-ready, etc.)
  > - Agent team: color-coded dots with active/idle state
  > - PR status if exists
  > - Task progress if available
  > Clicking navigates to the issue detail page.

- [ ] **Add `IssueDetail` component with terminal switching**
  Task ID: phase-5-web-03
  > **Implementation**: Create `packages/web/src/components/IssueDetail.tsx`
  > **Details**: Detail page for an issue showing:
  > - Team section with all agents, their status, and terminal links
  > - Terminal embed with `[switch ▾]` dropdown to flip between agent sessions
  > - Progress section: tasks, build/test cycles, review rounds
  > - Artifacts: PRD, tasks, PR links
  > - Action buttons: Run Tests, Request Review, Send to Builder, Move to Merge Ready
  > - History timeline of agent activities
  > Reuse existing `DirectTerminal` component for the terminal embed.

- [ ] **Redesign kanban columns**
  Task ID: phase-5-web-04
  > **Implementation**: Edit `packages/web/src/components/Dashboard.tsx`
  > **Details**: Replace current `KANBAN_LEVELS` (`working, pending, review, respond, merge`) with two board views:
  > - **Planning Board**: Inbox, Planning, Ready
  > - **Working Board**: Building, Merge Ready, Done
  > Add a board switcher toggle. Group sessions into IssueCards by issueId. All sessions require an issueId and agentType. Remove old SessionCard component.

- [ ] **Add repo group support to dashboard**
  Task ID: phase-5-web-05
  > **Implementation**: Edit `packages/web/src/components/Dashboard.tsx` and `packages/web/src/components/ProjectSidebar.tsx`
  > **Details**: When a `groups` config exists, show groups in the sidebar instead of individual projects. Clicking a group shows one unified kanban board with cards from all projects in the group. Each card shows a repo badge. The orchestrator link shows at the group level.

---

## Phase 6: Integration & Config

Wire everything together with the config and existing skills.

- [ ] **Update `ao start` for group-level orchestrator**
  Task ID: phase-6-start-01
  > **Implementation**: Edit `packages/cli/src/commands/start.ts`
  > **Details**: Add `ao start --group <name>` option. When a group is specified, start one orchestrator for the group (not per-project). The orchestrator's system prompt includes all projects in the group. Fall back to current per-project behavior when no group specified.

- [ ] **Update orchestrator prompt for team awareness**
  Task ID: phase-6-prompt-01
  > **Implementation**: Edit `packages/core/src/orchestrator-prompt.ts`
  > **Details**: Add sections for:
  > - Team management: `ao team ls`, `ao team spawn`, `ao team kill`
  > - Issue lifecycle: describe the planning → building → merge-ready flow
  > - Event handling: what events the orchestrator receives and how to respond
  > - Group context: when running as group orchestrator, list all projects and their tracker repos

- [ ] **Update `agentRules` injection for agent types**
  Task ID: phase-6-rules-01
  > **Implementation**: Edit `packages/core/src/prompt-builder.ts`
  > **Details**: When building the agent prompt, check the session's `agentType` and inject type-specific rules:
  > - Planner: "You are a planner. Do NOT write production code. Use /ao-start, /ao-prd, /ao-plan."
  > - Builder: "You are a builder. Implement from tasks.md. Use /ao-implement. Answer validation questions before claiming done."
  > - Tester: "You are a tester. Set up the dev environment, run tests, report results. Do NOT edit code."
  > - Reviewers: "You are a code reviewer. Post findings as PR comments. Do NOT edit code."

---

## Phase 7: Testing

- [ ] **Add unit tests for new types and session manager changes**
  Task ID: phase-7-test-01
  > **Implementation**: Add tests in `packages/core/src/__tests__/`
  > **Details**: Test:
  > - AgentType session ID generation (`sm-build-7` format)
  > - Spawn into existing worktree
  > - getIssueTeam() grouping
  > - spawnTeamMember() reuses worktree
  > - Config validation with new agentTypes and groups fields

- [ ] **End-to-end test: issue team lifecycle**
  Task ID: phase-7-test-02
  > **Implementation**: Manual test
  > **Details**:
  > 1. Create issue in solidactions-work
  > 2. `ao team spawn <issue> planner` — verify planner session created with worktree
  > 3. Attach to planner, run /ao-start and /ao-prd
  > 4. `ao team spawn <issue> builder` — verify builder reuses same worktree
  > 5. `ao team spawn <issue> tester` — verify tester reuses same worktree
  > 6. Verify `ao team ls <issue>` shows all three
  > 7. Verify `ao status` shows team composition
  > 8. Kill all, verify cleanup

---

*Generated by AO Planning /ao-plan*
