import { useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TOKEN_EVENT, getMe, getToken, isTokenExpired, logout } from "@/lib/api";

export const SESSION_KEY = ["backend-session"] as const;

function subscribe(onChange: () => void) {
  window.addEventListener(TOKEN_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(TOKEN_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** The current backend JWT, re-rendering when it is saved or cleared. */
export function useToken() {
  return useSyncExternalStore(subscribe, getToken, () => null);
}

/** The signed-in backend user (GitHub or Google OAuth), if any. */
export function useSession() {
  const queryClient = useQueryClient();
  const token = useToken();
  const hasToken = Boolean(token && !isTokenExpired(token));
  const me = useQuery({ queryKey: [...SESSION_KEY, token], queryFn: getMe, enabled: hasToken, staleTime: 60_000, retry: false });
  return {
    me: hasToken ? me.data : undefined,
    user: hasToken ? me.data?.user : undefined,
    isLoading: hasToken && me.isLoading,
    error: hasToken ? me.error : null,
    signedIn: hasToken && Boolean(me.data),
    signOut: async () => {
      await logout();
      queryClient.removeQueries({ queryKey: SESSION_KEY });
    },
  };
}
