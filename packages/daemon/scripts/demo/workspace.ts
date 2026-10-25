// A made-up shop of twenty repos for the screenshots on the documentation site: Spring services that call each
// other through Feign clients, two BFFs, two web frontends and two shared libraries, so the connection graph,
// the repo cards and the sessions look like a real projects folder. Every name here is invented.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface Service {
  name: string;
  port: number;
  /** The resource its controller serves under `/api/<resource>`. */
  resource: string;
  /** The services it calls through a Feign client. */
  calls: string[];
}

const SERVICES: Service[] = [
  { name: "api-gateway", port: 8080, resource: "routes", calls: ["catalog", "orders-api", "customers", "search", "auth"] },
  { name: "orders-api", port: 8081, resource: "orders", calls: ["payments", "inventory", "pricing", "customers", "notifications"] },
  { name: "payments", port: 8082, resource: "payments", calls: ["billing", "notifications", "customers"] },
  { name: "inventory", port: 8083, resource: "stock", calls: [] },
  { name: "catalog", port: 8084, resource: "products", calls: ["pricing", "reviews"] },
  { name: "customers", port: 8085, resource: "customers", calls: [] },
  { name: "shipping", port: 8086, resource: "shipments", calls: ["orders-api", "notifications", "inventory"] },
  { name: "notifications", port: 8087, resource: "notifications", calls: [] },
  { name: "pricing", port: 8088, resource: "prices", calls: [] },
  { name: "search", port: 8089, resource: "search", calls: ["catalog", "reviews"] },
  { name: "reviews", port: 8091, resource: "reviews", calls: [] },
  { name: "auth", port: 8092, resource: "tokens", calls: [] },
  { name: "billing", port: 8093, resource: "invoices", calls: [] },
  { name: "recommendations", port: 8094, resource: "recommendations", calls: ["catalog", "orders-api", "search"] },
  {
    name: "shop-bff",
    port: 8090,
    resource: "storefront",
    calls: ["catalog", "orders-api", "recommendations", "customers", "payments", "search"],
  },
  { name: "admin-bff", port: 8095, resource: "admin", calls: ["orders-api", "inventory", "shipping", "billing", "customers"] },
];

const FRONTENDS = [
  { name: "shop-web", bff: 8090, port: 5173, title: "Shop" },
  { name: "admin-web", bff: 8095, port: 5174, title: "Shop admin" },
];

const GROUP = "com.example.shop";

/** `orders-api` → `OrdersApi`. */
const pascal = (name: string) => name.replace(/(^|-)([a-z])/g, (_, __, c: string) => c.toUpperCase());
/** `orders-api` → `ordersapi`, a Java package segment. */
const javaPackage = (name: string) => `${GROUP}.${name.replace(/-/g, "")}`;

function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, ...path.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

function git(repo: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} in ${repo}: ${result.stderr}`);
}

/** A git repo with its files in one commit by a made-up author, and a remote on an invented host. */
function commitRepo(root: string, name: string, files: Record<string, string>): void {
  write(root, files);
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "remote", "add", "origin", `https://git.example.com/shop/${name}.git`);
  git(root, "add", "--all");
  git(root, "-c", "user.name=Demo", "-c", "user.email=demo@example.com", "commit", "--quiet", "-m", `Start ${name}`);
}

/**
 * A dev server that stands in for the real one: it answers on its port and logs like Spring Boot or Vite, so the
 * services panel finds the port and sees the service ready. Node runs it, the same on Windows and macOS.
 */
function devServer(port: number, started: string): string {
  return `import { createServer } from "node:http";

createServer((req, res) => {
  console.log(\`\${new Date().toISOString()}  INFO --- \${req.method} \${req.url}\`);
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ id: "42", status: "ok" }));
}).listen(${port}, "127.0.0.1", () => console.log(${JSON.stringify(started)}));
`;
}

const MISE_TOML = `[tasks.dev]
description = "Run locally"
run = "node dev-server.mjs"

[tasks.build]
description = "Build and test"
run = "node -e \\"console.log('BUILD SUCCESS')\\""

[tasks.lint]
description = "Check the style"
run = "node -e \\"console.log('no problems')\\""
`;

function servicePom(service: Service): string {
  return `<project>
  <groupId>${GROUP}</groupId>
  <artifactId>${service.name}</artifactId>
  <version>1.4.0</version>
  <dependencies>
    <dependency>
      <groupId>${GROUP}</groupId>
      <artifactId>shop-commons</artifactId>
      <version>2.1.0</version>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.cloud</groupId>
      <artifactId>spring-cloud-starter-openfeign</artifactId>
    </dependency>
  </dependencies>
</project>
`;
}

function controller(service: Service, pkg: string): string {
  const type = pascal(service.resource);
  return `package ${pkg};

import org.springframework.web.bind.annotation.*;
import java.util.List;

@RestController
@RequestMapping("/api/${service.resource}")
public class ${type}Controller {

    @GetMapping
    public List<${type}Dto> list() {
        return List.of();
    }

    @GetMapping("/{id}")
    public ${type}Dto get(@PathVariable String id) {
        return new ${type}Dto(id);
    }

    @PostMapping
    public ${type}Dto create(@RequestBody ${type}Dto body) {
        return body;
    }
}
`;
}

