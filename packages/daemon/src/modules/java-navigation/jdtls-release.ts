/**
 * The jdtls release and the Java Trackwall installs for Java navigation (ADR-123), pinned here so that every computer gets
 * the same server and a download is checked against the SHA-256 the Eclipse download site publishes next to it. A new
 * release is a change to this file, tried with a real project first (ADR-99 measured jdtls on a Spring Boot sample).
 */

export interface JdtlsRelease {
  version: string;
  url: string;
  sha256: string;
}

export const JDTLS_RELEASE: JdtlsRelease = {
  version: "1.63.0",
  url: "https://download.eclipse.org/jdtls/milestones/1.63.0/jdt-language-server-1.63.0-202610191322.tar.gz",
  sha256: "b1f2abe0b3cccb462cf64fb4a5587c7d09df60cf8be7748b152cbd89d018bdc4",
};

/**
 * The Java jdtls runs on, as mise names it: the newest Temurin 25, which mise downloads and checks itself. jdtls needs at
 * least 21; 25 because a jdtls build of October 2026 refused 21 on a Mac (ADR-99), and it is the current long-term release.
 */
export const JDTLS_JAVA = "temurin-25";
