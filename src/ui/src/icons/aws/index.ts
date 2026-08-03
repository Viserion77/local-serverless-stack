import { registerTreeIcons } from '@treeui/vue';
import { AWS_ICON_NAMES, awsIconArtwork, type AwsIconName } from './artwork.generated';
import { createAwsBrandIcon } from './createAwsBrandIcon';
import type { AwsIconTier } from './types';

/**
 * The official AWS service marks, as application-supplied TreeUI icons.
 *
 * `ui-ux.md` rule 3: functional interface icons come only from TreeUI, brands
 * do not belong in TreeUI's catalogue and come from a standardised external
 * source. For AWS that source is AWS's own pack — see `./NOTICE.md` for
 * provenance and terms, and `scripts/generate-aws-icons.mjs` for the curated
 * catalogue.
 *
 * Registering them by name (rather than importing components at each call
 * site) is what TreeUI documents for application icons: `<TIcon name="aws-s3"
 * />` and every `TIconInput` prop in the library then accept them, and
 * `registry.generated.d.ts` augments `TIconRegistry` so they typecheck.
 */

export type { AwsIconName };
export type { AwsIconArtwork, AwsIconNode, AwsIconTier } from './types';
export { AWS_ICON_NAMES, awsIconArtwork };

/** What an AWS mark stands for — enough to label or group it without the geometry. */
export interface AwsIconMeta {
  readonly name: AwsIconName;
  /** The AWS service name, as AWS spells it. Also the accessible name to use. */
  readonly label: string;
  /** The AWS Architecture category (which is also what colours the tile). */
  readonly category: string;
  readonly tier: AwsIconTier;
}

/**
 * The catalogue as a lookup, for product code that renders a label next to a
 * mark or iterates the set (a coverage grid, a legend, a picker).
 */
export const awsIcons: Record<AwsIconName, AwsIconMeta> = Object.fromEntries(
  AWS_ICON_NAMES.map((name) => {
    const { label, category, tier } = awsIconArtwork[name];
    return [name, { name, label, category, tier }];
  }),
) as Record<AwsIconName, AwsIconMeta>;

/** Registering twice would rebuild every component for no gain. */
let registered = false;

/**
 * Teaches the TreeUI icon registry every vendored AWS mark.
 *
 * Call it once, before `createApp`. The registry is reactive, so a later call
 * would still light icons up — but components that rendered an `aws-*` name in
 * the meantime log a one-time "Unknown icon" warning first.
 */
export const registerAwsIcons = (): void => {
  if (registered) {
    return;
  }
  registered = true;
  registerTreeIcons(
    Object.fromEntries(
      AWS_ICON_NAMES.map((name) => [name, createAwsBrandIcon(name, awsIconArtwork[name])]),
    ),
  );
};
