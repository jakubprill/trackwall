import { parseTrackwallLink, TRACKWALL_LINK_SCHEME, trackwallLinkCandidates } from "@trackwall/protocol";
import { defaultSchema } from "rehype-sanitize";
import { defaultRemarkPlugins } from "streamdown";

/**
 * How untrusted Markdown (`components/Markdown.tsx`) treats links and what it keeps, and `trackwall://` links in it
 * (ADR-52): an agent writes them as a Markdown link, as bare text or in backticks, and
 * GFM turns only web addresses into links. This remark plugin makes a link of a bare one in text and of inline code that
 * holds nothing but one, so all three can be clicked. Text inside a link or a code block stays as it is, and anything
 * `parseTrackwallLink` refuses stays text. The minimal shapes of the Markdown tree (mdast) it touches are written out
 * here, because its types are not a dependency of the UI.
 */
interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}

/**
 * Sanitization with GitHub's schema with the `user-content-` prefix for `id` and `name`, instead of Streamdown's own
 * (which strips it, and the text could then overwrite named elements of the window) and without `rehype-harden`, which
 * without a base URL turns relative links and images into "[blocked]". `metastring` is the code block options Streamdown
 * carries over from the fence (for example `startLine=10`). The sanitizer drops an `href` of any protocol not listed, so
 * `trackwall` joins GitHub's (`http`, `https`, `mailto` and the like).
 */
export const MARKDOWN_SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: { ...defaultSchema.attributes, code: [...(defaultSchema.attributes?.code ?? []), "metastring"] },
  protocols: { ...defaultSchema.protocols, href: [...(defaultSchema.protocols?.href ?? []), TRACKWALL_LINK_SCHEME] },
};

/** Streamdown's own remark plugins (GFM among them) are replaced when any are passed, so they come first. */
export const MARKDOWN_REMARK_PLUGINS = [...Object.values(defaultRemarkPlugins), remarkTrackwallLinks];

/** Nodes whose text is not looked into: a link stays one link, code stays code. */
const LEFT_AS_THEY_ARE = new Set(["link", "linkReference", "definition", "code", "html"]);

function remarkTrackwallLinks() {
  return (tree: MarkdownNode) => linkChildren(tree);
}

function linkChildren(node: MarkdownNode): void {
  if (!node.children || LEFT_AS_THEY_ARE.has(node.type)) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === "text") return linkText(child.value ?? "");
    if (child.type === "inlineCode" && child.value !== undefined && parseTrackwallLink(child.value.trim())) {
      return [{ type: "link", url: child.value.trim(), children: [child] }];
    }
    linkChildren(child);
    return [child];
  });
}

/** A text node split into text and links; the text itself when it holds none. */
function linkText(value: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  let from = 0;
  for (const match of value.matchAll(trackwallLinkCandidates())) {
    if (!parseTrackwallLink(match[0])) continue;
    if (match.index > from) nodes.push({ type: "text", value: value.slice(from, match.index) });
    nodes.push({ type: "link", url: match[0], children: [{ type: "text", value: match[0] }] });
    from = match.index + match[0].length;
  }
  if (from < value.length) nodes.push({ type: "text", value: value.slice(from) });
  return nodes;
}
