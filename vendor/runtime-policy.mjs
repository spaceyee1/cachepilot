// A dated compatibility/security floor, not a live vulnerability scanner.
export function supportedNode(version) {
  if (typeof version !== 'string') return false;
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return false;
  return (major === 24 && (minor > 22 || (minor === 22 && patch >= 1)))
    || (major === 26 && (minor > 12 || (minor === 12 && patch >= 1)));
}
export function supportedOpenSSL(version) {
  const match = typeof version === 'string' && /^(\d+)\.(\d+)\.(\d+)(?:[+.-].*)?$/.exec(version);
  if (!match) return false;
  const floor = { '3.5': 9, '3.6': 5, '4.0': 3 }[match[1] + '.' + match[2]];
  return floor !== undefined && Number(match[3]) >= floor;
}
export function assertSupportedNode(version = process.versions.node, embedded = process.versions) {
  if (!supportedNode(version) || !supportedOpenSSL(embedded?.openssl)) throw new Error('Unsupported Node runtime.');
}
export function runtimeIdentity() {
  return { executable: process.execPath, processId: process.pid, nodeVersion: process.versions.node,
    platform: process.platform, arch: process.arch,
    embedded: Object.fromEntries(['openssl', 'undici', 'llhttp', 'nghttp2', 'uv', 'v8', 'zlib'].map(key => [key, process.versions[key]])),
    securityFloorAssessmentDate: '2026-10-21', liveVulnerabilityScan: false,
    knownPendingAdvisoryAtAssessment: null,
    assessedSecurityAdvisories: ['https://nodejs.org/en/blog/vulnerability/october-2026-security-releases'],
    securityAssessmentScope: 'Version floor only; no claim that all vulnerabilities are absent.' };
}
