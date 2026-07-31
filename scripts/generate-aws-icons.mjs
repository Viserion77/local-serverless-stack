#!/usr/bin/env node
/**
 * Vendors the official AWS Architecture Service Icons into the dashboard.
 *
 * WHY THIS EXISTS
 * ---------------
 * The dashboard names AWS services all over the place (nav entries, resource
 * counters, service detail pages). `ui-ux.md` rule 3 says brands are NOT
 * TreeUI's job — they come from a standardised external source — and for AWS
 * marks the canonical source is AWS's own pack:
 *
 *   https://aws.amazon.com/architecture/icons/   (pack 07312025, "16" variant)
 *
 * The pack is a 41 MB download that we deliberately do NOT keep in the repo.
 * This script reads it once and emits the geometry as a committed TypeScript
 * module, so the build never depends on the download being present. The default
 * unzip location (`temp/`) is in `.gitignore` precisely so that reading the pack
 * can never turn into redistributing it: LSS is a public MIT repo, the artwork
 * is AWS's trademark, and a stray `git add -A` must not be able to pick it up.
 *
 * WHY THE "16" VARIANT
 * --------------------
 * The 16/32/48/64 variants are structurally identical artwork (a background
 * <rect> in the category colour plus a white glyph). Only the "16" files are
 * authored on a `viewBox="0 0 24 24"` grid — exactly the grid TreeUI's own
 * Branchline icons use — so they drop into the TreeUI registry with no
 * scaling wrapper and no fidelity loss.
 *
 * WHY A NESTED NODE TREE AND NOT `TIconNodes`
 * -------------------------------------------
 * TreeUI's raw geometry type is FLAT (`TIconNode = [tag, attrs]`, rendered by
 * `createTreeIcon` with no children), so a `<g fill="#FFFFFF">` wrapper cannot
 * be expressed and its inherited fill would have to be flattened onto every
 * leaf. AWS's terms require the marks to be used unmodified, so instead of
 * rewriting the artwork we keep the source tree and register each icon as a
 * Vue *component* — `registerTreeIcons` accepts `TIconNodes | Component` and
 * stores a component verbatim. See `createAwsBrandIcon.ts` for the component
 * contract (it mirrors `createTreeIcon`'s props so `<TIcon size>` keeps
 * working).
 *
 * USAGE
 * -----
 *   npm run icons:aws                 # default pack location (temp/…, gitignored)
 *   node scripts/generate-aws-icons.mjs /path/to/Architecture-Service-Icons_07312025
 *
 * An explicit path should live OUTSIDE the repo — `temp/` is the only in-repo
 * directory ignored for this, so any other one leaves the pack stageable.
 *
 * TO ADD A SERVICE: add one line to the CATALOGUE table below and re-run.
 * The table IS the curated catalogue — nothing else selects icons.
 *
 * NOTE: `eslint.config.mjs` ignores `**\/*.mjs`, so this file is lint-exempt.
 * Keep it clean anyway.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

/** The pack we vendor from — recorded in the generated banner and in NOTICE.md. */
const PACK_NAME = 'AWS Architecture Service Icons';
const PACK_DATE = '07312025';
const PACK_VARIANT = '16';
const PACK_URL = 'https://aws.amazon.com/architecture/icons/';
/** Default unzip target. `temp/` is gitignored, so the pack stays un-committable. */
const DEFAULT_PACK_DIR = resolve(REPO_ROOT, 'temp', `Architecture-Service-Icons_${PACK_DATE}`);
const OUT_DIR = resolve(REPO_ROOT, 'src/ui/src/icons/aws');

/**
 * THE CURATED CATALOGUE.
 *
 * `tier: 'core'` — an AWS service LSS actually provides today (emulated by the
 * self engine, or served by the orchestrator). `tier: 'reserve'` — imported
 * ahead of need so a future screen never has to re-download the pack.
 *
 * `name` is the key the icon is registered under in the TreeUI registry.
 * Naming rule: always `aws-` + kebab-case; use the acronym when the acronym is
 * what developers say (s3, sqs, sns, iam, kms, ecs…), otherwise the short
 * product name in words (secrets-manager, api-gateway, step-functions). Never
 * the legal long form (`aws-s3`, not `aws-simple-storage-service`).
 */
