# Orquestrador Local (proposta)

## Objetivo

Centralizar recursos DynamoDB, SQS e SNS em um control plane local único, orquestrando start/stop/hot-reload dos microserviços sem que cada um suba seu próprio LocalStack/Serverless Offline.

## Arquitetura

- **Frontend (TS + Vue 3 + Vite)**: build estático leve; servido pelo backend. Usa componentes vanilla e CSS próprio.
- **Backend (TS + Express)**: rotas `/api/*`; qualquer outra rota entrega o build do frontend. Lê CloudFormation templates de `.serverless/` e mantém cache de estado.
- **LocalStack interno**: provedor único de AWS (dynamo, sqs, sns). Subprocesso/container gerenciado pelo backend.
- **Registro de serviços (CloudFormation)**: plugin Serverless notifica o backend após `sls package`/`sls deploy`; o backend lê o CloudFormation template de `.serverless/` e extrai recursos (DynamoDB, SQS, SNS, Lambdas).
- **Ponte de execução**: eventos em SQS/SNS do control plane disparam o handler real do serviço (usando o artefato .zip gerado ou source diretamente).
- **Watcher**: escuta mudanças de código/config do serviço e aciona rebuild via `sls package` automático e re-sync de recursos.
- **Controle de processos**: backend pode identificar PIDs de serviços rodando (ex: `sls offline`) e enviar sinal para parar/restart antes de rodar novo comando.

## CloudFormation Template como fonte de verdade

**Não precisamos criar um manifest customizado.** O Serverless Framework já gera tudo que precisamos em `.serverless/`:

- `cloudformation-template-update-stack.json`: contém todas as definições de recursos (DynamoDB tables, SQS queues, SNS topics, Lambda functions com handlers, runtime, env vars, event sources como SQS triggers, SNS subscriptions, DynamoDB streams).
- `serverless-state.json`: contém configuração completa do serviço (service name, provider, functions, resources).
- `<function>.zip`: artefatos de build de cada função.

### O que o orquestrador extrai do CloudFormation template:

- **Lambdas** (`AWS::Lambda::Function`): handler path, runtime, env vars, memory, timeout.
- **DynamoDB** (`AWS::DynamoDB::Table`): table name, key schema, indexes, billing mode, streams.
- **SQS** (`AWS::SQS::Queue`): queue name, DLQ, visibility timeout, event source mappings.
- **SNS** (`AWS::SNS::Topic`): topic name, subscriptions.
- **Event Sources** (`AWS::Lambda::EventSourceMapping`): ligação entre SQS/DynamoDB streams e Lambdas.
- **Ignora**: API Gateway (não útil localmente), IAM roles, CloudWatch logs.

### Armazenamento do orquestrador

Cacheia em `~/.lss/orchestrator/cache/<service>/`:

- `cloudformation-template.json` (cópia do template)
- `metadata.json` (caminho raiz do serviço, timestamp, hash do template para detectar mudanças)
- `artifacts/` (opcional: cópias dos .zip se necessário)

## API do backend (esboço)

- `POST /api/services/register` → recebe path do serviço, lê `.serverless/cloudformation-template-update-stack.json`, extrai recursos e salva em cache, aplica diff no LocalStack.
- `POST /api/services/:name/package` → executa `sls package` no serviço e faz register automático após sucesso.
- `POST /api/services/:name/start` → opcionalmente para PID antigo e executa comando de start.
- `POST /api/services/:name/stop` → envia sinal para PID registrado.
- `POST /api/services/:name/redeploy` → re-executa `sls package`, re-lê template, aplica diff.
- `GET /api/services` → lista serviços, estado, PIDs, última atualização.
- `GET /api/resources` → lista dynamo/queues/topics provisionados no LocalStack.
- `GET /api/diff/:name` → diferenças pendentes entre template e estado aplicado no LocalStack.

## Fluxo de trabalho local

1. Subir backend do orquestrador (`npm run orchestrator:server`). Ele inicia LocalStack, Express e serve o build do frontend.
2. Frontend buildado é servido automaticamente pelo backend em qualquer rota não `/api/*`.
3. Em cada microserviço, rodar `sls package` (ou hook automático do plugin) para gerar `.serverless/cloudformation-template-update-stack.json`.
4. Plugin Serverless notifica o orquestrador (via POST `/api/services/register` com path do serviço).
5. Backend lê o CloudFormation template, extrai recursos e handlers, aplica no LocalStack e cacheia.
6. Watcher detecta mudanças em `src/`, `serverless.yml`, etc → re-executa `sls package` → redeploy automático.
7. UI permite ligar/desligar serviços (start/stop de processos), ver logs, aplicar diffs e reinvocar handlers manualmente.

## Estrutura sugerida no monorepo

```
orchestrator/
  package.json
  tsconfig.json
  server/ (Express + LocalStack runner + watcher)
  ui/ (Vue 3 + Vite, build para dist/)
  dist/ (build do UI servido pelo backend)
```

## Controle de processos

- Backend mantém tabela de PIDs por serviço.
- Antes de iniciar um serviço, tenta parar PID anterior (SIGINT/SIGTERM). Opcional: integração com terminals já abertos (enviar sinal pelo PID). Se falhar, loga e prossegue.

## Considerações de implementação

- **Roteamento**: Express serve `/api/*`; fallback `app.get('*')` entrega `dist/index.html` do frontend buildado.
- **LocalStack**: healthcheck + retry; provisiona recursos via AWS SDK v3 parseando CloudFormation template (converter `AWS::DynamoDB::Table` → chamadas `createTable`, etc).
- **Drift/diff**: backend persiste snapshot do template aplicado; ao receber novo template (via re-package), calcula diff e aplica mudanças incrementais.
- **Parser CloudFormation**: extrair apenas recursos relevantes (`AWS::Lambda::Function`, `AWS::DynamoDB::Table`, `AWS::SQS::Queue`, `AWS::SNS::Topic`, `AWS::Lambda::EventSourceMapping`); ignorar API Gateway, IAM roles, logs.
- **Invocação de handlers**: quando evento chega em SQS/SNS do LocalStack, ponte lê o event source mapping do CloudFormation, identifica o handler correto, carrega o .zip (se existir) ou source direto e invoca com o payload.
- **Segurança**: variáveis de ambiente do CloudFormation (`Environment.Variables`) são carregadas por handler; secrets não são centralizados.
- **Logs**: armazenar últimos eventos de package/deploy/invoke em memória + arquivo leve em `~/.lss/orchestrator/logs`.

## Próximos passos

1. Scaffold `orchestrator/server` (Express + LocalStack runner + CloudFormation parser + storage de cache).
2. Scaffold `orchestrator/ui` (Vue 3 + Vite) com layout mínimo: lista de serviços, estado, ações package/start/stop/redeploy, painel de logs.
3. Implementar parser de CloudFormation template → extrair recursos relevantes e converter para chamadas AWS SDK v3.
4. Implementar plugin Serverless com hook `after:package:finalize` para notificar orquestrador (POST `/api/services/register` com path do serviço).
5. Implementar watcher de arquivos (`src/`, `serverless.yml`) → acionar `sls package` → auto-register.
6. Implementar ponte de eventos: SQS/SNS/DynamoDB streams do LocalStack → identificar handler → carregar e invocar .zip ou source.
