/** Decoded Google ID token claims the relay cares about. */
export interface IdTokenClaims {
  uid?: string;
  email?: string;
  email_verified?: boolean;
  [k: string]: unknown;
}

/** Injectable verifier (tests pass a fake; production lazily loads firebase-admin). */
export interface IdTokenVerifier {
  verifyIdToken(idToken: string): Promise<IdTokenClaims>;
}

/**
 * firebase-admin is imported lazily on first use, so the relay boots fast and local / test runs never
 * load it. Verifying ID tokens only needs the project id (public signing keys are fetched by the SDK).
 */
export function createFirebaseVerifier(projectId: string): IdTokenVerifier {
  let authPromise: Promise<{ verifyIdToken(t: string, checkRevoked?: boolean): Promise<IdTokenClaims> }> | null = null;
  const getAuthClient = () => {
    authPromise ??= (async () => {
      const appMod = await import('firebase-admin/app');
      const authMod = await import('firebase-admin/auth');
      const name = 'kesoku-relay';
      const existing = appMod.getApps().find((a) => a.name === name);
      const app = existing ?? appMod.initializeApp({ projectId }, name);
      return authMod.getAuth(app) as unknown as { verifyIdToken(t: string): Promise<IdTokenClaims> };
    })();
    authPromise.catch(() => {
      authPromise = null;
    });
    return authPromise;
  };
  return {
    async verifyIdToken(idToken: string) {
      const auth = await getAuthClient();
      return auth.verifyIdToken(idToken);
    },
  };
}

/** Allowlist decision: verified email, lower-cased exact match. */
export function isEmailAllowed(claims: IdTokenClaims, allowed: readonly string[]): string | null {
  if (claims.email_verified !== true) return null;
  if (typeof claims.email !== 'string' || !claims.email) return null;
  const email = claims.email.trim().toLowerCase();
  return allowed.includes(email) ? email : null;
}