const CATALOGUE = [
  // ---------------------------------------------------------------------
  // Tier A — services LSS provides today. Each one has a live LSS surface.
  // ---------------------------------------------------------------------
  // Emulated control plane (engine/emulators/lambda-ctl) + the in-process runtime.
  { name: 'aws-lambda', label: 'AWS Lambda', category: 'Compute', tier: 'core', file: 'Arch_Compute/16/Arch_AWS-Lambda_16.svg' },
  // Emulated (engine/emulators/dynamodb): streams, GSI/LSI, TTL, transactions.
  { name: 'aws-dynamodb', label: 'Amazon DynamoDB', category: 'Database', tier: 'core', file: 'Arch_Database/16/Arch_Amazon-DynamoDB_16.svg' },
  // Emulated (engine/emulators/s3): presigned POST/GET, CORS, notifications.
  { name: 'aws-s3', label: 'Amazon S3', category: 'Storage', tier: 'core', file: 'Arch_Storage/16/Arch_Amazon-Simple-Storage-Service_16.svg' },
  // Emulated (engine/emulators/sqs) + SQS->Lambda dispatch (dispatch/sqs-poller).
  { name: 'aws-sqs', label: 'Amazon SQS', category: 'App Integration', tier: 'core', file: 'Arch_App-Integration/16/Arch_Amazon-Simple-Queue-Service_16.svg' },
  // Emulated, minimal (engine/emulators/sns): topics + Publish, no fan-out yet.
  { name: 'aws-sns', label: 'Amazon SNS', category: 'App Integration', tier: 'core', file: 'Arch_App-Integration/16/Arch_Amazon-Simple-Notification-Service_16.svg' },
  // Emulated (engine/emulators/events): buses, rules, patterns, scheduled targets.
  { name: 'aws-eventbridge', label: 'Amazon EventBridge', category: 'App Integration', tier: 'core', file: 'Arch_App-Integration/16/Arch_Amazon-EventBridge_16.svg' },
  // OpenSearch Serverless emulated (engine/emulators/opensearch, service 'aoss').
  // The pack ships no separate Serverless mark; this is the OpenSearch mark.
  { name: 'aws-opensearch', label: 'Amazon OpenSearch Service', category: 'Analytics', tier: 'core', file: 'Arch_Analytics/16/Arch_Amazon-OpenSearch-Service_16.svg' },
  // Emulated (engine/emulators/secretsmanager) with real AWSCURRENT/AWSPREVIOUS.
  { name: 'aws-secrets-manager', label: 'AWS Secrets Manager', category: 'Security, Identity & Compliance', tier: 'core', file: 'Arch_Security-Identity-Compliance/16/Arch_AWS-Secrets-Manager_16.svg' },
  // Served, not emulated on the AWS wire: LSS's own HTTP API emulation.
  { name: 'aws-api-gateway', label: 'Amazon API Gateway', category: 'Networking & Content Delivery', tier: 'core', file: 'Arch_Networking-Content-Delivery/16/Arch_Amazon-API-Gateway_16.svg' },
  // The provisioning source of truth (services/cloudformation-parser.ts).
  { name: 'aws-cloudformation', label: 'AWS CloudFormation', category: 'Management & Governance', tier: 'core', file: 'Arch_Management-Governance/16/Arch_AWS-CloudFormation_16.svg' },
  // Identity surface. ALSO CARRIES STS (engine/emulators/sts.ts): the
  // Architecture pack has no STS mark at all — AWS folds STS into IAM.
  { name: 'aws-iam', label: 'AWS Identity and Access Management', category: 'Security, Identity & Compliance', tier: 'core', file: 'Arch_Security-Identity-Compliance/16/Arch_AWS-Identity-and-Access-Management_16.svg' },
  // Log/observability surfaces only — there is no CloudWatch emulator. ALSO
  // CARRIES CLOUDWATCH LOGS: the Architecture pack only has the umbrella mark.
  { name: 'aws-cloudwatch', label: 'Amazon CloudWatch', category: 'Management & Governance', tier: 'core', file: 'Arch_Management-Governance/16/Arch_Amazon-CloudWatch_16.svg' },

  // ---------------------------------------------------------------------
  // Tier B — reserve. Not provided by LSS today; vendored so a future screen
  // (or a service whose template references them) has the mark on hand.
  // ---------------------------------------------------------------------
  { name: 'aws-step-functions', label: 'AWS Step Functions', category: 'App Integration', tier: 'reserve', file: 'Arch_App-Integration/16/Arch_AWS-Step-Functions_16.svg' },
  { name: 'aws-express-workflows', label: 'AWS Express Workflows', category: 'App Integration', tier: 'reserve', file: 'Arch_App-Integration/16/Arch_AWS-Express-Workflows_16.svg' },
  { name: 'aws-appsync', label: 'AWS AppSync', category: 'App Integration', tier: 'reserve', file: 'Arch_App-Integration/16/Arch_AWS-AppSync_16.svg' },
  { name: 'aws-mq', label: 'Amazon MQ', category: 'App Integration', tier: 'reserve', file: 'Arch_App-Integration/16/Arch_Amazon-MQ_16.svg' },
  { name: 'aws-iot-core', label: 'AWS IoT Core', category: 'Internet of Things', tier: 'reserve', file: 'Arch_Internet-of-Things/16/Arch_AWS-IoT-Core_16.svg' },
  { name: 'aws-iot-events', label: 'AWS IoT Events', category: 'Internet of Things', tier: 'reserve', file: 'Arch_Internet-of-Things/16/Arch_AWS-IoT-Events_16.svg' },
  { name: 'aws-iot-greengrass', label: 'AWS IoT Greengrass', category: 'Internet of Things', tier: 'reserve', file: 'Arch_Internet-of-Things/16/Arch_AWS-IoT-Greengrass_16.svg' },
  { name: 'aws-kinesis', label: 'Amazon Kinesis', category: 'Analytics', tier: 'reserve', file: 'Arch_Analytics/16/Arch_Amazon-Kinesis_16.svg' },
  { name: 'aws-kinesis-data-streams', label: 'Amazon Kinesis Data Streams', category: 'Analytics', tier: 'reserve', file: 'Arch_Analytics/16/Arch_Amazon-Kinesis-Data-Streams_16.svg' },
  { name: 'aws-data-firehose', label: 'Amazon Data Firehose', category: 'Analytics', tier: 'reserve', file: 'Arch_Analytics/16/Arch_Amazon-Data-Firehose_16.svg' },
  { name: 'aws-athena', label: 'Amazon Athena', category: 'Analytics', tier: 'reserve', file: 'Arch_Analytics/16/Arch_Amazon-Athena_16.svg' },
  { name: 'aws-glue', label: 'AWS Glue', category: 'Analytics', tier: 'reserve', file: 'Arch_Analytics/16/Arch_AWS-Glue_16.svg' },
  { name: 'aws-msk', label: 'Amazon MSK', category: 'Analytics', tier: 'reserve', file: 'Arch_Analytics/16/Arch_Amazon-Managed-Streaming-for-Apache-Kafka_16.svg' },
  { name: 'aws-cognito', label: 'Amazon Cognito', category: 'Security, Identity & Compliance', tier: 'reserve', file: 'Arch_Security-Identity-Compliance/16/Arch_Amazon-Cognito_16.svg' },
  { name: 'aws-kms', label: 'AWS Key Management Service', category: 'Security, Identity & Compliance', tier: 'reserve', file: 'Arch_Security-Identity-Compliance/16/Arch_AWS-Key-Management-Service_16.svg' },
  { name: 'aws-acm', label: 'AWS Certificate Manager', category: 'Security, Identity & Compliance', tier: 'reserve', file: 'Arch_Security-Identity-Compliance/16/Arch_AWS-Certificate-Manager_16.svg' },
  { name: 'aws-waf', label: 'AWS WAF', category: 'Security, Identity & Compliance', tier: 'reserve', file: 'Arch_Security-Identity-Compliance/16/Arch_AWS-WAF_16.svg' },
  { name: 'aws-systems-manager', label: 'AWS Systems Manager', category: 'Management & Governance', tier: 'reserve', file: 'Arch_Management-Governance/16/Arch_AWS-Systems-Manager_16.svg' },
  { name: 'aws-appconfig', label: 'AWS AppConfig', category: 'Management & Governance', tier: 'reserve', file: 'Arch_Management-Governance/16/Arch_AWS-AppConfig_16.svg' },
  { name: 'aws-cloudtrail', label: 'AWS CloudTrail', category: 'Management & Governance', tier: 'reserve', file: 'Arch_Management-Governance/16/Arch_AWS-CloudTrail_16.svg' },
  // AWS Config the compliance service — NOT application configuration. The
  // `aws-` prefix is what keeps this from reading as a TreeUI functional icon.
  { name: 'aws-config', label: 'AWS Config', category: 'Management & Governance', tier: 'reserve', file: 'Arch_Management-Governance/16/Arch_AWS-Config_16.svg' },
  { name: 'aws-x-ray', label: 'AWS X-Ray', category: 'Developer Tools', tier: 'reserve', file: 'Arch_Developer-Tools/16/Arch_AWS-X-Ray_16.svg' },
  { name: 'aws-cloudfront', label: 'Amazon CloudFront', category: 'Networking & Content Delivery', tier: 'reserve', file: 'Arch_Networking-Content-Delivery/16/Arch_Amazon-CloudFront_16.svg' },
  { name: 'aws-route-53', label: 'Amazon Route 53', category: 'Networking & Content Delivery', tier: 'reserve', file: 'Arch_Networking-Content-Delivery/16/Arch_Amazon-Route-53_16.svg' },
  { name: 'aws-vpc', label: 'Amazon Virtual Private Cloud', category: 'Networking & Content Delivery', tier: 'reserve', file: 'Arch_Networking-Content-Delivery/16/Arch_Amazon-Virtual-Private-Cloud_16.svg' },
  // `aws-elb` (Elastic Load Balancing) and `aws-ebs` (Elastic Block Store) are
  // deliberately near-identical keys: both acronyms are the spoken name. A
  // future ALB/NLB icon extends as `aws-alb`/`aws-nlb` — do not rename these.
  { name: 'aws-elb', label: 'Elastic Load Balancing', category: 'Networking & Content Delivery', tier: 'reserve', file: 'Arch_Networking-Content-Delivery/16/Arch_Elastic-Load-Balancing_16.svg' },
  { name: 'aws-ecs', label: 'Amazon ECS', category: 'Containers', tier: 'reserve', file: 'Arch_Containers/16/Arch_Amazon-Elastic-Container-Service_16.svg' },
  { name: 'aws-ecr', label: 'Amazon ECR', category: 'Containers', tier: 'reserve', file: 'Arch_Containers/16/Arch_Amazon-Elastic-Container-Registry_16.svg' },
  { name: 'aws-eks', label: 'Amazon EKS', category: 'Containers', tier: 'reserve', file: 'Arch_Containers/16/Arch_Amazon-Elastic-Kubernetes-Service_16.svg' },
  { name: 'aws-fargate', label: 'AWS Fargate', category: 'Containers', tier: 'reserve', file: 'Arch_Containers/16/Arch_AWS-Fargate_16.svg' },
  { name: 'aws-ec2', label: 'Amazon EC2', category: 'Compute', tier: 'reserve', file: 'Arch_Compute/16/Arch_Amazon-EC2_16.svg' },
  { name: 'aws-batch', label: 'AWS Batch', category: 'Compute', tier: 'reserve', file: 'Arch_Compute/16/Arch_AWS-Batch_16.svg' },
  { name: 'aws-elastic-beanstalk', label: 'AWS Elastic Beanstalk', category: 'Compute', tier: 'reserve', file: 'Arch_Compute/16/Arch_AWS-Elastic-Beanstalk_16.svg' },
  { name: 'aws-app-runner', label: 'AWS App Runner', category: 'Compute', tier: 'reserve', file: 'Arch_Compute/16/Arch_AWS-App-Runner_16.svg' },
  { name: 'aws-rds', label: 'Amazon RDS', category: 'Database', tier: 'reserve', file: 'Arch_Database/16/Arch_Amazon-RDS_16.svg' },
  { name: 'aws-aurora', label: 'Amazon Aurora', category: 'Database', tier: 'reserve', file: 'Arch_Database/16/Arch_Amazon-Aurora_16.svg' },
  { name: 'aws-elasticache', label: 'Amazon ElastiCache', category: 'Database', tier: 'reserve', file: 'Arch_Database/16/Arch_Amazon-ElastiCache_16.svg' },
  { name: 'aws-neptune', label: 'Amazon Neptune', category: 'Database', tier: 'reserve', file: 'Arch_Database/16/Arch_Amazon-Neptune_16.svg' },
  { name: 'aws-documentdb', label: 'Amazon DocumentDB', category: 'Database', tier: 'reserve', file: 'Arch_Database/16/Arch_Amazon-DocumentDB_16.svg' },
  { name: 'aws-timestream', label: 'Amazon Timestream', category: 'Database', tier: 'reserve', file: 'Arch_Database/16/Arch_Amazon-Timestream_16.svg' },
  { name: 'aws-memorydb', label: 'Amazon MemoryDB', category: 'Database', tier: 'reserve', file: 'Arch_Database/16/Arch_Amazon-MemoryDB_16.svg' },
  { name: 'aws-efs', label: 'Amazon EFS', category: 'Storage', tier: 'reserve', file: 'Arch_Storage/16/Arch_Amazon-EFS_16.svg' },
  { name: 'aws-ebs', label: 'Amazon Elastic Block Store', category: 'Storage', tier: 'reserve', file: 'Arch_Storage/16/Arch_Amazon-Elastic-Block-Store_16.svg' },
  { name: 'aws-backup', label: 'AWS Backup', category: 'Storage', tier: 'reserve', file: 'Arch_Storage/16/Arch_AWS-Backup_16.svg' },
  { name: 'aws-ses', label: 'Amazon Simple Email Service', category: 'Business Applications', tier: 'reserve', file: 'Arch_Business-Applications/16/Arch_Amazon-Simple-Email-Service_16.svg' },
  { name: 'aws-amplify', label: 'AWS Amplify', category: 'Front-End Web & Mobile', tier: 'reserve', file: 'Arch_Front-End-Web-Mobile/16/Arch_AWS-Amplify_16.svg' },
  { name: 'aws-codebuild', label: 'AWS CodeBuild', category: 'Developer Tools', tier: 'reserve', file: 'Arch_Developer-Tools/16/Arch_AWS-CodeBuild_16.svg' },
  { name: 'aws-codepipeline', label: 'AWS CodePipeline', category: 'Developer Tools', tier: 'reserve', file: 'Arch_Developer-Tools/16/Arch_AWS-CodePipeline_16.svg' },
  { name: 'aws-cdk', label: 'AWS Cloud Development Kit', category: 'Developer Tools', tier: 'reserve', file: 'Arch_Developer-Tools/16/Arch_AWS-Cloud-Development-Kit_16.svg' },
  { name: 'aws-cli', label: 'AWS Command Line Interface', category: 'Developer Tools', tier: 'reserve', file: 'Arch_Developer-Tools/16/Arch_AWS-Command-Line-Interface_16.svg' },
  { name: 'aws-bedrock', label: 'Amazon Bedrock', category: 'Artificial Intelligence', tier: 'reserve', file: 'Arch_Artificial-Intelligence/16/Arch_Amazon-Bedrock_16.svg' },
  // The current brand. The legacy Analytics `Arch_Amazon-SageMaker_16.svg` is
  // deliberately NOT vendored — it would be a near-duplicate key.
  { name: 'aws-sagemaker-ai', label: 'Amazon SageMaker AI', category: 'Artificial Intelligence', tier: 'reserve', file: 'Arch_Artificial-Intelligence/16/Arch_Amazon-SageMaker-AI_16.svg' },
];

