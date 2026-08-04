import { forwardRef } from "react";
import {
  Link as RouterLink,
  type LinkProps as RouterLinkProps,
} from "react-router-dom";

type Href =
  | string
  | {
      pathname?: string;
      query?: Record<string, string | number | boolean | null | undefined>;
      hash?: string;
    };

type NextLinkProps = Omit<RouterLinkProps, "to"> & {
  href: Href;
  prefetch?: boolean;
  scroll?: boolean;
};

function toHref(value: Href): string {
  if (typeof value === "string") return value;
  const search = new URLSearchParams();
  Object.entries(value.query || {}).forEach(([key, item]) => {
    if (item !== null && item !== undefined) search.set(key, String(item));
  });
  const query = search.toString();
  return `${value.pathname || "/"}${query ? `?${query}` : ""}${value.hash || ""}`;
}

const Link = forwardRef<HTMLAnchorElement, NextLinkProps>(function Link(
  { href, prefetch: _prefetch, scroll: _scroll, ...props },
  ref,
) {
  return <RouterLink ref={ref} to={toHref(href)} {...props} />;
});

export default Link;
