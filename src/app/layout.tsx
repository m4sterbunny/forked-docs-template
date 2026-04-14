import './global.css';
import { Inter } from 'next/font/google';
import type { Metadata } from 'next';
import { InkeepScript } from "@/components/inkeep-script"; 
import { Provider } from "./provider";
import 'katex/dist/katex.css';
import { getDocsSeoConfig } from '@/lib/seo-config';

const inter = Inter({
  subsets: ['latin'],
});

const { metadataBase } = getDocsSeoConfig();

export const metadata: Metadata = {
  metadataBase,
  title: {
    default: 'DOCS by Tether',
    template: '%s | DOCS',
  },
  description: 'Official documentation and single source of truth for DOCS.',
  icons: {
    icon: '/favicon.svg',
  },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html 
      lang="en" 
      suppressHydrationWarning
      className={inter.className}>
      <body className="flex flex-col min-h-screen">
        {process.env.NEXT_PUBLIC_INKEEP_API_KEY ? <InkeepScript /> : null}
          <Provider>{children}</Provider>
      </body>
    </html>
  );
}