// ---------------------------------------------------------------------------
// SVG parsing
//
// A 40-line parser instead of a dependency: the pack is a closed, uniform set
// of files (no entities, no CDATA, no namespaced elements) and this repo does
// not add dependencies for build-time chores. Anything the parser does not
// recognise makes it throw — see the ALLOWED/FORBIDDEN sets below.
// ---------------------------------------------------------------------------

/** Shapes and containers the artwork is allowed to use. */
const ALLOWED_TAGS = new Set(['svg', 'g', 'title', 'path', 'rect', 'circle', 'ellipse', 'line', 'polygon', 'polyline']);

/**
 * Tags that make an icon impossible to vendor as a plain node tree: they need
 * a document-scoped id space (`<defs>`/`<clipPath>`/`<mask>`/gradients), pull
 * in external bytes (`<image>`, `<use>`), or leak global styles (`<style>`).
 * Six files in the pack use `<defs>`/`<clipPath>`; none is in the catalogue,
 * and the generator must FAIL rather than silently emit broken geometry if one
 * is ever added.
 */
const FORBIDDEN_TAGS = new Set([
  'defs', 'clipPath', 'mask', 'use', 'image', 'style', 'script', 'symbol',
  'filter', 'pattern', 'linearGradient', 'radialGradient', 'foreignObject',
  'text', 'tspan', 'marker', 'switch',
]);

