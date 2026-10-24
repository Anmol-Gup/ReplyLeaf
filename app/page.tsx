import Link from "next/link";

export default function Home() {
  return (
    <main className="card narrow">
      <h1>WhatsApp AI Assistant</h1>
      <p>Business owners: <Link href="/dashboard">open your dashboard</Link>.</p>
    </main>
  );
}
