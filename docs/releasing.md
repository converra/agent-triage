# Publishing agent-triage

The package is `agent-triage`; its source repository is
[`converra/agent-triage`](https://github.com/converra/agent-triage).

The tag-driven workflow is `.github/workflows/publish.yml`. It validates the
version tag and main ancestry, runs type checks and mocked tests, rejects known
production dependency advisories, builds a fresh package, and publishes it with
provenance. It uses GitHub OIDC and has no npm token secret.

Before the first release through this workflow, a package maintainer must add
this **trusted publisher** in npm's `agent-triage` package settings:

| Setting | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization/user | `converra` |
| Repository | `agent-triage` |
| Workflow filename | `publish.yml` |
| Environment | Leave blank |
| Allowed action | Direct `npm publish` |

These are npm's documented [trusted publishing settings](https://docs.npmjs.com/trusted-publishers/).
Adding the workflow alone does not register the publisher or prove authentication.
The workflow uses Node 24 and npm 11 (npm 11.5.1+ and Node 22.14+ are required for
OIDC). No local login or long-lived publish token is needed after registration.

For a release:

1. Update `package.json`, its lockfile, and `CHANGELOG.md` in a reviewed PR.
2. Run `npm ci --ignore-scripts`, `npm run lint`, `npm run test:unit`, and
   `npm audit --omit=dev`. Integration tests remain separate and require explicit
   authorization to access real traces or provider APIs.
3. Run `npm pack`; inspect the tarball and smoke-test its CLI and MCP `--help`
   from a fresh installation. Packing rebuilds `dist`.
4. After merge and green required CI, tag the intended main commit as
   `v<package.json version>` and push that tag to trigger publishing.
5. Verify the workflow result, npm version/dist-tag, package provenance, and a
   fresh registry install. A prepared tarball or merged PR is not a published release.

Runtime support starts at Node 18.14.1 (the adapter's existing minimum). The package directly depends on the patched
`@hono/node-server` 1.19.17 adapter so clean downstream installations reuse its
Node 18-compatible branch of the MCP SDK's `^1.19.9 || ^2.0.5` range. This is a
published dependency constraint, not a root-only override. The packed runtime
install in CI uses `--engine-strict` to reject incompatible transitive engines.

The development test runner requires Node
20.19+; CI separately installs the packed runtime under Node 18.