/** Elements that paint — each one must resolve to a real fill (see below). */
const PAINTED_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon']);

class IconError extends Error {}

const fail = (file, message) => {
  throw new IconError(`${file}: ${message}`);
};

/** Finds the '>' that closes the tag starting at `start`, ignoring quoted text. */
const findTagEnd = (source, start, file) => {
  let quote = null;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return i;
    }
  }
  return fail(file, 'unterminated tag');
};

const ATTR_RE = /([:A-Za-z_][-.:\w]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

const parseAttrs = (body, file) => {
  const attrs = {};
  let match;
  ATTR_RE.lastIndex = 0;
  while ((match = ATTR_RE.exec(body)) !== null) {
    const name = match[1];
    const value = match[3] !== undefined ? match[3] : match[4];
    if (name in attrs) fail(file, `duplicate attribute "${name}"`);
    // An external reference (xlink:href, href, url(#gradient)) means the icon
    // is not self-contained and cannot be vendored as geometry.
    if (name === 'href' || name === 'xlink:href') fail(file, `external reference via "${name}"`);
    if (value.includes('url(')) fail(file, `external reference in "${name}": ${value}`);
    attrs[name] = value;
  }
  return attrs;
};

/** Parses one SVG file into `{ tag, attrs, children }`, rejecting anything exotic. */
const parseSvg = (source, file) => {
  const root = { tag: '#document', attrs: {}, children: [] };
  const stack = [root];
  let i = 0;

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      if (source.slice(i).trim() !== '') fail(file, 'unexpected trailing text');
      break;
    }
    // Text between elements. Only <title> carries any, and <title> is dropped.
    const text = source.slice(i, lt);
    if (text.trim() !== '' && stack[stack.length - 1].tag !== 'title') {
      fail(file, `unexpected text content "${text.trim()}"`);
    }

    if (source.startsWith('<?', lt)) {
      const end = source.indexOf('?>', lt);
      if (end === -1) fail(file, 'unterminated processing instruction');
      i = end + 2;
      continue;
    }
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt);
      if (end === -1) fail(file, 'unterminated comment');
      i = end + 3;
      continue;
    }
    if (source.startsWith('<!', lt)) {
      i = findTagEnd(source, lt, file) + 1;
      continue;
    }
    if (source.startsWith('</', lt)) {
      const end = findTagEnd(source, lt, file);
      const tag = source.slice(lt + 2, end).trim();
      const open = stack.pop();
      if (!open || open.tag !== tag) fail(file, `mismatched closing tag </${tag}>`);
      i = end + 1;
      continue;
    }

    const end = findTagEnd(source, lt, file);
    let body = source.slice(lt + 1, end);
    const selfClosing = body.endsWith('/');
    if (selfClosing) body = body.slice(0, -1);
    const tag = body.split(/[\s/]/, 1)[0];
    if (FORBIDDEN_TAGS.has(tag)) fail(file, `<${tag}> cannot be vendored as geometry`);
    if (!ALLOWED_TAGS.has(tag)) fail(file, `unexpected element <${tag}>`);

    const node = { tag, attrs: parseAttrs(body.slice(tag.length), file), children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    i = end + 1;
  }

  if (stack.length !== 1) fail(file, 'unclosed element');
  const elements = root.children;
  if (elements.length !== 1 || elements[0].tag !== 'svg') fail(file, 'expected exactly one root <svg>');
  return elements[0];
};

