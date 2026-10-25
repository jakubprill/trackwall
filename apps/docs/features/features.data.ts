// "All features": the groups and order of the sidebar, with the description from each page's frontmatter (TEMPLATE.md).
import { createContentLoader } from "vitepress";
import { FEATURE_GROUPS, type FeatureGroup } from "../.vitepress/sidebar.ts";

export interface FeatureGroupSummary {
  text: FeatureGroup["text"];
  items: (FeatureGroup["items"][number] & { description: string })[];
}

declare const data: FeatureGroupSummary[];

export { data };

export default createContentLoader("features/*.md", {
  transform(pages): FeatureGroupSummary[] {
    const descriptions = new Map(pages.map((page) => [page.url, page.frontmatter.description]));
    return FEATURE_GROUPS.map((group) => ({
      text: group.text,
      items: group.items.map((item) => {
        const description = descriptions.get(item.link);
        if (typeof description !== "string") throw new Error(`${item.link}.md has no description in its frontmatter`);
        return { ...item, description };
      }),
    }));
  },
});
