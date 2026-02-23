# Contributing to agent-triage

We welcome contributions! Whether it's a bug fix, new trace connector, or documentation improvement, we appreciate your help.

## Development Setup

```bash
git clone https://github.com/converra/agent-triage
cd agent-triage
npm install
npm run build
npm test
```

### Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run dev -- <command>` | Run CLI from source (e.g., `npm run dev -- demo`) |
| `npm test` | Run all tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run lint` | Type-check without emitting |

## Adding a Trace Connector

The easiest way to contribute is by adding support for a new trace source. Every connector implements the same contract:

1. Read traces from a source (file, API, etc.)
2. Return an array of `NormalizedConversation` objects

See [`src/ingestion/types.ts`](src/ingestion/types.ts) for the `NormalizedConversation` interface, and the existing connectors in `src/ingestion/` for reference.

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Add tests for new functionality
- Run `npm test` and `npm run lint` before submitting
- Use [conventional commits](https://www.conventionalcommits.org/) for commit messages (e.g., `feat:`, `fix:`, `test:`, `docs:`)
- Update documentation if your change affects the public API or CLI

## Reporting Bugs

[Open an issue](https://github.com/converra/agent-triage/issues/new?template=bug_report.yml) with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Node.js version and OS

## Code Style

- TypeScript strict mode
- ESM modules (`.js` extensions in imports)
- Early returns over nested conditionals
- Small, focused functions

## License

By contributing, you agree that your contributions will be licensed under the project's [FSL-1.1-Apache-2.0](./LICENSE) license.