// ---------------------------------------------------------------------------
// Transformation to vendored geometry
// ---------------------------------------------------------------------------

/**
 * Resolves the fill each painted element ends up with, walking the ancestor
 * chain. This is the guard that matters most: ~1/3 of the pack (Amazon S3
 * included) puts the white glyph fill on an ancestor `<g fill="#FFFFFF">` and
 * NOT on the `<path>`, so anything that reads leaf attributes alone silently
 * produces an invisible glyph on a coloured square.
 */
const assertResolvedFills = (node, inherited, file, seen) => {
  const fill = node.attrs.fill ?? inherited;
  if (PAINTED_TAGS.has(node.tag)) {
    if (!fill || fill === 'none') fail(file, `<${node.tag}> resolves to no fill — the glyph would be invisible`);
    seen.push({ tag: node.tag, attrs: node.attrs, fill });
  }
  for (const child of node.children) assertResolvedFills(child, fill, file, seen);
};

const isHexColour = (value) => /^#[0-9a-fA-F]{3,8}$/.test(value);

/**
 * Strips editor cruft. `id` is Sketch/Figma layer bookkeeping; `stroke="none"`
 * and its orphan `stroke-width` are no-ops on artwork that never strokes; a
 * `fill="none"` on a `<g>` is inert because `assertResolvedFills` has already
 * proven every painted descendant resolves its own fill. `fill-rule` is NOT
 * cruft — it lives on the outer `<g>` and every glyph with a cut-out needs it.
 *
 * The root `<svg>`'s own attributes never reach here: only its children are
 * vendored, because `createAwsBrandIcon` owns the `<svg>` shell.
 */
