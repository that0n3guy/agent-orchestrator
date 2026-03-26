# PRD: Agent Types, Issue Teams, and Dashboard Redesign

## Problem & Goal

**Problem:** AO currently has only two session roles: orchestrator and worker. All workers are identical — there's no distinction between an agent planning, building, testing, or reviewing. This means:
- No structured handoff between phases (planning → building → testing)
- No way for multiple agents to collaborate on one issue
- Workers come and go — no persistent team that maintains context
- The dashboard shows flat session lists, not the issue lifecycle
- No event-driven coordination between agents

**Goal:** Redesign AO's session model to support typed agent teams per issue, with persistent agents sharing a worktree, event-driven transitions between phases, and a dashboard that shows the issue lifecycle with team composition.

## Requirements

### Must-Have Features

#### 1. Agent Types

Six agent types replace the current `orchestrator` + `worker` model:

| Type | Role | Lifecycle | Writes code? | tmux session? |
|------|------|-----------|-------------|--------------|
| **Orchestrator** | Team lead / coordinator / human interface | Always running | No | Yes (1 per project or group) |
| **Planner** | Discovery, PRD, task breakdown, research/POC scripts | Ephemeral: created at discovery, killed when issue moves to ready | Yes (research scripts, not production code) | Yes |
| **Builder** | Implementation from tasks | Persistent: created at building, lives until merge ready | Yes | Yes |
| **Tester** | Spins up dev env, runs tests | Persistent: created at building, lives until merge ready | No (runs tests, reports) | Yes |
| **Claude Reviewer** | Code review from Claude's perspective | Ephemeral: created per review cycle, dies after posting | No (posts PR comments) | Yes (short-lived) |
| **Codex Reviewer** | Code review from Codex's perspective | Ephemeral: created per review cycle, dies after posting | No (posts PR comments) | Yes (short-lived) |

#### 2. Issue Teams

An **issue team** is a group of agents working on one issue in one shared worktree.

- **1 worktree per issue** — keeps code separate for PRs
- **Multiple tmux sessions per worktree** — each agent has its own session
- **Persistent agents (builder, tester) stay alive** from their creation until merge ready
- **Planner is ephemeral** — killed when issue moves to ready (orchestrator can handle plan questions later)
- **Planner writes research scripts** — POC/test scripts for API exploration, capability testing, etc. These stay in the worktree so the builder can reference them. Not production code — cleaned up before merge.
- **Agents don't talk directly** — the system (lifecycle worker + hooks) mediates transitions
- **The orchestrator is NOT in the team** — it sits above, monitoring all teams

Session naming convention: `{prefix}-{role}-{issue}` e.g., `sm-plan-7`, `sa-build-4`, `sa-test-4`

Worktree naming: `~/.worktrees/{project}/issue-{N}`

#### 3. Worktree Lifecycle

```
Created: when discovery starts (planner needs a branch)
Used by: planner → builder → tester → reviewers (all same worktree)
Cleaned up: when issue is done (merged/closed)
```

The tester sets up the dev environment (DB, app server, etc.) once per worktree using the project's setup script. This persists across test runs.

#### 4. Event-Driven Transitions

Agent lifecycle hooks emit events. The lifecycle worker reacts to them.

**Events emitted by hooks:**
- `building-complete` — builder marks last task `[x]`
- `code-pushed` — builder pushes to branch
- `tests-passed` / `tests-failed` — tester finishes a run
- `review-posted` — reviewer posts findings to PR
- `pr-created` — builder opens a PR

**Lifecycle worker reactions:**
- `building-complete` → auto-trigger tester
- `tests-passed` → auto-trigger reviewers (both Claude + Codex)
- `tests-failed` → send failure report to builder, builder resumes
- `review-posted` → notify orchestrator/human
- Human clicks "send back to builder" → builder gets review comments

**The orchestrator is pulled in when:**
- A human decision is needed (approve plan, merge, send back)
- The human wants to check on a team, give instructions, or nudge an agent
- An agent is stuck and needs intervention

#### 5. Two Kanban Boards

**Planning Board** (interactive, human-in-the-loop):

| Column | Agent Active | Notes |
|--------|-------------|-------|
| **Inbox** | none | Raw issues, no agents |
| **Planning** | Planner (persistent) | Discovery + PRD + tasks in one session. Interactive — human participates. PRD/tasks get refined in-place. |
| **Ready** | none (planner still alive, idle) | Approved plan. Human clicks "Start Build" to move to working board. |

**Working Board** (agent-driven with loops):

| Column | Agent(s) Active | Notes |
|--------|----------------|-------|
| **Building** | Builder + Tester (persistent) | Builder codes, tester runs tests. They loop: build → test → build. Reviewers (ephemeral) come and go. |
| **Merge Ready** | Builder (idle, waiting) | Reviews passed. Builder alive in case human has questions. Human merges. |
| **Done** | none | Worktree cleaned up, agents killed. Card stays as history. |

Issues can skip columns: simple bugs go `Inbox → Ready → Building → Merge Ready`.

The board columns represent the **issue phase**. The agents inside the card show what's actually happening within that phase.

