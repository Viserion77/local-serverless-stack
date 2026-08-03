/**
 * Shapes of the vendored AWS Architecture Service Icon artwork.
 *
 * These are hand-written; the geometry that fills them is generated (see
 * `artwork.generated.ts` and `scripts/generate-aws-icons.mjs`).
 */

/**
 * One element of a mark's artwork: a tag, its attributes, and — unlike
 * TreeUI's flat `TIconNode` — its children.
 *
 * Nesting is kept on purpose. Roughly a third of the AWS pack (Amazon S3
 * included) carries the white glyph fill on an ancestor `<g fill="#FFFFFF">`
 * rather than on the `<path>`, and several marks position the glyph with a
 * `<g transform="translate(…)">`. Flattening that would mean rewriting the
 * artwork, which the AWS Architecture Icon terms do not allow — so the tree is
 * reproduced as authored and `createAwsBrandIcon` renders it verbatim.
 *
 * Attribute names are passed straight to Vue's `h()` and land on the element
 * as DOM attributes, so they stay in SVG spelling (`fill-rule`, not
 * `fillRule`). Values stay strings for the same reason.
 */
export interface AwsIconNode {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children?: readonly AwsIconNode[];
}

/**
 * Whether LSS actually provides the service today.
 *
 * - `core` — emulated by the self engine or served by the orchestrator, so the
 *   mark stands for something the dashboard can show.
 * - `reserve` — vendored ahead of need. The AWS pack is a 41 MB download that
 *   is not kept in the repo, so importing the likely-next services up front is
 *   cheaper than re-downloading it for one icon.
 */
export type AwsIconTier = 'core' | 'reserve';

/** A single vendored mark: what it is called, and what it draws. */
export interface AwsIconArtwork {
  /** The AWS service name, as AWS spells it. Use it as the accessible name. */
  readonly label: string;
  /** The AWS Architecture category the mark belongs to (also its tile colour). */
  readonly category: string;
  readonly tier: AwsIconTier;
  /** The children of the mark's `<svg>`, on a 24x24 grid. */
  readonly nodes: readonly AwsIconNode[];
}
