const VERCEL_COMMIT_SHA = /^[0-9a-f]{40}$/i;

interface SentryBuildMetadata {
  release: string;
  dist?: string;
  initialScope?: {
    tags: {
      build_sha: string;
      app_version: string;
    };
  };
}

/**
 * Match the Edge release and GitHub commit identity. A stable semver release
 * cannot advance past a commit-based resolution when the app version stays
 * unchanged. Keep the app version as a tag for cross-deployment searches.
 */
export function getSentryBuildMetadata(
  appVersion: string,
  buildHash: string,
): SentryBuildMetadata {
  const release = `worldmonitor@${appVersion}`;
  const normalizedBuildHash = buildHash.trim();
  if (!VERCEL_COMMIT_SHA.test(normalizedBuildHash)) return { release };

  return {
    release: normalizedBuildHash,
    dist: normalizedBuildHash,
    initialScope: {
      tags: {
        build_sha: normalizedBuildHash,
        app_version: appVersion,
      },
    },
  };
}
