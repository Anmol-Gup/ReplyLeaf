import { login } from "./actions";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="card narrow">
      <h1>Sign in</h1>
      {error && <p className="notice error">Email or password is incorrect.</p>}
      <form action={login} className="stack">
        <label>Email<input name="email" type="email" required autoComplete="username" /></label>
        <label>Password<input name="password" type="password" required autoComplete="current-password" /></label>
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
