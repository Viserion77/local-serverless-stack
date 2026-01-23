# LSS - TODO List

## 🚧 In Progress

### High Priority

- [ ] **LocalStack Integration Testing**
  - Test with all AWS services (DynamoDB, SQS, SNS, Lambda)
  - Validate event source mappings work correctly
  - Test Lambda proxy invocation to serverless-offline

- [ ] **Error Handling**
  - Better error messages in CLI
  - Recovery from orchestrator crashes
  - Handle port conflicts gracefully
  - Validate serverless.yml before registration

- [ ] **Multi-microservice Testing**
  - Test with multiple services registered
  - Cross-service communication (SQS/SNS)
  - Resource isolation between services

### Medium Priority

- [ ] **Configuration File Support**
  - `lss.config.json` or `.lssrc` for project settings
  - Custom ports, LocalStack endpoint, etc.
  - Per-service configuration overrides

- [ ] **Enhanced CLI**
  - `npx lss restart` command
  - `npx lss list` to show registered services
  - `npx lss clean` to remove stale resources
  - `npx lss config` to show current configuration 

- [ ] **Dashboard Improvements**
  - Real-time log streaming
  - Resource usage metrics
  - Service health indicators
  - Manual resource management (create/delete)

- [ ] **Development Experience**
  - Auto-rebuild on serverless.yml changes
  - Better logging and debugging output

### Low Priority

- [ ] **Documentation**
  - API documentation
  - Architecture diagrams
  - Migration guide from pure LocalStack

- [ ] **Testing**
  - Unit tests for CLI
  - Integration tests for orchestrator

- [ ] **npm Publication**
  - Prepare for public release
  - Semantic versioning
  - Changelog automation
  - npm package optimization

## 🔮 Future Ideas

- [ ] Multi-project workspace management
- [ ] VS Code extension
- [ ] Template/project scaffolding
- [ ] Snapshot/restore of LocalStack state

## 🐛 Known Issues

1. **DynamoDB Proxy disabled by default**: Optional feature, enable with ENABLE_DYNAMO_PROXY=true

## 📝 Notes

- Current version is private (not published to npm)
- Used primarily in SimplificaMais project
- Breaking changes may occur before v1.0.0
- Contributions welcome via pull requests

## 🎯 v1.0.0 Roadmap

Before publishing to npm, we need:

1. ⏳ Comprehensive testing
2. ⏳ Production-ready error handling
3. ⏳ Complete documentation
4. ⏳ Migration path from existing setups
5. ⏳ Breaking change freeze

Target: Q2 2026