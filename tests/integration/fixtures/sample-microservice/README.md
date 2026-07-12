# sample-microservice (integration-test fixture)

This is the fixture service used by the integration suites (formerly the `sample-microservice` example, moved here when the examples folder was consolidated).
It is registered against an isolated LSS + LocalStack instance by `tests/integration/features.test.ts`
and `tests/integration/client.test.ts`.

The service name and all resource names (`sample-microservice-*`: Users, Sessions, Orders,
OrderProcessing, OrderEvents, uploads) are asserted by those tests — keep them stable.

Not a usage example — see `examples/` for runnable examples.
