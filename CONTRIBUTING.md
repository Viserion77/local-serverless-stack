# Contributing to Local Serverless Stack (LSS)

Thank you for your interest in contributing to LSS! This document provides guidelines and instructions for contributing.

## Code of Conduct

This project adheres to the Contributor Covenant [code of conduct](./CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## How to Contribute

### Reporting Bugs

Before creating a bug report, check the issue list to avoid duplicates. When filing a bug report, include:

- **Descriptive title** - Clear and specific
- **Reproduction steps** - Step-by-step instructions
- **Expected behavior** - What you expected to happen
- **Actual behavior** - What actually happened
- **Environment** - Node version, OS, LSS version, engine (`localstack` or `self`); include the Docker and LocalStack versions when using the `localstack` engine
- **Additional context** - Any relevant configuration or logs

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When submitting an enhancement suggestion:

- Use a **clear and descriptive title**
- Provide a **detailed description** of the enhancement
- Include **use cases** and benefits
- List **similar features** in other tools

### Pull Requests

1. **Fork** the repository
2. **Create a feature branch** (`git checkout -b feature/amazing-feature`)
3. **Make your changes** - Follow the code style guidelines
4. **Commit** with clear, descriptive messages
5. **Push** to your fork
6. **Open a Pull Request** with a clear description

#### PR Guidelines

- Link to related issues
- Describe the changes and why they're needed
- Include any breaking changes
- Update documentation as needed
- Ensure tests pass

## Development Setup

```bash
# Clone your fork
git clone https://github.com/<your-username>/local-serverless-stack.git  # your fork
cd local-serverless-stack

# Install dependencies (root + UI)
npm run setup

# Start development (server + UI in watch mode)
npm run dev

# Or run them individually
npm run server:dev   # Express server only
npm run ui:dev       # Vue UI only

# Build all packages
npm run build
```

## Project Structure

```
bin/
└── cli.js                 # CLI entry point (lss start/stop/status/logs)

src/
├── server/                # Express API server
│   ├── index.ts           # Entry point
│   ├── services/          # Core services (provisioning, LocalStack, etc)
│   ├── routes/            # API routes
│   ├── engine/            # Self engine (in-process AWS emulation, no Docker)
│   ├── runtime/           # Lambda runtime execution
│   └── dev/               # Development-only modules
├── client/                # Programmatic client (LssClient)
└── ui/                    # Vue 3 dashboard (@treeui/vue), separate workspace

tests/
├── unit/                  # Unit tests
└── integration/           # Self-engine integration tests (no Docker)
```

## Code Style

- **TypeScript** - Use strict mode
- **Formatting** - 2-space indentation
- **Naming** - camelCase for variables/functions, PascalCase for classes
- **Comments** - Document complex logic and public APIs
- **Error handling** - Use meaningful error messages

## Testing

```bash
# Run unit tests
npm test               # same as npm run test:unit

# Watch mode
npm run test:watch

# Coverage (CI enforces a coverage gate)
npm run test:coverage

# Integration tests (require Docker + LocalStack)
npm run test:integration

# Lint
npm run lint
```

## Documentation

- Update [README.md](./README.md) for user-facing changes
- Add code comments for complex logic
- Update this CONTRIBUTING.md for process changes
- Document environment variables in relevant sections

## Commit Messages

Follow the [Conventional Commits](https://www.conventionalcommits.org/) format:

```
type(scope): subject

body

footer
```

**Types:**
- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation
- `style:` - Code style changes
- `refactor:` - Code refactoring
- `perf:` - Performance improvements
- `test:` - Test additions/modifications
- `chore:` - Build/dependency changes

**Example:**
```
feat(server): add DynamoDB proxy for legacy compatibility

Implemented temporary HTTP reverse proxy forwarding to LocalStack
for DynamoDB access on port 8000. Feature is gated by ENABLE_DYNAMO_PROXY
environment variable and marked for future removal.

Closes #42
```

## Release Process

1. Bump the version with `npm version <patch|minor|major> --no-git-tag-version`
2. Update CHANGELOG.md
3. Once the version bump lands on `main`, GitHub Actions detects the change and publishes to npm — no git tags involved

See [docs/RELEASE.md](./docs/RELEASE.md) for details.

## Questions?

- Check the [README.md](./README.md) documentation
- Review existing [GitHub Issues](https://github.com/viserion77/local-serverless-stack/issues)
- Open a [Discussion](https://github.com/viserion77/local-serverless-stack/discussions) for questions

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
