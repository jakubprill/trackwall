// "All features": the groups and order of the sidebar, with the description from each page's frontmatter (TEMPLATE.md).
import { createContentLoader } from "vitepress";
import { FEATURE_GROUPS } from "../.vitepress/sidebar.ts";

export interface FeatureSummary {
  title: string;
  description: string;
  link: string;
}

export interface FeatureArea {
  title: string;
  features: FeatureSummary[];
}

declare const data: FeatureArea[];

export { data };

export default createContentLoader("features/*.md", {
  transform(pages): FeatureArea[] {
    const descriptions = new Map(pages.map((page) => [page.url.replace(/\.html$/, ""), page.frontmatter.description]));
    return FEATURE_GROUPS.map((group) => ({
      title: group.text,
      features: group.items.map((item) => {
        const description = descriptions.get(item.link);
        if (typeof description !== "string") throw new Error(`${item.link}.md has no description in its frontmatter`);
        return { title: item.text, description, link: item.link };
      }),
    }));
  },
});
