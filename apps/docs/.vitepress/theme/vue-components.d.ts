// Vue single-file components (the "Copy page" button) as the theme registers them; VitePress builds them, tsc only types them.
declare module "*.vue" {
  import type { Theme } from "vitepress";

  const component: NonNullable<Theme["Layout"]>;
  export default component;
}
