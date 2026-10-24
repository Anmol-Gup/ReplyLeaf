"use client";

import ErrorBoundary from "../components/ErrorBoundary";

export default function RootError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorBoundary {...props} home="/" />;
}
