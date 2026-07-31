# AWS service marks — provenance and terms

## What this is

`artwork.generated.ts` contains the geometry of **64 official AWS service icons**, vendored into this
repository from the **AWS Architecture Service Icons** pack:

| | |
|---|---|
| Source | <https://aws.amazon.com/architecture/icons/> |
| Pack | `Architecture-Service-Icons_07312025` (download dated **07312025**) |
| Variant | the **16** size variant (`.../<Arch_Category>/16/Arch_<Service>_16.svg`) |
| Grid | `viewBox="0 0 24 24"` — the same grid TreeUI's Branchline icons are authored on |

The 16/32/48/64 variants are the same artwork (a background `<rect>` in the AWS category colour plus
a white glyph); only the 16 variant is authored on a 24×24 grid, so it drops into the TreeUI icon
registry with no scaling wrapper and no fidelity loss.

## Ownership and terms — read before touching the artwork

These icons are **the property of Amazon Web Services, Inc. or its affiliates**. They are AWS
trademarks, reproduced here **unmodified** and used under the AWS Trademark Guidelines and the
Architecture Icon terms of use published at <https://aws.amazon.com/architecture/icons/>.

Consequences that bind this directory:

- **Do not modify the marks.** No recolouring, no re-rounding the tile, no insetting or restroking
  the glyph, no swapping the fills for `currentColor`. The conversion performed by the generator is
  deliberately lossless: it drops editor bookkeeping (`id`, inert `stroke="none"` / `fill="none"` /
  `stroke-width`, `<title>`) and nothing else — the drawn geometry, its nesting and its colours are
  byte-faithful to AWS's files.
- **Do not use them to imply AWS endorsement** of LSS, or as part of LSS's own branding. They label
  AWS services inside the dashboard; that is all.
- **They are brand tiles, not functional icons.** They are full-colour and theme-blind on purpose:
  they ignore `data-tree-theme` and the `branding.colors` overrides, and they look identical in light
  and dark. That is correct for a trademark and must not be "fixed" with CSS (see `ui-ux.md` rule 2).
- LSS itself is MIT-licensed; that licence covers the code in this directory, **not** the AWS
  artwork, which remains AWS's under the terms above.

## Files

| File | Hand-written? | What it is |
|---|---|---|
| `artwork.generated.ts` | generated | The vendored geometry, plus `AwsIconName` and `AWS_ICON_NAMES`. |
| `registry.generated.d.ts` | generated | Augments TreeUI's `TIconRegistry` so `aws-*` names typecheck. |
| `types.ts` | yes | `AwsIconNode` / `AwsIconArtwork` / `AwsIconTier`. |
| `createAwsBrandIcon.ts` | yes | Turns artwork into a Vue component honouring `TIcon`'s props. |
| `index.ts` | yes | `registerAwsIcons()`, `awsIcons`, `AWS_ICON_NAMES`, the exported types. |

The pack itself is **not** committed (it is a ~41 MB download), and that is *enforced*, not merely
asked for: `temp/` is in the repository's [`.gitignore`](../../../../../.gitignore), so the unzipped
pack cannot be swept into a commit by a `git add -A`. Everything the build needs is in
`artwork.generated.ts`, so a clean checkout builds without it.

## Usage

```ts
// Once, before createApp() — already wired in src/ui/src/main.ts.
import { registerAwsIcons } from './icons/aws';
registerAwsIcons();
```

```vue
<!-- Decorative next to a visible label -->
<TIcon name="aws-dynamodb" />

<!-- Standing alone: give it the accessible name. It comes from the i18n
     catalogue, not from `awsIcons[...].label` — the mark stands in for a
     resource in the reader's language ("3 tabelas DynamoDB"), and the
     catalogue label is the untranslated AWS product name. -->
<TIcon name="aws-s3" :label="t('services.groupBuckets')" size="24" />
```

`awsIcons` is the catalogue as a lookup — name, AWS label, category, tier. It is there for a screen
that renders the **set** (a coverage grid, a legend, an icon picker), not for accessible names.