const cleanAttrs = (node) => {
  const attrs = {};
  for (const [name, value] of Object.entries(node.attrs)) {
    if (name === 'id') continue;
    if (name === 'stroke' && value === 'none') continue;
    if (name === 'stroke-width' && !('stroke' in node.attrs && node.attrs.stroke !== 'none')) continue;
    if (name === 'fill' && value === 'none' && node.tag === 'g') continue;
    attrs[name] = value;
  }
  return attrs;
};

/**
 * Converts one source element into vendored nodes. Returns an ARRAY because a
 * `<g>` whose attributes were all cruft is a pure wrapper with no rendering
 * effect: it is collapsed into its parent, which is what turns the Figma
 * files' triple nesting into a flat pair of nodes.
 */
const toNodes = (node) => {
  if (node.tag === 'title') return []; // the accessible name comes from the consumer
  const attrs = cleanAttrs(node);
  const children = node.children.flatMap(toNodes);
  if (node.tag === 'g') {
    if (Object.keys(attrs).length === 0) return children;
    if (children.length === 0) return [];
  }
  return [children.length > 0 ? { tag: node.tag, attrs, children } : { tag: node.tag, attrs }];
};

const convert = (entry, packDir) => {
  const file = entry.file;
  const absolute = join(packDir, file);
  if (!existsSync(absolute)) fail(file, `missing from the pack (looked in ${packDir})`);
  const source = readFileSync(absolute, 'utf8');

  const svg = parseSvg(source, file);
  // The "16" variant is the only one authored on TreeUI's 24x24 grid; a
  // different viewBox means the wrong variant was pointed at.
  if (svg.attrs.viewBox !== '0 0 24 24') {
    fail(file, `expected viewBox="0 0 24 24" (the "16" variant), got "${svg.attrs.viewBox ?? ''}"`);
  }

  const painted = [];
  assertResolvedFills(svg, undefined, file, painted);

  // Every Architecture icon is a full-bleed 24x24 tile in the category colour
  // plus a glyph. If that shape is missing we are looking at something else.
  const background = painted.filter((el) => el.tag === 'rect' && el.attrs.width === '24' && el.attrs.height === '24');
  if (background.length !== 1) fail(file, `expected exactly one 24x24 background rect, found ${background.length}`);
  if (!isHexColour(background[0].fill)) fail(file, `background rect fill "${background[0].fill}" is not a hex colour`);
  if (painted.length < 2) fail(file, 'no glyph element on top of the background rect');

  const nodes = svg.children.flatMap(toNodes);
  if (nodes.length === 0) fail(file, 'produced no geometry');
  return { ...entry, nodes, background: background[0].fill };
};

