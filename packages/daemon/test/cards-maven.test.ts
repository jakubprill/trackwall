import { describe, expect, test } from "bun:test";
import { extractMaven } from "../src/modules/cards/maven.ts";
import { parseXml } from "../src/modules/cards/xml.ts";
import { snapshotOf } from "./support/snapshot.ts";

const PARENT_POM = `<?xml version="1.0" encoding="UTF-8"?>
<!-- projekt nadrzędny -->
<project>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.3.0</version>
  </parent>
  <groupId>com.example.orders</groupId>
  <artifactId>orders-parent</artifactId>
  <version>1.4.0-SNAPSHOT</version>
  <packaging>pom</packaging>
  <properties>
    <java.version>21</java.version>
    <feign.version>4.1.2</feign.version>
  </properties>
  <modules>
    <module>orders-api</module>
    <module>orders-app</module>
  </modules>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>org.springframework.cloud</groupId>
        <artifactId>spring-cloud-dependencies</artifactId>
        <version>2023.0.2</version>
        <type>pom</type>
        <scope>import</scope>
      </dependency>
      <dependency>
        <groupId>org.slf4j</groupId>
        <artifactId>slf4j-api</artifactId>
        <version>2.0.13</version>
      </dependency>
    </dependencies>
  </dependencyManagement>
</project>
`;

const API_POM = `<project>
  <parent>
    <groupId>com.example.orders</groupId>
    <artifactId>orders-parent</artifactId>
    <version>1.4.0-SNAPSHOT</version>
  </parent>
  <artifactId>orders-api</artifactId>
</project>
`;

const APP_POM = `<project>
  <parent>
    <groupId>com.example.orders</groupId>
    <artifactId>orders-parent</artifactId>
    <version>1.4.0-SNAPSHOT</version>
  </parent>
  <artifactId>orders-app</artifactId>
  <dependencies>
    <dependency>
      <groupId>com.example.orders</groupId>
      <artifactId>orders-api</artifactId>
      <version>\${project.version}</version>
    </dependency>
    <dependency>
      <groupId>org.springframework.cloud</groupId>
      <artifactId>spring-cloud-starter-openfeign</artifactId>
      <version>\${feign.version}</version>
    </dependency>
    <dependency>
      <groupId>com.example.payments</groupId>
      <artifactId>payments-client</artifactId>
      <version>\${payments.version}</version>
    </dependency>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <scope>test</scope>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <artifactId>maven-surefire-plugin</artifactId>
      </plugin>
    </plugins>
  </build>
</project>
`;

