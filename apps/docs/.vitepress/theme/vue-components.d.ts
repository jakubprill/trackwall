// Vue single-file components (the "Copy page" button) as the theme registers them; VitePress builds them, tsc only types them.
declare module "*.vue" {
  import type { DefineComponent } from "vue";

  const component: DefineComponent;
  export default component;
}
