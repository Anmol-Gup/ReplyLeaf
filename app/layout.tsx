import "./globals.css";
import { AUTH_HASH_SCRIPT } from "../lib/auth-links";
import { PRODUCT_NAME } from "../lib/brand";

export const metadata = {
  title: `${PRODUCT_NAME} | AI replies for your customers`,
  description: "Replyleaf is an AI assistant on WhatsApp that answers customer questions, captures enquiries and collects appointment requests.",
};

// Light theme only: tells the browser never to draw form controls, scrollbars or the page dark.
export const viewport = { colorScheme: "light" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Redirects old-style email-confirmation links before the page is drawn (see lib/auth-links.ts). */}
        <script dangerouslySetInnerHTML={{ __html: AUTH_HASH_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
