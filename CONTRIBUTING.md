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
- **Environment** - Node version, OS, LocalStack version
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
# Clone the repository
git clone https://github.com/yourusername/local-serverless-stack.git
cd local-serverless-stack

# Install dependencies
npm install

# Start development
npm run orchestrator:dev

# Build all packages
npm run build
```

## Project Structure

```
packages/
├── orchestrator/          # Main Express server and orchestration logic
│   ├── server/
│   │   ├── index.ts       # Entry point
│   │   ├── dev/           # Development-only modules (temporary)
│   │   ├── services/      # Core services (provisioning, LocalStack, etc)
│   │   ├── routes/        # API routes
│   │   └── ui/            # Vue3 frontend
│   └── package.json
│
└── serverless-plugin/     # Serverless Framework plugin
    ├── src/
    │   └── index.ts       # Plugin entry point
    └── package.json
```

## Code Style

- **TypeScript** - Use strict mode
- **Formatting** - 2-space indentation
- **Naming** - camelCase for variables/functions, PascalCase for classes
- **Comments** - Document complex logic and public APIs
- **Error handling** - Use meaningful error messages

## Testing

```bash
# Run tests (when available)
npm test

# Run with coverage
npm run test:coverage
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
feat(orchestrator): add DynamoDB proxy for legacy compatibility

Implemented temporary HTTP reverse proxy forwarding to LocalStack
for DynamoDB access on port 8000. Feature is gated by ENABLE_DYNAMO_PROXY
environment variable and marked for future removal.

Closes #42
```

## Release Process

1. Update version in package.json files
2. Update CHANGELOG.md
3. Create a release tag
4. GitHub Actions will publish to npm

## Questions?

- Check the [README.md](./README.md) documentation
- Review existing [GitHub Issues](https://github.com/local-serverless-stack/lss/issues)
- Open a [Discussion](https://github.com/local-serverless-stack/lss/discussions) for questions

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
