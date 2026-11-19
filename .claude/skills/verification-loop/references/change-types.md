# What to verify, by kind of change

Use every section that applies. Most changes touch more than one: an API change usually also has backend and
database parts.

## Frontend (web UI, components, styles)

- **Tests:** component or unit tests for logic and state; an end-to-end test (Playwright, Cypress or the
  project's tool) for each changed flow.
- **States:** loading, empty, error, success, long content, slow network, a disabled control, permission denied.
- **Real browser:** open the page, do the flow as a user would, and check:
  - the console has no errors or warnings, and no network request fails;
  - it works at mobile width (about 375 px) and desktop width;
  - it works in light and dark themes when the app has both;
  - keyboard only: tab order, focus visible, Enter and Escape behave.
- **Accessibility:** labels on inputs, alt text, contrast, and roles on custom controls. Run the project's a11y
  linter or axe if it has one.
- **Build:** the production build succeeds, with no new bundle-size warnings or type errors.
- **Regression:** the screens next to the change still render; shared components still look right where else
  they are used.

## Backend (services, jobs, business logic)

- **Tests:** unit tests for every branch; integration tests against a real test database or queue (a container
  or the project's test setup), not mocks of your own code.
- **Errors:**
  - a dependency that times out or is down;
  - retries, and making them idempotent (running twice must not double charge or double send);
  - partial failure part-way through a batch.
- **Concurrency:** two requests or jobs at the same time on the same record; locks and transactions.
- **Config:** a missing or invalid environment variable fails clearly at start-up, not deep inside a request.
- **Logs:** useful on failure, and no secrets, tokens or personal data in them.
- **Run it:** start the service and exercise the changed path for real (an HTTP call, a job trigger or a CLI command).

## Database (schema, migrations, queries)

- **Migrate up on a copy:** apply it to a database that has realistic existing data, not only an empty one.
  Check the existing rows survive and are correct.
- **Rollback:** run the down migration, or write down the rollback plan when it can't be reversed. Test the
  rollback too.
- **Compatibility:** the old app version still works against the new schema during a deploy. Use expand,
  migrate, then contract, and add a column before you require it.
- **Locks and size:** long locks on big tables, index builds (concurrently where the DB supports it), and the
  time a backfill takes.
- **Constraints:** NOT NULL, unique, foreign keys and defaults are tested with data that violates them.
- **Queries:** correct results on edge data (NULLs, duplicates, no rows), an EXPLAIN for new hot queries, and no
  N+1 queries.
- **Never** run a migration against production or shared data as part of verification.

## API (HTTP, RPC, GraphQL, webhooks you expose)

- **Contract:** request and response shapes match the spec or the types; tested with an actual HTTP client
  against the running server.
- **Status codes and errors:** success, validation error (400 or 422), unauthenticated (401), forbidden (403),
  not found, conflict, rate limited, and a server error. The error bodies are useful and leak nothing.
- **Auth:** every new route checks authentication and authorization. Test that another user's resource is
  refused.
- **Validation:** missing fields, wrong types, huge payloads, unicode, injection-shaped strings.
- **Backwards compatibility:** existing clients still work. No field was removed or renamed without a version
  bump or a deprecation path.
- **Idempotency and retries:** a repeated POST or webhook delivery doesn't duplicate side effects.
- **Pagination, sorting and filters:** first page, last page, empty, and out of range.
- Update the API docs and the OpenAPI or schema files when the contract changed.

## Messaging integrations (WhatsApp and similar)

Applies to WhatsApp Business / Cloud API and other messaging providers (SMS, email, chat platforms).

- **Never message real customers while testing.** Use the provider's test numbers, a sandbox, or a mocked
  provider at the HTTP edge. Confirm which phone number ID or sender a test run uses before running it.
- **Inbound webhooks:**
  - verify the signature (for WhatsApp, `X-Hub-Signature-256` with the app secret), and test that a bad or
    missing signature is refused;
  - handle the verification challenge (the GET handshake);
  - answer quickly (2xx) and do the slow work asynchronously.
- **Duplicates and order:** the provider retries deliveries and can send them out of order. Store each message
  ID or event ID and process it once. Test a duplicate delivery and an out-of-order delivery.
- **Status updates:** sent, delivered, read and failed callbacks update state correctly, including when one
  arrives before the send call has returned.
- **Outbound rules:**
  - pre-approved templates outside the customer-service window, with free-form text only inside it;
  - template parameter counts and formats;
  - test that a send outside the window is refused or handled.
- **Errors from the provider:** rate limits, an invalid recipient, an expired token, a template that was rejected
  or paused, and media upload or download failures. Each one is handled, logged without personal data, and
  doesn't crash the worker.
- **Media:** types and size limits, and expiring download URLs (fetch them promptly and handle a 404).
- **Opt-in and opt-out:** the user's consent state is respected, and STOP-style opt-outs are honoured.
- **Secrets:** tokens and app secrets come only from config or a secret store. None appear in code, tests,
  fixtures or logs.
- **End to end:** send a real message from the test number to the test recipient, receive a reply through the
  webhook (a tunnel or staging), and check the full round trip in the app's own UI or data.

## Build, config and dependencies

- **Clean install:** run the clean install the way CI does (`npm ci`, `pip install` from the lock file, and so
  on) and check the lock file changed only as intended.
- **Upgraded dependency:** read its changelog for breaking changes, then run the full suite plus a real run of
  the features that use it.
- **CI config changed:** check the workflow syntax, and that the jobs still run the same checks (none silently
  removed).
- **Environment and config changed:** update the example config and the docs, check the defaults are safe, and
  test a start-up with the setting missing.