Names are also valid wherever TreeUI takes a `TIconInput` — for example `TNavMenu`'s items, which
should always receive the **name**, never a component.

## Adding or regenerating an icon

1. Download the pack from <https://aws.amazon.com/architecture/icons/> and unzip it to
   `temp/Architecture-Service-Icons_07312025/` — the generator's default location, and the **only**
   in-repo path that `.gitignore` covers. Any other directory works too (pass it as an argument), but
   put it **outside** the repository: unzipping 41 MB of AWS artwork into some other in-repo folder
   makes it stageable, and this is a public MIT repo that must not redistribute the pack.
2. Add **one line** to the `CATALOGUE` table in `scripts/generate-aws-icons.mjs` — the table is the
   whole curation; nothing else selects icons:

   ```js
   { name: 'aws-glue', label: 'AWS Glue', category: 'Analytics', tier: 'reserve', file: 'Arch_Analytics/16/Arch_AWS-Glue_16.svg' },
   ```

   Naming rule: always `aws-` + kebab-case; the acronym when that is what developers say (`aws-s3`,
   `aws-sqs`, `aws-iam`), otherwise the short product name in words (`aws-secrets-manager`,
   `aws-step-functions`). Never the legal long form.
3. Run it:

   ```bash
   npm run icons:aws
   # or: node scripts/generate-aws-icons.mjs /path/to/Architecture-Service-Icons_07312025
   ```

   Output is sorted by name, so regenerating an unchanged catalogue produces no diff. The generator
   hard-fails — rather than emitting broken geometry — on a wrong `viewBox`, on `<defs>`/`<clipPath>`/
   `<use>`/`<image>`/`<style>`, on any external reference (`href`, `url(...)`), on a missing 24×24
   background tile, and on any painted element that does not resolve to a real fill.
4. Commit the regenerated files together with the catalogue line.

## Coverage notes

- **`tier: 'core'`** (12) are the services LSS provides today: Lambda, DynamoDB, S3, SQS, SNS,
  EventBridge, OpenSearch, Secrets Manager, API Gateway, CloudFormation, IAM, CloudWatch.
  **`tier: 'reserve'`** (52) are vendored ahead of need so a future screen never has to re-download
  the pack.
- **`tier` classifies; it does not gate loading.** All 64 marks are registered eagerly in
  `main.ts`, so the reserve costs ~45 KB gzip in the entry chunk that nothing renders today. That is
  deliberate: splitting the reserve behind a lazy `registerAwsReserveIcons()` would mean a future
  `<TIcon name="aws-step-functions" />` typechecks, passes review and renders **nothing** until
  someone remembers the extra call — trading a silent-failure footgun for bytes that do not matter on
  a localhost dashboard whose entry chunk is already an order of magnitude larger. Reach for the
  split only if the reserve grows past a few hundred marks. `tier` is there so a coverage screen can
  say "supported today" versus "known to AWS", and to keep the catalogue reviewable.
- **`aws-iam` also stands for AWS STS.** The Architecture pack has no STS mark at all — AWS folds STS
  into the IAM icon — and the self engine does emulate `sts:GetCallerIdentity`.
- **`aws-cloudwatch` also stands for CloudWatch Logs.** The Architecture pack only ships the umbrella
  service mark; the Logs sub-service mark exists only in the sibling *Resource Icons* pack, which is
  a different visual language (48×48, monochrome line art, no coloured tile) and would not sit on
  this grid.
- **`aws-opensearch` covers OpenSearch Serverless** (the engine's `aoss` service): the pack has no
  separate Serverless mark.
- `aws-elb` (Elastic Load Balancing) and `aws-ebs` (Elastic Block Store) are deliberately similar
  keys — both acronyms are the spoken name. A future ALB/NLB mark extends as `aws-alb` / `aws-nlb`;
  do not rename these. `aws-config` is **AWS Config**, the compliance service, not app configuration.
