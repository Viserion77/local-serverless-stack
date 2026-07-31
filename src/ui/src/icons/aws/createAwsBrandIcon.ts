import { defineComponent, h, type Component, type VNode } from 'vue';
import { treeIconDefaults } from '@treeui/vue';
import type { AwsIconArtwork, AwsIconNode } from './types';

/**
 * Turns vendored AWS artwork into a component TreeUI can render.
 *
 * `registerTreeIcons` accepts `TIconNodes | Component`. Raw nodes are the
 * common case, but they are FLAT (`[tag, attrs]`, no children) and they are
 * wrapped by `createTreeIcon` in an `<svg fill="none" stroke="currentColor">`
 * shell — both wrong for a brand mark: the artwork nests, and every glyph
 * would be outlined in the surrounding text colour. A registered Component is
 * stored and returned verbatim by the registry, so this factory owns the whole
 * `<svg>` and reproduces the AWS marks unmodified, as their terms require.
 *
 * The trade-off is that TreeUI adds nothing for us — the component has to
 * honour the props `TIcon` forwards by itself, which is what the props block
 * below is for.
 */

/** `aws-secrets-manager` -> `AwsSecretsManagerIcon`, for Vue devtools/warnings. */
const toComponentName = (name: string): string =>
  `${name.replace(/(^|-)([a-z0-9])/g, (_match, _sep, char: string) => char.toUpperCase())}Icon`;

/** Renders one artwork node and, recursively, its children. */
const renderNode = (node: AwsIconNode): VNode =>
  h(node.tag, node.attrs, node.children ? node.children.map(renderNode) : undefined);

export const createAwsBrandIcon = (name: string, artwork: AwsIconArtwork): Component =>
  defineComponent({
    name: toComponentName(name),
    // The three props TIcon forwards, with createTreeIcon's own shapes and
    // defaults. Declaring them is load-bearing: an undeclared prop falls
    // through to the DOM, and `size="20"` is not a valid SVG attribute — the
    // mark would then render with no width/height and stretch to the replaced
    // element default. `strokeWidth`/`absoluteStrokeWidth` are accepted and
    // deliberately ignored (a full-colour tile has no stroke to scale);
    // declaring them is what keeps them out of the markup.
    props: {
      size: { type: [Number, String], default: treeIconDefaults.size },
      strokeWidth: { type: [Number, String], default: treeIconDefaults.strokeWidth },
      absoluteStrokeWidth: { type: Boolean, default: treeIconDefaults.absoluteStrokeWidth },
    },
    setup(props, { attrs }) {
      return () =>
        h(
          'svg',
          {
            xmlns: 'http://www.w3.org/2000/svg',
            width: props.size,
            height: props.size,
            // The "16" variant of the AWS pack is authored on the same 24x24
            // grid as TreeUI's Branchline icons, so no scaling is needed.
            viewBox: '0 0 24 24',
            // Only a fallback: every painted node resolves its own fill (the
            // generator fails the build otherwise). No `stroke` is set — the
            // artwork is filled shapes, and `currentColor` must not touch it.
            fill: 'none',
            // Decorative by default; the consumer supplies the accessible name
            // via TIcon's `label`, which arrives in `attrs` as `role="img"` +
            // `aria-label` + `aria-hidden: undefined`.
            'aria-hidden': 'true',
            // Spread last on purpose, exactly as createTreeIcon does: it is
            // what lets TIcon erase the `aria-hidden` default above.
            ...attrs,
          },
          artwork.nodes.map(renderNode),
        );
    },
  });
