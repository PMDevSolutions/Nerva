# Lint & Format

Run ESLint, Prettier, and TypeScript type checking across the API project.

## Purpose

This command checks and fixes code quality and formatting issues in the Nerva API codebase.

## Usage

```
/lint
```

## What this command does

1. **Runs ESLint** to check for code quality issues
2. **Runs Prettier** to check and fix formatting
3. **Runs TypeScript** type checking
4. **Reports** remaining issues that need manual attention

## Steps

### 1. Check if tools are installed
```bash
pnpm eslint --version && pnpm prettier --version && pnpm tsc --version
```

### 2. Run ESLint with auto-fix
```bash
pnpm eslint . --fix --ext .ts
```

### 3. Run Prettier
```bash
pnpm prettier --write "api/src/**/*.ts" "api/tests/**/*.ts"
```

### 4. Type check
```bash
pnpm tsc --noEmit
```

## Or use the project script

```bash
./scripts/check-types.sh
```

## Common Issues

- **Missing ESLint config**: Copy `templates/shared/eslint.config.js` to project root
- **Missing Prettier config**: Copy `templates/shared/prettier.config.js` to project root
- **TypeScript path errors**: Ensure `tsconfig.json` paths match your directory structure
- **Import resolution**: Check that `moduleResolution` is set to `bundler` in tsconfig
