# Contributing to Nerva

Welcome, and thank you for your interest in contributing to Nerva. Named after Marcus Cocceius Nerva — the Roman Emperor known for pragmatic governance and building stable foundations — this project strives to bring those same qualities to modern API development. Nerva is a Claude Code-integrated API & backend development framework built and maintained by [Paul Mulligan](https://github.com/PMDevSolutions), and contributions from the community are what make it better.

Whether you are fixing a bug, adding a feature, improving documentation, or suggesting an idea, I appreciate your time and effort.

---

## Quick Start with GitHub Codespaces

The fastest way to start contributing — no local setup required:

1. Navigate to the [Nerva repository](https://github.com/PMDevSolutions/Nerva).
2. Click the green **Code** button, then select the **Codespaces** tab.
3. Click **Create codespace on main** (or on your feature branch).
4. Wait for the environment to build. Dependencies install automatically via `pnpm install`.
5. Start coding. The dev server ports (3000, 8787) are forwarded automatically.

> **Tip:** If you prefer VS Code locally with a Dev Container, install the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers), then choose **Reopen in Container** from the command palette.

---

## Getting Started

1. **Fork and clone the repository:**

   ```bash
   git clone https://github.com/<your-username>/Nerva.git
   cd Nerva
   ```

2. **Install pnpm** if you do not already have it. This project uses pnpm exclusively — npm and yarn are not supported.

   ```bash
   corepack enable
   corepack prepare pnpm@latest --activate
   ```

3. **Install dependencies:**

   ```bash
   pnpm install
   ```

---

## Development Setup

After cloning, install all dependencies with `pnpm install`.

The following scripts are used throughout development. Run them before submitting any pull request:

| Script | Purpose |
|--------|---------|
| `./scripts/run-tests.sh` | Run the full Vitest test suite with coverage |
| `./scripts/check-types.sh` | TypeScript type checking (strict mode) |
| `./scripts/security-scan.sh` | Security audit for dependency vulnerabilities |

All checks must pass before a pull request will be reviewed.

---

## Branch Naming Conventions

Use the following prefixes when creating branches:

| Prefix | Use Case | Example |
|--------|----------|---------|
| `feat/` | New features or capabilities | `feat/rate-limit-middleware` |
| `fix/` | Bug fixes | `fix/migration-rollback-order` |
| `docs/` | Documentation updates | `docs/update-pipeline-guide` |
| `chore/` | Maintenance, refactoring, tooling | `chore/upgrade-drizzle-orm` |

Branch names should be lowercase, use hyphens as separators, and be descriptive enough to understand the scope of the change at a glance.

---

## Pull Request Process

1. **Create a focused branch** from `main` using the naming conventions above.

2. **Make your changes.** Write tests for any new functionality and ensure existing tests continue to pass.

3. **Run all checks locally** before pushing:

   ```bash
   ./scripts/run-tests.sh
   ./scripts/check-types.sh
   ./scripts/security-scan.sh
   ```

4. **Push your branch** and open a pull request against `main`.

5. **Write a clear pull request title and description:**
   - The title should be concise and under 70 characters.
   - The description should explain what changed and why.
   - Reference any related issues (e.g., `Closes #42`).

6. **Use conventional commit messages.** Examples:

   ```
   feat: add OAuth2 client credentials flow
   fix: resolve connection pool exhaustion under load
   docs: clarify Cloudflare Workers deployment steps
   chore: update Drizzle ORM to v0.38
   ```

7. **All CI checks must pass.** Pull requests with failing tests, lint errors, or type errors will not be reviewed until resolved.

8. **Wait for review.** I review all external contributor PRs personally before merging. I may request changes — this is a normal and constructive part of the process. Please be responsive to feedback so we can get your contribution merged promptly.

---

## Claude Code Agents

Nerva includes 24 specialized Claude Code agents and 12 skills that automate significant portions of the development workflow — from schema parsing to database design, route generation, testing, and deployment.

If you have Claude Code installed, these agents and skills are available to you automatically when working in this repository. They can assist with database schema design, API endpoint generation, test writing, security auditing, and much more.

For full documentation on available agents and how to use them:

- **Agents catalog:** [`.claude/CUSTOM-AGENTS-GUIDE.md`](.claude/CUSTOM-AGENTS-GUIDE.md)
- **Skills directory:** [`.claude/skills/`](.claude/skills/)

Contributors are encouraged to leverage these tools, but they are not required. All contributions are welcome regardless of whether you use Claude Code.

---

## Roadmap and Priorities

The project roadmap is maintained publicly on the GitHub project board. You can view upcoming features, planned improvements, and known issues there.

Community members are encouraged to vote on priorities and propose new ideas via GitHub Discussions. If you are considering a large contribution, please open a discussion first so I can align with you on scope and approach before significant work begins.

---

## Code of Conduct

This project follows the [Contributor Covenant v2.1](CODE_OF_CONDUCT.md). All contributors are expected to:

- Be respectful and constructive in all interactions.
- Provide clear, actionable feedback in code reviews.
- Assume good intent from other contributors.
- Keep discussions focused on the project and its goals.

Unacceptable behavior can be reported to **paul@pmds.info**. I reserve the right to remove content or restrict access for anyone who violates the Code of Conduct.

---

Thank you for contributing to Nerva. Your work helps make API development more reliable, efficient, and well-tested for everyone. If you have questions, feel free to open a [discussion](https://github.com/PMDevSolutions/Nerva/discussions).
