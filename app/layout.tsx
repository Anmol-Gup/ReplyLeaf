import "./globals.css";
import { COMPANY_NAME, PRODUCT_NAME } from "../lib/brand";

export const metadata = {
  title: `${PRODUCT_NAME} | ${COMPANY_NAME}`,
  description: "An AI assistant on WhatsApp that answers customer questions and takes booking requests.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
