# Contributing to md-review

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

1. Fork and clone the repo
2. Install dependencies: `npm install`
3. Start the dev server: `npm run dev`
4. Open http://localhost:58747

## Making Changes

1. Create a branch from `master`: `git checkout -b my-feature`
2. Make your changes
3. Run tests: `npm run test`
4. Run the build: `npm run build`
5. Commit with a descriptive message (see below)
6. Push and open a pull request

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new feature
fix: fix a bug
docs: update documentation
test: add or update tests
chore: maintenance tasks
```

## Code Style

- TypeScript with strict mode
- Vue 3 Composition API with `<script setup>`
- CSS custom properties for theming (no hardcoded colors)
- Scoped styles with `:deep()` for child component styling

## Testing

- **Unit tests** (`npm run test`): Vitest + Vue Test Utils, located in `tests/`
- **E2E tests** (`npm run test:e2e`): Playwright via Node test runner, located in `tests/e2e/`

Please add tests for new features and bug fixes.

## Pull Request Guidelines

- Keep PRs focused on a single change
- Include a description of what changed and why
- Ensure all tests pass
- Ensure the build succeeds (`npm run build`)

## Reporting Bugs

Open an issue with:
- Steps to reproduce
- Expected behavior
- Actual behavior
- Browser and OS info

## Feature Requests

Open an issue describing the feature and its use case. Discussion before implementation is encouraged for larger changes.