#### 6. Card Design

**Kanban card (compact):**
```
┌────────────────────────────┐
│ #7 Add favicon      [mktg] │
│ Building (5/8 tasks)       │
│ 🟢BLD● 🟣TST○ 🟡REV      │
│ PR: #42 (CI passing)       │
└────────────────────────────┘
● = active  ○ = idle
```

**Card detail page (click into card):**
- Team section: all agents with status and `[terminal]` links
- Terminal with agent switcher dropdown `[switch ▾]`
- Progress: tasks, build/test cycles, review rounds
- Artifacts: PRD, tasks, PR links
- Action buttons: Run Tests, Request Review, Send to Builder, Move to Merge Ready, Ask Builder Questions
- History: timeline of agent activities

#### 7. Orchestrator as Team Lead

The orchestrator is the human's interface to all teams:

- **Reactive**: receives events (builder done, tests failed, PR opened), surfaces them
- **Interactive**: human asks "how's #7 going?" or "tell the builder to simplify the auth"
- **Coordinator**: relays messages between human and agents
- **Not a micromanager**: doesn't actively poll. Gets notified via events.

The orchestrator knows about all issues, all teams, all agents. It can:
- Check any agent's status
- Send messages to any agent via `ao send` (just like the human would)
- Trigger actions (run tests, request review)
- Answer questions about progress across issues
- Handle plan clarification questions itself (no need to keep planner alive)

#### 8. Builder Self-Validation

Before claiming "done," the builder must answer:
1. What tasks did you mark complete without e2e verification?
2. What bugs did you encounter but not fix? Why?
3. What shortcuts did you take for speed?
4. Are there any bugs that aren't from this issue? (Post to GH if so)

These answers are posted to the PR or issue for the human to review. The human can then ask follow-up questions via the orchestrator.

#### 9. Two Project Modes

**Single repo mode:**
- Issues tracked in the repo's own GitHub Issues
- PRD/tasks stored in the repo at `plans/issue-<N>/` (loosely version controlled — not every edit needs a commit)
- One orchestrator per repo
- One kanban board per repo

**Repo group mode:**
- Issues tracked in a shared `*-work` repo (e.g., `solidactions-work`)
- PRD/tasks stored in the work repo at `plans/issue-<N>/`
- **One orchestrator** for the entire group
- **One kanban board** for the entire group
- Cards show which code repo the issue targets
- Label-based routing to the correct code repo
- Visual indicator in the UI that this is a repo group

### Technical Requirements

- AO fork: `that0n3guy/agent-orchestrator`
- Dashboard: Next.js + unified server on single port (already working)
- Terminal: xterm.js via WebSocket (already working)
- Agent runtime: tmux (already working)
- Workspace: git worktrees (already working)
- Skills: `/ao-start`, `/ao-prd`, `/ao-plan`, `/ao-implement`, `/ao-verify`, `/codex-review`

### Architecture & Design

**Session model changes:**
- Add `agentType` field to Session: `orchestrator | planner | builder | tester | claude-reviewer | codex-reviewer`
- Add `issueTeam` concept: group of sessions tied to one issue ID + worktree
- Add `lifecycle` field: `persistent | ephemeral`
- Session naming: `{prefix}-{role}-{issue}` instead of `{prefix}-{N}`

**Config changes:**
```yaml
projects:
  solidactions-app:
    agentTypes:
      planner:
        agent: claude-code
        skills: [ao-start, ao-prd, ao-plan]
        agentConfig:
          permissions: permissionless
      builder:
        agent: claude-code
        skills: [ao-implement, ao-verify]
        agentConfig:
          permissions: permissionless
      tester:
        agent: claude-code
        setupCommand: "bash scripts/ao-worktree-setup.sh"
        agentConfig:
          permissions: permissionless
      claude-reviewer:
        agent: claude-code
        lifecycle: ephemeral
      codex-reviewer:
        agent: codex
        lifecycle: ephemeral

# Repo group — explicit config, not inferred
groups:
  solidactions:
    name: SolidActions
    tracker:
      plugin: github
      repo: SolidActions/solidactions-work
    projects: [solidactions-app, solidactions-cli, solidactions-ts-sdk, solidactions-examples, solidactions-marketing, solidactions-site]
    # One orchestrator for the whole group
    # One kanban board for the whole group
    # Label-based routing to correct code repo
```

**Event system:**
- Extend existing PostToolUse hooks to emit agent lifecycle events
- Lifecycle worker subscribes to events and triggers transitions
- Events stored in session metadata for history/timeline

## Out of Scope

- Auto-merging (human gate stays)
- OpenClaw/Mercer integration
- Multi-model orchestrator (orchestrator stays Claude)
- Custom agent types beyond the six defined
- Real-time collaboration between agents (they take turns, mediated by events)
- Mobile/responsive dashboard design

## Constraints

- No backwards compatibility required — this is a clean-cut replacement of the old session model
- Old config format without `agentTypes` and `groups` is invalid
- All sessions require `agentType` and `issueId`
- The six agent types are the full set for v1 — don't design for arbitrary custom types yet

---

*Generated: 2026-03-26*
