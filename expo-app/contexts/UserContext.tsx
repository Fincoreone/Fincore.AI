import React, { createContext, useContext, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { apiPost, apiFetch } from '../lib/api';
import { loadSessionToken, setSessionToken, clearSessionToken, setSessionExpiredHandler } from '../lib/session';

const USER_ID_KEY = 'fincore_user_id';
const USER_NAME_KEY = 'fincore_user_name';
const AUTH_PROVIDER_KEY = 'fincore_auth_provider';
const USER_EMAIL_KEY = 'fincore_user_email';
const ONBOARDING_COMPLETED_KEY = 'fincore_onboarding_completed';

type AuthProvider = 'anonymous' | 'google' | 'apple' | 'microsoft';

interface ProviderAuthResponse {
  user_id: string;
  session_token: string | null;
  requires_2fa?: boolean;
  challenge_token?: string;
  phone_hint?: string;
}

/**
 * `two_factor_required` carries no session -- the caller must collect the SMS
 * code and call completeTwoFactor before the user is actually signed in.
 */
export type AuthResult =
  | { status: 'success' }
  | { status: 'two_factor_required'; challengeToken: string; phoneHint?: string }
  | { status: 'error' };

interface UserContextValue {
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  authProvider: AuthProvider;
  hasCompletedOnboarding: boolean;
  isLoading: boolean;
  setUserName: (name: string) => Promise<void>;
  setUserEmail: (email: string) => Promise<void>;
  setAuthProvider: (provider: AuthProvider) => Promise<void>;
  completeOnboarding: () => Promise<void>;
  clearUser: () => Promise<void>;
  /**
   * Verifies a Sign-In-with-{provider} identity token server-side and
   * establishes a real session. userId is derived entirely from the
   * provider's verified subject claim -- the client never picks it.
   */
  authenticateWithProvider: (
    provider: 'apple' | 'google' | 'microsoft',
    identityToken?: string | null,
    authorizationCode?: string | null
  ) => Promise<AuthResult>;
  /** Exchanges a 2FA challenge token plus the SMS code for a real session. */
  completeTwoFactor: (challengeToken: string, code: string) => Promise<AuthResult>;
  /**
   * Marks onboarding complete if the account already has saved Big Five scores.
   * Returns true when the caller should skip straight to the tabs.
   */
  restoreOnboardingFromServer: () => Promise<boolean>;
  /**
   * TEMP (2026-09-10): dev-only bypass. Obtains a real server-signed session
   * for a fixed test user from the backend's /auth/dev endpoint, which only
   * exists when the server runs with ENVIRONMENT=development. Guarded by
   * __DEV__ so it is a no-op in release/TestFlight builds.
   */
  authenticateAsDevUser: () => Promise<AuthResult>;
}

const UserContext = createContext<UserContextValue | null>(null);

/**
 * True when the signed-in account already has Big Five scores saved server-side,
 * i.e. they have completed the survey before on some device.
 *
 * Returns false if the request fails, so a network blip re-runs onboarding
 * rather than stranding a genuinely new user in the tabs with no profile.
 */
async function hasServerProfile(): Promise<boolean> {
  try {
    // This call gates the splash screen, and fetch has no default timeout, so a
    // stalled connection would otherwise hang the app on launch indefinitely.
    const timeout = new Promise<false>(resolve => setTimeout(() => resolve(false), 5000));
    const lookup = apiFetch<{ big_five?: Record<string, number> | null }>('/profile')
      .then(({ data }) => Boolean(data?.big_five && Object.keys(data.big_five).length > 0));
    return await Promise.race([lookup, timeout]);
  } catch {
    return false;
  }
}

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [userId, setUserId] = useState<string | null>(null);
  const [userName, setUserNameState] = useState<string | null>(null);
  const [userEmail, setUserEmailState] = useState<string | null>(null);
  const [authProvider, setAuthProviderState] = useState<AuthProvider>('anonymous');
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadUser = async () => {
      try {
        // Load the session token first -- apiFetch reads it synchronously
        // from the in-memory cache, so it must be hydrated before any
        // authenticated request can go out.
        // Each read is a keychain round trip; they are independent, so issue
        // them together rather than one after another.
        const [
          storedSessionToken,
          storedUserId,
          storedUserName,
          storedEmail,
          storedProvider,
          storedOnboarding,
        ] = await Promise.all([
          loadSessionToken(),
          SecureStore.getItemAsync(USER_ID_KEY),
          SecureStore.getItemAsync(USER_NAME_KEY),
          SecureStore.getItemAsync(USER_EMAIL_KEY),
          SecureStore.getItemAsync(AUTH_PROVIDER_KEY),
          SecureStore.getItemAsync(ONBOARDING_COMPLETED_KEY),
        ]);

        // A stored identity with no session token behind it is not a logged-in
        // user. Hydrating the name/email anyway desyncs the two notions of
        // "signed in": the route guards key off userName/userEmail/provider
        // and keep the user in the tabs, while every fetch keys off userId and
        // silently does nothing -- an app that looks logged in and loads
        // nothing. Drop the orphaned identity so the guards send them to login.
        if (!storedSessionToken) {
          await clearUser();
          return;
        }

        setUserId(storedUserId);
        setUserNameState(storedUserName);
        setUserEmailState(storedEmail);
        if (storedProvider) {
          setAuthProviderState(storedProvider as AuthProvider);
        }

        // The local flag is only ever written after the survey is actually
        // saved, so when it is present it is the answer and there is nothing
        // to ask the server. This is the common case for every returning
        // user and it keeps the launch off the network entirely.
        if (storedOnboarding === 'true') {
          setHasCompletedOnboarding(true);
          return;
        }

        // No local flag: either a fresh install or the flag was wiped by a
        // sign-out. The server is the authority here. Trusting the missing
        // flag alone would send a returning user back through all 60 survey
        // questions and overwrite the scores already saved against their
        // account, so this one case is worth the round trip.
        const completedOnServer = await hasServerProfile();
        setHasCompletedOnboarding(completedOnServer);
        if (completedOnServer) {
          await SecureStore.setItemAsync(ONBOARDING_COMPLETED_KEY, 'true');
        }
      } catch (error) {
        console.error('Failed to load user:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadUser();
  }, []);


  const setUserName = async (name: string) => {
    try {
      await SecureStore.setItemAsync(USER_NAME_KEY, name);
      setUserNameState(name);
    } catch (error) {
      console.error('Failed to save user name:', error);
    }
  };

  const setUserEmail = async (email: string) => {
    try {
      await SecureStore.setItemAsync(USER_EMAIL_KEY, email);
      setUserEmailState(email);
    } catch (error) {
      console.error('Failed to save user email:', error);
    }
  };

  const setAuthProvider = async (provider: AuthProvider) => {
    try {
      await SecureStore.setItemAsync(AUTH_PROVIDER_KEY, provider);
      setAuthProviderState(provider);
    } catch (error) {
      console.error('Failed to save auth provider:', error);
    }
  };

  const restoreOnboardingFromServer = async (): Promise<boolean> => {
    const completed = await hasServerProfile();
    if (completed) await completeOnboarding();
    return completed;
  };

  const completeOnboarding = async () => {
    try {
      await SecureStore.setItemAsync(ONBOARDING_COMPLETED_KEY, 'true');
      setHasCompletedOnboarding(true);
    } catch (error) {
      console.error('Failed to save onboarding state:', error);
    }
  };

  const clearUser = async () => {
    try {
      await SecureStore.deleteItemAsync(USER_ID_KEY);
      await SecureStore.deleteItemAsync(USER_NAME_KEY);
      await SecureStore.deleteItemAsync(USER_EMAIL_KEY);
      await SecureStore.deleteItemAsync(ONBOARDING_COMPLETED_KEY);
      await SecureStore.setItemAsync(AUTH_PROVIDER_KEY, 'anonymous');
      await clearSessionToken();
      setUserId(null);
      setUserNameState(null);
      setUserEmailState(null);
      setHasCompletedOnboarding(false);
      setAuthProviderState('anonymous');
    } catch (error) {
      console.error('Failed to clear user:', error);
    }
  };

  const establishSession = async (data: ProviderAuthResponse): Promise<AuthResult> => {
    if (data.requires_2fa && data.challenge_token) {
      return {
        status: 'two_factor_required',
        challengeToken: data.challenge_token,
        phoneHint: data.phone_hint,
      };
    }

    if (!data.session_token) return { status: 'error' };

    await SecureStore.setItemAsync(USER_ID_KEY, data.user_id);
    await setSessionToken(data.session_token);
    setUserId(data.user_id);
    return { status: 'success' };
  };

  // A 401 on an authenticated request means the stored token is dead --
  // expired, revoked, or minted before a token-format change. Sign out fully:
  // the splash gate routes on userName/userEmail/authProvider, so clearing
  // userId alone would still drop the user into the tabs with a dead session.
  useEffect(() => {
    setSessionExpiredHandler(() => {
      clearUser();
    });
    return () => setSessionExpiredHandler(null);
  }, []);

  const authenticateWithProvider = async (
    provider: 'apple' | 'google' | 'microsoft',
    identityToken?: string | null,
    authorizationCode?: string | null
  ): Promise<AuthResult> => {
    try {
      const { data, error } = await apiPost<ProviderAuthResponse>(`/auth/${provider}`, {
        identity_token: identityToken ?? null,
        authorization_code: authorizationCode ?? null,
      });

      if (error || !data) {
        console.error('Provider authentication failed:', error);
        return { status: 'error' };
      }

      return establishSession(data);
    } catch (error) {
      console.error('Provider authentication failed:', error);
      return { status: 'error' };
    }
  };

  const completeTwoFactor = async (challengeToken: string, code: string): Promise<AuthResult> => {
    try {
      const { data, error } = await apiPost<ProviderAuthResponse>('/auth/2fa/challenge', {
        challenge_token: challengeToken,
        code,
      });

      if (error || !data) return { status: 'error' };

      return establishSession(data);
    } catch (error) {
      console.error('2FA challenge failed:', error);
      return { status: 'error' };
    }
  };

  const authenticateAsDevUser = async (): Promise<AuthResult> => {
    if (!__DEV__) return { status: 'error' };
    try {
      const { data, error } = await apiPost<ProviderAuthResponse>('/auth/dev', {});
      if (error || !data) {
        console.error('Dev authentication failed:', error);
        return { status: 'error' };
      }
      return establishSession(data);
    } catch (error) {
      console.error('Dev authentication failed:', error);
      return { status: 'error' };
    }
  };

  return (
    <UserContext.Provider value={{
      userId,
      userName,
      userEmail,
      authProvider,
      hasCompletedOnboarding,
      isLoading,
      setUserName,
      setUserEmail,
      setAuthProvider,
      authenticateWithProvider,
      completeTwoFactor,
      authenticateAsDevUser,
      completeOnboarding,
      restoreOnboardingFromServer,
      clearUser,
    }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser(): UserContextValue {
  const context = useContext(UserContext);
  if (!context) {
    throw new Error('useUser must be used within a UserProvider');
  }
  return context;
}