function feignClient(target: Service, pkg: string): string {
  const type = pascal(target.resource);
  return `package ${pkg}.clients;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.*;

@FeignClient(name = "${target.name}", url = "\${clients.${target.name}.url}")
public interface ${pascal(target.name)}Client {

    @GetMapping("/api/${target.resource}/{id}")
    ${type}Ref get(@PathVariable("id") String id);
}
`;
}

function serviceFiles(service: Service): Record<string, string> {
  const pkg = javaPackage(service.name);
  const dir = `src/main/java/${pkg.replace(/\./g, "/")}`;
  const targets = service.calls.map((name) => {
    const target = SERVICES.find((s) => s.name === name);
    if (target === undefined) throw new Error(`${service.name} calls unknown ${name}`);
    return target;
  });
  const type = pascal(service.resource);
  const files: Record<string, string> = {
    "pom.xml": servicePom(service),
    "mise.toml": MISE_TOML,
    "dev-server.mjs": devServer(service.port, `Tomcat started on port ${service.port} (http) with context path '/'`),
    "README.md": `# ${service.name}\n\nThe ${service.resource} service of the demo shop. Runs on port ${service.port}.\n`,
    "src/main/resources/application.yml": [
      "spring:",
      "  application:",
      `    name: ${service.name}`,
      "server:",
      `  port: ${service.port}`,
      ...(targets.length > 0 ? ["clients:", ...targets.flatMap((t) => [`  ${t.name}:`, `    url: http://${t.name}:8080`])] : []),
      "",
    ].join("\n"),
    [`${dir}/${pascal(service.name)}Application.java`]: `package ${pkg};\n\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\nimport org.springframework.cloud.openfeign.EnableFeignClients;\n\n@SpringBootApplication\n@EnableFeignClients\npublic class ${pascal(service.name)}Application {}\n`,
    [`${dir}/${type}Controller.java`]: controller(service, pkg),
    [`${dir}/${type}Dto.java`]: `package ${pkg};\n\npublic record ${type}Dto(String id) {}\n`,
  };
  for (const target of targets) files[`${dir}/clients/${pascal(target.name)}Client.java`] = feignClient(target, pkg);
  return files;
}

function frontendFiles(frontend: (typeof FRONTENDS)[number]): Record<string, string> {
  return {
    "package.json": `${JSON.stringify(
      { name: frontend.name, private: true, scripts: { dev: "vite" }, dependencies: { "@shop/ui-kit": "3.2.0", react: "19.1.0" } },
      null,
      2,
    )}\n`,
    ".env": `VITE_API_URL=http://localhost:${frontend.bff}\nVITE_APP_TITLE="${frontend.title}"\n`,
    "vite.config.mjs": `export default {\n  server: {\n    proxy: {\n      "/api": { target: "http://localhost:${frontend.bff}", changeOrigin: true },\n    },\n  },\n};\n`,
    "mise.toml": MISE_TOML,
    "dev-server.mjs": devServer(frontend.port, `  ➜  Local:   http://localhost:${frontend.port}/`),
    "README.md": `# ${frontend.name}\n\n${frontend.title} in the browser.\n`,
  };
}

const LIBRARIES: Record<string, Record<string, string>> = {
  "shop-commons": {
    "pom.xml": `<project>\n  <groupId>${GROUP}</groupId>\n  <artifactId>shop-commons</artifactId>\n  <version>2.1.0</version>\n  <packaging>jar</packaging>\n</project>\n`,
    "mise.toml": MISE_TOML,
    "dev-server.mjs": devServer(8099, "shop-commons docs on port 8099"),
    "README.md": "# shop-commons\n\nShared DTOs and error handling for the shop services.\n",
    "src/main/java/com/example/shop/commons/Money.java":
      "package com.example.shop.commons;\n\npublic record Money(long cents, String currency) {}\n",
  },
  "ui-kit": {
    "package.json": `${JSON.stringify({ name: "@shop/ui-kit", version: "3.2.0", dependencies: { react: "19.1.0" } }, null, 2)}\n`,
    "mise.toml": MISE_TOML,
    "dev-server.mjs": devServer(6006, "Storybook started on http://localhost:6006/"),
    "README.md": "# ui-kit\n\nThe shop's React components.\n",
  },
};

/** The names of the demo repos, in the order they are created. */
export const DEMO_REPOS = [...SERVICES.map((s) => s.name), ...FRONTENDS.map((f) => f.name), ...Object.keys(LIBRARIES)];

/** Creates the demo repos in `projectsDir`, each a git repo with one commit, and leaves a few with uncommitted work. */
export function createDemoWorkspace(projectsDir: string): void {
  for (const service of SERVICES) commitRepo(join(projectsDir, service.name), service.name, serviceFiles(service));
  for (const frontend of FRONTENDS) commitRepo(join(projectsDir, frontend.name), frontend.name, frontendFiles(frontend));
  for (const [name, files] of Object.entries(LIBRARIES)) commitRepo(join(projectsDir, name), name, files);
  // Work in progress, so "Changes" and the repo list have something to show.
  write(join(projectsDir, "orders-api"), {
    "README.md": "# orders-api\n\nThe orders service of the demo shop. Runs on port 8081 and retries payments twice.\n",
    "CHANGELOG.md": "- Retry payments\n",
  });
  write(join(projectsDir, "shop-web"), { "src/Checkout.tsx": "export function Checkout() {\n  return null;\n}\n" });
}