// ---------------------------------------------------------------------------
// TypeScript emission
// ---------------------------------------------------------------------------

const quote = (value) => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const key = (name) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : quote(name));

const serializeNode = (node, indent) => {
  const pad = ' '.repeat(indent);
  const attrs = Object.entries(node.attrs).map(([name, value]) => `${key(name)}: ${quote(value)}`).join(', ');
  const head = `${pad}{ tag: ${quote(node.tag)}, attrs: { ${attrs} }`;
  if (!node.children) return `${head} }`;
  const children = node.children.map((child) => serializeNode(child, indent + 4)).join(',\n');
  return `${head}, children: [\n${children},\n${pad}  ] }`;
};

const banner = (script) => `// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Produced by ${script} from the official
// ${PACK_NAME} pack (${PACK_URL}),
// download ${PACK_DATE}, "${PACK_VARIANT}" size variant (viewBox="0 0 24 24").
//
// The artwork is Amazon Web Services' property, reproduced unmodified under the
// AWS Trademark and Architecture Icon terms published at the URL above. See
// ./NOTICE.md before changing anything here.
//
// Regenerate with:  npm run icons:aws
// Add a service by adding one line to the CATALOGUE table in that script.
`;

const emitArtwork = (icons, script) => {
  const entries = icons.map((icon) => {
    const nodes = icon.nodes.map((node) => serializeNode(node, 6)).join(',\n');
    return [
      `  // ${icon.file}`,
      `  ${key(icon.name)}: {`,
      `    label: ${quote(icon.label)},`,
      `    category: ${quote(icon.category)},`,
      `    tier: ${quote(icon.tier)},`,
      '    nodes: [',
      `${nodes},`,
      '    ],',
      '  },',
    ].join('\n');
  });

  return `${banner(script)}
import type { AwsIconArtwork } from './types';

/** Every AWS service mark vendored into the dashboard. */
export type AwsIconName =
${icons.map((icon) => `  | ${quote(icon.name)}`).join('\n')};

/** The registry keys, in a stable order, for code that iterates the catalogue. */
export const AWS_ICON_NAMES: readonly AwsIconName[] = [
${icons.map((icon) => `  ${quote(icon.name)},`).join('\n')}
];

/**
 * The vendored artwork: the children of each mark's \`<svg>\`, with the source
 * nesting preserved (a \`<g>\` may carry the fill or transform its children
 * inherit). \`createAwsBrandIcon\` renders this tree verbatim.
 */
export const awsIconArtwork: Record<AwsIconName, AwsIconArtwork> = {
${entries.join('\n')}
};
`;
};

