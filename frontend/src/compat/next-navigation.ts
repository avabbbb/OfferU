import { useMemo } from "react";
import {
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";

interface NavigationOptions {
  scroll?: boolean;
}

export function useRouter() {
  const navigate = useNavigate();
  return useMemo(
    () => ({
      push: (href: string, _options?: NavigationOptions) => navigate(href),
      replace: (href: string, _options?: NavigationOptions) =>
        navigate(href, { replace: true }),
      back: () => navigate(-1),
      forward: () => navigate(1),
      refresh: () => window.location.reload(),
    }),
    [navigate],
  );
}

export function usePathname() {
  return useLocation().pathname;
}

export function useSearchParams() {
  const { search } = useLocation();
  return useMemo(() => new URLSearchParams(search), [search]);
}

export { useParams };
