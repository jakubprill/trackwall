/**
 * What Trackwall downloads for Java navigation (ADR-123, ADR-167): the jdtls release and the Lombok jar, pinned here with
 * their SHA-256 so that every computer gets the same files and a download is checked before anything reads it, and the
 * Java jdtls runs on. A new release is a change to this file, tried with a real project first (ADR-99 measured jdtls on a
 * Spring Boot sample).
 */

export interface PinnedRelease {
  version: string;
  url: string;
  sha256: string;
}

export const JDTLS_RELEASE: PinnedRelease = {
  version: "1.63.0",
  url: "https://download.eclipse.org/jdtls/milestones/1.63.0/jdt-language-server-1.63.0-202610191322.tar.gz",
  sha256: "b1f2abe0b3cccb462cf64fb4a5587c7d09df60cf8be7748b152cbd89d018bdc4",
};

/**
 * Lombok's jar, which jdtls loads as a Java agent so that code using Lombok's generated getters, builders and loggers
 * resolves (ADR-167). From Maven Central, whose published SHA-1 the jar was checked against when it was pinned; the SHA-256
 * is of that same jar.
 */
export const LOMBOK_RELEASE: PinnedRelease = {
  version: "1.18.48",
  url: "https://repo1.maven.org/maven2/org/projectlombok/lombok/1.18.48/lombok-1.18.48.jar",
  sha256: "85477a4655ebb2c074a9099cfb749be454449fee564d4282610df1b85f7c508b",
};

/**
 * The Java jdtls runs on, as mise names it: the newest Temurin 25, which mise downloads and checks itself. jdtls needs at
 * least 21; 25 because a jdtls build of October 2026 refused 21 on a Mac (ADR-99), and it is the current long-term release.
 */
export const JDTLS_JAVA = "temurin-25";