describe("ekstraktor Maven", () => {
  test("wielomodułowy projekt: każdy moduł udostępnia współrzędne z grupą i wersją dziedziczoną z rodzica", () => {
    const out = extractMaven(snapshotOf({ "pom.xml": PARENT_POM, "orders-api/pom.xml": API_POM, "orders-app/pom.xml": APP_POM }));

    expect(out.provides).toEqual([
      {
        kind: "package",
        ecosystem: "maven",
        name: "com.example.orders:orders-parent",
        version: "1.4.0-SNAPSHOT",
        evidence: { path: "pom.xml", line: 10 },
      },
      {
        kind: "package",
        ecosystem: "maven",
        name: "com.example.orders:orders-api",
        version: "1.4.0-SNAPSHOT",
        evidence: { path: "orders-api/pom.xml", line: 7 },
      },
      {
        kind: "package",
        ecosystem: "maven",
        name: "com.example.orders:orders-app",
        version: "1.4.0-SNAPSHOT",
        evidence: { path: "orders-app/pom.xml", line: 7 },
      },
    ]);
    expect(out.buildFiles).toEqual([
      { path: "pom.xml", tool: "maven", name: "orders-parent", memberOf: null },
      { path: "orders-api/pom.xml", tool: "maven", name: "orders-api", memberOf: "pom.xml" },
      { path: "orders-app/pom.xml", tool: "maven", name: "orders-app", memberOf: "pom.xml" },
    ]);
  });

  test("używane: rodzic spoza repo, importowany BOM, zależności z zakresem i wtyczki; moduły z repo i zwykłe wpisy dependencyManagement pominięte", () => {
    const out = extractMaven(snapshotOf({ "pom.xml": PARENT_POM, "orders-api/pom.xml": API_POM, "orders-app/pom.xml": APP_POM }));

    expect(out.consumes.map((c) => [c.name, c.version, c.scope, c.evidence.path, c.evidence.line])).toEqual([
      ["org.springframework.boot:spring-boot-starter-parent", "3.3.0", "parent", "pom.xml", 4],
      ["org.springframework.cloud:spring-cloud-dependencies", "2023.0.2", "import", "pom.xml", 23],
      ["org.springframework.cloud:spring-cloud-starter-openfeign", "4.1.2", "compile", "orders-app/pom.xml", 14],
      // Właściwości nie ma w repo, więc zostaje w tekście: widać, skąd wersja pochodzi.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: to dosłowny zapis właściwości Maven, nie szablon JS.
      ["com.example.payments:payments-client", "${payments.version}", "compile", "orders-app/pom.xml", 19],
      ["org.junit.jupiter:junit-jupiter", null, "test", "orders-app/pom.xml", 24],
      ["org.apache.maven.plugins:maven-surefire-plugin", null, "plugin", "orders-app/pom.xml", 32],
    ]);
  });

  test("wersja Javy z właściwości to podpowiedź narzędzia", () => {
    const out = extractMaven(snapshotOf({ "pom.xml": PARENT_POM }));
    expect(out.tools).toEqual([{ tool: "java", version: "21", source: "hint", evidence: { path: "pom.xml", line: 14 } }]);
  });

  test("pom spoza modułów (fixture testów) nie trafia na kartę, a pom w osobnym katalogu bez korzenia tak", () => {
    const fixture = "<project><groupId>x</groupId><artifactId>fixture</artifactId></project>";
    const out = extractMaven(
      snapshotOf({
        "service/pom.xml": "<project><groupId>com.example</groupId><artifactId>service</artifactId></project>",
        "service/src/test/resources/pom.xml": fixture,
      }),
    );
    expect(out.provides.map((p) => p.name)).toEqual(["com.example:service"]);
  });

  test("moduł z profilu też jest częścią buildu", () => {
    const out = extractMaven(
      snapshotOf({
        "pom.xml":
          "<project><groupId>g</groupId><artifactId>root</artifactId><profiles><profile><modules><module>extra</module></modules></profile></profiles></project>",
        "extra/pom.xml":
          "<project><parent><groupId>g</groupId><artifactId>root</artifactId></parent><artifactId>extra</artifactId></project>",
      }),
    );
    expect(out.provides.map((p) => p.name)).toEqual(["g:root", "g:extra"]);
  });

  test("uszkodzony pom to problem karty, nie błąd", () => {
    const out = extractMaven(snapshotOf({ "pom.xml": "<project><artifactId>x</project>" }));
    expect(out.provides).toEqual([]);
    expect(out.problems).toEqual([{ path: "pom.xml", message: "niepasujący znacznik </project> w linii 1" }]);
  });

  test("rodzice zapętleni przez relativePath nie zawieszają ekstraktora", () => {
    const pom = (self: string, parent: string) =>
      `<project><parent><groupId>g</groupId><artifactId>${parent}</artifactId><relativePath>../${parent}/pom.xml</relativePath></parent><artifactId>${self}</artifactId><modules><module>../${parent}</module></modules></project>`;
    const out = extractMaven(
      snapshotOf({
        "pom.xml": "<project><groupId>g</groupId><artifactId>root</artifactId><modules><module>a</module></modules></project>",
        "a/pom.xml": pom("a", "b"),
        "b/pom.xml": pom("b", "a"),
      }),
    );
    expect(out.provides.map((p) => p.name)).toEqual(["g:root", "g:a", "g:b"]);
  });
});

describe("parser XML", () => {
  test("tekst z encjami i CDATA, komentarze i deklaracje pominięte, linie od 1", () => {
    const root = parseXml(
      '<?xml version="1.0"?>\n<!DOCTYPE x>\n<a>\n  <!-- <b>nie</b> -->\n  <b>R&amp;D &lt;3 &#65;</b>\n  <c><![CDATA[<x> & y]]></c>\n  <d/>\n</a>',
    );
    expect(root.children.map((c) => [c.name, c.text, c.line])).toEqual([
      ["b", "R&D <3 A", 5],
      ["c", "<x> & y", 6],
      ["d", "", 7],
    ]);
  });
});
