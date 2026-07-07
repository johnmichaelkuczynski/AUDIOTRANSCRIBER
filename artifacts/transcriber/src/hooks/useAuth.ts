import {
  useGetCurrentUser,
  getGetCurrentUserQueryKey,
} from "@workspace/api-client-react";
import type { AuthUser } from "@workspace/api-client-react";

export function useAuth(): {
  user: AuthUser | null;
  isLoading: boolean;
} {
  const { data, isLoading, isError } = useGetCurrentUser({
    query: {
      queryKey: getGetCurrentUserQueryKey(),
      retry: false,
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  });

  return {
    user: isError ? null : (data ?? null),
    isLoading,
  };
}
