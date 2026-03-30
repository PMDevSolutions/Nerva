# Plugins Reference — Nerva Framework

## Installed Plugins

### episodic-memory
Persistent conversation memory across Claude Code sessions.

**Commands:**
- `/search-conversations` — Search previous conversation history
- Memory is automatically persisted and retrieved

**Use for:** Recalling past decisions, finding previous solutions, maintaining context across sessions.

### commit-commands
Git workflow automation for structured commits and PRs.

**Commands:**
- `/commit` — Create a structured git commit with conventional message
- `/commit-push-pr` — Commit, push, and open a pull request
- `/clean_gone` — Clean up local branches that have been deleted on remote

**Use for:** All git operations. Ensures consistent commit messages and clean branch management.

### superpowers
Advanced development workflows for planning, TDD, debugging, and code review.

**Key Skills:**
- **brainstorming** — Explore requirements before implementation
- **writing-plans** — Create implementation plans from specs
- **executing-plans** — Execute plans with review checkpoints
- **test-driven-development** — TDD workflow (red-green-refactor)
- **systematic-debugging** — Structured debugging approach
- **verification-before-completion** — Verify before claiming done
- **requesting-code-review** — Request review of completed work
- **receiving-code-review** — Handle review feedback properly
- **dispatching-parallel-agents** — Run independent tasks in parallel
- **subagent-driven-development** — Execute plans with subagents

**Use for:** Any non-trivial development task. The TDD and planning workflows are particularly important for the Nerva pipeline.

### ai-taskmaster
Local task management for tracking work items.

**Use for:** Breaking down complex tasks, tracking progress, managing dependencies between work items.

---

## GitHub Integration

GitHub operations use the `gh` CLI (not a plugin):

```bash
# Pull Requests
gh pr create --title "Add user endpoints" --body "..."
gh pr list
gh pr view 123
gh pr merge 123

# Issues
gh issue create --title "Bug: auth middleware" --body "..."
gh issue list
gh issue view 456

# Releases
gh release create v1.0.0 --notes "Initial release"
```

---

## Plugin Configuration

Plugins are configured in `.claude/settings.json`. Each plugin provides:
- Custom slash commands available in Claude Code
- Background automation (hooks, triggers)
- Persistent state across sessions

To view installed plugins: check `.claude/settings.json` or run Claude Code's plugin list command.
