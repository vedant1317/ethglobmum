# ENSure docs

ENSure deploys websites to ENS, with ENS Lifeboat (verification and recovery) on top. All of it is built in this repo.

| File | Use |
| --- | --- |
| [LIFEBOAT_CONTEXT.md](./LIFEBOAT_CONTEXT.md) | The product. Wins on scope |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System design, every feature, keys, API, data |
| [BUILD_SPEC.md](./BUILD_SPEC.md) | How to build each component, in order. Wins on implementation |
| [TECH_AND_DEMO.md](./TECH_AND_DEMO.md) | Tool per feature, language decision, demo script. Wins on tool choice |
| [REFERENCE_ARCHITECTURE.md](./REFERENCE_ARCHITECTURE.md) | History: how the earlier deploy platform worked, and its mistakes |
| [ARKIV_PROGRESS.md](./ARKIV_PROGRESS.md) | Arkiv dependency map, schema, integrations, and step-by-step progress |

**State:** the base feature's backend is built and tested on a local Sepolia fork: API, deploys, names, CLI, bot, deploy log. Nothing is deployed live. The website pages, the verifier and the release controller's tests are still to do. Run steps are in the [README](../README.md).

**Next:** run it live (see "Before it's live" in the README), then [C12](./BUILD_SPEC.md#c12-controller) onward. The full order is in [BUILD_SPEC.md section 4](./BUILD_SPEC.md#4-build-plan).
