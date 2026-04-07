"use client";
import { RootProvider } from "fumadocs-ui/provider/next";
import dynamic from "next/dynamic";
import NextLink from "next/link";
import type { ReactNode } from "react";

const InkeepSearchDialog = dynamic(() => import("@/components/inkeep-search"));

function hasInkeepSearchEnv(): boolean {
  const key = process.env.NEXT_PUBLIC_INKEEP_API_KEY;
  return typeof key === "string" && key.length > 0;
}

type NoPrefetchLinkProps = React.ComponentProps<"a"> & { prefetch?: boolean };

function NoPrefetchLink({ prefetch: _prefetch, href, ...props }: NoPrefetchLinkProps) {
  // Work around static-export navigation edge cases by disabling prefetch globally.
  // We still use Next's <Link> so navigation stays client-side and preserves sidebar behavior.
  return <NextLink href={href ?? "#"} prefetch={false} {...props} />;
}

export function Provider({ children }: { children: ReactNode }) {
  const inkeepSearch = hasInkeepSearchEnv();

  return (
    <RootProvider
      components={{
        Link: NoPrefetchLink,
      }}
      search={
        inkeepSearch
          ? {
              SearchDialog: InkeepSearchDialog,
            }
          : undefined
      }
    >
      {children}
    </RootProvider>
  );
}