const emitRegistry = (icons, script) => `${banner(script)}
// Teaches TypeScript about the application-supplied icons registered by
// \`registerAwsIcons()\`, so \`<TIcon name="aws-lambda" />\` and every other
// \`TIconInput\` prop in TreeUI typecheck. The \`export {}\` is required: without
// it this becomes an ambient module that SHADOWS the real @treeui/icons.
export {};

declare module '@treeui/icons' {
  interface TIconRegistry {
${icons.map((icon) => `    ${quote(icon.name)}: true;`).join('\n')}
  }
}
`;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const main = () => {
  const packDir = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_PACK_DIR;
  if (!existsSync(packDir)) {
    console.error(`Cannot find the ${PACK_NAME} pack at:\n  ${packDir}\n`);
    console.error(`Download "${PACK_NAME}" from ${PACK_URL} and unzip it there,`);
    console.error('or pass the unzipped folder as an argument:');
    console.error('  node scripts/generate-aws-icons.mjs /path/to/Architecture-Service-Icons_' + PACK_DATE);
    console.error('\nThe generated geometry is committed, so this is only needed when the');
    console.error('catalogue changes — a normal build never touches the pack.');
    process.exit(1);
  }

  const names = new Set();
  for (const entry of CATALOGUE) {
    if (names.has(entry.name)) throw new IconError(`duplicate catalogue name "${entry.name}"`);
    names.add(entry.name);
  }

  // Sorted output keeps regeneration diff-free regardless of table order.
  const icons = [...CATALOGUE]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((entry) => convert(entry, packDir));

  mkdirSync(OUT_DIR, { recursive: true });
  const script = 'scripts/generate-aws-icons.mjs';
  writeFileSync(join(OUT_DIR, 'artwork.generated.ts'), emitArtwork(icons, script), 'utf8');
  writeFileSync(join(OUT_DIR, 'registry.generated.d.ts'), emitRegistry(icons, script), 'utf8');

  const core = icons.filter((icon) => icon.tier === 'core').length;
  console.log(`Vendored ${icons.length} AWS service marks (${core} core, ${icons.length - core} reserve)`);
  console.log(`  from ${packDir}`);
  console.log(`  into ${OUT_DIR}/artwork.generated.ts`);
  console.log(`       ${OUT_DIR}/registry.generated.d.ts`);
};

try {
  main();
} catch (error) {
  if (error instanceof IconError) {
    console.error(`AWS icon generation failed — ${error.message}`);
    process.exit(1);
  }
  throw error;
}
